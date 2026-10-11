// Claude Code adapter, after Zeron's harness (crates/harness/src/claude): each turn runs the installed `claude`
// CLI speaking stream-json over stdio — no SDK or adapter process in between.
//
// - A turn runs in one CLI process: the prompt is its first stdin line, `--session-id` names a new session and
//   `--resume` continues one. The CLI's own `result` frame ends the turn; stdin then closes and the CLI exits
//   (unless background tasks keep it up, below).
// - Steering writes another user line mid-run (`priority: "now"`, or "next" while a tool runs so it isn't
//   aborted); the CLI folds it in at its next step and replays it, which is when it joins the transcript.
// - Background tasks outlive the `result` of the turn that started them, and the CLI follows up on each one
//   that ends with a turn of its own. Subagents are the turn's own work, so it stays open until they report.
//   Shells (dev servers, watchers) only keep the process up: their follow-ups reopen the last turn, and a new
//   prompt starts its turn in that same process, since a second one resuming the session would fork it.
// - Permissions are bypassed. `--permission-prompt-tool stdio` (undocumented, the Agent SDK's transport)
//   still routes `can_use_tool` control requests here: every tool is allowed, and AskUserQuestion becomes a
//   question card whose answers go back in the tool's input.
// - Interrupt sends the protocol's interrupt request (which also stops subagents), then escalates to SIGTERM
//   and SIGKILL.
// - Sessions are listed and replayed from the CLI's own transcripts (~/.claude/projects/<cwd>/<id>.jsonl),
//   so sessions started in a terminal show up here too.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { finalizeItem, mergeItem, summary, titleFrom, UNTITLED, type Harness } from "./harness";
import { claudeListing, claudeStatus, toClaude, type ClaudeSeen, type McpListing, type McpPlan } from "./mcp";
import type {
  FileChange,
  Item,
  ItemStatus,
  McpStatus,
  ModelOption,
  PlanStep,
  RequestResponse,
  RuntimeRequest,
  Thread,
  ThreadEvent,
  ThreadSummary,
  Turn,
  TurnSettings,
  TurnStatus,
  UsageWindow,
} from "../shared/model";

const CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const INTERRUPT_GRACE_MS = 2000;
const KILL_GRACE_MS = 3000;
/** How long the CLI must stay quiet before a held turn end, or an idle process, is taken as final. */
const QUIET_MS = 5000;
const HISTORY_TURNS = 50;
/** A run whose transcript gains entries this long after its last stdout frame has lost its output (watch()). */
const STALL_MS = 30_000;
/** How often a running turn's transcript is checked against its output, and followed once that's lost. */
const WATCH_MS = 10_000;
/** Where watch() looks for the transcript's latest entry. */
const WATCH_TAIL_BYTES = 1024 * 1024;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;

/** The installed CLI: CLAUDE_CODE_EXECUTABLE, PATH, then the installer's usual homes. */
function findClaude(): string | null {
  const override = process.env.CLAUDE_CODE_EXECUTABLE;
  if (override) return existsSync(override) ? override : null;
  const home = homedir();
  return (
    Bun.which("claude") ??
    [join(home, ".claude", "local", "claude"), join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => existsSync(p)) ??
    null
  );
}

/** What a run's CLI was started with; a turn in a live process switches the ones it changes. */
type Flags = { model: string | null; effort: string | null; fast: boolean };

type Run = {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  threadId: string;
  /** The MCP servers it was started with, beyond Claude's own config. */
  mcp: McpPlan;
  /** The turn frames land in: the latest prompt's, reopened when the CLI follows up on its own. */
  turnId: string;
  flags: Flags;
  /** The streamed assistant message and its content blocks (stream index -> item id). */
  messageId: string | null;
  blocks: Map<number, string>;
  lastIndex: number;
  openTools: Set<string>;
  toolStarts: Map<string, number>;
  /** Steers written to stdin that the CLI hasn't replayed yet. */
  pendingSteers: Set<string>;
  /** Background tasks the CLI is running: subagents, whose reports the turn waits for, and shells. */
  agents: number;
  shells: number;
  /** Backgrounded calls -> their turn: the call returns at once, its item runs until the task ends. */
  background: Map<string, string>;
  interrupted: boolean;
  /** The turn is over; the process may live on for background shells. */
  finished: boolean;
  /** stdin ended: the CLI exits once nothing is left to follow up on. */
  closed: boolean;
  /** A `result` that may not end the turn yet, and the timer that takes it as final once the CLI goes quiet. */
  heldResult: any;
  held: ReturnType<typeof setTimeout> | null;
  /** Interrupt escalation and idle shutdown: void once the turn ends or another starts. */
  timers: ReturnType<typeof setTimeout>[];
  error: string | null;
  stderr: string[];
  model: string | null;
  /** When stdout last gave a frame; `lost`: it stopped while the CLI went on (its transcript is followed instead). */
  lastFrameAt: number;
  lost: boolean;
  watch: ReturnType<typeof setInterval> | null;
  following: boolean;
};

type PendingRequest = { threadId: string; request: RuntimeRequest; resolve: (response: RequestResponse) => void };

type Listed = { mtime: number; size: number; summary: ThreadSummary | null };

export class ClaudeAdapter implements Harness {
  readonly id = "claude" as const;
  readonly name = "Claude Code";
  onEvent: (threadId: string, event: ThreadEvent) => void = () => {};
  onExit: (err: Error) => void = () => {};
  onUsage: (windows: UsageWindow[]) => void = () => {};

  private exe: string | null = null;
  /** bismuth's auto-compact window (Settings → Providers), passed to every run; null follows Claude's own settings. */
  compactWindow: () => number | null = () => null;
  /** What runs in a project get of the MCP servers (Ctrl+K → MCP servers): Claude's own ones switched off are denied
   *  to the run, ones another harness defines are passed in. */
  mcpPlan: (cwd: string) => Promise<McpPlan> = async () => ({ off: [], on: [], add: {} });
  /** Each project's MCP servers as its last run reported them (names a config file doesn't hold: plugins,
   *  connectors). */
  private mcpSeen: Record<string, Record<string, ClaudeSeen>>;
  private threads = new Map<string, Thread>();
  /** Sessions the CLI has a transcript for: later turns `--resume` them instead of naming a new one. */
  private onDisk = new Set<string>();
  private runs = new Map<string, Run>();
  private pending = new Map<string, PendingRequest>();
  private listed = new Map<string, Listed>();
  private archived: Set<string>;
  /** Context windows the CLI reported per model (a transcript doesn't record them). */
  private windowsByModel: Record<string, number>;
  private models: ModelOption[] = [];

  /** Which project folder each listed session lives in (its transcript sits under that folder's dir). */
  private where = new Map<string, string>();

  constructor(private stateDir: string) {
    this.archived = new Set(readJson<string[]>(join(stateDir, "claude-archived.json")) ?? []);
    this.windowsByModel = readJson<Record<string, number>>(join(stateDir, "claude-context-windows.json")) ?? {};
    const seen = readJson<Record<string, Record<string, ClaudeSeen | McpStatus | null>>>(join(stateDir, "claude-mcp-seen.json")) ?? {};
    // An earlier build kept the bare status.
    this.mcpSeen = Object.fromEntries(Object.entries(seen).map(([cwd, servers]) => [cwd, Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, s && typeof s === "object" ? s : { status: s, carried: false }]))]));
  }

  /** Its servers for a project (Ctrl+K → MCP servers). */
  mcpListing = (cwd: string): McpListing => claudeListing(cwd, this.mcpSeen[cwd] ?? {});

  /** A run's init named the servers it loaded. Its own ones it didn't because bismuth denied them stay listed. */
  private sawMcp(run: Run, servers: unknown) {
    const cwd = this.threads.get(run.threadId)?.cwd;
    if (!cwd || !Array.isArray(servers)) return;
    const kept = Object.entries(this.mcpSeen[cwd] ?? {}).filter(([name, s]) => !s.carried && run.mcp.off.includes(name)).map(([name]) => [name, { status: null, carried: false }] as const);
    const reported = servers
      .filter((s) => typeof s?.name === "string")
      .map((s) => [s.name as string, { status: claudeStatus(s.status), carried: s.name in run.mcp.add }] as const);
    this.mcpSeen[cwd] = Object.fromEntries([...kept, ...reported]);
    writeFileSync(join(this.stateDir, "claude-mcp-seen.json"), JSON.stringify(this.mcpSeen));
  }


  async start() {
    this.exe = findClaude();
    if (!this.exe) throw new Error("Claude Code is not installed (no `claude` on PATH; set CLAUDE_CODE_EXECUTABLE to point at it)");
    // One `initialize` handshake (no model turn) reports the account and the models this login can use.
    const init = await this.initialize().catch((err) => {
      console.warn("[claude] initialize failed:", err.message);
      return null;
    });
    this.models = toModels(init?.models ?? []);
  }

  private async initialize(): Promise<any> {
    const proc = Bun.spawn([this.exe!, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
      cwd: homedir(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(JSON.stringify({ type: "control_request", request_id: "bismuth-init", request: { subtype: "initialize" } }) + "\n");
    proc.stdin.flush();
    const timeout = setTimeout(() => proc.kill(), 15_000);
    try {
      for await (const line of lines(proc.stdout)) {
        const frame = parse(line);
        if (frame?.type !== "control_response" || frame.response?.request_id !== "bismuth-init") continue;
        if (frame.response.subtype === "error") throw new Error(frame.response.error ?? "initialize failed");
        return frame.response.response;
      }
      throw new Error("claude exited before answering initialize");
    } finally {
      clearTimeout(timeout);
      proc.kill();
    }
  }

  // ---------------- queries ----------------

  async listModels(): Promise<ModelOption[]> {
    return this.models;
  }

  async listThreads(cwds: string[]): Promise<ThreadSummary[]> {
    const all: ThreadSummary[] = [];
    for (const cwd of cwds) {
      const dir = projectDir(cwd);
      const out = new Map<string, ThreadSummary>();
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          const id = name.slice(0, -6);
          if (this.archived.has(id)) continue;
          const path = join(dir, name);
          let st;
          try {
            st = statSync(path);
          } catch {
            continue;
          }
          let entry = this.listed.get(id);
          if (!entry || entry.mtime !== st.mtimeMs || entry.size !== st.size) {
            entry = { mtime: st.mtimeMs, size: st.size, summary: peekSession(id, path, st.size, st.mtimeMs, cwd) };
            this.listed.set(id, entry);
          }
          this.where.set(id, cwd);
          if (entry.summary) out.set(id, entry.summary);
        }
      }
      // Loaded threads are fresher than their transcripts (and new ones may have none yet).
      for (const t of this.threads.values()) if (t.cwd === cwd && !this.archived.has(t.id) && (t.turns.length || out.has(t.id))) out.set(t.id, summary(t));
      all.push(...[...out.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50));
    }
    return all;
  }

  openThread(threadId: string): Promise<Thread> {
    const loaded = this.threads.get(threadId);
    if (loaded) return Promise.resolve(loaded);
    return this.loadThread(threadId);
  }

  private async loadThread(threadId: string): Promise<Thread> {
    const cwd = this.where.get(threadId);
    const path = cwd ? join(projectDir(cwd), `${threadId}.jsonl`) : null;
    if (!cwd || !path || !existsSync(path)) throw new Error(`no Claude Code session ${threadId} in a project`);
    const history = await readHistory(path);
    const st = statSync(path);
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const thread: Thread = {
      id: threadId,
      harness: "claude",
      title: history.title ?? UNTITLED,
      updatedAt: st.mtimeMs,
      createdAt: history.createdAt ?? st.mtimeMs,
      status: "idle",
      branch: history.branch,
      cwd,
      model: history.model,
      effort: null,
      serviceTier: null,
      activeTurnId: null,
      turns: history.turns.slice(-HISTORY_TURNS),
      requests: [],
      plan: null,
      contextTokens: history.contextTokens,
      contextWindow: history.model ? (this.windowsByModel[history.model] ?? null) : null,
      notice: null,
    };
    this.threads.set(threadId, thread);
    this.onDisk.add(threadId);
    return thread;
  }

  // ---------------- commands ----------------

  async newThread(settings: TurnSettings, cwd: string): Promise<Thread> {
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      harness: "claude",
      title: UNTITLED,
      updatedAt: now,
      createdAt: now,
      status: "idle",
      branch: gitBranch(cwd),
      cwd,
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      activeTurnId: null,
      turns: [],
      requests: [],
      plan: null,
      contextTokens: null,
      contextWindow: null,
      notice: null,
    };
    this.threads.set(thread.id, thread);
    this.emitThread(thread);
    return thread;
  }

  async send(threadId: string, text: string, settings: TurnSettings) {
    const thread = await this.openThread(threadId);
    // Asked before anything else, so nothing else can start a run for the thread in between.
    const mcp = await this.mcpPlan(thread.cwd).catch(() => ({ off: [], on: [], add: {} }));
    const live = this.runs.get(threadId);
    if (live && !live.finished && !live.closed) {
      // Steer: `now` cuts in at once, but would abort a running tool, so wait for it instead.
      const uuid = randomUUID();
      live.pendingSteers.add(uuid);
      this.write(live, { type: "user", uuid, priority: live.openTools.size ? "next" : "now", message: { role: "user", content: text }, parent_tool_use_id: null });
      return;
    }

    thread.model = settings.model ?? thread.model;
    thread.effort = settings.effort;
    thread.serviceTier = settings.serviceTier;
    const flags: Flags = { model: thread.model, effort: settings.effort, fast: settings.serviceTier === "fast" };
    let run: Run;
    if (live && !live.closed) {
      // The last turn's process is up for its background shells: this turn runs in it too.
      run = live;
      this.reflag(run, flags);
    } else run = this.spawn(thread, flags, mcp);

    const turn: Turn = { id: randomUUID(), status: "inProgress", error: null, durationMs: null, startedAt: Date.now(), completedAt: null, items: [] };
    thread.turns.push(turn);
    this.activate(run, thread, turn);
    this.write(run, { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  private spawn(thread: Thread, flags: Flags, mcp: McpPlan): Run {
    if (!this.exe) throw new Error("Claude Code is not available");
    // Servers carried over from another harness go in a file only this user can read: they can hold credentials.
    const mcpFile = join(this.stateDir, "claude-mcp", `${thread.id}.json`);
    if (Object.keys(mcp.add).length) {
      mkdirSync(join(this.stateDir, "claude-mcp"), { recursive: true, mode: 0o700 });
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(mcp.add).map(([name, def]) => [name, toClaude(def)])) }), { mode: 0o600 });
    } else rmSync(mcpFile, { force: true });
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose", // required with --print + stream-json output
      "--include-partial-messages",
      "--replay-user-messages",
      // Newer models emit no readable thinking unless a summary is asked for.
      "--thinking-display", "summarized",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", "bypassPermissions",
      "--dangerously-skip-permissions",
      ...(this.onDisk.has(thread.id) ? ["--resume", thread.id] : ["--session-id", thread.id]),
      ...(flags.model ? ["--model", flags.model] : []),
      ...(flags.effort ? ["--effort", flags.effort] : []),
      ...runSettings(flags.fast, this.compactWindow(), mcp.off),
      ...(Object.keys(mcp.add).length ? ["--mcp-config", mcpFile] : []),
    ];
    const run: Run = {
      proc: Bun.spawn([this.exe, ...args], { cwd: thread.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
      threadId: thread.id,
      mcp,
      turnId: "",
      flags,
      messageId: null,
      blocks: new Map(),
      lastIndex: -1,
      openTools: new Set(),
      toolStarts: new Map(),
      pendingSteers: new Set(),
      agents: 0,
      shells: 0,
      background: new Map(),
      interrupted: false,
      finished: false,
      closed: false,
      heldResult: null,
      held: null,
      timers: [],
      error: null,
      stderr: [],
      model: flags.model,
      lastFrameAt: Date.now(),
      lost: false,
      watch: null,
      following: false,
    };
    run.watch = setInterval(() => void this.watch(run), WATCH_MS);
    this.runs.set(thread.id, run);
    void this.pump(run);
    return run;
  }

  /** A live process keeps the flags it started with: switch the ones this turn changes. */
  private reflag(run: Run, flags: Flags) {
    const settings = {
      ...(flags.model && flags.model !== run.flags.model ? { model: flags.model } : {}),
      ...(flags.effort && flags.effort !== run.flags.effort ? { effortLevel: flags.effort } : {}),
      ...(flags.fast !== run.flags.fast ? { fastMode: flags.fast } : {}),
    };
    run.flags = flags;
    if (Object.keys(settings).length) this.write(run, { type: "control_request", request_id: `flags-${randomUUID()}`, request: { subtype: "apply_flag_settings", settings } });
  }

  /** Point the run's frames at a turn in progress: a prompt's new one, or the last one reopened. */
  private activate(run: Run, thread: Thread, turn: Turn) {
    run.turnId = turn.id;
    run.finished = false;
    run.interrupted = false;
    run.error = null;
    turn.status = "inProgress";
    turn.error = null;
    turn.completedAt = null;
    turn.durationMs = null;
    thread.activeTurnId = turn.id;
    thread.status = "running";
    thread.notice = null;
    thread.updatedAt = Date.now();
    this.emitTurn(thread.id, turn);
    this.emitThread(thread);
  }

  /** The CLI started a turn of its own: a background task reported back to the turn it belongs to. */
  private reopen(run: Run) {
    const thread = this.threads.get(run.threadId);
    const turn = thread?.turns.find((t) => t.id === run.turnId);
    if (thread && turn && this.runs.get(run.threadId) === run) this.activate(run, thread, turn);
  }

  async interrupt(threadId: string) {
    const run = this.runs.get(threadId);
    if (!run || run.finished || run.interrupted) return;
    run.interrupted = true;
    this.write(run, { type: "control_request", request_id: `interrupt-${randomUUID()}`, request: { subtype: "interrupt" } });
    // If the CLI doesn't wind down: SIGTERM (kills its shell trees, runs SessionEnd hooks), then SIGKILL.
    run.timers.push(
      setTimeout(() => {
        run.proc.kill("SIGTERM");
        run.timers.push(setTimeout(() => run.proc.kill("SIGKILL"), KILL_GRACE_MS));
      }, INTERRUPT_GRACE_MS),
    );
  }

  async archive(threadId: string) {
    // The CLI has no archive: hide the session from this app (its transcript stays for `claude --resume`).
    await this.interrupt(threadId);
    // An idle process lives on only for background shells, which end with the session.
    const run = this.runs.get(threadId);
    if (run?.finished) run.proc.kill("SIGTERM");
    this.archived.add(threadId);
    writeFileSync(join(this.stateDir, "claude-archived.json"), JSON.stringify([...this.archived]));
    this.threads.delete(threadId);
    this.onEvent(threadId, { type: "thread.archived" });
  }

  respond(requestId: string, response: RequestResponse) {
    this.pending.get(requestId)?.resolve(response);
  }

  /** The core is exiting: end the processes kept up only for background shells (running turns finish headless). */
  shutdown() {
    for (const run of this.runs.values()) if (run.finished) run.proc.kill("SIGTERM");
  }

  // ---------------- the run loop ----------------

  private write(run: Run, frame: unknown) {
    if (run.closed) return;
    try {
      run.proc.stdin.write(JSON.stringify(frame) + "\n");
      run.proc.stdin.flush();
    } catch (err: any) {
      console.warn("[claude] stdin write failed:", err?.message ?? err);
    }
  }

  private async pump(run: Run) {
    void (async () => {
      for await (const line of lines(run.proc.stderr)) {
        if (process.env.DEBUG) console.error(`[claude] ${line}`);
        run.stderr.push(line);
        if (run.stderr.length > 20) run.stderr.shift();
      }
    })();
    try {
      for await (const line of lines(run.proc.stdout)) {
        run.lastFrameAt = Date.now();
        const frame = parse(line);
        if (!frame) continue;
        // Still producing: whatever a held turn end waits on hasn't gone quiet yet.
        if (run.held) this.hold(run);
        try {
          this.handleFrame(run, frame);
        } catch (err) {
          console.error("[claude] frame handling failed:", err);
        }
      }
    } catch (err: any) {
      console.warn(`[claude] ${run.threadId}: stdout closed:`, err?.message ?? err);
    }
    // A CLI that's exiting closes stdout a moment before it's gone.
    await Promise.race([run.proc.exited, Bun.sleep(1000)]);
    if (run.proc.exitCode === null && run.proc.signalCode === null) {
      // The CLI runs on without a way to tell us: its transcript is followed until it ends (watch()).
      console.warn(`[claude] ${run.threadId}: stdout ended while the CLI still runs (pid ${run.proc.pid})`);
      run.lost = true;
    }
    const code = await run.proc.exited;
    if (run.watch) clearInterval(run.watch);
    for (const toolId of [...run.background.keys()]) this.backgroundDone(run, toolId, "stopped", "");
    if (!run.finished) {
      if (run.interrupted) this.finish(run, "interrupted", null);
      else this.finish(run, "failed", run.error ?? (run.stderr.slice(-3).join("\n") || `claude exited with code ${code}`));
    }
    for (const t of run.timers) clearTimeout(t);
    if (this.runs.get(run.threadId) === run) this.runs.delete(run.threadId);
  }

  private handleFrame(run: Run, f: any) {
    if (run.finished && startsTurn(f)) this.reopen(run);
    switch (f.type) {
      case "system":
        if (f.subtype === "init") {
          run.model = f.model ?? run.model;
          this.onDisk.add(run.threadId);
          this.sawMcp(run, f.mcp_servers);
        } else if (f.subtype === "compact_boundary") this.upsertItem(run.threadId, run.turnId, { id: f.uuid ?? randomUUID(), kind: "notice", text: "Context compacted" });
        else if (f.subtype === "background_tasks_changed") this.backgroundChanged(run, f.tasks ?? []);
        else if (f.subtype === "task_started" && f.is_backgrounded && f.tool_use_id) run.background.set(f.tool_use_id, run.turnId);
        else if (f.subtype === "task_notification" && f.tool_use_id) this.backgroundDone(run, f.tool_use_id, f.status, f.summary ?? "");
        return;
      case "stream_event":
        // Subagent traffic carries its spawning tool's id; it isn't part of this transcript.
        if (!f.parent_tool_use_id) this.streamEvent(run, f.event);
        return;
      case "assistant":
        if (!f.parent_tool_use_id) this.assistantFrame(run, f);
        return;
      case "user":
        if (!f.parent_tool_use_id) this.userFrame(run, f);
        return;
      case "rate_limit_event":
        this.rateLimit(run, f.rate_limit_info);
        return;
      case "result":
        this.result(run, f);
        return;
      case "control_request":
        this.controlRequest(run, f);
        return;
      case "control_response":
        // An interrupt taken while idle, waiting on subagents: the CLI stopped them, and no result follows.
        if (String(f.response?.request_id).startsWith("interrupt-") && run.heldResult) this.settle(run, run.heldResult);
        return;
    }
  }

  private streamEvent(run: Run, e: any) {
    switch (e?.type) {
      case "message_start":
        // A new response: whatever result was held, the one this ends with decides.
        if (run.held) clearTimeout(run.held);
        run.held = null;
        run.heldResult = null;
        run.messageId = e.message?.id ?? randomUUID();
        run.blocks.clear();
        run.lastIndex = -1;
        return;
      case "content_block_start": {
        const block = e.content_block ?? {};
        run.lastIndex = e.index;
        let item: Item | null = null;
        if (block.type === "text") item = { id: `${run.messageId}:${e.index}`, kind: "assistant", text: block.text ?? "", phase: null, done: false };
        else if (block.type === "thinking") {
          // Shown once it has words: a thought cut off by a steer before its summary leaves nothing.
          run.blocks.set(e.index, `${run.messageId}:${e.index}`);
          if (block.thinking) item = { id: `${run.messageId}:${e.index}`, kind: "reasoning", summary: [block.thinking], done: false };
        }
        else if (block.type === "tool_use") {
          run.openTools.add(block.id);
          run.toolStarts.set(block.id, Date.now());
          item = toolItem(block.id, block.name, block.input ?? {});
        }
        if (!item) return;
        run.blocks.set(e.index, item.id);
        this.upsertItem(run.threadId, run.turnId, item);
        return;
      }
      case "content_block_delta": {
        const id = run.blocks.get(e.index);
        if (!id) return;
        if (e.delta?.type === "text_delta") this.applyDelta(run.threadId, run.turnId, id, "text", e.delta.text ?? "");
        else if (e.delta?.type === "thinking_delta" && e.delta.thinking) {
          if (this.findItem(run.threadId, run.turnId, id)) this.applyDelta(run.threadId, run.turnId, id, "summary", e.delta.thinking, 0);
          else this.upsertItem(run.threadId, run.turnId, { id, kind: "reasoning", summary: [e.delta.thinking], done: false });
        }
        return;
      }
      case "content_block_stop": {
        const id = run.blocks.get(e.index);
        const item = id ? this.findItem(run.threadId, run.turnId, id) : null;
        if (item && (item.kind === "assistant" || item.kind === "reasoning") && !item.done) this.upsertItem(run.threadId, run.turnId, { ...item, done: true });
        return;
      }
    }
  }

  /** A complete content block (the CLI sends one frame per block, just before the stream closes it). */
  private assistantFrame(run: Run, f: any) {
    const message = f.message ?? {};
    const thread = this.threads.get(run.threadId);
    for (const block of blocksOf(message.content)) {
      const streamed = message.id === run.messageId ? run.blocks.get(run.lastIndex) : undefined;
      const id = block.type === "tool_use" ? block.id : (streamed ?? `${message.id ?? randomUUID()}:${block.type}`);
      if (block.type === "text") this.upsertItem(run.threadId, run.turnId, { id, kind: "assistant", text: block.text ?? "", phase: null, done: true });
      else if (block.type === "thinking") {
        const prev = this.findItem(run.threadId, run.turnId, id);
        const text = block.thinking || (prev?.kind === "reasoning" ? prev.summary.join("") : "");
        if (text || prev) this.upsertItem(run.threadId, run.turnId, { id, kind: "reasoning", summary: text ? [text] : [], done: true });
      } else if (block.type === "tool_use") {
        run.openTools.add(block.id);
        if (block.name === "TodoWrite" && thread) {
          thread.plan = todos(block.input);
          this.emitThread(thread);
        }
        const item = toolItem(block.id, block.name, block.input ?? {});
        if (item) this.upsertItem(run.threadId, run.turnId, item);
      }
    }
    if (thread && message.usage) {
      const u = message.usage;
      const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (tokens && tokens !== thread.contextTokens) {
        thread.contextTokens = tokens;
        thread.contextWindow ??= this.windowsByModel[message.model ?? run.model ?? ""] ?? null;
        this.emitThread(thread);
      }
    }
    // A failed turn (usage limit, billing, auth, overload) carries only a terse code here.
    if (f.error) run.error = assistantErrorText(f.error);
  }

  private userFrame(run: Run, f: any) {
    const content = f.message?.content;
    if (f.isReplay) {
      // The CLI confirming a prompt joined its conversation: the first one, or a steer folded in.
      run.pendingSteers.delete(f.uuid);
      const text = promptText(content);
      if (text === null) return;
      const images = blocksOf(content).filter((b) => b.type === "image").length;
      this.upsertItem(run.threadId, run.turnId, { id: f.uuid ?? randomUUID(), kind: "user", text, images });
      return;
    }
    const result = f.tool_use_result ?? f.toolUseResult;
    for (const block of blocksOf(content)) {
      if (block.type !== "tool_result") continue;
      run.openTools.delete(block.tool_use_id);
      const item = this.findItem(run.threadId, run.turnId, block.tool_use_id);
      if (!item) continue;
      let done = completeTool(item, block, result);
      // A call the interrupt cut off reports a rejection, not a failure.
      if (run.interrupted && block.is_error && "status" in done) done = { ...done, status: "interrupted" } as Item;
      const started = run.toolStarts.get(block.tool_use_id);
      // A backgrounded call returns at once; its item runs on with the task.
      if (run.background.has(block.tool_use_id)) done = running(done);
      else if (done.kind === "command" && started) done = { ...done, durationMs: Date.now() - started };
      this.upsertItem(run.threadId, run.turnId, done);
    }
  }

  private rateLimit(run: Run, info: any) {
    const unified = info?.unifiedWindows;
    if (unified) {
      const windows: UsageWindow[] = [];
      for (const [key, label] of [["five_hour", "Session"], ["seven_day", "Week"]] as const) {
        const w = unified[key];
        if (typeof w?.utilization === "number") windows.push({ label, usedPercent: w.utilization * 100, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
      }
      if (windows.length) this.onUsage(windows);
    }
    if (info?.status === "rejected") {
      const thread = this.threads.get(run.threadId);
      if (!thread) return;
      thread.notice = `Claude ${rateWindowLabel(info.rateLimitType)} limit reached — try again after it resets.`;
      this.emitThread(thread);
    }
  }

  private result(run: Run, f: any) {
    const thread = this.threads.get(run.threadId);
    if (thread) {
      const usage = f.modelUsage ?? {};
      const entry = (run.model && usage[run.model]) ?? Object.values<any>(usage).find((u) => u?.canonicalModel === run.model) ?? Object.values<any>(usage)[0];
      if (entry?.contextWindow) {
        thread.contextWindow = entry.contextWindow;
        const model = run.model ?? entry.canonicalModel;
        if (model && this.windowsByModel[model] !== entry.contextWindow) {
          this.windowsByModel[model] = entry.contextWindow;
          writeFileSync(join(this.stateDir, "claude-context-windows.json"), JSON.stringify(this.windowsByModel));
        }
      }
    }
    // A `now` steer interrupts the turn it lands in with a result of its own: that's a step boundary, not the
    // end. Hold it until the steer replays; if nothing follows, the steer was absorbed and the turn is over.
    if (run.pendingSteers.size && !run.interrupted) {
      this.hold(run, f);
      return;
    }
    // Subagents still at work: the CLI follows up on their reports, and that's still this turn.
    if (run.agents && !run.interrupted) {
      run.heldResult = f;
      return;
    }
    this.settle(run, f);
  }

  /** The CLI's full set of background tasks, sent whenever it changes. */
  private backgroundChanged(run: Run, tasks: any[]) {
    run.shells = tasks.filter((t) => t.task_type === "local_bash").length;
    run.agents = tasks.length - run.shells;
    if (run.agents) return;
    // The subagents a held turn end waited on are done: the CLI follows up shortly, or the held result stands.
    if (run.heldResult && !run.held) this.hold(run);
    // The shells an idle process stayed up for are done: let it go once it has followed up on them.
    if (run.finished && !run.shells) run.timers.push(setTimeout(() => run.finished && !run.agents && !run.shells && this.close(run), QUIET_MS));
  }

  /** A backgrounded call's task ended: so does its item, left running when the call returned. */
  private backgroundDone(run: Run, toolId: string, status: string, summary: string) {
    const turnId = run.background.get(toolId);
    if (!turnId) return;
    run.background.delete(toolId);
    const item = this.findItem(run.threadId, turnId, toolId);
    if (item?.kind === "tool" && item.status === "inProgress") {
      this.upsertItem(run.threadId, turnId, { ...item, status: status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted" });
    } else if (item?.kind === "command" && item.status === "inProgress") {
      // Like a foreground command: a nonzero exit is still a completed run, told by its code.
      const code = summary.match(/exit code (\d+)/)?.[1];
      const started = run.toolStarts.get(toolId);
      this.upsertItem(run.threadId, turnId, {
        ...item,
        status: status === "completed" || status === "failed" ? "completed" : "interrupted",
        exitCode: code ? Number(code) : null,
        durationMs: started ? Date.now() - started : null,
      });
    }
  }

  private hold(run: Run, result?: any) {
    if (result) run.heldResult = result;
    if (run.held) clearTimeout(run.held);
    run.held = setTimeout(() => {
      run.held = null;
      run.pendingSteers.clear();
      if (run.heldResult && !run.finished && !run.agents) this.settle(run, run.heldResult);
    }, QUIET_MS);
  }

  private settle(run: Run, f: any) {
    if (run.held) clearTimeout(run.held);
    run.held = null;
    if (run.interrupted) this.finish(run, "interrupted", null);
    else if (f.subtype === "success" && !f.is_error) this.finish(run, "completed", null);
    else this.finish(run, "failed", resultError(f) ?? run.error);
    // Background shells keep the process up for their follow-ups (and any next prompt).
    if (!run.agents && !run.shells) this.close(run);
  }

  // ---------------- lost output ----------------
  // A turn once showed as running for over an hour, its last two minutes of work missing, though the CLI had
  // finished: its stdout stopped reaching us mid-turn. Whatever the cause, the transcript on disk still has it all,
  // so a running turn's transcript is checked against its frames; once they part, the turn follows the transcript.

  private async watch(run: Run) {
    const thread = this.threads.get(run.threadId);
    if (!thread || run.finished || run.following) return;
    const path = join(projectDir(thread.cwd), `${thread.id}.jsonl`);
    if (!run.lost) {
      const last = lastEntryAt(path);
      if (last === null || last - run.lastFrameAt < STALL_MS) return;
      run.lost = true;
      console.warn(`[claude] ${thread.id}: no output for ${Math.round((Date.now() - run.lastFrameAt) / 1000)}s while the transcript moved on (pid ${run.proc.pid}, exit ${run.proc.exitCode}): following the transcript`);
    }
    run.following = true;
    try {
      await this.follow(run, thread, path);
    } catch (err: any) {
      console.warn(`[claude] ${thread.id}: following the transcript failed:`, err?.message ?? err);
    } finally {
      run.following = false;
    }
  }

  /** The turn brought up to date from the transcript; ended (and the process let go) once the transcript ends it. */
  private async follow(run: Run, thread: Thread, path: string) {
    const turn = thread.turns.find((t) => t.id === run.turnId);
    if (!turn || run.finished) return;
    const mtime = statSync(path).mtimeMs;
    const history = await readHistory(path, false);
    // The transcript's turns from the one this turn's prompt opened (steers open more).
    const prompt = turn.items.find((i) => i.kind === "user");
    let from = prompt ? history.turns.findIndex((t) => t.items.some((i) => i.id === prompt.id)) : -1;
    if (from < 0) from = history.turns.findIndex((t) => (t.startedAt ?? 0) >= (turn.startedAt ?? Infinity) - 5000);
    if (from < 0 || run.finished) return;
    // What the turn already shows under another id (a prompt, a block streamed before a frame named it).
    const words = (i: Item) => (i.kind === "user" || i.kind === "assistant" ? `${i.kind}:${i.text}` : i.kind === "reasoning" ? `reasoning:${i.summary.join("")}` : null);
    const shown = new Set(turn.items.map(words).filter(Boolean));
    for (const t of history.turns.slice(from)) {
      for (const item of t.items) {
        if (!turn.items.some((i) => i.id === item.id) && shown.has(words(item))) continue;
        const had = turn.items.find((i) => i.id === item.id);
        if (!had || JSON.stringify(had) !== JSON.stringify(item)) this.upsertItem(thread.id, turn.id, item);
      }
    }
    // Over: its last word is an answer (or an interruption), and nothing has been written since for a while.
    if (history.ended && Date.now() - mtime > QUIET_MS) {
      console.warn(`[claude] ${thread.id}: the transcript ended the turn; closing the run`);
      this.finish(run, history.turns.at(-1)?.status === "interrupted" ? "interrupted" : "completed", null);
      this.close(run);
    }
  }

  /** End of input: the CLI exits once it has nothing left to follow up on. */
  private close(run: Run) {
    if (run.closed) return;
    run.closed = true;
    try {
      run.proc.stdin.end();
    } catch {}
  }

  private finish(run: Run, status: TurnStatus, error: string | null) {
    if (run.finished) return;
    run.finished = true;
    run.heldResult = null;
    for (const t of run.timers.splice(0)) clearTimeout(t);
    for (const p of [...this.pending.values()]) if (p.threadId === run.threadId) p.resolve({ answers: {} });
    const thread = this.threads.get(run.threadId);
    const turn = thread?.turns.find((t) => t.id === run.turnId);
    if (!thread || !turn) return;
    turn.status = status;
    turn.error = error;
    turn.completedAt = Date.now();
    turn.durationMs = turn.startedAt ? turn.completedAt - turn.startedAt : null;
    for (const item of turn.items) {
      const done = finalizeItem(item, status);
      if (done !== item) this.upsertItem(thread.id, turn.id, done);
    }
    thread.activeTurnId = null;
    thread.status = "idle";
    thread.plan = null;
    thread.updatedAt = Date.now();
    this.emitTurn(thread.id, turn);
    this.emitThread(thread);
  }

  // ---------------- questions ----------------

  /** Every `can_use_tool` must be answered or the CLI blocks: tools are allowed, AskUserQuestion asks the user. */
  private controlRequest(run: Run, f: any) {
    const req = f.request ?? {};
    if (req.subtype !== "can_use_tool") return;
    const reply = (input: unknown) =>
      this.write(run, { type: "control_response", response: { subtype: "success", request_id: f.request_id, response: { behavior: "allow", updatedInput: input } } });
    if (req.tool_name !== "AskUserQuestion") return reply(req.input);

    const raw: any[] = Array.isArray(req.input?.questions) ? req.input.questions : [];
    const questions = raw.map((q, i) => ({
      id: `q${i}`,
      header: q.header ?? q.title ?? "",
      question: q.question ?? q.prompt ?? "",
      options: (q.options ?? []).map((o: any) => (typeof o === "string" ? { label: o, description: "" } : { label: o.label ?? o.value ?? "", description: o.description ?? "" })),
      allowOther: true,
      secret: false,
      multiSelect: !!(q.multiSelect ?? q.multi_select),
    }));
    const request: RuntimeRequest = {
      id: `claude-${f.request_id}`,
      kind: "userInput",
      turnId: run.turnId,
      itemId: req.tool_use_id ?? "",
      questions,
    };
    void this.waitForUser(run.threadId, request).then((response) => {
      // The tool reads answers keyed by question text: a label for single-select, a list for multi. Unanswered is
      // "" either way (an empty list reads as an answer of nothing).
      const answers: Record<string, string | string[]> = {};
      for (const q of questions) {
        const picked = (response.answers[q.id] ?? []).filter(Boolean);
        answers[q.question] = q.multiSelect && picked.length ? picked : (picked[0] ?? "");
      }
      reply({ ...req.input, answers });
    });
  }

  private waitForUser(threadId: string, request: RuntimeRequest): Promise<RequestResponse> {
    return new Promise((resolve) => {
      this.pending.set(request.id, {
        threadId,
        request,
        resolve: (response) => {
          if (!this.pending.delete(request.id)) return;
          const thread = this.threads.get(threadId);
          if (thread) {
            thread.requests = thread.requests.filter((r) => r.id !== request.id);
            this.onEvent(threadId, { type: "request.remove", requestId: request.id });
            if (thread.status === "waiting" && !thread.requests.length) {
              thread.status = thread.activeTurnId ? "running" : "idle";
              this.emitThread(thread);
            }
          }
          resolve(response);
        },
      });
      const thread = this.threads.get(threadId);
      if (thread) {
        thread.requests.push(request);
        this.onEvent(threadId, { type: "request.upsert", request });
        thread.status = "waiting";
        this.emitThread(thread);
      }
    });
  }

  // ---------------- state + events ----------------

  private findItem(threadId: string, turnId: string, itemId: string): Item | undefined {
    return this.threads
      .get(threadId)
      ?.turns.find((t) => t.id === turnId)
      ?.items.find((i) => i.id === itemId);
  }

  private upsertItem(threadId: string, turnId: string, item: Item) {
    const thread = this.threads.get(threadId);
    const turn = thread?.turns.find((t) => t.id === turnId);
    if (!thread || !turn) return;
    const merged = mergeItem(turn, item);
    this.onEvent(threadId, { type: "item.upsert", turnId, item: merged });
    if (merged.kind === "user" && thread.title === UNTITLED && merged.text.trim()) {
      thread.title = titleFrom(merged.text);
      this.emitThread(thread);
    }
  }

  private applyDelta(threadId: string, turnId: string, itemId: string, field: "text" | "summary", delta: string, index?: number) {
    const item = this.findItem(threadId, turnId, itemId);
    if (!item || !delta) return;
    if (field === "text" && item.kind === "assistant") item.text += delta;
    else if (field === "summary" && item.kind === "reasoning" && index !== undefined) {
      while (item.summary.length <= index) item.summary.push("");
      item.summary[index] += delta;
    } else return;
    this.onEvent(threadId, { type: "item.delta", turnId, itemId, field, delta, ...(index !== undefined ? { index } : {}) });
  }

  private emitTurn(threadId: string, turn: Turn) {
    const { items: _items, ...meta } = turn;
    this.onEvent(threadId, { type: "turn.upsert", turn: meta });
  }

  private emitThread(t: Thread) {
    const { turns: _turns, requests: _requests, ...rest } = t;
    this.onEvent(t.id, { type: "thread.upsert", thread: rest });
  }
}

// ---------------- stream helpers ----------------

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const blocksOf = (content: unknown): any[] => (Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []);

function gitBranch(cwd: string): string | null {
  const res = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stderr: "ignore" });
  const branch = res.exitCode === 0 ? res.stdout.toString().trim() : "";
  return branch && branch !== "HEAD" ? branch : null;
}

// ---------------- normalization ----------------

/** The models this login offers, from `initialize`: one row per concrete model (aliases fold into it). */
function toModels(raw: any[]): ModelOption[] {
  const out: ModelOption[] = [];
  const defaultId = raw.find((m) => m.value === "default")?.resolvedModel;
  for (const m of raw) {
    const id: string = m.resolvedModel || m.value;
    if (!id || id === "default" || out.some((o) => o.id === id)) continue;
    const efforts: string[] = m.supportsEffort ? (m.supportedEffortLevels ?? []) : [];
    // "Opus 5.5 · Best for everyday, complex tasks" names the version; the alias row only says "Opus".
    const name = String(m.description ?? "").split(" · ")[0].trim() || m.displayName || id;
    out.push({
      id,
      harness: "claude",
      name,
      efforts,
      defaultEffort: efforts.includes("high") ? "high" : (efforts[0] ?? ""),
      isDefault: id === defaultId,
      fastTier: m.supportsFastMode ? "fast" : null,
    });
  }
  return out;
}

function assistantErrorText(code: string): string {
  const known: Record<string, string> = {
    authentication_failed: "Authentication failed — sign in to Claude again.",
    oauth_org_not_allowed: "This organization isn't allowed to use Claude here.",
    billing_error: "Billing error — check your Claude plan or payment method.",
    rate_limit: "Claude usage limit reached — try again after the limit resets.",
    overloaded: "Claude is overloaded right now — try again shortly.",
    invalid_request: "The request was rejected as invalid.",
    model_not_found: "The selected model isn't available.",
    server_error: "Claude had a server error — try again.",
    max_output_tokens: "The reply hit the maximum output length.",
  };
  return known[code] ?? `Claude error: ${code}`;
}

function rateWindowLabel(kind?: string): string {
  if (kind === "five_hour") return "5-hour";
  if (kind?.startsWith("seven_day")) return "weekly";
  return "usage";
}

function resultError(f: any): string | null {
  // The CLI seeds `errors` with `[ede_diagnostic]` telemetry breadcrumbs; those aren't for the user.
  const errors = (f.errors ?? []).map((e: unknown) => (typeof e === "string" ? e : JSON.stringify(e))).filter((e: string) => !e.includes("[ede_diagnostic]"));
  if (errors.length) return errors.join("; ");
  if (f.subtype === "error_max_turns") return "The run hit the maximum number of turns.";
  if (f.subtype === "error_max_budget_usd") return "The run hit its cost budget.";
  return null;
}

/** A frame that only comes with a turn under way (subagents' carry their spawning call's id). */
const startsTurn = (f: any) => (f.type === "system" && f.subtype === "init") || ((f.type === "stream_event" || f.type === "assistant") && !f.parent_tool_use_id);

/** A backgrounded call's item, still running after the call returned. */
function running(item: Item): Item {
  if (item.kind === "command") return { ...item, status: "inProgress", exitCode: null };
  if (item.kind === "tool") return { ...item, status: "inProgress" };
  return item;
}

/** A prompt's visible text, or null for what the CLI injects into user frames (reminders, interrupt markers, background-task notices). */
function promptText(content: unknown): string | null {
  const parts = blocksOf(content).filter((b) => b.type === "text").map((b) => String(b.text ?? ""));
  if (!parts.length && !blocksOf(content).some((b) => b.type === "image")) return null;
  const text = parts.join("\n");
  const head = text.trimStart();
  if (head.startsWith("<system-reminder>") || head.startsWith("[Request interrupted") || head.startsWith("<local-command-") || head.startsWith("<task-notification>") || head.startsWith("Caveat:")) return null;
  // A slash command is recorded as tags: show it the way it was typed.
  const command = head.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1];
  if (command) {
    const args = head.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return `${command.startsWith("/") ? command : `/${command}`}${args ? ` ${args}` : ""}`;
  }
  return text;
}

function todos(input: any): PlanStep[] {
  return (input?.todos ?? []).map((t: any) => ({
    step: String(t.content ?? t.activeForm ?? ""),
    status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "inProgress" : "pending",
  }));
}

const json = (v: unknown) => (v === null || v === undefined || (typeof v === "object" && !Object.keys(v as object).length) ? "" : JSON.stringify(v, null, 2));

/** A tool call as one of the transcript's item kinds; null for the ones shown elsewhere (todos). */
function toolItem(id: string, name: string, input: any): Item | null {
  switch (name) {
    case "TodoWrite":
      return null;
    case "AskUserQuestion": {
      const qs: any[] = Array.isArray(input.questions) ? input.questions : [];
      return { id, kind: "question", questions: qs.map((q) => ({ header: String(q.header ?? ""), question: String(q.question ?? "") })), answers: null };
    }
    case "Bash":
      return { id, kind: "command", command: String(input.command ?? ""), cwd: "", output: "", exitCode: null, durationMs: null, status: "inProgress" };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = String(input.file_path ?? input.notebook_path ?? "");
      return { id, kind: "fileChange", status: "inProgress", changes: path ? [{ path, kind: name === "Write" ? "add" : "update", movePath: null, diff: provisionalDiff(name, input) }] : [] };
    }
    case "WebSearch":
      return { id, kind: "webSearch", query: String(input.query ?? "") };
    case "Agent":
    case "Task":
      return { id, kind: "tool", name: `subagent · ${input.description || "Agent"}`, input: String(input.prompt ?? ""), output: "", status: "inProgress" };
  }
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  return { id, kind: "tool", name: mcp ? `${mcp[1]} · ${mcp[2]}` : name, input: json(input), output: "", status: "inProgress" };
}

/** Until the result's patch arrives, an edit shows its intent from the call itself. */
function provisionalDiff(name: string, input: any): string {
  if (name === "Write") return String(input.content ?? "");
  const edits: any[] = name === "MultiEdit" ? (input.edits ?? []) : [input];
  return edits
    .filter((e) => e && (e.old_string != null || e.new_string != null))
    .map((e) => [...String(e.old_string ?? "").split("\n").map((l) => `-${l}`), ...String(e.new_string ?? "").split("\n").map((l) => `+${l}`)].join("\n"))
    .join("\n");
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .map((b) => (b.type === "text" ? String(b.text ?? "") : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** Close a tool item with its `tool_result` block (and the structured `toolUseResult` riding the frame). */
function completeTool(item: Item, block: any, result: any): Item {
  const failed = !!block.is_error;
  const status: ItemStatus = failed ? "failed" : "completed";
  const text = resultText(block.content);
  switch (item.kind) {
    case "question": {
      // The structured result keys answers by question text: a label, a list of them, or "" for none.
      const given: Record<string, unknown> = result?.answers ?? {};
      const answers = item.questions.map((q) => {
        const a = given[q.question];
        return (Array.isArray(a) ? a : [a]).map((x) => (x == null ? "" : String(x))).filter(Boolean);
      });
      return { ...item, answers };
    }
    case "command": {
      const code = Number(text.match(/^Exit code (\d+)/)?.[1] ?? (failed ? 1 : 0));
      const output = result && typeof result === "object" && "stdout" in result ? [result.stdout, result.stderr].filter(Boolean).join("\n") : text.replace(/^Exit code \d+\n?/, "");
      return { ...item, output, exitCode: code, status: code ? "completed" : status };
    }
    case "fileChange": {
      const patch: any[] | undefined = result?.structuredPatch;
      const changes: FileChange[] = item.changes.map((c) => ({
        ...c,
        kind: result?.type === "create" ? "add" : c.kind,
        diff: patch?.length
          ? patch.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines ?? []).join("\n")}`).join("\n")
          : result?.type === "create" && typeof result.content === "string"
            ? result.content
            : c.diff,
      }));
      return { ...item, changes, status };
    }
    case "tool":
      return { ...item, output: text, status };
    default:
      return item;
  }
}

// ---------------- transcripts on disk ----------------

/** Read `bytes` from `path` at `offset`. */
function readChunk(path: string, offset: number, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, offset);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** When the transcript's latest entry of the conversation itself (a message or a tool's result) was written. */
function lastEntryAt(path: string): number | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  const tail = readChunk(path, Math.max(0, size - WATCH_TAIL_BYTES), Math.min(size, WATCH_TAIL_BYTES)).split("\n");
  for (let i = tail.length - 1; i >= 0; i--) {
    const r = parse(tail[i]);
    if (r && !r.isSidechain && (r.type === "assistant" || r.type === "user") && r.timestamp) return Date.parse(r.timestamp);
  }
  return null;
}

/** A session's sidebar entry from the head (first prompt, start time, branch) and tail (latest title) of its
 *  transcript, without reading what can run to hundreds of megabytes. Sessions with no prompt are skipped. */
/** The CLI's own encoding of a working directory (`/home/a/.b` -> `-home-a--b`). */
const projectDir = (cwd: string) => join(CONFIG, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

function peekSession(id: string, path: string, size: number, mtime: number, cwd: string): ThreadSummary | null {
  let createdAt: number | null = null;
  let prompt: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  const head = readChunk(path, 0, Math.min(size, HEAD_BYTES)).split("\n");
  if (size > HEAD_BYTES) head.pop(); // torn last line
  for (const line of head) {
    const r = parse(line);
    if (!r) continue;
    if (r.timestamp && createdAt === null) createdAt = Date.parse(r.timestamp);
    if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
    if (prompt === null && r.type === "user" && !r.isSidechain && !r.isMeta && !r.isCompactSummary) {
      const text = promptText(r.message?.content);
      if (text?.trim()) {
        prompt = text;
        branch = r.gitBranch && r.gitBranch !== "HEAD" ? r.gitBranch : null;
      }
    }
  }
  if (prompt === null) return null;
  if (size > HEAD_BYTES) {
    const tail = readChunk(path, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)).split("\n").slice(1);
    for (const line of tail) {
      if (!line.includes('"custom-title"') && !line.includes('"agent-name"')) continue;
      const r = parse(line);
      if (r?.type === "custom-title" && r.customTitle) title = r.customTitle;
      else if (r?.type === "agent-name" && r.agentName && !title) title = r.agentName;
    }
  }
  return { id, harness: "claude", title: title || titleFrom(prompt) || UNTITLED, updatedAt: mtime, createdAt: createdAt ?? mtime, status: "idle", branch, cwd };
}

/** `ended`: the transcript's last word is an answer or an interruption, with nothing after it to answer. */
type History = { turns: Turn[]; title: string | null; createdAt: number | null; branch: string | null; model: string | null; contextTokens: number | null; ended: boolean };

/** Rebuild a session's turns from its transcript: each human prompt opens a turn, assistant blocks and tool
 *  results fill it. Subagent (sidechain) records belong to their own transcripts and are skipped. */
/** `settled`: the transcript is done with (calls with no result were cut off); a running one's are still going. */
async function readHistory(path: string, settled = true): Promise<History> {
  const turns: Turn[] = [];
  const tools = new Map<string, { turn: Turn; index: number }>();
  const counters = new Map<string, number>();
  let turn: Turn | null = null;
  let title: string | null = null;
  let agentName: string | null = null;
  let createdAt: number | null = null;
  let branch: string | null = null;
  let model: string | null = null;
  let contextTokens: number | null = null;
  let ended = false;

  const open = (id: string, at: number | null) => {
    turn = { id, status: "completed", error: null, durationMs: null, startedAt: at, completedAt: at, items: [] };
    turns.push(turn);
    return turn;
  };

  for await (const line of lines(Bun.file(path).stream())) {
    const r = parse(line);
    if (!r || r.isSidechain) continue;
    const at = r.timestamp ? Date.parse(r.timestamp) : null;
    if (at !== null) createdAt ??= at;
    switch (r.type) {
      case "custom-title":
        if (r.customTitle) title = r.customTitle;
        continue;
      case "agent-name":
        if (r.agentName) agentName = r.agentName;
        continue;
      case "summary":
        if (r.summary && !title) agentName ??= r.summary;
        continue;
      case "system":
        if (r.subtype === "compact_boundary") (turn ?? open(r.uuid ?? randomUUID(), at)).items.push({ id: r.uuid ?? randomUUID(), kind: "notice", text: "Context compacted" });
        continue;
      case "user": {
        const content = r.message?.content;
        let results = false;
        for (const block of blocksOf(content)) {
          if (block.type !== "tool_result") continue;
          results = true;
          const ref = tools.get(block.tool_use_id);
          if (ref) ref.turn.items[ref.index] = completeTool(ref.turn.items[ref.index], block, r.toolUseResult);
        }
        if (results) ended = false;
        if (results || r.isMeta || r.isCompactSummary) continue;
        const raw = blocksOf(content).map((b) => String(b.text ?? "")).join("\n").trimStart();
        if (raw.startsWith("[Request interrupted")) {
          if (turn) (turn as Turn).status = "interrupted";
          ended = true;
          continue;
        }
        const text = promptText(content);
        if (text === null) continue;
        ended = false;
        branch ??= r.gitBranch && r.gitBranch !== "HEAD" ? r.gitBranch : null;
        const t = open(r.uuid ?? randomUUID(), at);
        t.items.push({ id: r.uuid ?? randomUUID(), kind: "user", text, images: blocksOf(content).filter((b) => b.type === "image").length });
        continue;
      }
      case "assistant": {
        const message = r.message ?? {};
        const t: Turn = turn ?? open(r.uuid ?? randomUUID(), at);
        if (at !== null) t.completedAt = at;
        ended = message.stop_reason === "end_turn";
        model = message.model && message.model !== "<synthetic>" ? message.model : model;
        for (const block of blocksOf(message.content)) {
          const n = counters.get(message.id) ?? 0;
          counters.set(message.id, n + 1);
          const id = `${message.id ?? r.uuid}:${n}`;
          if (block.type === "text" && block.text) t.items.push({ id, kind: "assistant", text: block.text, phase: null, done: true });
          else if (block.type === "thinking" && block.thinking) t.items.push({ id, kind: "reasoning", summary: [block.thinking], done: true });
          else if (block.type === "tool_use") {
            const item = toolItem(block.id, block.name, block.input ?? {});
            if (item) {
              tools.set(block.id, { turn: t, index: t.items.length });
              t.items.push(item);
            }
          }
        }
        const u = message.usage;
        if (u) {
          const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          if (tokens) contextTokens = tokens;
        }
        continue;
      }
    }
  }
  for (const t of turns) {
    t.durationMs = t.startedAt && t.completedAt ? t.completedAt - t.startedAt : null;
    // Calls with no recorded result were cut off.
    if (settled) t.items = t.items.map((i) => ((i.kind === "command" || i.kind === "fileChange" || i.kind === "tool") && i.status === "inProgress" ? { ...i, status: "interrupted" } : i));
  }
  const first = turns.flatMap((t) => t.items).find((i) => i.kind === "user");
  return { turns, title: title ?? agentName ?? (first?.kind === "user" ? titleFrom(first.text) : null), createdAt, branch, model, contextTokens, ended };
}

/** The run's --settings layer: fast mode, bismuth's auto-compact window and the MCP servers switched off, when set. */
function runSettings(fast: boolean, compactWindow: number | null, mcpOff: string[]): string[] {
  const layer = {
    ...(fast ? { fastMode: true } : {}),
    ...(compactWindow ? { autoCompactWindow: compactWindow } : {}),
    ...(mcpOff.length ? { deniedMcpServers: mcpOff.map((serverName) => ({ serverName })) } : {}),
  };
  return Object.keys(layer).length ? ["--settings", JSON.stringify(layer)] : [];
}
