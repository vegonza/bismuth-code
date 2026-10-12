// Codex adapter: owns one `codex app-server` process (JSON-RPC over stdio) and normalizes
// its threads/turns/items/server-requests into the provider-agnostic model in shared/model.ts.
import { randomUUID } from "node:crypto";
import type * as C from "../codex-protocol/v2";
import type { InitializeParams } from "../codex-protocol";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { finalizeItem, mergeItem, summary, titleFrom, UNTITLED, type Harness } from "./harness";
import { JsonRpcPeer, RpcError, type Id } from "./jsonrpc";
import { fromCodex, toCodex, type McpDef, type McpListing, type McpPlan } from "./mcp";
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

export class CodexAdapter implements Harness {
  readonly id = "codex" as const;
  readonly name = "Codex";
  private peer: JsonRpcPeer | null = null;
  private threads = new Map<string, LoadedThread>();
  private childToParent = new Map<string, string>(); // subagent thread -> root thread
  private pending = new Map<string, PendingRequest>(); // keyed by JSON-RPC request id
  private loading = new Map<string, Promise<Thread>>();
  // commandExecution itemId -> {threadId, processId}; Codex keeps these alive past an interrupt.
  private runningCommands = new Map<string, { threadId: string; turnId: string; processId: string }>();

  /** Called for every normalized change; the server fans these out to clients. */
  onEvent: (threadId: string, event: ThreadEvent) => void = () => {};
  onExit: (err: Error) => void = () => {};
  onUsage: (windows: UsageWindow[]) => void = () => {};
  private limits: C.RateLimitSnapshot | null = null;
  private lastList: ThreadSummary[] | null = null;
  private proc: Bun.Subprocess | null = null;
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

  async start() {
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
      if (this.proc !== proc) return; // a deliberate restart replaced it
      this.peer = null;
      for (const p of this.pending.values()) p.resolve({ answers: {} });
      this.pending.clear();
      this.onExit(err);
    };
    this.peer = peer;

    const init: InitializeParams = {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        // We derive nothing from the cumulative turn diff; skip the traffic (t3code does the same).
        optOutNotificationMethods: ["turn/diff/updated"],
      },
    };
    await peer.request("initialize", init);
    peer.notify("initialized");
    await this.readConfigLimit();
  }

  /** Re-read the config's own limit (it may have been edited by hand or by the Codex CLI). */
  async readConfigLimit() {
    try {
      const res: C.ConfigReadResponse = await this.rpc().request("config/read", { includeLayers: false } satisfies C.ConfigReadParams, QUERY_TIMEOUT_MS);
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
    const res: C.ConfigReadResponse = await this.rpc().request("config/read", { includeLayers: true, cwd } satisfies C.ConfigReadParams, QUERY_TIMEOUT_MS);
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
          const page: C.ListMcpServerStatusResponse = await this.rpc().request("mcpServerStatus/list", { threadId: loaded.id, detail: "toolsAndAuthOnly", cursor } satisfies C.ListMcpServerStatusParams, QUERY_TIMEOUT_MS);
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
    const out: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const res: C.ModelListResponse = await this.rpc().request("model/list", { cursor, limit: 100 } satisfies C.ModelListParams);
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
    let pages: C.ThreadListResponse[];
    try {
      // One page per project, so a busy one can't crowd the others out of the list.
      pages = await Promise.all(
        cwds.map((cwd) =>
          this.rpc().request<C.ThreadListResponse>("thread/list", {
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
    return (this.lastList = pages.flatMap((res) =>
      res.data.map((t): ThreadSummary => {
        const loaded = this.threads.get(t.id);
        return loaded
          ? summary(loaded)
          : { id: t.id, harness: "codex", title: titleOf(t), updatedAt: activityAt(t), createdAt: t.createdAt * 1000, status: threadStatus(t.status), branch: t.gitInfo?.branch ?? null, cwd: t.cwd };
      }),
    ));
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
      p = this.resumeThread(threadId).finally(() => this.loading.delete(threadId));
      this.loading.set(threadId, p);
    }
    return p;
  }

  private async resumeThread(threadId: string): Promise<Thread> {
    // Its folder as the list had it; a session the list hasn't shown gets its project's switches by a reopen below.
    const listedCwd = this.lastList?.find((t) => t.id === threadId)?.cwd ?? null;
    await this.planMcp(listedCwd);
    const config = this.threadConfig(listedCwd, this.keyOf(threadId));
    const res: C.ThreadResumeResponse = await this.rpc().request("thread/resume", {
      threadId,
      ...FULL_ACCESS_THREAD,
      ...config.params,
      excludeTurns: true, // full-history hydration is deprecated; page turns instead
    } satisfies C.ThreadResumeParams, OPEN_TIMEOUT_MS);
    // Newest 50 turns with full items, returned newest-first.
    const page: C.ThreadTurnsListResponse = await this.rpc().request("thread/turns/list", {
      threadId,
      limit: 50,
      sortDirection: "desc",
      itemsView: "full",
    } satisfies C.ThreadTurnsListParams, OPEN_TIMEOUT_MS);
    const turns = page.data.map(toTurn).reverse();
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

  async newThread(settings: TurnSettings, cwd: string): Promise<Thread> {
    await this.planMcp(cwd);
    const key = `new-${randomUUID()}`;
    const config = this.threadConfig(cwd, key);
    const res: C.ThreadStartResponse = await this.rpc().request("thread/start", {
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

  /** Starts a turn, or steers the running one (Codex appends the input to the active turn). */
  async send(threadId: string, text: string, settings: TurnSettings) {
    await this.reopening.get(threadId);
    const thread = await this.openThread(threadId) as LoadedThread;
    const input: C.UserInput[] = [{ type: "text", text, text_elements: [] }];
    const clientUserMessageId = crypto.randomUUID();

    if (thread.activeTurnId) {
      try {
        await this.rpc().request<C.TurnSteerResponse>("turn/steer", {
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

    const params: C.TurnStartParams = {
      threadId,
      input,
      clientUserMessageId,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      serviceTier: settings.serviceTier,
      ...FULL_ACCESS_TURN, // re-asserted per turn so threads created elsewhere with other settings get bypassed too
    };
    const res: C.TurnStartResponse = await this.rpc().request("turn/start", params);
    this.upsertTurn(threadId, res.turn);
  }

  async interrupt(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread?.activeTurnId) return;
    const turnId = thread.activeTurnId;
    const processes = [...this.runningCommands.values()].filter((c) => c.turnId === turnId);
    // Acknowledged immediately; the terminal state arrives later via turn/completed.
    await this.rpc().request("turn/interrupt", { threadId, turnId } satisfies C.TurnInterruptParams);
    // Codex keeps a running command alive as a background terminal after an interrupt;
    // a user Stop means stop everything this turn started (t3code does the same).
    await Promise.all(
      processes.map((c) =>
        this.rpc()
          .request("thread/backgroundTerminals/terminate", { threadId: c.threadId, processId: c.processId } satisfies C.ThreadBackgroundTerminalsTerminateParams)
          .catch((err) => console.warn(`[codex] terminate ${c.processId} failed:`, err.message)),
      ),
    );
  }

  async archive(threadId: string) {
    await this.rpc().request("thread/archive", { threadId } satisfies C.ThreadArchiveParams);
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
        if (thread.parentThreadId) this.childToParent.set(thread.id, this.rootThreadId(thread.parentThreadId));
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
        const item = toItem(p.item, method === "item/completed");
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
      const item = toItem(rawItem, true);
      if (item) mergeItem(turn, item);
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
    if (!t) return; // subagent threads: not rendered in this prototype
    let turn = t.turns.find((x) => x.id === turnId);
    if (!turn) {
      turn = { id: turnId, status: "inProgress", error: null, durationMs: null, startedAt: Date.now(), completedAt: null, items: [] };
      t.turns.push(turn);
      const { items: _items, ...meta } = turn;
      this.onEvent(threadId, { type: "turn.upsert", turn: meta });
    }
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
        await this.rpc().request("thread/unsubscribe", { threadId } satisfies C.ThreadUnsubscribeParams, QUERY_TIMEOUT_MS);
        await this.rpc().request("thread/resume", { threadId, ...FULL_ACCESS_THREAD, ...config.params, excludeTurns: true } satisfies C.ThreadResumeParams, OPEN_TIMEOUT_MS);
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
    this.runningCommands.clear();
    this.limits = null;
    try {
      await this.start();
    } catch (err: any) {
      this.onExit(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.restarting = false;
    }
  }

  private rootThreadId(threadId: string) {
    return this.childToParent.get(threadId) ?? threadId;
  }

  private rpc(): JsonRpcPeer {
    if (!this.peer) throw new Error("codex app-server is not running");
    return this.peer;
  }
}

// ---------------- pure normalization ----------------

/** Listing answers in well under a second; opening resumes the thread (MCP servers start), so it gets longer. */
const QUERY_TIMEOUT_MS = 8_000;
const OPEN_TIMEOUT_MS = 30_000;

/** When the thread last saw activity (ms). Codex's updatedAt also moves when a thread is merely resumed. */
const activityAt = (t: C.Thread) => (t.recencyAt ?? t.updatedAt) * 1000;

function baseThread(t: C.Thread, model: string, effort: string | null, serviceTier: string | null): Omit<LoadedThread, "turns"> {
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

const titleOf = (t: C.Thread) => t.name?.trim() || t.preview.trim().split("\n")[0].slice(0, 80) || UNTITLED;

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

function toTurn(t: C.Turn): Turn {
  return {
    id: t.id,
    status: t.status,
    error: t.error?.message ?? null,
    durationMs: t.durationMs,
    startedAt: ms(t.startedAt),
    completedAt: ms(t.completedAt),
    items: t.items.map((i) => toItem(i, true)).filter((i): i is Item => i !== null),
  };
}

function toItem(i: C.ThreadItem, done: boolean): Item | null {
  switch (i.type) {
    case "userMessage":
      return {
        id: i.id,
        kind: "user",
        text: i.content.flatMap((c) => (c.type === "text" ? [c.text] : c.type === "mention" || c.type === "skill" ? [`@${c.name}`] : [])).join("\n"),
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
    case "collabAgentToolCall":
      return {
        id: i.id,
        kind: "tool",
        name: `subagent · ${i.tool}`,
        input: i.prompt ?? "",
        output: i.receiverThreadIds.length ? `threads: ${i.receiverThreadIds.join(", ")}` : "",
        status: i.status === "interrupted" ? "failed" : (i.status as ItemStatus),
      };
    case "webSearch":
      return { id: i.id, kind: "webSearch", query: i.query };
    case "contextCompaction":
      return { id: i.id, kind: "notice", text: "Context compacted" };
    case "enteredReviewMode":
      return { id: i.id, kind: "notice", text: "Entered review mode" };
    case "exitedReviewMode":
      return { id: i.id, kind: "notice", text: "Exited review mode" };
    case "imageView":
      return { id: i.id, kind: "notice", text: `Viewed image ${i.path}` };
    default:
      // hookPrompt, functionCallOutput, subAgentActivity, sleep, imageGeneration: not shown yet.
      return null;
  }
}

const ms = (seconds: number | null) => (seconds == null ? null : seconds * 1000);
const json = (v: unknown) => (v === null || v === undefined ? "" : JSON.stringify(v, null, 2));
function mcpText(r: C.McpToolCallResult): string {
  return r.content.map((c: any) => (c && typeof c === "object" && "text" in c ? String(c.text) : json(c))).join("\n");
}

/** A model's context window from Codex's own model catalog cache (what it sizes sessions by). */
function cachedContextWindow(model: string): number | null {
  try {
    const file = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
    const cache = JSON.parse(readFileSync(file, "utf8"));
    const entry = (cache.models ?? []).find((m: any) => m.slug === model);
    return entry?.context_window > 0 ? entry.context_window : null;
  } catch {
    return null;
  }
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
