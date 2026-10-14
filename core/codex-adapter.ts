// Codex adapter: owns one `codex app-server` process (JSON-RPC over stdio) and normalizes
// its threads/turns/items/server-requests into the provider-agnostic model in shared/model.ts.
// Subagents are threads of Codex's own (`parentThreadId` names who spawned them): each goes by its session's
// subagentThread here, a read-only transcript its spawn row opens, and its notifications are re-keyed to that.
import { randomUUID } from "node:crypto";
import type * as C from "../codex-protocol/v2";
import type { InitializeParams } from "../codex-protocol";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { finalizeItem, finishedTurns, mergeItem, summary, titleFrom, UNTITLED, type Harness } from "./harness";
import { JsonRpcPeer, RpcError, type Id } from "./jsonrpc";
import { fromCodex, toCodex, type McpDef, type McpListing, type McpPlan } from "./mcp";
import { subagentOf, subagentThread } from "../shared/model";
import type {
  FileChange,
  Invocable,
  Item,
  ItemStatus,
  McpStatus,
  ModelOption,
  PlanStep,
  RequestResponse,
  RuntimeRequest,
  Thread,
  ThreadEvent,
  ThreadStatus,
  ThreadSummary,
  Turn,
  TurnSettings,
  UsageWindow,
} from "../shared/model";

const CLIENT_INFO = { name: "bismuth", title: "Bismuth", version: "0.1.0" };

type PendingRequest = {
  threadId: string;
  request: RuntimeRequest;
  resolve: (response: RequestResponse) => void;
};

type LoadedThread = Thread;

/** The commands bismuth runs on Codex's own API, as the Codex TUI does. */
const COMMANDS: Invocable[] = [
  { name: "compact", kind: "command", text: "/compact", description: "Summarize the conversation to free up context", hint: null },
  { name: "goal", kind: "command", text: "/goal", description: "Set a goal Codex keeps working on until it's done", hint: "[objective | pause | resume | clear]" },
];

export class CodexAdapter implements Harness {
  readonly id = "codex" as const;
  readonly name = "Codex";
  private peer: JsonRpcPeer | null = null;
  private threads = new Map<string, LoadedThread>();
  private childToParent = new Map<string, string>(); // subagent thread -> root thread
  /** Subagents' own thread ids -> what they go by here (subagentThread of the session at their root). */
  private subIds = new Map<string, string>();
  private pending = new Map<string, PendingRequest>(); // keyed by JSON-RPC request id
  private loading = new Map<string, Promise<Thread>>();
  // commandExecution itemId -> {threadId, processId}; Codex keeps these alive past an interrupt.
  private runningCommands = new Map<string, { threadId: string; turnId: string; processId: string }>();
  /** Sessions whose `/compact` turn is about to start: it opens with the prompt, which Codex doesn't record. */
  private compacting = new Set<string>();
  /** Each session's goal, as Codex last reported it. */
  private goals = new Map<string, C.ThreadGoal | null>();
  /** A goal's first turn starting, before the goal goes active: a Stop meanwhile keeps it paused. */
  private activating = new Map<string, { stopped: boolean }>();

  /** Called for every normalized change; the server fans these out to clients. */
  onEvent: (threadId: string, event: ThreadEvent) => void = () => {};
  onExit: (err: Error) => void = () => {};
  onUsage: (windows: UsageWindow[]) => void = () => {};
  private limits: C.RateLimitSnapshot | null = null;
  private lastList: ThreadSummary[] | null = null;
  private proc: Bun.Subprocess | null = null;
  /** A session has used the app-server: it keeps running from then on (see rpc). */
  private inUse = false;
  private waking: Promise<JsonRpcPeer> | null = null;
  private parkTimer: ReturnType<typeof setTimeout> | null = null;
  private configs = new Map<string, { stamp: string; res: C.ConfigReadResponse }>();
  /** The app-server is stale: the live login changed on disk (account switch) or the CLI was updated. */
  private authStale = false;
  private restarting = false;
  /** bismuth's auto-compact override (Settings → Providers), passed to each session started or resumed. */
  compactLimit: () => number | null = () => null;
  /** What sessions in a project get of the MCP servers (Ctrl+K → MCP servers): Codex's own ones switched off or on,
   *  and ones another harness defines carried over. */
  mcpPlan: (cwd: string) => Promise<McpPlan> = async () => ({ off: [], on: [], add: {} });
  /** Servers a session's runs get of their own (`key`: the session's id, or a new one's key): the browser's. */
  sessionMcp: (cwd: string, key: string) => Record<string, McpDef> = () => ({});
  /** A new session's key (what its own servers were given before it had an id) and its id, once it has one. */
  onSessionKey: (key: string, id: string) => void = () => {};
  /** The keys sessions started here were given; a session started elsewhere (or before a restart) goes by its id. */
  private keys = new Map<string, string>();
  private keyOf = (threadId: string) => this.keys.get(threadId) ?? threadId;
  /** Each project folder's plan as last asked for (before a session there starts or resumes, and on a switch). */
  private plans = new Map<string, McpPlan>();
  /** The overrides each loaded session got: Codex keeps them until the session is resumed again. */
  private appliedLimits = new Map<string, number | null>();
  private appliedMcp = new Map<string, string>();
  /** Sessions being reopened with new overrides (a send waits for it), and ones to reopen once their turn ends. */
  private reopening = new Map<string, Promise<void>>();
  private reopenWhenIdle = new Set<string>();
  private reopened = new Set<string>();
  private defaultModel: string | null = null;
  /** model_auto_compact_token_limit from the user's config.toml, if set. */
  configLimit: number | null = null;
  /** What Codex compacts new sessions at on its own: the config's limit, else 90% of the configured model's window. */
  configDefault: { limit: number | null; model: string | null; window: number | null } = { limit: null, model: null, window: null };

  /** Nothing runs yet: sessions list from Codex's own index on disk and models from its catalog cache, and the
   *  app-server starts when something needs it (see rpc). */
  async start() {
    if (!Bun.which("codex")) throw new Error("codex is not installed (not found on PATH)");
  }

  /** The app-server, started on demand. Anything a session does (`use`: opening, starting, sending to one) keeps it
   *  running from then on; until then it only answers queries (config, skills, models) and stops once they've been
   *  quiet for a while, so a Codex nobody uses this session costs nothing. */
  private async rpc(use = true): Promise<JsonRpcPeer> {
    if (use) this.inUse = true;
    if (this.parkTimer) clearTimeout(this.parkTimer);
    this.parkTimer = this.inUse ? null : setTimeout(() => this.park(), PARK_AFTER_MS);
    if (this.peer) return this.peer;
    if (this.waking) return this.waking;
    if (this.proc) throw new Error("codex app-server is not running"); // it exited
    return (this.waking = this.launch().finally(() => (this.waking = null)));
  }

  /** Queries went quiet and no session has used it: stop it until something asks again. */
  private park() {
    if (this.inUse || !this.proc || this.waking) return;
    const proc = this.proc;
    this.proc = null;
    this.peer = null;
    proc.kill();
  }

  private async launch(): Promise<JsonRpcPeer> {
    // A fresh process reads the live login and the CLI as they are now.
    this.authStale = false;
    // One app-server serves every project: each thread carries its own cwd.
    const proc = Bun.spawn(["codex", "app-server"], {
      cwd: homedir(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) process.stderr.write(`[codex] ${dec.decode(chunk)}`);
    })();
    const peer = new JsonRpcPeer(proc);
    peer.onNotification = (method, params) => this.handleNotification(method, params);
    peer.onRequest = (method, params, id) => this.handleServerRequest(method, params, id);
    this.proc = proc;
    peer.onClose = (err) => {
      if (this.proc !== proc) return; // a deliberate restart or park replaced it
      this.peer = null;
      for (const p of this.pending.values()) p.resolve({ answers: {} });
      this.pending.clear();
      this.onExit(err);
    };

    const init: InitializeParams = {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        // We derive nothing from the cumulative turn diff; skip the traffic (t3code does the same).
        optOutNotificationMethods: ["turn/diff/updated"],
      },
    };
    try {
      await peer.request("initialize", init);
      peer.notify("initialized");
    } catch (err) {
      // Not left half-started: the next ask tries again.
      if (this.proc === proc) this.proc = null;
      proc.kill();
      throw err;
    }
    this.peer = peer;
    void this.readConfigLimit();
    return peer;
  }

  /** Codex's config as it resolves it for `cwd` (with its layers). Asked of the app-server again only once a config
   *  file has changed: MCP plans ask before every run of every harness, and the answer is the same until then. */
  private async configRead(cwd?: string): Promise<C.ConfigReadResponse> {
    const key = cwd ?? "";
    const stamp = configStamp(cwd);
    const hit = this.configs.get(key);
    if (hit?.stamp === stamp) return hit.res;
    const res: C.ConfigReadResponse = await (await this.rpc(false)).request("config/read", { includeLayers: true, ...(cwd ? { cwd } : {}) } satisfies C.ConfigReadParams, QUERY_TIMEOUT_MS);
    this.configs.set(key, { stamp, res });
    return res;
  }

  /** Re-read the config's own limit (it may have been edited by hand or by the Codex CLI). */
  async readConfigLimit() {
    try {
      const res = await this.configRead();
      const v = Number(res.config.model_auto_compact_token_limit ?? 0);
      this.configLimit = v > 0 ? v : null;
      const model = res.config.model ?? this.defaultModel;
      const window = Number(res.config.model_context_window ?? 0) || (model ? cachedContextWindow(model) : null);
      this.configDefault = { limit: this.configLimit ?? (window ? Math.round(window * 0.9) : null), model, window };
    } catch {
      // keep the last value
    }
    return this.configLimit;
  }

  appliedLimit = (threadId: string) => this.appliedLimits.get(threadId) ?? null;

  /** Thread config carrying bismuth's overrides for a session in `cwd` (the auto-compact limit, the project's MCP
   *  plan), recorded for the session it starts or resumes. */
  private threadConfig(cwd: string | null, key: string) {
    const limit = this.compactLimit();
    const cached = cwd ? this.plans.get(cwd) : undefined;
    const plan = cwd && cached ? { ...cached, add: { ...cached.add, ...this.sessionMcp(cwd, key) } } : cached;
    // Codex reads the keys as dotted paths: a name with a dot in it can't be addressed.
    const mcp: [string, unknown][] = [
      ...(plan?.off ?? []).map((name) => [`mcp_servers.${name}.enabled`, false] as [string, unknown]),
      ...(plan?.on ?? []).map((name) => [`mcp_servers.${name}.enabled`, true] as [string, unknown]),
      ...Object.entries(plan?.add ?? {}).map(([name, def]) => [`mcp_servers.${name}`, toCodex(def)] as [string, unknown]),
    ]
      .filter(([key]) => key.split(".").length === (key.endsWith(".enabled") ? 3 : 2))
      .sort(([a], [b]) => a.localeCompare(b));
    const config = { ...(limit ? { model_auto_compact_token_limit: limit } : {}), ...Object.fromEntries(mcp) } as C.ThreadStartParams["config"];
    return { limit, mcp: JSON.stringify(mcp), params: Object.keys(config!).length ? { config } : {} };
  }

  private applied(threadId: string, config: ReturnType<CodexAdapter["threadConfig"]>) {
    this.appliedLimits.set(threadId, config.limit);
    this.appliedMcp.set(threadId, config.mcp);
  }

  /** The project's MCP plan, asked for before a session there starts or resumes. */
  private async planMcp(cwd: string | null) {
    if (!cwd) return;
    try {
      this.plans.set(cwd, await this.mcpPlan(cwd));
    } catch (err: any) {
      console.error(`[codex] MCP plan for ${cwd} failed:`, err?.message ?? err);
    }
  }

  /** A switch changed: the plans of every folder with a loaded session are asked for again, and sessions whose config
   *  changed reopen (see reapply). */
  async replanMcp() {
    const cwds = new Set([...this.threads.values()].map((t) => t.cwd));
    await Promise.all([...cwds].map((cwd) => this.planMcp(cwd)));
    return this.reapply();
  }

  /** Its servers for a project (Ctrl+K → MCP servers): as Codex's config resolves them for the folder, and (`live`)
   *  how they're doing in a session loaded there, if any (asking without one would start every server). */
  async mcpListing(cwd: string, live: boolean): Promise<McpListing> {
    const res = await this.configRead(cwd);
    // Layers come strongest first: a server's source is the first that declares it.
    const from = new Map<string, string>();
    for (const layer of res.layers ?? []) {
      const servers = (layer.config as { mcp_servers?: Record<string, unknown> } | null)?.mcp_servers ?? {};
      for (const name of Object.keys(servers)) if (!from.has(name)) from.set(name, layerName(layer.name, cwd));
    }
    const status: McpListing["status"] = {};
    const loaded = live ? [...this.threads.values()].find((t) => t.cwd === cwd && this.appliedMcp.has(t.id)) : undefined;
    if (loaded) {
      try {
        let cursor: string | null = null;
        do {
          const page: C.ListMcpServerStatusResponse = await (await this.rpc(false)).request("mcpServerStatus/list", { threadId: loaded.id, detail: "toolsAndAuthOnly", cursor } satisfies C.ListMcpServerStatusParams, QUERY_TIMEOUT_MS);
          for (const s of page.data) status[s.name] = { status: codexStatus(s), tools: Object.keys(s.tools).length };
          cursor = page.nextCursor;
        } while (cursor);
      } catch {
        // configured servers still list, without a status
      }
    }
    const natives = Object.entries<any>((res.config.mcp_servers as Record<string, unknown> | null) ?? {})
      .filter(([, config]) => !bundledWithCodex(config))
      .map(([name, config]) => ({
      name,
      source: from.get(name) ?? "Codex config",
      def: fromCodex(config),
      configured: config?.enabled !== false,
      locked: name.includes(".") ? "Codex can't switch a server whose name has a dot" : null,
    }));
    return { natives, status };
  }

  // ---------------- queries ----------------

  async listModels(): Promise<ModelOption[]> {
    // Not running: Codex's own catalog cache, which model/list answers from, rather than starting it to ask.
    const cached = this.peer ? null : cachedModels();
    if (cached?.length) {
      this.defaultModel = cached.find((m) => m.isDefault)?.id ?? null;
      return cached;
    }
    const out: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const res: C.ModelListResponse = await (await this.rpc(false)).request("model/list", { cursor, limit: 100 } satisfies C.ModelListParams);
      for (const m of res.data) {
        if (m.isDefault) this.defaultModel = m.model;
        if (m.hidden) continue;
        out.push({
          id: m.id,
          harness: "codex",
          name: m.displayName,
          efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          defaultEffort: m.defaultReasoningEffort,
          isDefault: m.isDefault,
          fastTier: m.serviceTiers.find((t) => t.name.toLowerCase() === "fast")?.id ?? null,
        });
      }
      cursor = res.nextCursor;
    } while (cursor);
    return out;
  }

  async listThreads(cwds: string[]): Promise<ThreadSummary[]> {
    if (!cwds.length) return [];
    // Not running: Codex's own index of its sessions, which thread/list answers from, rather than starting it to ask.
    let found = this.peer ? null : diskThreads(cwds);
    if (!found) {
      let pages: C.ThreadListResponse[];
      try {
        const rpc = await this.rpc(false);
        // One page per project, so a busy one can't crowd the others out of the list.
        pages = await Promise.all(
          cwds.map((cwd) =>
            rpc.request<C.ThreadListResponse>("thread/list", {
              cwd,
              limit: 50,
              // Recency, not updated_at: resuming a thread (just opening it) bumps updated_at, which would reorder the
              // sidebar under every click. recency_at only moves with real activity.
              sortKey: "recency_at",
              sortDirection: "desc",
              archived: false,
            } satisfies C.ThreadListParams, QUERY_TIMEOUT_MS),
          ),
        );
      } catch (err) {
        // A stalled app-server must not hang everything that lists (startup, the sidebar, apply's status
        // check): keep showing the last list, with loaded threads' fresher state.
        if (!(err instanceof RpcError) || !this.lastList) throw err;
        return this.lastList.filter((t) => cwds.includes(t.cwd)).map((t) => (this.threads.has(t.id) ? summary(this.threads.get(t.id)!) : t));
      }
      found = pages.flatMap((res) =>
        res.data
          .filter((t) => !t.parentThreadId)
          .map((t): ThreadSummary => ({ id: t.id, harness: "codex", title: titleOf(t), updatedAt: activityAt(t), createdAt: t.createdAt * 1000, status: threadStatus(t.status), branch: t.gitInfo?.branch ?? null, cwd: t.cwd })),
      );
    }
    const listed = found.map((t) => (this.threads.has(t.id) ? summary(this.threads.get(t.id)!) : t));
    // A fork isn't listed until it has a turn of its own: loaded ones with the turns they inherited are.
    const ids = new Set(listed.map((t) => t.id));
    const forks = [...this.threads.values()].filter((t) => !t.subagent && !ids.has(t.id) && t.turns.length && cwds.includes(t.cwd)).map(summary);
    // Subagents seen since the core started, so a reloaded window knows them (its sessions' running ones).
    const subs = [...this.threads.values()].filter((t) => t.subagent && cwds.includes(t.cwd)).map((t) => ({ ...summary(t), parent: t.parent, subagent: true }));
    return (this.lastList = [...listed, ...forks, ...subs]);
  }

  private windows(): UsageWindow[] {
    return [this.limits?.primary, this.limits?.secondary]
      .filter((w): w is C.RateLimitWindow => !!w)
      .map((w) => ({ label: windowLabel(w.windowDurationMins), usedPercent: w.usedPercent, resetsAt: w.resetsAt == null ? null : w.resetsAt * 1000 }));
  }

  /** Full state of a thread, resuming it into this app-server if needed. */
  openThread(threadId: string): Promise<Thread> {
    const loaded = this.threads.get(threadId);
    if (loaded) return Promise.resolve(loaded);
    let p = this.loading.get(threadId);
    if (!p) {
      const sub = subagentOf(threadId);
      p = (sub ? this.readSubagent(threadId, sub.session, sub.ref) : this.resumeThread(threadId)).finally(() => this.loading.delete(threadId));
      this.loading.set(threadId, p);
    }
    return p;
  }

  private async resumeThread(threadId: string): Promise<Thread> {
    // Its folder as the list had it; a session the list hasn't shown gets its project's switches by a reopen below.
    const listedCwd = this.lastList?.find((t) => t.id === threadId)?.cwd ?? null;
    await this.planMcp(listedCwd);
    const config = this.threadConfig(listedCwd, this.keyOf(threadId));
    const res: C.ThreadResumeResponse = await (await this.rpc()).request("thread/resume", {
      threadId,
      ...FULL_ACCESS_THREAD,
      ...config.params,
      excludeTurns: true, // full-history hydration is deprecated; page turns instead
    } satisfies C.ThreadResumeParams, OPEN_TIMEOUT_MS);
    // Newest 50 turns with full items, returned newest-first.
    const page: C.ThreadTurnsListResponse = await (await this.rpc()).request("thread/turns/list", {
      threadId,
      limit: 50,
      sortDirection: "desc",
      itemsView: "full",
    } satisfies C.ThreadTurnsListParams, OPEN_TIMEOUT_MS);
    const turns = page.data.map((t) => toTurn(t, threadId)).reverse();
    const active = turns.findLast((t) => t.status === "inProgress");
    const thread: LoadedThread = {
      ...baseThread(res.thread, res.model, res.reasoningEffort, res.serviceTier),
      turns,
      activeTurnId: active?.id ?? null,
    };
    // Status events may have raced the resume; don't clobber a newer entry.
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    this.applied(threadId, config);
    this.threads.set(threadId, thread);
    if (!listedCwd) void this.planMcp(thread.cwd).then(() => this.reapply());
    return thread;
  }

  // ---------------- commands ----------------

  /** A subagent not run under this app-server: its thread read as Codex keeps it, not resumed (it's its session's to
   *  run). */
  private async readSubagent(id: string, session: string, child: string): Promise<Thread> {
    const read: C.ThreadReadResponse = await (await this.rpc()).request("thread/read", { threadId: child, includeTurns: true } satisfies C.ThreadReadParams, OPEN_TIMEOUT_MS);
    const existing = this.threads.get(id);
    if (existing) return existing;
    const thread: LoadedThread = {
      ...baseThread(read.thread, null, null, null),
      ...subagentFields(read.thread, id, session),
      status: "idle",
      turns: read.thread.turns.slice(-50).map((t) => toTurn(t, id)),
    };
    this.threads.set(id, thread);
    return thread;
  }

  async newThread(settings: TurnSettings, cwd: string): Promise<Thread> {
    await this.planMcp(cwd);
    const key = `new-${randomUUID()}`;
    const config = this.threadConfig(cwd, key);
    const res: C.ThreadStartResponse = await (await this.rpc()).request("thread/start", {
      cwd,
      ...(settings.model ? { model: settings.model } : {}),
      ...FULL_ACCESS_THREAD,
      ...config.params,
    } satisfies C.ThreadStartParams);
    const thread: LoadedThread = { ...baseThread(res.thread, res.model, res.reasoningEffort, res.serviceTier), turns: [] };
    this.keys.set(thread.id, key);
    this.onSessionKey(key, thread.id);
    this.applied(thread.id, config);
    this.threads.set(thread.id, thread);
    this.emitThread(thread);
    return thread;
  }

  /** A side chat: Codex's own fork, persisted (an ephemeral one keeps the parent's prompt cache but can't be
   *  reopened or moved to the sidebar), so its first turn writes the cache afresh under its own session id. */
  async fork(parentId: string): Promise<Thread> {
    const parent = await this.openThread(parentId);
    const lastTurnId = finishedTurns(parent).at(-1)!.id;
    await this.planMcp(parent.cwd);
    const key = `new-${randomUUID()}`;
    const config = this.threadConfig(parent.cwd, key);
    const res: C.ThreadForkResponse = await (await this.rpc()).request("thread/fork", {
      threadId: parentId,
      lastTurnId,
      ...FULL_ACCESS_THREAD,
      ...config.params,
      excludeTurns: true,
    } satisfies C.ThreadForkParams, OPEN_TIMEOUT_MS);
    // The fork lists the turns it inherited, under their ids in the parent.
    const page: C.ThreadTurnsListResponse = await (await this.rpc()).request("thread/turns/list", {
      threadId: res.thread.id,
      limit: 50,
      sortDirection: "desc",
      itemsView: "full",
    } satisfies C.ThreadTurnsListParams, OPEN_TIMEOUT_MS);
    // The parent's settings, not the config's defaults the fork reports: it carries on the same conversation.
    const thread: LoadedThread = {
      ...baseThread(res.thread, parent.model ?? res.model, parent.effort, parent.serviceTier),
      title: UNTITLED,
      turns: page.data.map((t) => toTurn(t, parentId)).reverse(),
      contextTokens: parent.contextTokens,
      contextWindow: parent.contextWindow,
    };
    this.keys.set(thread.id, key);
    this.onSessionKey(key, thread.id);
    this.applied(thread.id, config);
    this.threads.set(thread.id, thread);
    return thread;
  }

  /** The commands bismuth runs, and the project's skills as a prompt names them (`$name`). */
  async invocables(cwd: string): Promise<Invocable[]> {
    const skills = (await this.skillList(cwd)).map((s): Invocable => ({ name: s.name, kind: "skill", text: `$${s.name}`, description: s.interface?.shortDescription ?? s.shortDescription ?? s.description, hint: null }));
    return [...COMMANDS, ...skills];
  }

  /** The skills a session in `cwd` can use (the app-server keeps them cached, and rescans when they change on disk). */
  private async skillList(cwd: string): Promise<C.SkillMetadata[]> {
    const res: C.SkillsListResponse = await (await this.rpc(false)).request("skills/list", { cwds: [cwd] } satisfies C.SkillsListParams, QUERY_TIMEOUT_MS);
    return res.data.flatMap((e) => e.skills).filter((s) => s.enabled);
  }

  /** Each `$name` in the prompt that names a skill goes with it as that skill, as the Codex TUI sends one. */
  private async skillInputs(cwd: string, text: string): Promise<C.UserInput[]> {
    const named = new Set([...text.matchAll(/(?<=^|\s)\$([\w:.-]+)/g)].map((m) => m[1].replace(/[.:]+$/, "")));
    if (!named.size) return [];
    const skills = await this.skillList(cwd).catch(() => []);
    return skills.filter((s) => named.has(s.name)).map((s): C.UserInput => ({ type: "skill", name: s.name, path: s.path }));
  }

  /** Starts a turn, or steers the running one (Codex appends the input to the active turn). */
  async send(threadId: string, text: string, settings: TurnSettings) {
    await this.reopening.get(threadId);
    const thread = await this.openThread(threadId) as LoadedThread;
    const command = /^\/(compact|goal)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (command?.[1] === "compact" && !command[2]?.trim()) return this.compact(thread);
    if (command?.[1] === "goal") return this.goal(thread, text.trim(), command[2]?.trim() ?? "", settings);
    const input = await this.input(thread, text);
    const clientUserMessageId = crypto.randomUUID();

    if (thread.activeTurnId) {
      try {
        await (await this.rpc()).request<C.TurnSteerResponse>("turn/steer", {
          threadId,
          input,
          clientUserMessageId,
          expectedTurnId: thread.activeTurnId,
        } satisfies C.TurnSteerParams);
        return;
      } catch (err) {
        // The turn finished between our read and the steer: fall through to a new turn.
        if (!(err instanceof RpcError)) throw err;
        console.warn("[codex] steer rejected, starting a new turn:", err.message);
      }
    }
    await this.startTurn(threadId, input, settings, clientUserMessageId);
  }

  /** A prompt as Codex takes it: its text, and each skill it names. */
  private async input(thread: LoadedThread, text: string): Promise<C.UserInput[]> {
    return [{ type: "text", text, text_elements: [] }, ...(await this.skillInputs(thread.cwd, text))];
  }

  private async startTurn(threadId: string, input: C.UserInput[], settings: TurnSettings, clientUserMessageId = crypto.randomUUID()) {
    const params: C.TurnStartParams = {
      threadId,
      input,
      clientUserMessageId,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      serviceTier: settings.serviceTier,
      ...FULL_ACCESS_TURN, // re-asserted per turn so threads created elsewhere with other settings get bypassed too
    };
    const res: C.TurnStartResponse = await (await this.rpc()).request("turn/start", params);
    this.upsertTurn(threadId, res.turn);
  }

  /** `/compact`: a turn of its own that summarizes the conversation (it shows as the prompt, then the compaction). */
  private async compact(thread: LoadedThread) {
    if (thread.activeTurnId) throw new Error("Wait for the turn to end to compact");
    this.compacting.add(thread.id);
    try {
      await (await this.rpc()).request("thread/compact/start", { threadId: thread.id } satisfies C.ThreadCompactStartParams);
    } catch (err) {
      this.compacting.delete(thread.id);
      throw err;
    }
  }

  /**
   * `/goal`, read as the Codex TUI does: bare (or `edit`) shows the goal, `clear`, `pause` and `resume` act on it, and
   * anything else sets it. Setting or resuming starts the goal's first turn with this session's settings (a turn
   * Codex starts itself reuses the last one's), then makes the goal active so Codex carries on with the next turns.
   */
  private async goal(thread: LoadedThread, prompt: string, arg: string, settings: TurnSettings) {
    const threadId = thread.id;
    const action = ["", "edit", "clear", "pause", "resume"].includes(arg.toLowerCase()) ? arg.toLowerCase() : "set";
    if ((action === "set" || action === "resume") && thread.activeTurnId) throw new Error("Wait for the turn to end to start a goal");
    const res: C.ThreadGoalGetResponse = await (await this.rpc()).request("thread/goal/get", { threadId } satisfies C.ThreadGoalGetParams);
    const current = res.goal?.objective.trim() ? res.goal : null;
    this.goals.set(threadId, current);
    if (action === "" || action === "edit") return this.reply(thread, prompt, current ? `Goal ${goalStatus(current)}: ${current.objective.trim()}` : "No goal is set.");
    if (action === "clear") {
      const { cleared }: C.ThreadGoalClearResponse = await (await this.rpc()).request("thread/goal/clear", { threadId, origin: "user" } satisfies C.ThreadGoalClearParams);
      this.goals.set(threadId, null);
      return this.reply(thread, prompt, cleared ? "Goal cleared." : "No goal to clear.");
    }
    if (!current && action !== "set") return this.reply(thread, prompt, "No goal is set.");
    if (action === "pause") {
      await this.setGoal(threadId, { status: "paused" });
      return this.reply(thread, prompt, "Goal paused. Send /goal resume to continue.");
    }
    if (action === "set") {
      // A new objective replaces the goal and what it has used. Paused until its turn runs, so Codex doesn't start one.
      if (current) await (await this.rpc()).request("thread/goal/clear", { threadId, origin: "user" } satisfies C.ThreadGoalClearParams);
      await this.setGoal(threadId, { objective: arg, status: "paused" });
    }
    const activation = { stopped: false };
    this.activating.set(threadId, activation);
    try {
      // The first turn carries the objective; a resume carries on from the conversation.
      await this.startTurn(threadId, action === "set" ? await this.input(thread, arg) : [], settings);
      if (activation.stopped) return;
      await this.setGoal(threadId, { status: "active" });
      if (activation.stopped) await this.setGoal(threadId, { status: "paused" });
    } finally {
      if (this.activating.get(threadId) === activation) this.activating.delete(threadId);
    }
  }

  private async setGoal(threadId: string, change: Pick<C.ThreadGoalSetParams, "objective" | "status">) {
    const { goal }: C.ThreadGoalSetResponse = await (await this.rpc()).request("thread/goal/set", { threadId, origin: "user", ...change } satisfies C.ThreadGoalSetParams);
    this.goals.set(threadId, goal);
  }

  /** A command's answer, as a turn of its own. Codex never sees it, so it's gone once the session reloads. */
  private reply(thread: LoadedThread, prompt: string, text: string) {
    const now = Date.now();
    const id = `bismuth-${randomUUID()}`;
    const turn: Turn = { id, status: "completed", error: null, durationMs: 0, startedAt: now, completedAt: now, items: [] };
    thread.turns.push(turn);
    const { items: _items, ...meta } = turn;
    this.onEvent(thread.id, { type: "turn.upsert", turn: meta });
    this.upsertItem(thread.id, id, { id: `${id}:prompt`, kind: "user", text: prompt, images: 0 });
    this.upsertItem(thread.id, id, { id: `${id}:reply`, kind: "assistant", text, phase: null, done: true });
    thread.updatedAt = now;
    this.emitThread(thread);
  }

  async interrupt(threadId: string) {
    // Stopping a goal's turn pauses the goal, or Codex would start the next one.
    const activation = this.activating.get(threadId);
    if (activation) activation.stopped = true;
    if (!this.goals.has(threadId)) {
      const res = await (await this.rpc()).request<C.ThreadGoalGetResponse>("thread/goal/get", { threadId } satisfies C.ThreadGoalGetParams, QUERY_TIMEOUT_MS).catch(() => null);
      if (res) this.goals.set(threadId, res.goal);
    }
    if (this.goals.get(threadId)?.status === "active")
      await this.setGoal(threadId, { status: "paused" }).catch((err) => console.warn("[codex] pausing the goal failed:", err.message));
    const thread = this.threads.get(threadId);
    if (!thread?.activeTurnId) return;
    const turnId = thread.activeTurnId;
    const processes = [...this.runningCommands.values()].filter((c) => c.turnId === turnId);
    // Acknowledged immediately; the terminal state arrives later via turn/completed.
    await (await this.rpc()).request("turn/interrupt", { threadId, turnId } satisfies C.TurnInterruptParams);
    // Codex keeps a running command alive as a background terminal after an interrupt;
    // a user Stop means stop everything this turn started (t3code does the same).
    await Promise.all(
      processes.map((c) =>
        this.rpc()
          .then((rpc) => rpc.request("thread/backgroundTerminals/terminate", { threadId: c.threadId, processId: c.processId } satisfies C.ThreadBackgroundTerminalsTerminateParams))
          .catch((err) => console.warn(`[codex] terminate ${c.processId} failed:`, err.message)),
      ),
    );
  }

  async archive(threadId: string) {
    await (await this.rpc()).request("thread/archive", { threadId } satisfies C.ThreadArchiveParams);
    this.threads.delete(threadId);
    this.onEvent(threadId, { type: "thread.archived" });
  }

  respond(requestId: string, response: RequestResponse) {
    const p = this.pending.get(requestId);
    if (!p) return;
    p.resolve(response);
  }

  // ---------------- server -> client requests ----------------

  private handleServerRequest(method: string, params: any, rpcId: Id): Promise<unknown> {
    switch (method) {
      // Permissions are always bypassed (approvalPolicy "never" + danger-full-access), so Codex
      // shouldn't ask. If something still does (e.g. an MCP/network edge case), approve it.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        console.warn(`[codex] auto-approving ${method}`);
        return Promise.resolve({ decision: "acceptForSession" } satisfies C.CommandExecutionRequestApprovalResponse & C.FileChangeRequestApprovalResponse);
      case "item/permissions/requestApproval": {
        const p = params as C.PermissionsRequestApprovalParams;
        console.warn(`[codex] auto-granting ${method}`);
        return Promise.resolve({
          permissions: {
            ...(p.permissions.network ? { network: p.permissions.network } : {}),
            ...(p.permissions.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}),
          },
          scope: "session",
        } satisfies C.PermissionsRequestApprovalResponse);
      }
      case "item/tool/requestUserInput": {
        const p = params as C.ToolRequestUserInputParams;
        const ids = new Set(p.questions.map((q) => q.id));
        return this.waitForUser(p.threadId, {
          id: String(rpcId),
          kind: "userInput",
          turnId: p.turnId,
          itemId: p.itemId,
          questions: p.questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.question,
            options: q.options ?? [],
            allowOther: q.isOther,
            secret: q.isSecret,
            multiSelect: false,
          })),
        }).then((r) => {
          const answers: C.ToolRequestUserInputResponse["answers"] = {};
          for (const [qid, values] of Object.entries(r.answers)) if (ids.has(qid)) answers[qid] = { answers: values };
          return { answers } satisfies C.ToolRequestUserInputResponse;
        });
      }
      case "mcpServer/elicitation/request":
        // Not rendered yet; declining is the safe answer (t3code declines shapes it can't show).
        return Promise.resolve({ action: "decline", content: null, _meta: null } satisfies C.McpServerElicitationRequestResponse);
      case "execCommandApproval":
      case "applyPatchApproval":
        // Legacy v1 conversation API; v2 threads never send these.
        return Promise.resolve({ decision: "approved_for_session" });
      default:
        // item/tool/call (we register no dynamic tools), account/chatgptAuthTokens/refresh
        // (we don't own auth), attestation/generate (not requested), ...
        return Promise.reject(new RpcError(-32601, `unsupported server request: ${method}`));
    }
  }

  private waitForUser(threadId: string, request: RuntimeRequest): Promise<RequestResponse> {
    const rootId = this.rootThreadId(threadId);
    return new Promise<RequestResponse>((resolve) => {
      const entry: PendingRequest = {
        threadId: rootId,
        request,
        resolve: (response) => {
          if (!this.pending.has(request.id)) return;
          this.pending.delete(request.id);
          this.removeRequest(rootId, request.id);
          resolve(response);
        },
      };
      this.pending.set(request.id, entry);
      const thread = this.threads.get(rootId);
      if (thread) {
        thread.requests.push(request);
        this.onEvent(rootId, { type: "request.upsert", request });
      }
    });
  }

  private removeRequest(threadId: string, requestId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const before = thread.requests.length;
    thread.requests = thread.requests.filter((r) => r.id !== requestId);
    if (thread.requests.length !== before) this.onEvent(threadId, { type: "request.remove", requestId });
  }

  // ---------------- notifications ----------------

  private handleNotification(method: string, params: any) {
    const sub = typeof params?.threadId === "string" ? this.subIds.get(params.threadId) : undefined;
    if (sub) params = { ...params, threadId: sub };
    switch (method) {
      case "account/rateLimits/updated": {
        // Sparse rolling update: merge what arrived into the last full read.
        const next = (params as C.AccountRateLimitsUpdatedNotification).rateLimits;
        if (next.limitId && next.limitId !== "codex") return;
        this.limits = { ...(this.limits ?? next), primary: next.primary ?? this.limits?.primary ?? null, secondary: next.secondary ?? this.limits?.secondary ?? null };
        this.onUsage(this.windows());
        return;
      }
      case "thread/started": {
        const { thread } = params as C.ThreadStartedNotification;
        if (!thread.parentThreadId) return;
        const session = this.rootThreadId(thread.parentThreadId);
        this.childToParent.set(thread.id, session);
        // A subagent the agent spawned (not one Codex runs for itself: a review, a compaction, an action's guardian):
        // its transcript, under the id it goes by here, which its notifications from now on are for.
        if (!spawned(thread)) return;
        const id = subagentThread(session, thread.id);
        this.subIds.set(thread.id, id);
        if (this.threads.has(id)) return;
        const t: LoadedThread = { ...baseThread(thread, null, null, null), ...subagentFields(thread, id, session), turns: [] };
        this.threads.set(id, t);
        this.emitThread(t);
        return;
      }
      case "thread/status/changed": {
        const p = params as C.ThreadStatusChangedNotification;
        const t = this.threads.get(p.threadId);
        // A reopen's unload and reload aren't news (the unload can be reported late): the session stays as it was.
        if (!t || this.reopening.has(p.threadId) || (p.status.type === "notLoaded" && this.reopened.has(p.threadId))) return;
        t.status = threadStatus(p.status);
        this.emitThread(t);
        return;
      }
      case "thread/name/updated": {
        const p = params as C.ThreadNameUpdatedNotification;
        const t = this.threads.get(p.threadId);
        if (!t || !p.threadName) return;
        t.title = p.threadName;
        this.emitThread(t);
        return;
      }
      case "thread/tokenUsage/updated": {
        const p = params as C.ThreadTokenUsageUpdatedNotification;
        const t = this.threads.get(p.threadId);
        if (!t) return;
        t.contextTokens = p.tokenUsage.last.totalTokens;
        t.contextWindow = p.tokenUsage.modelContextWindow;
        this.emitThread(t);
        return;
      }
      case "thread/settings/updated": {
        const p = params as C.ThreadSettingsUpdatedNotification;
        const t = this.threads.get(p.threadId);
        if (!t) return;
        t.model = p.threadSettings.model;
        t.effort = p.threadSettings.effort;
        t.serviceTier = p.threadSettings.serviceTier;
        this.emitThread(t);
        return;
      }
      case "turn/started": {
        const p = params as C.TurnStartedNotification;
        this.upsertTurn(p.threadId, p.turn);
        if (this.compacting.delete(p.threadId)) this.upsertItem(p.threadId, p.turn.id, compactPrompt(p.turn.id));
        return;
      }
      case "thread/goal/updated": {
        const p = params as C.ThreadGoalUpdatedNotification;
        this.goals.set(p.threadId, p.goal);
        return;
      }
      case "thread/goal/cleared": {
        const p = params as C.ThreadGoalClearedNotification;
        this.goals.set(p.threadId, null);
        return;
      }
      case "turn/completed": {
        const p = params as C.TurnCompletedNotification;
        this.upsertTurn(p.threadId, p.turn);
        // Anything still pending for this turn can no longer be answered.
        for (const req of [...this.pending.values()]) if (req.request.turnId === p.turn.id) req.resolve({ answers: {} });
        return;
      }
      case "turn/plan/updated": {
        const p = params as C.TurnPlanUpdatedNotification;
        const t = this.threads.get(p.threadId);
        if (!t) return;
        t.plan = p.plan.map((s): PlanStep => ({ step: s.step, status: s.status }));
        this.emitThread(t);
        return;
      }
      case "item/started":
      case "item/completed": {
        const p = params as C.ItemStartedNotification | C.ItemCompletedNotification;
        if (p.item.type === "commandExecution") {
          if (method === "item/started" && p.item.processId)
            this.runningCommands.set(p.item.id, { threadId: p.threadId, turnId: p.turnId, processId: p.item.processId });
          else if (method === "item/completed") this.runningCommands.delete(p.item.id);
        }
        const item = toItem(p.item, method === "item/completed", p.threadId);
        if (item) this.upsertItem(p.threadId, p.turnId, item);
        return;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        const p = params as C.AgentMessageDeltaNotification;
        this.applyDelta(p.threadId, p.turnId, p.itemId, "text", p.delta);
        return;
      }
      case "item/commandExecution/outputDelta": {
        const p = params as C.CommandExecutionOutputDeltaNotification;
        this.applyDelta(p.threadId, p.turnId, p.itemId, "output", p.delta);
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        const p = params as C.ReasoningSummaryPartAddedNotification;
        this.applyDelta(p.threadId, p.turnId, p.itemId, "summary", "", p.summaryIndex);
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const p = params as C.ReasoningSummaryTextDeltaNotification;
        this.applyDelta(p.threadId, p.turnId, p.itemId, "summary", p.delta, p.summaryIndex);
        return;
      }
      case "serverRequest/resolved": {
        // Codex resolved it itself (turn interrupted, auto-review, another client answered).
        const p = params as C.ServerRequestResolvedNotification;
        this.pending.get(String(p.requestId))?.resolve({ answers: {} });
        return;
      }
      case "error": {
        const p = params as C.ErrorNotification;
        const t = this.threads.get(p.threadId);
        if (!t) return;
        t.notice = p.willRetry ? `${p.error.message} — retrying…` : p.error.message;
        this.emitThread(t);
        return;
      }
      case "warning":
      case "configWarning":
      case "deprecationNotice":
        console.warn(`[codex] ${method}:`, JSON.stringify(params).slice(0, 300));
        return;
    }
  }

  // ---------------- state mutation + events ----------------

  private upsertTurn(threadId: string, raw: C.Turn) {
    const t = this.threads.get(threadId);
    if (!t) return;
    let turn = t.turns.find((x) => x.id === raw.id);
    if (!turn) {
      turn = { id: raw.id, status: raw.status, error: null, durationMs: null, startedAt: null, completedAt: null, items: [] };
      t.turns.push(turn);
    }
    turn.status = raw.status;
    turn.error = raw.error?.message ?? null;
    turn.durationMs = raw.durationMs;
    turn.startedAt = ms(raw.startedAt) ?? turn.startedAt;
    turn.completedAt = ms(raw.completedAt) ?? (raw.status === "inProgress" ? null : Date.now());
    // turn/started & turn/completed carry no items for live turns; keep what we streamed.
    for (const rawItem of raw.items) {
      const item = toItem(rawItem, true, threadId);
      if (item && !opensAgentAgain(turn.items, item)) mergeItem(turn, item);
    }
    if (raw.status === "inProgress") {
      t.activeTurnId = raw.id;
      t.notice = null;
    } else {
      if (t.activeTurnId === raw.id) {
        t.activeTurnId = null;
        t.plan = null;
      }
      // Items cut off by an interrupt/failure never get item/completed.
      for (const item of turn.items) {
        const finalized = finalizeItem(item, raw.status);
        if (finalized !== item) {
          turn.items[turn.items.indexOf(item)] = finalized;
          this.onEvent(threadId, { type: "item.upsert", turnId: turn.id, item: finalized });
        }
      }
      for (const [id, c] of this.runningCommands) if (c.turnId === raw.id) this.runningCommands.delete(id);
    }
    t.updatedAt = Date.now();
    const { items: _items, ...meta } = turn;
    this.onEvent(threadId, { type: "turn.upsert", turn: meta });
    this.emitThread(t);
  }

  private upsertItem(threadId: string, turnId: string, item: Item) {
    const t = this.threads.get(threadId);
    if (!t) return;
    let turn = t.turns.find((x) => x.id === turnId);
    if (!turn) {
      turn = { id: turnId, status: "inProgress", error: null, durationMs: null, startedAt: Date.now(), completedAt: null, items: [] };
      t.turns.push(turn);
      const { items: _items, ...meta } = turn;
      this.onEvent(threadId, { type: "turn.upsert", turn: meta });
    }
    if (opensAgentAgain(turn.items, item)) return;
    const merged = mergeItem(turn, item);
    this.onEvent(threadId, { type: "item.upsert", turnId, item: merged });
    if (merged.kind === "user" && t.title === UNTITLED && merged.text.trim()) {
      // Codex fills `preview` from the first message; mirror that until thread/name/updated arrives.
      t.title = titleFrom(merged.text);
      this.emitThread(t);
    }
  }

  private applyDelta(threadId: string, turnId: string, itemId: string, field: "text" | "output" | "summary", delta: string, index?: number) {
    const t = this.threads.get(threadId);
    const item = t?.turns.find((x) => x.id === turnId)?.items.find((i) => i.id === itemId);
    if (!item) return;
    if (field === "text" && (item.kind === "assistant" || item.kind === "plan")) item.text += delta;
    else if (field === "output" && item.kind === "command") item.output += delta;
    else if (field === "summary" && item.kind === "reasoning" && index !== undefined) {
      while (item.summary.length <= index) item.summary.push("");
      item.summary[index] += delta;
    } else return;
    this.onEvent(threadId, { type: "item.delta", turnId, itemId, field, delta, ...(index !== undefined ? { index } : {}) });
  }

  private emitThread(t: LoadedThread) {
    const { turns: _turns, requests: _requests, ...rest } = t;
    this.onEvent(t.id, { type: "thread.upsert", thread: rest });
    // A beat after the turn ends, so its trailing notifications land first.
    if (this.authStale && !t.activeTurnId) setTimeout(() => void this.restartIfIdle(), 1000);
    if (this.reopenWhenIdle.has(t.id) && !t.activeTurnId) setTimeout(() => void this.reopen(t.id), 1000);
  }

  /**
   * An override changed (auto-compact, a project's MCP switch): Codex fixes a session's config when it loads it, so
   * every loaded session that has a different one is reopened (unsubscribed, which unloads it, then resumed with the new config). Its
   * history is on disk and unchanged, and this.threads keeps the same object, so open views just carry on. Idle
   * sessions reopen now; one mid-turn once its turn ends — never under a running turn.
   */
  reapply(): { now: number; afterTurn: number } {
    let now = 0;
    let afterTurn = 0;
    for (const t of this.threads.values()) {
      // One without a turn has nothing on disk to resume from: unloading it would lose it.
      if (!t.turns.length) continue;
      const want = this.threadConfig(t.cwd, this.keyOf(t.id));
      if (this.appliedLimit(t.id) === want.limit && this.appliedMcp.get(t.id) === want.mcp) continue;
      if (t.activeTurnId) (this.reopenWhenIdle.add(t.id), afterTurn++);
      else (void this.reopen(t.id), now++);
    }
    return { now, afterTurn };
  }

  private reopen(threadId: string): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t || t.activeTurnId) return Promise.resolve();
    this.reopenWhenIdle.delete(threadId);
    let p = this.reopening.get(threadId);
    if (p) return p;
    p = (async () => {
      const config = this.threadConfig(t.cwd, this.keyOf(t.id));
      try {
        await (await this.rpc()).request("thread/unsubscribe", { threadId } satisfies C.ThreadUnsubscribeParams, QUERY_TIMEOUT_MS);
        await (await this.rpc()).request("thread/resume", { threadId, ...FULL_ACCESS_THREAD, ...config.params, excludeTurns: true } satisfies C.ThreadResumeParams, OPEN_TIMEOUT_MS);
        this.applied(threadId, config);
        this.reopened.add(threadId);
        setTimeout(() => this.reopened.delete(threadId), 30_000);
      } catch (err: any) {
        console.error(`[codex] reopening ${threadId} for new overrides failed:`, err?.message ?? err);
      }
      // Unloading reported it notLoaded in passing; it's idle again.
      t.status = "idle";
      this.emitThread(t);
    })().finally(() => this.reopening.delete(threadId));
    this.reopening.set(threadId, p);
    return p;
  }

  /**
   * An account switch rewrote ~/.codex/auth.json (the app-server holds its login in memory), or an update replaced
   * the binary: restart — once no turn is running, never under one. Threads resume into the new process when next
   * opened or sent to.
   */
  restartWhenIdle() {
    this.authStale = true;
    void this.restartIfIdle();
  }

  private async restartIfIdle() {
    if (!this.authStale || this.restarting || !this.proc || [...this.threads.values()].some((t) => t.activeTurnId)) return;
    this.restarting = true;
    this.authStale = false;
    const old = this.proc;
    this.proc = null;
    this.peer = null;
    old.kill();
    this.threads.clear();
    this.loading.clear();
    this.childToParent.clear();
    this.subIds.clear();
    this.runningCommands.clear();
    this.limits = null;
    try {
      // One only answering queries starts again when next asked.
      if (this.inUse) await this.rpc();
    } catch (err: any) {
      this.onExit(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.restarting = false;
    }
  }

  private rootThreadId(threadId: string) {
    return this.childToParent.get(threadId) ?? threadId;
  }
}

// ---------------- pure normalization ----------------

/** Listing answers in well under a second; opening resumes the thread (MCP servers start), so it gets longer. */
const QUERY_TIMEOUT_MS = 8_000;
const OPEN_TIMEOUT_MS = 30_000;
/** How long an app-server no session has used stays up after its last query. */
const PARK_AFTER_MS = 60_000;

/** When the thread last saw activity (ms). Codex's updatedAt also moves when a thread is merely resumed. */
const activityAt = (t: C.Thread) => (t.recencyAt ?? t.updatedAt) * 1000;

/** A thread an agent spawned as its subagent. */
const spawned = (t: C.Thread) => typeof t.source === "object" && "subAgent" in t.source && typeof t.source.subAgent === "object" && "thread_spawn" in t.source.subAgent;

/** A second row opening a subagent the turn already has one for (a spawn reported both ways). */
const opensAgentAgain = (items: Item[], item: Item) =>
  item.kind === "tool" && !!item.agent && items.some((i) => i.id !== item.id && i.kind === "tool" && i.agent === item.agent);

/** What a subagent's thread is besides a thread: its id here, its session, and the name Codex gave it. */
function subagentFields(t: C.Thread, id: string, session: string): Pick<LoadedThread, "id" | "title" | "parent" | "subagent"> {
  return { id, title: t.agentNickname?.trim() || titleOf(t), parent: session, subagent: true };
}

const firstLine = (text: string) => text.trim().split("\n")[0].slice(0, 80);

function baseThread(t: C.Thread, model: string | null, effort: string | null, serviceTier: string | null): Omit<LoadedThread, "turns"> {
  return {
    id: t.id,
    harness: "codex",
    title: titleOf(t),
    updatedAt: activityAt(t),
    createdAt: t.createdAt * 1000,
    status: threadStatus(t.status),
    branch: t.gitInfo?.branch ?? null,
    cwd: t.cwd,
    model,
    effort,
    serviceTier,
    activeTurnId: null,
    requests: [],
    plan: null,
    contextTokens: null,
    contextWindow: null,
    notice: null,
  };
}

// Accounts' labels: a ~5h session, a weekly window, the free tier's month.
function windowLabel(mins: number | null): string {
  if (mins == null) return "Usage";
  return mins >= 28 * 1440 ? "Month" : mins >= 5 * 1440 ? "Week" : "Session";
}

// Permissions are always bypassed: never ask, no sandbox.
const FULL_ACCESS_THREAD = { approvalPolicy: "never", sandbox: "danger-full-access" } as const satisfies Pick<C.ThreadStartParams, "approvalPolicy" | "sandbox">;
const FULL_ACCESS_TURN = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } } as const satisfies Pick<C.TurnStartParams, "approvalPolicy" | "sandboxPolicy">;

const titleOf = (t: { name?: string | null; preview: string }) => t.name?.trim() || t.preview.trim().split("\n")[0].slice(0, 80) || UNTITLED;

// "/usr/bin/bash -lc 'printf hi > x'" -> "printf hi > x"
function unwrapShell(command: string): string {
  const m = /^\S*\b(?:bash|zsh|sh) -l?c '([\s\S]*)'$/.exec(command);
  return m ? m[1].replaceAll("'\\''", "'") : command;
}

function threadStatus(s: C.ThreadStatus): ThreadStatus {
  switch (s.type) {
    case "active":
      return s.activeFlags.length > 0 ? "waiting" : "running";
    case "systemError":
      return "error";
    case "notLoaded":
      return "notLoaded";
    default:
      return "idle";
  }
}

/** `threadId`: the thread it's of, whose session the subagents it spawns are of. */
function toTurn(t: C.Turn, threadId: string): Turn {
  const items: Item[] = [];
  for (const raw of t.items) {
    const item = toItem(raw, true, threadId);
    if (item && !opensAgentAgain(items, item)) items.push(item);
  }
  // A turn that only compacted is a `/compact` (one that compacts on its own does it within a turn that has more).
  if (t.items.length && t.items.every((i) => i.type === "contextCompaction")) items.unshift(compactPrompt(t.id));
  return {
    id: t.id,
    status: t.status,
    error: t.error?.message ?? null,
    durationMs: t.durationMs,
    startedAt: ms(t.startedAt),
    completedAt: ms(t.completedAt),
    items,
  };
}

/** The prompt that ran a `/compact`, which Codex doesn't record. */
const compactPrompt = (turnId: string): Item => ({ id: `${turnId}:compact`, kind: "user", text: "/compact", images: 0 });

/** How a goal's status reads (`usageLimited`: "usage limited"). */
const goalStatus = (goal: C.ThreadGoal) => goal.status.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);

/** `threadId`: the thread it's of, whose session the subagents it spawns are of. */
function toItem(i: C.ThreadItem, done: boolean, threadId: string): Item | null {
  const session = subagentOf(threadId)?.session ?? threadId;
  switch (i.type) {
    case "userMessage":
      return {
        id: i.id,
        kind: "user",
        // A skill rides beside the text that names it (`$name`).
        text: i.content.flatMap((c) => (c.type === "text" ? [c.text] : c.type === "mention" ? [`@${c.name}`] : [])).join("\n"),
        images: i.content.filter((c) => c.type === "image" || c.type === "localImage").length,
      };
    case "agentMessage":
      return { id: i.id, kind: "assistant", text: i.text, phase: i.phase, done };
    case "reasoning":
      return { id: i.id, kind: "reasoning", summary: [...i.summary], done };
    case "plan":
      return { id: i.id, kind: "plan", text: i.text };
    case "commandExecution":
      return {
        id: i.id,
        kind: "command",
        command: unwrapShell(i.command),
        cwd: i.cwd,
        output: i.aggregatedOutput ?? "",
        exitCode: i.exitCode,
        durationMs: i.durationMs,
        status: i.status,
      };
    case "fileChange":
      return {
        id: i.id,
        kind: "fileChange",
        status: i.status,
        changes: i.changes.map(
          (c): FileChange => ({ path: c.path, kind: c.kind.type, movePath: c.kind.type === "update" ? c.kind.move_path : null, diff: c.diff }),
        ),
      };
    case "mcpToolCall":
      return {
        id: i.id,
        kind: "tool",
        name: `${i.server} · ${i.tool}`,
        input: json(i.arguments),
        output: i.error?.message ?? (i.result ? mcpText(i.result) : ""),
        status: i.status,
      };
    case "dynamicToolCall":
      return {
        id: i.id,
        kind: "tool",
        name: i.tool,
        input: json(i.arguments),
        output: (i.contentItems ?? []).map((c) => ("text" in c ? String(c.text) : "")).join("\n"),
        status: i.status,
      };
    case "collabAgentToolCall": {
      // A spawn opens the subagent's transcript (multi-agent v1); the calls that steer or wait on it are its own.
      const spawned = i.tool === "spawnAgent" ? i.receiverThreadIds[0] : undefined;
      return {
        id: i.id,
        kind: "tool",
        name: `subagent · ${spawned ? firstLine(i.prompt ?? "") || i.tool : i.tool}`,
        input: i.prompt ?? "",
        output: i.receiverThreadIds.length ? `threads: ${i.receiverThreadIds.join(", ")}` : "",
        status: i.status === "interrupted" ? "failed" : (i.status as ItemStatus),
        ...(spawned ? { agent: subagentThread(session, spawned) } : {}),
      };
    }
    case "subAgentActivity":
      // Multi-agent v2 says a subagent started this way (and only once): it's what opens its transcript.
      if (i.kind !== "started") return null;
      return { id: i.id, kind: "tool", name: `subagent · ${i.agentPath}`, input: "", output: "", status: "completed", agent: subagentThread(session, i.agentThreadId) };
    case "webSearch":
      return { id: i.id, kind: "webSearch", query: i.query };
    case "contextCompaction":
      return { id: i.id, kind: "notice", text: "Context compacted" };
    case "enteredReviewMode":
      return { id: i.id, kind: "notice", text: "Entered review mode" };
    case "exitedReviewMode":
      return { id: i.id, kind: "notice", text: "Exited review mode" };
    case "imageView":
      // A tool call like any other (Codex's `view_image`), folded into the turn's group.
      return { id: i.id, kind: "tool", name: "view_image", input: json({ path: i.path }), output: "", status: "completed" };
    default:
      // hookPrompt, functionCallOutput, sleep, imageGeneration: not shown yet.
      return null;
  }
}

const ms = (seconds: number | null) => (seconds == null ? null : seconds * 1000);
const json = (v: unknown) => (v === null || v === undefined ? "" : JSON.stringify(v, null, 2));
function mcpText(r: C.McpToolCallResult): string {
  return r.content.map((c: any) => (c && typeof c === "object" && "text" in c ? String(c.text) : json(c))).join("\n");
}

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");

/** A model's context window from Codex's own model catalog cache (what it sizes sessions by). */
function cachedContextWindow(model: string): number | null {
  try {
    const cache = JSON.parse(readFileSync(join(CODEX_HOME, "models_cache.json"), "utf8"));
    const entry = (cache.models ?? []).find((m: any) => m.slug === model);
    return entry?.context_window > 0 ? entry.context_window : null;
  } catch {
    return null;
  }
}

/** The models model/list answers with, from the catalog cache it answers from: the listed ones in Codex's order, the
 *  config's model the default (else the first). Null without a cache to read. */
function cachedModels(): ModelOption[] | null {
  try {
    const cache = JSON.parse(readFileSync(join(CODEX_HOME, "models_cache.json"), "utf8"));
    const listed = (cache.models as any[]).filter((m) => m.visibility === "list").sort((a, b) => a.priority - b.priority);
    let model: unknown = null;
    try {
      model = (Bun.TOML.parse(readFileSync(join(CODEX_HOME, "config.toml"), "utf8")) as { model?: unknown }).model;
    } catch {
      // no config: Codex's own default
    }
    const def = listed.find((m) => m.slug === model) ?? listed[0];
    return listed.map((m) => ({
      id: m.slug,
      harness: "codex",
      name: m.display_name,
      efforts: m.supported_reasoning_levels.map((e: any) => e.effort),
      defaultEffort: m.default_reasoning_level,
      isDefault: m === def,
      fastTier: (m.service_tiers ?? []).find((t: any) => t.name.toLowerCase() === "fast")?.id ?? null,
    }));
  } catch {
    return null;
  }
}

/** The sessions thread/list answers with, from the index it answers from (state_<n>.sqlite, the newest layout): each
 *  folder's 50 most recent, interactive (not exec or subagent) and with a prompt. Null when it can't be read. */
function diskThreads(cwds: string[]): ThreadSummary[] | null {
  let db: Database | null = null;
  try {
    const file = readdirSync(CODEX_HOME)
      .map((f) => /^state_(\d+)\.sqlite$/.exec(f))
      .filter((m) => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
    if (!file) return null;
    db = new Database(join(CODEX_HOME, file), { readonly: true });
    const query = db.query<{ id: string; cwd: string; name: string | null; preview: string; created_at: number; recency_at: number; git_branch: string | null }, [string]>(
      `select id, cwd, name, preview, created_at, recency_at, git_branch from threads
       where cwd = ? and archived = 0 and source in ('cli', 'vscode') and preview <> ''
       order by recency_at_ms desc, id desc limit 50`,
    );
    return cwds.flatMap((cwd) =>
      query.all(cwd).map((t): ThreadSummary => ({ id: t.id, harness: "codex", title: titleOf(t), updatedAt: t.recency_at * 1000, createdAt: t.created_at * 1000, status: "notLoaded", branch: t.git_branch, cwd: t.cwd })),
    );
  } catch (err: any) {
    console.error("[codex] reading its sessions from disk failed, asking the app-server:", err?.message ?? err);
    return null;
  } finally {
    db?.close();
  }
}

/** When the config files Codex resolves for `cwd` last changed: the user's and the system's, and each project
 *  folder's `.codex/config.toml` from `cwd` up. */
function configStamp(cwd?: string): string {
  const files = [join(CODEX_HOME, "config.toml"), "/etc/codex/config.toml"];
  for (let dir = cwd; dir && dir !== dirname(dir); dir = dirname(dir)) files.push(join(dir, ".codex", "config.toml"));
  return files.map((f) => statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0).join(",");
}

/** A server OpenAI's desktop app wrote into the config for Codex itself (its node_repl, OpenAI's docs): left out of
 *  MCP servers, like Codex's built-in ones, and left to run as configured. */
function bundledWithCodex(config: any): boolean {
  if (typeof config?.command === "string" && /[\\/](chatgpt|ChatGPT\.app|Codex\.app)[\\/]/i.test(config.command)) return true;
  try {
    return typeof config?.url === "string" && new URL(config.url).hostname === "developers.openai.com";
  } catch {
    return false;
  }
}

/** Where a config layer comes from, as the user would find it. */
function layerName(source: C.ConfigLayerSource, cwd: string): string {
  const home = homedir();
  const tilde = (p: string) => (p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  switch (source.type) {
    case "user":
      return tilde(source.file) + (source.profile ? ` (profile ${source.profile})` : "");
    case "project":
      return (source.dotCodexFolder.startsWith(cwd + "/") ? source.dotCodexFolder.slice(cwd.length + 1) : tilde(source.dotCodexFolder)) + "/config.toml";
    case "system":
    case "legacyManagedConfigTomlFromFile":
      return source.file;
    case "sessionFlags":
      return "Codex flags";
    default:
      return "Managed config";
  }
}

function codexStatus(s: C.McpServerStatus): McpStatus | null {
  if (s.authStatus === "notLoggedIn") return "needsAuth";
  switch (s.runtimeStatus) {
    case "connected":
      return "connected";
    case "starting":
    case "notStarted":
      return "starting";
    case "authenticationRequired":
      return "needsAuth";
    case "failed":
    case "cancelled":
      return "failed";
    case "disabled":
      return "disabled";
    default:
      return null;
  }
}
