// Cursor adapter, after Zeron's harness (crates/harness/src/cursor): turns run on Cursor's agent runtime through
// the pinned @cursor/sdk, driven by a small Node shim (core/cursor-shim.mjs, JSONL over stdio). Not ACP and not
// `cursor-agent -p`: ACP strips subagent transcripts, and the SDK is what Cursor points integrators at.
//
// - The SDK is a managed npm install under .bismuth/cursor-sdk/<version>, made on first start; the shim is
//   written next to its node_modules so `import("@cursor/sdk")` resolves.
// - A turn is one shim process: `run` (with `resume` = the SDK agent id after the first turn), then the shim's
//   `turn` frame ends it and closing stdin lets it exit. Steering writes `steer`; the shim acknowledges each one
//   with `steered` once Cursor consumed it, which is when it joins the transcript.
// - AUTH: the SDK's login (~/.cursor/sdk/auth.json, or CURSOR_API_KEY) is separate from `cursor-agent login`.
//   "Installed" means the cursor-agent CLI is present (Zeron's signal that the user uses Cursor).
// - Cursor keeps no listing a terminal could share, so bismuth persists its own copy of each conversation
//   (.bismuth/cursor-threads/<id>.json): the SDK holds the model-side state, the file the transcript.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { finalizeItem, mergeItem, summary, titleFrom, UNTITLED, type Harness } from "./harness";
import { toCursor, type McpDef, type McpPlan } from "./mcp";
import type { Item, ModelOption, PlanStep, RequestResponse, Thread, ThreadEvent, ThreadSummary, Turn, TurnSettings, TurnStatus, UsageWindow } from "../shared/model";

/** The pinned SDK (public beta, ~weekly releases): bump deliberately and revalidate the shim against its typings. */
const CURSOR_SDK = "@cursor/sdk@1.0.32";
const SDK_VERSION = CURSOR_SDK.split("@").pop()!;
const SHIM_SOURCE = join(import.meta.dirname, "cursor-shim.mjs");
const INTERRUPT_GRACE_MS = 2000;
const KILL_GRACE_MS = 3000;
const MODELS_TIMEOUT_MS = 30_000;
const HISTORY_TURNS = 50;

type Stored = { thread: Omit<Thread, "requests">; agentId: string | null; archived?: boolean };

type Run = {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  threadId: string;
  turnId: string;
  /** The streaming assistant text and thought, closed when a tool or a steer comes between. */
  text: string | null;
  thinking: string | null;
  tools: Map<string, number>;
  /** Steers written to the shim, oldest first, until Cursor acknowledges them. */
  steers: string[];
  interrupted: boolean;
  finished: boolean;
  error: string | null;
  stderr: string[];
  timers: ReturnType<typeof setTimeout>[];
};

/** How a model's typed parameters map onto bismuth's effort and fast settings. */
type ModelParams = { effort: string | null; fast: boolean; defaults: Record<string, string> };

function findCursorAgent(): string | null {
  const home = homedir();
  return Bun.which("cursor-agent") ?? [join(home, ".local", "bin", "cursor-agent"), join(home, ".cursor", "bin", "cursor-agent"), "/usr/local/bin/cursor-agent", "/opt/homebrew/bin/cursor-agent"].find((p) => existsSync(p)) ?? null;
}

export class CursorAdapter implements Harness {
  readonly id = "cursor" as const;
  readonly name = "Cursor";
  onEvent: (threadId: string, event: ThreadEvent) => void = () => {};
  onExit: (err: Error) => void = () => {};
  onUsage: (windows: UsageWindow[]) => void = () => {};
  /** What runs in a project get of the MCP servers (Ctrl+K → MCP servers): the ones another harness defines, passed
   *  inline (Cursor's own are switched in Cursor's own list). */
  mcpPlan: (cwd: string) => Promise<McpPlan> = async () => ({ off: [], on: [], add: {} });
  /** Servers a session's runs get of their own (`key`: the session's id, or a new one's key): the browser's. */
  sessionMcp: (cwd: string, key: string) => Record<string, McpDef> = () => ({});

  private node: string | null = null;
  private shim = "";
  private models: ModelOption[] = [];
  private params = new Map<string, ModelParams>();
  private threads = new Map<string, Thread>();
  private agents = new Map<string, string | null>();
  private runs = new Map<string, Run>();
  private readonly dir: string;

  constructor(private stateDir: string) {
    this.dir = join(stateDir, "cursor-threads");
  }

  async start() {
    if (!findCursorAgent()) throw new Error("Cursor is not installed (no `cursor-agent` on PATH)");
    this.node = Bun.which("node");
    if (!this.node) throw new Error("Cursor needs Node.js (no `node` on PATH)");
    this.shim = await this.install();
    mkdirSync(this.dir, { recursive: true });
    const items = await this.discoverModels();
    this.models = this.toModels(items);
  }

  /** argv for the shim's login mode (the SDK's browser sign-in) minting into `store`; null until started. */
  loginArgv(store: string): string[] | null {
    return this.node && this.shim ? [this.node, this.shim, "login", store] : null;
  }

  /** The managed SDK install with the current shim beside its node_modules; installs on first use. */
  private async install(): Promise<string> {
    const root = join(this.stateDir, "cursor-sdk", SDK_VERSION);
    const marker = join(root, ".installed");
    if (!existsSync(marker)) {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bismuth-cursor-sdk", private: true, type: "module" }));
      const npm = Bun.which("npm");
      if (!npm) throw new Error("Cursor needs npm to install its SDK (no `npm` on PATH)");
      console.log(`[cursor] installing ${CURSOR_SDK}…`);
      const proc = Bun.spawn([npm, "install", "--no-audit", "--no-fund", "--silent", CURSOR_SDK], { cwd: root, stdout: "ignore", stderr: "pipe" });
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (code !== 0) throw new Error(`installing ${CURSOR_SDK} failed: ${err.trim().split("\n").slice(-3).join(" ") || `npm exited with ${code}`}`);
      writeFileSync(marker, CURSOR_SDK);
    }
    // Rewritten every start so a shim change in core/ lands with the core restart that loads it.
    const shim = join(root, "bismuth-cursor-shim.mjs");
    const source = readFileSync(SHIM_SOURCE, "utf8");
    if (!existsSync(shim) || readFileSync(shim, "utf8") !== source) writeFileSync(shim, source);
    return shim;
  }

  private spawnShim(args: string[], cwd = homedir()) {
    return Bun.spawn([this.node!, this.shim, ...args], {
      cwd,
      env: { ...process.env, BISMUTH_CURSOR_STATE_DIR: join(this.stateDir, "cursor-state") },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  private async discoverModels(): Promise<any[]> {
    const proc = this.spawnShim(["models"]);
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill(), MODELS_TIMEOUT_MS);
    try {
      for await (const line of lines(proc.stdout)) {
        const frame = parse(line);
        if (frame?.ev === "models") return Array.isArray(frame.items) ? frame.items : [];
        if (frame?.ev === "fatal") throw new Error(String(frame.message ?? "Cursor model discovery failed"));
      }
      throw new Error(`Cursor model discovery returned nothing (exit ${await proc.exited})`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `Cursor.models.list()` → picker rows. The effort-like parameter becomes the effort slider, `fast` the fast
   *  toggle; every other parameter (context, thinking…) keeps the catalog's default variant. */
  private toModels(items: any[]): ModelOption[] {
    const out: ModelOption[] = [];
    for (const item of items) {
      const id = typeof item?.id === "string" ? item.id : "";
      if (!id) continue;
      const parameters: any[] = Array.isArray(item.parameters) ? item.parameters : [];
      const defaults: Record<string, string> = {};
      for (const p of item.variants?.find((v: any) => v.isDefault)?.params ?? []) if (p?.id && typeof p.value === "string") defaults[p.id] = p.value;
      const effortParam = parameters.find((p) => ["effort", "reasoning_effort", "reasoning"].includes(p?.id));
      const efforts: string[] = (effortParam?.values ?? []).map((v: any) => String(v.value)).filter(Boolean);
      const fast = parameters.some((p) => p?.id === "fast");
      this.params.set(id, { effort: effortParam?.id ?? null, fast, defaults });
      out.push({
        id,
        harness: "cursor",
        name: String(item.displayName || id),
        efforts,
        defaultEffort: (effortParam && defaults[effortParam.id]) || (efforts.includes("high") ? "high" : (efforts[0] ?? "")),
        isDefault: id === "default",
        fastTier: fast ? "fast" : null,
      });
    }
    return out;
  }

  private modelOptions(model: string, settings: TurnSettings): Record<string, string> {
    const p = this.params.get(model);
    if (!p) return {};
    // Only what the picker chose: the rest is left for Cursor to default. Sent explicitly, a catalog default can be
    // refused (claude-sonnet-5-5's own default `context: 1m` fails with "Invalid parameters for registry model").
    const options: Record<string, string> = {};
    if (p.effort && settings.effort) options[p.effort] = settings.effort;
    if (p.fast && settings.serviceTier === "fast") options.fast = "true";
    return options;
  }

  // ---------------- queries ----------------

  async listModels(): Promise<ModelOption[]> {
    return this.models;
  }

  async listThreads(cwds: string[]): Promise<ThreadSummary[]> {
    const out = new Map<string, ThreadSummary>();
    if (existsSync(this.dir))
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith(".json")) continue;
        const stored = readJson<Stored>(join(this.dir, name));
        if (!stored || stored.archived || !cwds.includes(stored.thread.cwd)) continue;
        out.set(stored.thread.id, summary({ ...stored.thread, requests: [] } as Thread));
      }
    for (const t of this.threads.values()) if (t.turns.length && cwds.includes(t.cwd)) out.set(t.id, summary(t));
    const sorted = [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    // Up to 50 per project, like the other harnesses.
    return cwds.flatMap((cwd) => sorted.filter((t) => t.cwd === cwd).slice(0, 50));
  }

  async openThread(threadId: string): Promise<Thread> {
    const loaded = this.threads.get(threadId);
    if (loaded) return loaded;
    const stored = readJson<Stored>(join(this.dir, `${threadId}.json`));
    if (!stored) throw new Error(`no Cursor conversation ${threadId}`);
    const thread: Thread = { ...stored.thread, turns: stored.thread.turns.slice(-HISTORY_TURNS), requests: [], status: "idle", activeTurnId: null, notice: null };
    this.threads.set(threadId, thread);
    this.agents.set(threadId, stored.agentId);
    return thread;
  }

  // ---------------- commands ----------------

  async newThread(settings: TurnSettings, cwd: string): Promise<Thread> {
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      harness: "cursor",
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
    this.agents.set(thread.id, null);
    this.emitThread(thread);
    return thread;
  }

  async send(threadId: string, text: string, settings: TurnSettings) {
    const thread = await this.openThread(threadId);
    // Asked before anything else, so nothing else can start a run for the thread in between.
    const plan = await this.mcpPlan(thread.cwd).catch(() => ({ off: [], on: [], add: {} }) as McpPlan);
    const mcp: McpPlan = { ...plan, add: { ...plan.add, ...this.sessionMcp(thread.cwd, threadId) } };
    const run = this.runs.get(threadId);
    if (run && !run.finished) {
      run.steers.push(text);
      this.write(run, { op: "steer", prompt: text });
      return;
    }
    if (!this.node) throw new Error("Cursor is not available");

    thread.model = settings.model ?? thread.model ?? "default";
    thread.effort = settings.effort;
    thread.serviceTier = settings.serviceTier;
    const proc = this.spawnShim([], thread.cwd);
    const turnId = randomUUID();
    const turn: Turn = { id: turnId, status: "inProgress", error: null, durationMs: null, startedAt: Date.now(), completedAt: null, items: [] };
    thread.turns.push(turn);
    thread.activeTurnId = turnId;
    thread.status = "running";
    thread.notice = null;
    thread.updatedAt = Date.now();
    const next: Run = { proc, threadId, turnId, text: null, thinking: null, tools: new Map(), steers: [], interrupted: false, finished: false, error: null, stderr: [], timers: [] };
    this.runs.set(threadId, next);
    this.emitTurn(threadId, turn);
    this.upsertItem(threadId, turnId, { id: randomUUID(), kind: "user", text, images: 0 });
    this.emitThread(thread);

    this.write(next, {
      op: "run",
      prompt: text,
      cwd: thread.cwd,
      model: thread.model,
      modelOptions: this.modelOptions(thread.model!, settings),
      resume: this.agents.get(threadId) ?? undefined,
      ...(Object.keys(mcp.add).length ? { mcpServers: Object.fromEntries(Object.entries(mcp.add).map(([name, def]) => [name, toCursor(def)])) } : {}),
    });
    void this.pump(next);
  }

  async interrupt(threadId: string) {
    const run = this.runs.get(threadId);
    if (!run || run.finished || run.interrupted) return;
    run.interrupted = true;
    this.write(run, { op: "interrupt" });
    run.timers.push(
      setTimeout(() => {
        if (run.finished) return;
        run.proc.kill("SIGTERM");
        run.timers.push(setTimeout(() => run.proc.kill("SIGKILL"), KILL_GRACE_MS));
      }, INTERRUPT_GRACE_MS),
    );
  }

  async archive(threadId: string) {
    await this.interrupt(threadId);
    const path = join(this.dir, `${threadId}.json`);
    const stored = readJson<Stored>(path);
    if (stored) writeAtomic(path, { ...stored, archived: true });
    this.threads.delete(threadId);
    this.onEvent(threadId, { type: "thread.archived" });
  }

  /** The SDK has no answer channel for questions (askQuestion is disallowed at agent creation). */
  respond(_requestId: string, _response: RequestResponse) {}

  // ---------------- the run loop ----------------

  private write(run: Run, frame: unknown) {
    try {
      run.proc.stdin.write(JSON.stringify(frame) + "\n");
      run.proc.stdin.flush();
    } catch (err: any) {
      console.warn("[cursor] stdin write failed:", err?.message ?? err);
    }
  }

  private async pump(run: Run) {
    void (async () => {
      for await (const line of lines(run.proc.stderr)) {
        if (process.env.DEBUG) console.error(`[cursor] ${line}`);
        run.stderr.push(line);
        if (run.stderr.length > 20) run.stderr.shift();
      }
    })();
    try {
      for await (const line of lines(run.proc.stdout)) {
        const frame = parse(line);
        if (!frame) continue;
        try {
          this.handleFrame(run, frame);
        } catch (err) {
          console.error("[cursor] frame handling failed:", err);
        }
      }
    } catch (err: any) {
      console.warn("[cursor] stdout closed:", err?.message ?? err);
    }
    const code = await run.proc.exited;
    if (!run.finished) {
      if (run.interrupted) this.finish(run, "interrupted", null);
      else this.finish(run, "failed", run.error ?? (run.stderr.slice(-3).join("\n") || `the Cursor shim exited with code ${code}`));
    }
    for (const t of run.timers) clearTimeout(t);
    if (this.runs.get(run.threadId) === run) this.runs.delete(run.threadId);
  }

  private handleFrame(run: Run, f: any) {
    // Subagent traffic (tagged with its spawning task) isn't part of this transcript; the task row stands for it.
    if (f.parent) return;
    switch (f.ev) {
      case "ready": {
        const thread = this.threads.get(run.threadId);
        if (typeof f.agentId === "string" && f.agentId) this.agents.set(run.threadId, f.agentId);
        if (thread && typeof f.model === "string" && f.model && thread.model !== f.model) {
          thread.model = f.model;
          this.emitThread(thread);
        }
        this.persist(run.threadId);
        return;
      }
      case "text":
        if (!f.text) return;
        this.closeThinking(run);
        if (!run.text) {
          run.text = randomUUID();
          this.upsertItem(run.threadId, run.turnId, { id: run.text, kind: "assistant", text: f.text, phase: null, done: false });
        } else this.applyDelta(run, run.text, "text", f.text);
        return;
      case "thinking":
        if (!f.text) return;
        this.closeText(run);
        if (!run.thinking) {
          run.thinking = randomUUID();
          this.upsertItem(run.threadId, run.turnId, { id: run.thinking, kind: "reasoning", summary: [f.text], done: false });
        } else this.applyDelta(run, run.thinking, "summary", f.text, 0);
        return;
      case "tool":
        this.closeText(run);
        this.closeThinking(run);
        if (f.phase === "start") this.toolStart(run, f);
        else if (f.phase === "end") this.toolEnd(run, f);
        return;
      case "steered": {
        // Oldest first: the shim acknowledges steers in the order they were sent.
        const text = run.steers.shift();
        this.closeText(run);
        this.closeThinking(run);
        if (text !== undefined) this.upsertItem(run.threadId, run.turnId, { id: randomUUID(), kind: "user", text, images: 0 });
        return;
      }
      // `usage` (the turn's summed input/output) is no context-window reading: every step of the turn re-counts
      // the conversation, so it isn't shown.
      case "turn": {
        // A steer that raced the turn's end comes back as a follow-up turn the shim starts itself: keep going.
        if (run.steers.length && !run.interrupted && f.status === "finished") return;
        const status: TurnStatus = run.interrupted || f.status === "cancelled" ? "interrupted" : f.status === "error" ? "failed" : "completed";
        this.finish(run, status, status === "failed" ? String(f.error ?? "Cursor run failed") : null);
        // End of input: the shim winds the SDK down and exits.
        try {
          run.proc.stdin.end();
        } catch {}
        return;
      }
      case "fatal":
        run.error = String(f.message ?? "Cursor failed");
        return;
    }
  }

  private closeText(run: Run) {
    if (!run.text) return;
    const item = this.findItem(run, run.text);
    if (item?.kind === "assistant" && !item.done) this.upsertItem(run.threadId, run.turnId, { ...item, done: true });
    run.text = null;
  }

  private closeThinking(run: Run) {
    if (!run.thinking) return;
    const item = this.findItem(run, run.thinking);
    if (item?.kind === "reasoning" && !item.done) this.upsertItem(run.threadId, run.turnId, { ...item, done: true });
    run.thinking = null;
  }

  private cwdOf = (run: Run) => this.threads.get(run.threadId)?.cwd ?? "";

  private toolStart(run: Run, f: any) {
    const id = String(f.id ?? randomUUID());
    run.tools.set(id, Date.now());
    if (f.name === "updateTodos") return this.todos(run, f.args);
    const item = toolItem(id, String(f.name ?? "tool"), f.args ?? {}, this.cwdOf(run));
    if (item) this.upsertItem(run.threadId, run.turnId, item);
  }

  private toolEnd(run: Run, f: any) {
    const id = String(f.id ?? "");
    const started = run.tools.get(id);
    run.tools.delete(id);
    if (f.name === "updateTodos") return this.todos(run, f.args);
    const prev = this.findItem(run, id) ?? toolItem(id, String(f.name ?? "tool"), f.args ?? {}, this.cwdOf(run));
    if (!prev) return;
    const failed = !!f.error;
    const status = run.interrupted && failed ? "interrupted" : failed ? "failed" : "completed";
    const r = f.result ?? {};
    let done: Item = prev;
    if (prev.kind === "command") {
      const exitCode = typeof r.exitCode === "number" ? r.exitCode : failed ? 1 : 0;
      done = { ...prev, output: String(r.output ?? r.error ?? ""), exitCode, durationMs: r.ms ?? (started ? Date.now() - started : null), status: exitCode && !r.error ? "completed" : status };
    } else if (prev.kind === "fileChange") {
      done = { ...prev, status, changes: prev.changes.map((c) => ({ ...c, diff: typeof r.diff === "string" && r.diff ? r.diff : c.diff })) };
    } else if (prev.kind === "tool") {
      done = { ...prev, output: String(r.error ?? r.output ?? ""), status };
    }
    this.upsertItem(run.threadId, run.turnId, done);
  }

  private todos(run: Run, args: any) {
    const thread = this.threads.get(run.threadId);
    const list: any[] = Array.isArray(args?.todos) ? args.todos : [];
    if (!thread || !list.length) return;
    thread.plan = list
      .filter((t) => t?.status !== "cancelled")
      .map((t): PlanStep => ({ step: String(t.content ?? ""), status: t.status === "completed" ? "completed" : t.status === "inProgress" ? "inProgress" : "pending" }));
    this.emitThread(thread);
  }

  private finish(run: Run, status: TurnStatus, error: string | null) {
    if (run.finished) return;
    run.finished = true;
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
    this.persist(thread.id);
  }

  // ---------------- state + events ----------------

  /** The transcript on disk, rewritten whole (atomically) at each turn boundary. */
  private persist(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const { requests: _requests, ...rest } = thread;
    writeAtomic(join(this.dir, `${threadId}.json`), { thread: rest, agentId: this.agents.get(threadId) ?? null } satisfies Stored);
  }

  private findItem(run: Run, itemId: string): Item | undefined {
    return this.threads
      .get(run.threadId)
      ?.turns.find((t) => t.id === run.turnId)
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

  private applyDelta(run: Run, itemId: string, field: "text" | "summary", delta: string, index?: number) {
    const item = this.findItem(run, itemId);
    if (!item) return;
    if (field === "text" && item.kind === "assistant") item.text += delta;
    else if (field === "summary" && item.kind === "reasoning" && index !== undefined) {
      while (item.summary.length <= index) item.summary.push("");
      item.summary[index] += delta;
    } else return;
    this.onEvent(run.threadId, { type: "item.delta", turnId: run.turnId, itemId, field, delta, ...(index !== undefined ? { index } : {}) });
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

// ---------------- normalization ----------------

/** One SDK tool call (its public vocabulary, Zeron's decode_tool) as a transcript item. */
function toolItem(id: string, name: string, args: any, cwd: string): Item | null {
  const s = (...keys: string[]) => String(keys.map((k) => args?.[k]).find((v) => typeof v === "string") ?? "");
  const rel = (path: string) => (path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path);
  switch (name) {
    case "shell":
      return { id, kind: "command", command: s("command"), cwd: s("workingDirectory"), output: "", exitCode: null, durationMs: null, status: "inProgress" };
    case "edit":
    case "write":
    case "delete": {
      const path = s("path", "filePath", "file_path");
      const diff = name === "write" ? s("fileText", "content") : "";
      return { id, kind: "fileChange", status: "inProgress", changes: path ? [{ path, kind: name === "write" ? "add" : name === "delete" ? "delete" : "update", movePath: null, diff }] : [] };
    }
    case "webSearch":
      return { id, kind: "webSearch", query: s("query", "search") };
    case "task":
      return { id, kind: "tool", name: `subagent · ${s("description") || "Agent"}`, input: s("prompt"), output: "", status: "inProgress" };
    case "read":
      return { id, kind: "tool", name: "Read", input: rel(s("path", "filePath", "file_path")), output: "", status: "inProgress" };
    case "grep":
      return { id, kind: "tool", name: "Grep", input: [s("pattern", "query"), rel(s("path", "directory"))].filter(Boolean).join("  in  "), output: "", status: "inProgress" };
    case "glob":
      return { id, kind: "tool", name: "Glob", input: s("pattern", "globPattern"), output: "", status: "inProgress" };
    case "ls":
      return { id, kind: "tool", name: "List", input: rel(s("path")), output: "", status: "inProgress" };
    case "mcp":
      return { id, kind: "tool", name: `${s("server", "serverName") || "mcp"} · ${s("tool", "toolName", "name") || "tool"}`, input: json(args?.args ?? args?.input), output: "", status: "inProgress" };
    default:
      return { id, kind: "tool", name, input: json(args), output: "", status: "inProgress" };
  }
}

// ---------------- helpers ----------------

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

function writeAtomic(path: string, value: unknown) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

const json = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));

function gitBranch(cwd: string): string | null {
  const res = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stderr: "ignore" });
  const branch = res.exitCode === 0 ? res.stdout.toString().trim() : "";
  return branch && branch !== "HEAD" ? branch : null;
}
