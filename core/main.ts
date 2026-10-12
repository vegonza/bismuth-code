// bun core/main.ts [dir]   — the bismuth core: owns the harnesses (`codex app-server`, the `claude` CLI) and all thread
// state across every project, serves the UI on 127.0.0.1. `dir` adds that folder as a project and opens on it.
// The core is never hot-reloaded (changing it needs an app restart); the UI is swapped underneath it by `bun run apply`.
import "./log";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AgentAccounts, detectConfig } from "./accounts";
import { HarnessUpdates } from "./updates";
import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { CursorAdapter } from "./cursor-adapter";
import { summary, titleFrom, UNTITLED, type Harness } from "./harness";
import { injectLiveClient } from "./live";
import { AutoCompact, claudeCompactAt, codexCompactAt } from "./compact";
import { dropSnapshot, snapshot } from "./checkpoints";
import { blob, changes, commit, commitChanges, discard, init, log, pull, push, sync } from "./scm";
import { baseText, createEntry, duplicateEntry, gitState, rawFile, listDirectory, openExternal, previewFile, readFile, renameEntry, resolveRefs, revealEntry, searchFiles, trashEntries, writeFile } from "./files";
import { definition, killLanguageServers } from "./lsp";
import { FolderWatch, gitDirOf } from "./watch";
import { cursorListing, McpOverrides, setCursorServer, type McpBuiltin, type McpDef, type McpListing, type McpPlan } from "./mcp";
import { HOME, listFolder, Projects } from "./projects";
import { MessageQueue, type Row } from "./queue";
import { RemoteAccessControl } from "./remote";
import { Settlement } from "./settled";
import { SideChats } from "./sidechats";
import { Terminals } from "./terminals";
import { SharedUiState } from "./uistate";
import { MAX_UPLOAD_BYTES, Uploads } from "./uploads";
import { VIEW_SERVER, Views } from "./views";
import { Browser, BROWSER_SERVER } from "./browser";
import * as ui from "./ui";
import type { ClientMessage, HarnessId, HarnessInfo, McpSnapshot, ModelOption, RestartMode, RestartResult, RpcMethods, ServerMessage, Thread, ThreadSummary, TurnSettings, UsageReport } from "../shared/model";

const PORT = Number(process.env.PORT ?? 7421);
mkdirSync(ui.STATE, { recursive: true }); // a fresh checkout has none yet
// The first run seeds the registry with the folder bismuth used to be bound to (the launch dir).
const projects = new Projects(ui.STATE, process.argv[2] ?? process.env.BISMUTH_LAUNCH_CWD ?? process.cwd());
const launch = process.argv[2] ? projects.ensure(process.argv[2]).id : null;
const settlement = new Settlement(ui.STATE);
const sideChats = new SideChats(ui.STATE);
const uploads = new Uploads(ui.STATE);
// Screenshots of views are in the user's appearance ("system" is taken as dark).
const views = new Views(ui.STATE, () => server.port!, () => {
  let prefs: { scheme?: string } = {};
  try {
    prefs = JSON.parse(sharedUi.all()["bismuth.prefs"] ?? "{}");
  } catch {}
  return { appearance: prefs.scheme === "light" ? "light" : "dark" };
});
const sharedUi = new SharedUiState(ui.STATE);
// The browser agents drive (core/browser.ts): the window's own browser tabs, through Chromium's DevTools port.
const browserAsks = new Map<string, { resolve: (targetId: string | undefined) => void; reject: (err: Error) => void; left: number }>();
const browser = new Browser(ui.STATE, () => server.port!, Number(process.env.BISMUTH_CDP_PORT) || null, {
  open: async (session, url) => (await askWindow({ op: "open", session, url }))!,
  close: async (session, targetId) => void (await askWindow({ op: "close", session, targetId })),
  show: async (session, targetId) => void (await askWindow({ op: "show", session, targetId })),
  awake: (targets) => broadcast({ type: "browserAwake", targets }),
});

/** The windows on this machine (the desktop's) asked to do something with their browser tabs: the first that does
 *  answers; it fails only when every one couldn't. */
function askWindow(ask: { op: "open"; session: string; url: string } | { op: "close" | "show"; session: string; targetId: string }): Promise<string | undefined> {
  const windows = [...clients].filter((c) => c.data.kind === "app" && !c.data.remote);
  if (!windows.length) return Promise.reject(new Error("bismuth's window isn't open"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(() => reject(new Error("bismuth's window didn't answer"))), 30_000);
    const settle = (fn: () => void) => (clearTimeout(timer), browserAsks.delete(id), fn());
    browserAsks.set(id, { resolve: (t) => settle(() => resolve(t)), reject: (e) => settle(() => reject(e)), left: windows.length });
    for (const c of windows) send(c, { type: "browser", id, ...ask });
  });
}
/** When each thread's run in flight began: its turn's start as the harness reports it, else when the run was first
 *  seen. Every run starts under this core (harness work doesn't outlive it), so it's never a guess. */
const runStarts = new Map<string, number>();
/** A summary (or full thread) as clients see it: with its settlement, how long it's been running, and for a side chat
 *  its parent and its own title. */
const settled = <T extends ThreadSummary>(t: T): T => ({ ...t, ...lineage(t.id), settledAt: settlement.settledAt(t, projects.settleBefore(t.cwd)), runningSince: runStarts.get(t.id) ?? null });
function lineage(id: string): Partial<ThreadSummary> {
  const title = sideChats.title(id);
  return title === undefined ? {} : { parent: sideChats.parent(id), title: title ?? UNTITLED, forked: sideChats.forked(id) };
}

type SocketData = { kind: "app" | "live" | "cdp"; threadId: string | null; id: string; remote: boolean }; // cdp: threadId is the session (core/browser.ts) // id: the window, for queue edits; remote: through remote access
type Client = ServerWebSocket<SocketData>;
const clients = new Set<Client>();
const live = new Set<Client>();
/** The folders each window shows, watched for changes. */
const folders = new FolderWatch();
const send = (ws: Client, msg: ServerMessage) => ws.send(JSON.stringify(msg));
const broadcast = (msg: ServerMessage) => {
  for (const c of clients) send(c, msg);
};
// The message queue: every window sees every thread's queue (it's tiny), so switching threads shows it at once.
const queue = new MessageQueue(ui.STATE);
queue.onChanged = (threadId, sent) =>
  broadcast({ type: "queue", threadId, queue: queue.get(threadId), ...(sent ? { sent: { id: sent.id, text: sent.text, at: Date.now() } } : {}) });
// Project terminals: every window sees the same tabs; output streams to the windows attached to each one.
// The shells live in a host process of their own (one per app, found by the core's port), so a restart keeps them.
const terminals = new Terminals<Client>(join(ui.STATE, `terminals-${PORT || process.pid}.sock`), join(ui.STATE, "terminal-host.log"), send);
terminals.onChanged = () => broadcast({ type: "terminals", terminals: terminals.list() });
// Picked up before serving, so the first hello already lists the shells a restart kept.
await terminals.connect().catch((err) => console.error("[terminals]", err?.message ?? err));

const codex = new CodexAdapter();
const claude = new ClaudeAdapter(ui.STATE);
const cursor = new CursorAdapter(ui.STATE);
const harnesses: Harness[] = [codex, claude, cursor];
const autoCompact = new AutoCompact(ui.STATE);
codex.compactLimit = () => autoCompact.get("codex");
claude.compactWindow = () => autoCompact.get("claude");
const mcp = new McpOverrides(ui.STATE);
for (const h of [claude, codex, cursor]) (h.mcpPlan = (cwd) => mcpPlan(cwd, h.id)), (h.sessionMcp = (cwd, key) => sessionMcp(cwd, h.id, key));
codex.onSessionKey = (key, id) => browser.alias(key, id);
/** A thread as clients see it: settled or not, and where it auto-compacts (its context ring's full mark). */
const decorated = <T extends Omit<Thread, "turns" | "requests">>(t: T): T => ({
  ...settled(t),
  compactAt:
    t.harness === "claude"
      ? claudeCompactAt(autoCompact.get("claude"), t.model, t.contextWindow, t.cwd)
      : t.harness === "codex"
        ? codexCompactAt(codex.appliedLimit(t.id), codex.configLimit, t.contextWindow)
        : null,
});
// Claude and Cursor read their login per run; Codex's app-server holds it, so a switch restarts it when idle.
const accounts = new AgentAccounts(detectConfig(ui.STATE), (store) => cursor.loginArgv(store));
accounts.onLiveChanged = (h) => h === "codex" && codex.restartWhenIdle();
const byId = (id: HarnessId) => harnesses.find((h) => h.id === id)!;
// Each harness starts on its own; one that's missing or broken leaves the others usable.
const status = new Map<HarnessId, { available: boolean; error: string | null }>(harnesses.map((h) => [h.id, { available: false, error: null }]));
let models: ModelOption[] = [];
/** Which harness owns each thread the UI has seen. */
const owner = new Map<string, Harness>();
/** Each thread's folder, as last listed or reported. */
const cwds = new Map<string, string>();

// CLI versions: auto-updates wait until no turn of that provider runs.
const running = new Map<string, HarnessId>(); // threads with a turn in flight
const busy = (id: HarnessId) => [...running.values()].includes(id);
// Threads whose last snapshot still names an active turn. A harness can report a thread idle before the turn itself
// has completed (Codex's status and turn/completed are separate notifications): the queue waits for both.
const activeTurns = new Set<string>();
const turnInFlight = (threadId: string) => running.has(threadId) || activeTurns.has(threadId);
const updates = new HarnessUpdates(ui.STATE, busy);
updates.onChanged = (id) => void harnessReplaced(id);

/** A CLI changed on disk: a running Codex app-server restarts when idle; a harness that was down tries again. */
async function harnessReplaced(id: HarnessId) {
  const h = byId(id);
  if (status.get(id)!.available) {
    if (id === "codex") codex.restartWhenIdle();
    return;
  }
  await startHarness(h);
  for (const c of clients) send(c, { type: "harnesses", harnesses: harnessInfo(), models });
}

const harnessInfo = (): HarnessInfo[] => harnesses.map((h) => ({ id: h.id, name: h.name, ...status.get(h.id)! }));
const startError = () => (harnesses.every((h) => !status.get(h.id)!.available) ? harnesses.map((h) => status.get(h.id)!.error).filter(Boolean).join("\n") || null : null);

for (const h of harnesses) {
  h.onEvent = (threadId, event) => {
    owner.set(threadId, h);
    if (event.type === "thread.upsert") cwds.set(threadId, event.thread.cwd);
    if (event.type === "thread.upsert") {
      if (event.thread.status === "running" || event.thread.status === "waiting") {
        running.set(threadId, h.id);
        if (!runStarts.has(threadId)) runStarts.set(threadId, Date.now());
      } else {
        runStarts.delete(threadId);
        if (running.delete(threadId)) {
          updates.idle(h.id);
          if (restartWhenIdle && !running.size) void restartNow();
        }
      }
      if (event.thread.activeTurnId) activeTurns.add(threadId);
      else activeTurns.delete(threadId);
      // The turn ended (or the thread was idle anyway): the queue's head goes out next.
      if (!turnInFlight(threadId)) void drain(threadId);
    }
    // A failed turn (usage limit, auth, overload) would likely fail the next one too: the queue waits for the user.
    if (event.type === "turn.upsert" && event.turn.status === "failed" && queue.rows(threadId).length)
      queue.setPause(threadId, { reason: "failed", message: event.turn.error });
    if (event.type === "thread.archived") {
      const cwd = cwds.get(threadId);
      if (cwd) void dropSnapshot(cwd, threadId);
      activeTurns.delete(threadId);
      queue.drop(threadId);
      // Its side chats go with it.
      for (const child of sideChats.children(threadId))
        void harnessFor(child)
          .then((ch) => ch.archive(child))
          .catch((err) => console.error(`[side chats] archiving ${child} failed:`, err?.message ?? err));
      sideChats.drop(threadId);
    }
    if (event.type === "turn.upsert" && event.turn.status === "inProgress" && event.turn.startedAt) runStarts.set(threadId, event.turn.startedAt);
    if (event.type === "thread.upsert") event = { ...event, thread: decorated(event.thread) };
    const msg = JSON.stringify({ type: "event", threadId, event } satisfies ServerMessage);
    for (const c of clients) {
      // Thread metadata goes to everyone (sidebar); turn/item/request detail only to viewers.
      if (event.type === "thread.upsert" || event.type === "thread.archived" || c.data.threadId === threadId) c.send(msg);
    }
  };
  h.onExit = (err) => {
    status.set(h.id, { available: false, error: err.message });
    console.error(`[${h.id}] ${err.message}`);
    for (const c of clients) send(c, { type: "error", message: `${h.name}: ${err.message}` });
  };
  h.onUsage = (windows) => accounts.noteLiveUsage(h.id, windows);
}

const startHarness = (h: Harness) =>
  h
    .start()
    .then(async () => {
      status.set(h.id, { available: true, error: null });
      const list = await h.listModels();
      models = [...models.filter((m) => m.harness !== h.id), ...list];
    })
    .catch((err) => {
      status.set(h.id, { available: false, error: String(err?.message ?? err) });
      console.error(`${h.name} failed to start:`, status.get(h.id)!.error);
    });
const ready = Promise.all(harnesses.map(startHarness)).then(() => updates.start());

async function threadList(): Promise<ThreadSummary[]> {
  const lists = await Promise.all(
    harnesses.filter((h) => status.get(h.id)!.available).map((h) =>
      h.listThreads(projects.paths()).catch((err) => {
        console.error(`[${h.id}] listing threads failed:`, err?.message ?? err);
        return [] as ThreadSummary[];
      }),
    ),
  );
  const all = lists.flat().map(settled).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of all) owner.set(t.id, byId(t.harness)), cwds.set(t.id, t.cwd);
  return all;
}

/** The harness that owns a thread; unknown ids are looked up by listing again. */
async function harnessFor(threadId: string): Promise<Harness> {
  if (!owner.has(threadId)) await threadList();
  // A side chat with no turn of its own may not be listed.
  const lone = sideChats.harness(threadId);
  const h = owner.get(threadId) ?? (lone ? byId(lone) : undefined);
  if (!h) throw new Error(`unknown thread ${threadId}`);
  return h;
}

// A project added, renamed or removed: every client gets the new list, and the sessions that come with it.
// The list goes out at once; sessions follow when the harnesses have listed (a resuming Codex thread can hold
// its listing up for seconds).
projects.onChanged = async () => {
  const list = projects.list();
  for (const c of clients) send(c, { type: "projects", projects: list });
  const threads = await threadList().catch(() => null);
  if (threads) for (const c of clients) send(c, { type: "threads", threads });
};

async function handle(ws: Client, msg: ClientMessage) {
  switch (msg.type) {
    case "open": {
      ws.data.threadId = msg.threadId;
      const thread = await (await harnessFor(msg.threadId)).openThread(msg.threadId);
      if (ws.data.threadId === msg.threadId) send(ws, { type: "thread", thread: decorated(thread) });
      return;
    }
    case "send": {
      let threadId = msg.threadId;
      const h = threadId ? await harnessFor(threadId) : byId(msg.settings.harness);
      if (!threadId) {
        if (!status.get(h.id)!.available) throw new Error(`${h.name} is not available${status.get(h.id)!.error ? `: ${status.get(h.id)!.error}` : ""}`);
        const project = msg.projectId ? projects.get(msg.projectId) : null;
        if (!project) throw new Error("Pick a project for the new session first");
        projects.touch(project.id);
        const thread = await h.newThread(msg.settings, project.path);
        owner.set(thread.id, h);
        cwds.set(thread.id, thread.cwd);
        threadId = thread.id;
        ws.data.threadId = threadId;
        send(ws, { type: "thread", thread: decorated(thread) });
      }
      const id = threadId;
      // Under the queue's lock: a prompt typed as the queue sends its head goes after it, not into a race with it.
      // An explicit prompt is the user acting again: a held queue goes on once this turn ends.
      await serially(id, async () => {
        queue.setPause(id, null);
        await sendTurn(h, id, msg.text, msg.settings);
      });
      return;
    }
    case "queue.add":
      await harnessFor(msg.threadId);
      queue.add(msg.threadId, msg.text, msg.settings);
      // Queued just as the turn ended (or nothing was running): it doesn't wait for a turn that never comes.
      void drain(msg.threadId);
      return;
    case "interrupt":
      await interrupt(msg.threadId);
      return;
    case "archive":
      await (await harnessFor(msg.threadId)).archive(msg.threadId);
      return;
    case "respond":
      (await harnessFor(msg.threadId)).respond(msg.requestId, msg.response);
      return;
    case "terminal.attach":
      terminals.attach(String(msg.id), ws, Number(msg.afterSeq) || 0);
      return;
    case "terminal.detach":
      terminals.detach(String(msg.id), ws);
      return;
    case "terminal.input":
      terminals.write(String(msg.id), String(msg.data));
      return;
    case "terminal.resize":
      terminals.resize(String(msg.id), Number(msg.cols), Number(msg.rows));
      return;
    case "rpc": {
      try {
        send(ws, { type: "rpcResult", id: msg.id, result: await rpc(msg.method, msg.params as any, ws) });
      } catch (err: any) {
        send(ws, { type: "rpcResult", id: msg.id, error: String(err?.message ?? err) });
      }
      return;
    }
    // A shared UI setting changed in this window: every other one takes it. A seed (a value the window had before the
    // core held any) only fills a gap, and only from this machine's own windows: the desktop's settings are the ones
    // to keep, not a phone's defaults.
    case "uiState.set": {
      if (typeof msg.key !== "string" || (msg.value !== null && typeof msg.value !== "string")) return;
      if (msg.seed && (ws.data.remote || sharedUi.has(msg.key))) {
        // Turned down: the window takes what the core holds instead, if anything.
        if (sharedUi.has(msg.key)) send(ws, { type: "uiState", key: msg.key, value: sharedUi.all()[msg.key] });
        return;
      }
      if (!sharedUi.set(msg.key, msg.value)) return;
      for (const c of clients) if (c !== ws) send(c, { type: "uiState", key: msg.key, value: msg.value });
      return;
    }
    case "usage.report": {
      const days = [1, 7, 30, 90].includes(msg.days) ? msg.days : 30;
      try {
        send(ws, { type: "usageReport", days, report: await usageReport(days) });
      } catch (err: any) {
        send(ws, { type: "usageReportFailed", days, message: String(err?.message ?? err) });
      }
      return;
    }
  }
}

/** A thread's metadata to every window again, after the core changed what they see of it (a side chat's lineage or
 *  title). */
async function announce(threadId: string) {
  const { turns: _turns, requests: _requests, ...meta } = await (await harnessFor(threadId)).openThread(threadId);
  broadcast({ type: "event", threadId, event: { type: "thread.upsert", thread: decorated(meta) } });
}

/** Send a prompt: a new turn, or a steer into the running one. */
async function sendTurn(h: Harness, threadId: string, text: string, settings: TurnSettings) {
  // A side chat's first prompt names it.
  if (sideChats.named(threadId, titleFrom(text))) await announce(threadId);
  // A new turn wakes a settled session (t3code clears the override on a user message).
  if (settlement.activity(threadId)) broadcast({ type: "settlement", threadId, settledAt: null });
  // A new turn (not a steer): its folder as it stands first, for the turn's changes to show against. A repository
  // that takes long to read doesn't hold the prompt up past a moment.
  if (!turnInFlight(threadId)) await within(snapshotTurn(threadId), SNAPSHOT_WAIT_MS, false);
  await h.send(threadId, text, settings);
}

/** How long a turn waits for its folder's snapshot before it goes anyway. */
const SNAPSHOT_WAIT_MS = 3_000;
async function snapshotTurn(threadId: string): Promise<boolean> {
  const cwd = cwds.get(threadId);
  const ok = !!cwd && (await snapshot(cwd, threadId).catch(() => false));
  if (ok) broadcast({ type: "turnSnapshot", threadId });
  return ok;
}

// ---------------- the message queue ----------------
// Zeron's DocHost::drain_queue: when a thread has no turn in flight (a question waiting on the user counts as one),
// its queue's head goes out as the next turn, one row per turn. Everything that takes from a queue runs one at a time
// per thread (Zeron's drain lock), so a turn-end drain and a Steer can't both send the same row, or two rows at once.

const queueLocks = new Map<string, Promise<unknown>>();
function serially<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const next = (queueLocks.get(threadId) ?? Promise.resolve()).catch(() => {}).then(fn);
  queueLocks.set(threadId, next);
  void next.catch(() => {}).finally(() => queueLocks.get(threadId) === next && queueLocks.delete(threadId));
  return next;
}

/** Send a taken row. If the harness refuses it, it goes back where it was and the queue holds (saying why): the rows
 *  behind it would only fail the same way. */
async function dispatchQueued(threadId: string, row: Row, index: number) {
  try {
    await sendTurn(await harnessFor(threadId), threadId, row.text, row.settings);
  } catch (err: any) {
    const message = String(err?.message ?? err);
    console.error(`[queue] sending to ${threadId} failed:`, message);
    queue.insert(threadId, index, row);
    queue.setPause(threadId, { reason: "error", message });
    throw err;
  }
}

function drain(threadId: string): Promise<void> {
  if (!queue.rows(threadId).length) return Promise.resolve();
  return serially(threadId, async () => {
    // A restart waiting for idle sessions shouldn't watch them start again: the queue keeps (paused) across it.
    if (restartWhenIdle || queue.pause(threadId) || turnInFlight(threadId)) return;
    // An edit or review holds the head, and the rows behind it keep their order.
    const head = queue.rows(threadId)[0];
    if (!head || head.gate) return;
    await dispatchQueued(threadId, queue.take(threadId, head.id)!, 0);
  }).catch(() => {}); // the queue holds and its tray says why
}

/** An explicit Stop: the turn winding down must not release the next queued row (Zeron's interrupt_and_pause_queue). */
async function interrupt(threadId: string) {
  const h = await harnessFor(threadId);
  await serially(threadId, async () => {
    const before = queue.pause(threadId);
    if (turnInFlight(threadId)) queue.setPause(threadId, { reason: "stop", message: null });
    try {
      await h.interrupt(threadId);
    } catch (err) {
      queue.setPause(threadId, before);
      throw err;
    }
  });
}

/** Steer one row in now: into the running turn, or as the next turn when none runs. Never interrupts. A steer that
 *  fails reports to whoever asked; the queue stays as it was. */
function steerQueued(threadId: string, id: string) {
  return serially(threadId, async () => {
    const index = queue.rows(threadId).findIndex((r) => r.id === id);
    if (index < 0) throw new Error("That message was already sent or removed");
    if (queue.rows(threadId)[index].gate) throw new Error("That message is being edited");
    const before = queue.pause(threadId);
    queue.setPause(threadId, null);
    try {
      await dispatchQueued(threadId, queue.take(threadId, id)!, index);
    } catch (err) {
      queue.setPause(threadId, before);
      throw err;
    }
  });
}

async function rpc<M extends keyof RpcMethods>(method: M, params: RpcMethods[M]["params"], ws: Client): Promise<RpcMethods[M]["result"]> {
  const p = params as any;
  const harness = (h: unknown): HarnessId => {
    if (h !== "claude" && h !== "codex" && h !== "cursor") throw new Error(`unknown provider ${h}`);
    return h;
  };
  switch (method) {
    case "accounts.list":
      return accounts.list(!!p.forceUsage);
    case "accounts.activate":
      return accounts.activate(harness(p.harness), String(p.id));
    case "accounts.forget":
      return accounts.forget(harness(p.harness), String(p.id));
    case "accounts.login.start":
      return accounts.startLogin(harness(p.harness));
    case "accounts.login.poll":
      return accounts.pollLogin(String(p.loginId));
    case "accounts.login.complete":
      return accounts.completeLogin(String(p.loginId), String(p.code));
    case "accounts.login.cancel":
      accounts.cancelLogin(String(p.loginId));
      return null;
    case "updates.list":
      return updates.list();
    case "updates.check":
      return updates.checkAll();
    case "updates.apply":
      return updates.apply(harness(p.harness));
    case "updates.policy":
      if (!["notify", "autoWhenIdle", "off"].includes(p.policy)) throw new Error(`unknown policy ${p.policy}`);
      return updates.setPolicy(harness(p.harness), p.policy);
    case "harness.install":
      await updates.install(harness(p.harness));
      return null;
    case "projects.add":
      return projects.add(String(p.path));
    case "projects.rename":
      projects.rename(String(p.id), p.name == null ? null : String(p.name));
      return null;
    case "projects.remove":
      terminals.closeProject(String(p.id));
      projects.remove(String(p.id));
      return null;
    case "terminals.open": {
      const project = projects.get(String(p.projectId));
      if (!project) throw new Error("unknown project");
      return terminals.open(project.id, project.path, Number(p.cols), Number(p.rows));
    }
    case "terminals.close":
      terminals.close(String(p.id));
      return null;
    case "terminals.move":
      terminals.move(String(p.id), Number(p.index));
      return null;
    case "fs.list":
      return listFolder(p.path == null ? null : String(p.path));
    case "files.list":
      return listDirectory(String(p.root), String(p.path ?? ""), !!p.all);
    case "files.read":
      return readFile(String(p.root), String(p.path));
    case "files.search":
      return searchFiles(String(p.root), String(p.query ?? ""), !!p.all);
    case "files.git":
      return gitState(String(p.root), p.since ? String(p.since) : null);
    case "files.base":
      return baseText(String(p.root), String(p.path), p.since ? String(p.since) : null);
    case "files.write":
      return writeFile(String(p.root), String(p.path), String(p.text), p.expect == null ? null : Number(p.expect));
    case "files.create":
      return createEntry(String(p.root), String(p.path), p.kind === "dir" ? "dir" : "file"), null;
    case "files.rename":
      return renameEntry(String(p.root), String(p.from), String(p.to)), null;
    case "files.duplicate":
      return duplicateEntry(String(p.root), String(p.path));
    case "files.trash":
      return trashEntries(String(p.root), (p.paths as unknown[]).map(String), !!p.permanent).then(() => null);
    case "git.changes":
      return changes(String(p.root), p.since ? String(p.since) : null);
    case "git.discard":
      return discard(String(p.root), (p.paths as unknown[]).map(String), p.since ? String(p.since) : null).then(() => null);
    case "git.commit":
      return commit(String(p.root), String(p.message ?? ""), (p.paths as unknown[]).map(String)).then(() => null);
    case "git.pull":
      return pull(String(p.root)).then(() => null);
    case "git.push":
      return push(String(p.root)).then(() => null);
    case "git.sync":
      return sync(String(p.root)).then(() => null);
    case "git.init":
      return init(String(p.root)).then(() => null);
    case "git.log":
      return log(String(p.root), Number(p.skip ?? 0), Number(p.limit ?? 100));
    case "git.commitChanges":
      return commitChanges(String(p.root), String(p.hash));
    case "git.blob":
      return blob(String(p.root), String(p.rev), String(p.path));
    case "files.reveal":
      return revealEntry(String(p.root), String(p.path)).then(() => null);
    case "files.openExternal":
      return openExternal(String(p.root), String(p.path)), null;
    case "files.previewBase":
      return previewBase(String(p.root));
    case "files.resolve":
      return resolveRefs(String(p.root), (p.refs as unknown[]).map(String));
    case "files.watch": {
      const root = String(p.root);
      const dirs = (p.dirs as unknown[]).map(String);
      folders.set(ws.data.id, (r, changed, git) => send(ws, { type: "files.changed", root: r, dirs: changed, git }), root, dirs, dirs.length ? await gitDirOf(root) : null);
      return null;
    }
    case "files.definition":
      return definition(String(p.root), String(p.path), String(p.text), Number(p.line), Number(p.character));
    case "app.restart":
      return restart(p.mode as RestartMode);
    case "autoCompact.get":
      // A busy Codex app-server can be slow to answer: the last read config stands in after a second.
      await within(codex.readConfigLimit(), 1_000, null);
      return autoCompact.snapshot({ configLimit: codex.configLimit, ...codex.configDefault });
    case "autoCompact.set": {
      const h = p.harness === "codex" ? "codex" : p.harness === "claude" ? "claude" : null;
      if (!h) throw new Error(`no auto-compact setting for ${p.harness}`);
      autoCompact.set(h, p.value == null ? null : Number(p.value));
      const reopened = h === "codex" ? codex.reapply() : null;
      // Open sessions re-measure: Claude's next run uses it; Codex's as each reopens (an idle one right away).
      for (const c of clients) {
        const id = c.data.threadId;
        if (!id || owner.get(id)?.id !== h) continue;
        const { turns: _turns, requests: _requests, ...meta } = await owner.get(id)!.openThread(id);
        send(c, { type: "event", threadId: id, event: { type: "thread.upsert", thread: decorated(meta) } });
      }
      return { ...autoCompact.snapshot({ configLimit: codex.configLimit, ...codex.configDefault }), reopened };
    }
    case "browser.owners":
      browser.setOwners((Array.isArray(p.owners) ? p.owners : []).map(([t, s]: [unknown, unknown]) => [String(t), s == null ? null : String(s)]), !!p.all);
      return null;
    case "browser.done": {
      const ask = browserAsks.get(String(p.id));
      if (!ask) return null;
      if (!p.error) ask.resolve(p.targetId ? String(p.targetId) : undefined);
      else if (--ask.left <= 0) ask.reject(new Error(String(p.error)));
      return null;
    }
    case "remote.get":
      return remote.get();
    case "remote.set":
      return remote.set(!!p.enabled);
    case "mcp.list":
      return mcpSnapshot(mcpProject(p.projectId).path);
    case "invocables.list": {
      if (p.threadId) {
        const h = await harnessFor(String(p.threadId));
        const cwd = cwds.get(String(p.threadId)) ?? (await h.openThread(String(p.threadId))).cwd;
        return (await h.invocables?.(cwd)) ?? [];
      }
      const h = byId(harness(p.harness));
      if (!status.get(h.id)!.available) return [];
      return (await h.invocables?.(mcpProject(p.projectId).path)) ?? [];
    }
    case "mcp.set": {
      const project = mcpProject(p.projectId);
      const name = String(p.name);
      const enabled = !!p.enabled;
      const scope = p.scope === "all" ? "all" : "project";
      const hs: HarnessId[] = (Array.isArray(p.harnesses) ? p.harnesses : []).map(harness);
      const listings = await mcpListings(project.path, false);
      const row = mcp.table(project.path, hs, listings, builtins()).find((s) => s.name === name);
      if (!row) throw new Error(`No MCP server named ${name} here`);
      for (const h of hs) {
        const use = row.uses[h];
        if (!use) throw new Error(`No MCP server named ${name} here`);
        if (use.locked) throw new Error(use.locked);
      }
      for (const h of hs) {
        // A dormant definition (a project's .cursor/mcp.json) isn't one the harness runs on its own: its switch is bismuth's.
        const native = listings[h]?.natives.find((n) => n.name === name && !n.dormant);
        // Cursor's own servers switch in Cursor's per-project list: "all" is every project there is now.
        if (native && h === "cursor") for (const cwd of scope === "all" ? projects.paths() : [project.path]) setCursorServer(cwd, name, enabled);
        // A built-in server is on unless switched off.
        else mcp.set(project.path, h, name, enabled, scope, row.from === "bismuth" ? true : (native?.configured ?? false));
      }
      if (hs.includes("codex")) await codex.replanMcp();
      return mcpSnapshot(project.path);
    }
    case "queue.move":
      queue.move(String(p.threadId), String(p.id), Number(p.index));
      void drain(String(p.threadId)); // a new head may be free to go
      return null;
    case "queue.remove":
      // Under the queue's lock, so a removal that succeeded means the row was never sent.
      await serially(String(p.threadId), async () => queue.remove(String(p.threadId), String(p.id)));
      void drain(String(p.threadId));
      return null;
    case "queue.steer":
      await steerQueued(String(p.threadId), String(p.id));
      return null;
    case "queue.resume":
      queue.setPause(String(p.threadId), null);
      void drain(String(p.threadId));
      return null;
    case "queue.edit.begin":
      return serially(String(p.threadId), async () => ({ text: queue.beginEdit(String(p.threadId), String(p.id), ws.data.id).text }));
    case "queue.edit.finish":
      queue.finishEdit(String(p.threadId), String(p.id), ws.data.id, p.text == null ? null : String(p.text), p.settings ?? null);
      void drain(String(p.threadId));
      return null;
    case "projects.settleAll": {
      const project = projects.get(String(p.id));
      if (!project) throw new Error(`unknown project ${p.id}`);
      projects.settleAll(project.id);
      const before = await threadList();
      settlement.clearActive(before.filter((t) => t.cwd === project.path).map((t) => t.id));
      broadcast({ type: "threads", threads: await threadList() });
      return null;
    }
    case "threads.fork": {
      const parent = String(p.id);
      const h = await harnessFor(parent);
      const thread = await h.fork(parent);
      owner.set(thread.id, h);
      cwds.set(thread.id, thread.cwd);
      // Titled as it is now, should it be gone later (one the harness hasn't named goes by its first prompt).
      const from = await h.openThread(parent);
      const named = settled(summary(from)).title;
      const prompt = from.turns.flatMap((t) => t.items).find((i) => i.kind === "user")?.text ?? "";
      sideChats.add(thread.id, parent, h.id, { from: parent, title: named === UNTITLED ? titleFrom(prompt) || UNTITLED : named, turns: thread.turns.length });
      await announce(thread.id);
      return settled(summary(thread));
    }
    case "threads.promote": {
      const id = String(p.id);
      sideChats.promote(id);
      await announce(id);
      return null;
    }
    case "threads.settle": {
      const id = String(p.id);
      broadcast({ type: "settlement", threadId: id, settledAt: settlement.set(id, !!p.settled) });
      return null;
    }
  }
  throw new Error(`unknown method ${method}`);
}

// ---------------- token usage ----------------

// Scanning ~1 GB of transcripts runs off the event loop. One worker for the core's lifetime keeps each file's
// parse position, so a warm report only reads what was appended since.
const usageWorker = new Worker(new URL("./usage-worker.ts", import.meta.url).href);
usageWorker.postMessage({ type: "init", stateDir: ui.STATE });
let usageSeq = 0;
const usageWaiting = new Map<number, { resolve: (r: UsageReport) => void; reject: (e: Error) => void }>();
usageWorker.onmessage = (e: MessageEvent) => {
  const w = usageWaiting.get(e.data.id);
  if (!w) return;
  usageWaiting.delete(e.data.id);
  if (e.data.error) w.reject(new Error(e.data.error));
  else w.resolve(e.data.report);
};
function mcpProject(id: unknown) {
  const project = projects.get(String(id));
  if (!project) throw new Error("That project is gone");
  return project;
}

/** Every harness's own MCP servers for a project folder (a harness that isn't installed can still define ones the
 *  others take); `live`: with how they're doing. A busy Codex app-server that doesn't answer in time leaves Codex's
 *  out rather than holding up the rest. */
async function mcpListings(cwd: string, live: boolean): Promise<Partial<Record<HarnessId, McpListing>>> {
  const fromCodex = status.get("codex")!.available ? await within(codex.mcpListing(cwd, live).catch(() => null), 5_000, null) : null;
  return { claude: claude.mcpListing(cwd), ...(fromCodex ? { codex: fromCodex } : {}), cursor: cursorListing(cwd) };
}

async function mcpSnapshot(cwd: string): Promise<McpSnapshot> {
  const available = harnesses.filter((h) => status.get(h.id)!.available).map((h) => h.id);
  return { harnesses: available, servers: mcp.table(cwd, available, await mcpListings(cwd, true), builtins()) };
}

/** bismuth's own servers, listed first in MCP servers and on unless switched off there: the browser's only where
 *  there's one to drive (the desktop app). */
const builtins = (): McpBuiltin[] => [
  { name: VIEW_SERVER, title: "bismuth inline preview", source: "Built into bismuth", target: "render: views made with the project's own frontend, shown in the conversation" },
  ...(browser.available ? [{ name: BROWSER_SERVER, title: "bismuth browser", source: "Built into bismuth · Chrome DevTools MCP", target: "The browser tabs beside the chat: read, click, type, screenshots, console, network" }] : []),
];

/** What a harness's runs in a project get (without a switch for it there, nothing to read), and bismuth's own server
 *  for views (core/views.ts) unless it's switched off. */
async function mcpPlan(cwd: string, h: HarnessId): Promise<McpPlan> {
  const plan: McpPlan = Object.keys(mcp.get(cwd, h)).length ? mcp.plan(cwd, h, await mcpListings(cwd, false)) : { off: [], on: [], add: {} };
  return mcp.builtinOn(cwd, h, VIEW_SERVER) ? { ...plan, add: { ...plan.add, [VIEW_SERVER]: views.server(cwd) } } : plan;
}

/** The servers a session's runs get of their own: the browser's, its session's tabs (core/browser.ts). */
function sessionMcp(cwd: string, h: HarnessId, key: string): Record<string, McpDef> {
  return browser.available && mcp.builtinOn(cwd, h, BROWSER_SERVER) ? { [BROWSER_SERVER]: browser.server(cwd, key) } : {};
}

function usageReport(days: number): Promise<UsageReport> {
  const id = ++usageSeq;
  return new Promise((resolve, reject) => {
    usageWaiting.set(id, { resolve, reject });
    usageWorker.postMessage({ type: "report", id, days });
  });
}

// ---------------- restart ----------------
// Restart bismuth (the command palette): the desktop shell starts the core again on the same port when it exits with
// RESTART_CODE, and the window reconnects into the new build. The code it would start with is checked first, so a
// broken core is refused here instead of leaving the app without one.
const RESTART_CODE = 75;
let restartWhenIdle = false;

/** Why the core as it is on disk wouldn't start, or null: a typecheck, then bundling the core (unresolvable
 *  imports, syntax the runtime rejects). */
async function restartCheck(): Promise<string | null> {
  const tsc = Bun.spawn([join(ui.ROOT, "node_modules", ".bin", "tsc"), "--noEmit", "--pretty", "false"], { cwd: ui.ROOT, stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(tsc.stdout).text()) + (await new Response(tsc.stderr).text());
  if ((await tsc.exited) !== 0) return `Typecheck failed:\n${out.trim()}`;
  const bundle = await Bun.build({ entrypoints: [join(ui.ROOT, "core", "main.ts"), join(ui.ROOT, "core", "terminal-host.ts")], target: "bun", throw: false });
  if (!bundle.success) return `The core doesn't build:\n${bundle.logs.map(String).join("\n")}`;
  return null;
}

async function restart(mode: RestartMode): Promise<RestartResult> {
  if (mode === "cancel") {
    const was = restartWhenIdle;
    restartWhenIdle = false;
    if (was) broadcast({ type: "restart", state: "cancelled", running: running.size, error: null });
    // Queues held back for the restart go on.
    for (const id of Object.keys(queue.all())) void drain(id);
    return { running: running.size, state: "cancelled" };
  }
  if (!process.env.BISMUTH_DESKTOP) throw new Error("Restarting needs the desktop app (bun run app); restart `bun start` yourself.");
  const problem = await restartCheck();
  if (problem) throw new Error(problem);
  if (running.size && mode !== "now") {
    if (mode === "ifIdle") return { running: running.size, state: "running" };
    restartWhenIdle = true;
    broadcast({ type: "restart", state: "scheduled", running: running.size, error: null });
    return { running: running.size, state: "scheduled" };
  }
  exitForRestart();
  return { running: running.size, state: "restarting" };
}

/** The wait ended: check again (the code may have changed meanwhile), then go. */
async function restartNow() {
  restartWhenIdle = false;
  const problem = await restartCheck();
  if (problem) return broadcast({ type: "restart", state: "failed", running: 0, error: problem });
  exitForRestart();
}

function exitForRestart() {
  broadcast({ type: "restart", state: "restarting", running: running.size, error: null });
  terminals.keep(); // the shells wait for the next core
  // Let the answer and the notice reach the window first.
  setTimeout(() => process.exit(RESTART_CODE), 150);
}

// ---------------- UI builds ----------------
// Start from a fresh build of the source; if that's broken, fall back to the last build that was applied.
const coreFingerprint = ui.fingerprint(ui.CORE_PATHS);
let build: ui.BuildMeta | null = null;
{
  const res = await ui.buildUI();
  if (res.ok) build = res.meta;
  else {
    build = ui.readCurrent();
    console.error(`UI build failed${build ? `, serving last applied build ${build.id}` : ""}:\n${res.error}`);
  }
  if (build) ui.writeCurrent(build.id);
}

function activate(id: string) {
  const meta = ui.readBuild(id);
  if (!meta) throw new Error(`no such build: ${id}`);
  build = meta;
  ui.writeCurrent(id);
  for (const c of live) c.send(JSON.stringify({ type: "reload", build: id }));
  ui.pruneBuilds([id]);
  return live.size;
}

async function serveBuild(id: string, path: string, inject: boolean): Promise<Response> {
  const file = ui.buildFile(id, path);
  if (!file) return new Response("not found", { status: 404 });
  if (inject && file.endsWith(".html")) {
    return new Response(sharedUi.inject(injectLiveClient(await Bun.file(file).text(), id)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(Bun.file(file));
}

// ---------------- HTML previews ----------------
// A preview is the file's text in a sandboxed frame (scripts run, with an origin of its own and no way to connect
// anywhere); its relative URLs resolve under /preview/<signature>/<folder>/, which serves that folder's files.
const previewKey = randomBytes(32);
const sign = (root: string) => createHmac("sha256", previewKey).update(root).digest("hex").slice(0, 32);

function previewBase(root: string): string {
  return `/preview/${sign(root)}/${Buffer.from(root).toString("base64url")}/`;
}

function servePreview(signature: string, encoded: string, rel: string): Response {
  const root = Buffer.from(encoded, "base64url").toString();
  if (signature !== sign(root)) return new Response("forbidden", { status: 403 });
  try {
    const file = Bun.file(previewFile(root, rel));
    const headers: Record<string, string> = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    // A page the preview opens in a frame of its own gets the same sandbox.
    if (/\.html?$/i.test(rel)) headers["content-security-policy"] = "sandbox allow-scripts; connect-src 'none'; form-action 'none'";
    return new Response(file, { headers });
  } catch {
    return new Response("none", { status: 404 });
  }
}

// ---------------- control API for `bun run apply` ----------------
const token = randomBytes(24).toString("hex");
/** `p`, or `fallback` if it hasn't settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
const json = (body: unknown, status = 200) => Response.json(body, { status });
/** Files `apply` changed that need this core restarted (null: nothing pending). */
let restartNeeded: string[] | null = null;

async function control(req: Request, path: string): Promise<Response> {
  if (req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
  if (path === "/_bismuth/status" && req.method === "GET") {
    // Answer promptly even while a harness is starting or stalled (a resuming Codex thread can hold listing up for
    // longer than the connection lives): the threads only pick what the smoke test opens, and none is fine.
    const threads = await within(ready.then(threadList), 3_000, []).catch(() => []);
    return json({ pid: process.pid, build, core: coreFingerprint, threads: threads.map((t) => ({ id: t.id, loaded: t.status !== "notLoaded" })) } satisfies ui.CoreStatus);
  }
  // `bun run apply` changed code this core only loads on restart: every window is told, now and when it connects.
  if (path === "/_bismuth/restart-needed" && req.method === "POST") {
    const { files } = (await req.json()) as { files: string[] };
    restartNeeded = files.map(String);
    broadcast({ type: "restartNeeded", files: restartNeeded });
    return json({ ok: true });
  }
  if (path === "/_bismuth/activate" && req.method === "POST") {
    const { id } = (await req.json()) as { id: string };
    try {
      return json({ ok: true, reloaded: activate(id) });
    } catch (err: any) {
      return json({ error: err.message }, 400);
    }
  }
  return json({ error: "not found" }, 404);
}

const remote = new RemoteAccessControl(() => server.port!);

const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", // no auth on the app socket: never listen beyond localhost (remote access goes through `tailscale serve`)
  port: PORT,
  async fetch(req, srv) {
    const path = new URL(req.url).pathname;
    // Requests name this machine's own address, or come through remote access from its owner. Any other name is a
    // page that rebound its domain to localhost.
    const host = req.headers.get("host");
    const away = host !== `127.0.0.1:${srv.port}` && host !== `localhost:${srv.port}`;
    if (away && !(await remote.admits(host, req.headers.get("tailscale-user-login")))) return new Response("forbidden", { status: 403 });
    // Only this app's own pages talk to the core: any other page (a site in a browser, an HTML preview's sandboxed
    // frame, whose origin is "null") is turned away before it can drive a session.
    const origin = req.headers.get("origin");
    if ((path === "/ws" || path === "/_bismuth/live") && origin !== `http://${host}` && origin !== `https://${host}`) return new Response("forbidden", { status: 403 });
    if (path === "/ws" && srv.upgrade(req, { data: { kind: "app", threadId: null, id: randomUUID(), remote: away } })) return;
    // The browser agents drive (core/browser.ts): Chrome DevTools MCP's socket, from this machine only.
    const cdpSession = path.startsWith("/cdp/") && !away ? browser.admits(req, path) : null;
    if (cdpSession && srv.upgrade(req, { data: { kind: "cdp", threadId: cdpSession, id: randomUUID(), remote: false } })) return;
    if (path === "/_bismuth/live" && srv.upgrade(req, { data: { kind: "live", threadId: null, id: randomUUID(), remote: away } })) return;
    // Candidate builds are served un-injected so `apply` can smoke-test them without them ever being told to reload.
    const preview = path.match(/^\/_bismuth\/preview\/([\w-]+)(\/.*)?$/);
    if (preview) return serveBuild(preview[1], preview[2] ?? "/", false);
    if (path.startsWith("/_bismuth/")) return control(req, path);
    if (path === "/project-icon") {
      const icon = projects.iconPath(new URL(req.url).searchParams.get("id") ?? "");
      return icon ? new Response(Bun.file(icon)) : new Response("none", { status: 404 });
    }
    // Composer attachments. The custom header forces a CORS preflight (never answered), so other pages can't upload.
    if (path === "/upload" && req.method === "POST") {
      if (req.headers.get("x-bismuth-upload") !== "1") return json({ error: "forbidden" }, 403);
      if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) return json({ error: "Too large (24 MB max)." }, 413);
      const name = new URL(req.url).searchParams.get("name") || "image";
      try {
        return json({ path: uploads.save(name, new Uint8Array(await req.arrayBuffer())) });
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }
    }
    // A file's bytes for the viewer (a PDF): only to this app's own pages, which name the folder and path.
    if (path === "/file") {
      if (req.headers.get("sec-fetch-site") !== "same-origin") return new Response("forbidden", { status: 403 });
      const q = new URL(req.url).searchParams;
      try {
        const { abs, type } = rawFile(q.get("root") ?? "", q.get("path") ?? "");
        return new Response(Bun.file(abs), { headers: { "content-type": type, "cache-control": "no-store" } });
      } catch {
        return new Response("none", { status: 404 });
      }
    }
    // What an HTML preview loads beside it, under a base only the app hands out (signed per folder).
    const view = path.match(/^\/preview\/([0-9a-f]{32})\/([\w-]+)\/(.*)$/);
    if (view) return servePreview(view[1], view[2], decodeURIComponent(view[3]));
    // Views agents render (core/views.ts): their MCP server, and the pages a transcript frames.
    if (path.startsWith("/mcp/") || path.startsWith("/view/")) {
      const res = views.handle(req, path);
      if (res) return res;
    }
    if (path === "/attachment") {
      const hit = uploads.read(new URL(req.url).searchParams.get("path") ?? "");
      return hit ? new Response(Bun.file(hit.file), { headers: { "content-type": hit.type, "cache-control": "max-age=31536000, immutable" } }) : new Response("none", { status: 404 });
    }
    if (!build) return new Response("bismuth: no UI build available — fix web/ and run `bun run apply`", { status: 503 });
    return serveBuild(build.id, path, true);
  },
  websocket: {
    async open(ws) {
      if (ws.data.kind === "cdp") return browser.open(ws, ws.data.threadId!);
      if (ws.data.kind === "live") {
        // A page that missed a reload (its socket was down when the build switched) catches up on reconnect.
        live.add(ws);
        if (build) ws.send(JSON.stringify({ type: "build", build: build.id }));
        return;
      }
      if (process.env.DEBUG) console.log("[ws] open");
      clients.add(ws);
      await ready;
      send(ws, {
        type: "hello",
        device: hostname(),
        home: HOME,
        projects: projects.list(),
        launch,
        harnesses: harnessInfo(),
        models,
        threads: await threadList().catch(() => []),
        queues: queue.all(),
        uiState: sharedUi.all(),
        ready: !startError(),
        error: startError(),
      });
      send(ws, { type: "terminals", terminals: terminals.list() });
      send(ws, { type: "browserAwake", targets: browser.awake() });
      if (restartNeeded) send(ws, { type: "restartNeeded", files: restartNeeded });
    },
    async message(ws, raw) {
      if (ws.data.kind === "cdp") return browser.message(ws, raw);
      if (ws.data.kind === "live") return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (process.env.DEBUG) console.log("[ws <-]", JSON.stringify(msg).slice(0, 200));
      try {
        await handle(ws, msg);
      } catch (err: any) {
        console.error(`[${msg.type}]`, err);
        send(ws, { type: "error", message: String(err?.message ?? err) });
      }
    },
    close(ws, code) {
      if (ws.data.kind === "cdp") return browser.close(ws);
      if (process.env.DEBUG) console.log("[ws] close", ws.data.kind, code);
      clients.delete(ws);
      live.delete(ws);
      if (ws.data.kind === "app") queue.release(ws.data.id), folders.drop(ws.data.id);
      terminals.detachAll(ws);
    },
  },
});

// Register so `bun run apply` can find this core; the token keeps other local web pages off the control API.
const registry = join(ui.CORES, `${process.pid}.json`);
mkdirSync(ui.CORES, { recursive: true });
writeFileSync(registry, JSON.stringify({ pid: process.pid, port: server.port!, token, cwd: process.argv[2] ?? HOME, startedAt: Date.now() } satisfies ui.CoreInfo), { mode: 0o600 });
process.on("exit", () => {
  rmSync(registry, { force: true });
  updates.stop();
  terminals.shutdown();
  accounts.shutdown(); // no orphan `codex login` holding its loopback port into the next run
  claude.shutdown(); // nor an idle `claude` holding a background dev server
  killLanguageServers();
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));

console.log(`bismuth (${projects.paths().length} projects)\nopen http://${server.hostname}:${server.port}`);

// Under the desktop shell, stdin is a pipe from Electron: when it closes (app quit or crash), shut down too.
if (process.env.BISMUTH_DESKTOP) {
  void (async () => {
    for await (const _ of Bun.stdin.stream());
    process.exit(0);
  })();
}
