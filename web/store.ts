// UI state shared across modules. The core owns the truth; this mirrors what it sent plus local view state.
import type { ClientMessage, HarnessInfo, ModelOption, Project, RpcMethods, Thread, ThreadQueue, ThreadSummary, TurnSettings } from "../shared/model";

/** Sidebar view options (Zeron's "…" menu): grouping, sort, which row details show, compact rows. */
export type ViewOptions = {
  organize: "device" | "project" | "none";
  sort: "updated" | "created";
  branch: boolean;
  harness: boolean;
  projectIcon: boolean;
  location: boolean;
  compact: boolean;
  /** Holding the jump modifier shows each row's key over its corner (the jumps themselves always work). */
  jumpHints: boolean;
  v?: number;
};
const VIEW_DEFAULTS: ViewOptions = { organize: "none", sort: "updated", branch: true, harness: true, projectIcon: true, location: true, compact: false, jumpHints: true };
const savedView = JSON.parse(localStorage.getItem("bismuth.view") ?? "{}") as Partial<ViewOptions>;
// v2: the harness moved to the row's bottom line (t3code's card) and shows by default.
if (!savedView.v) delete savedView.harness;

export const store = {
  device: "",
  home: "",
  projects: [] as Project[],
  /** Where a new session starts (Ctrl+Shift+O): the open session's project, else the one last picked. */
  currentProject: localStorage.getItem("bismuth.project"),
  models: [] as ModelOption[],
  harnesses: [] as HarnessInfo[],
  view: { ...VIEW_DEFAULTS, ...savedView, v: 2 } as ViewOptions,
  summaries: new Map<string, ThreadSummary>(),
  thread: null as Thread | null,
  /** Each thread's message queue (prompts held until its turn ends), as the core keeps it. */
  queues: new Map<string, ThreadQueue>(),
  /** The core holds queues (a UI applied before the core restarted into queue support steers instead). */
  queueSupported: false,
  /** A thread asked of the core but not loaded yet; the sidebar already shows it selected. */
  opening: null as string | null,
  /** The prompt just sent, shown as the newest bubble until the harness echoes it back (null threadId: a
   *  new session not created yet). `seen` is how many prompts the thread had when it was sent. */
  echo: null as { threadId: string | null; text: string; at: number; seen: number } | null,
  /** Queued prompts the core just sent, shown like `echo` until the harness records them: `seen` is how many
   *  prompts with the same text the thread had, `prompts` how many prompts in all. */
  sent: [] as { threadId: string; id: string; text: string; at: number; seen: number; prompts: number }[],
  /** Threads that finished while not open: the sidebar shows "Done" until they're viewed. */
  done: new Set<string>(JSON.parse(localStorage.getItem("bismuth.done") ?? "[]") as string[]),
  favorites: new Set<string>(JSON.parse(localStorage.getItem("bismuth.favorites") ?? "[]") as string[]),
  /** Session names the user gave (Rename session), over the harness's titles. */
  titles: new Map<string, string>(Object.entries(JSON.parse(localStorage.getItem("bismuth.titles") ?? "{}") as Record<string, string>)),
  /** When each running session was first seen running, for the sidebar's "Working 4m". */
  runningSince: new Map<string, number>(Object.entries(JSON.parse(localStorage.getItem("bismuth.runningSince") ?? "{}") as Record<string, number>)),
  settings: { harness: "codex", model: null, effort: null, serviceTier: null, ...JSON.parse(localStorage.getItem("bismuth.settings") ?? "{}") } as TurnSettings,
  sessionsOpen: localStorage.getItem("bismuth.sessionsOpen") !== "0",
  /** The Settled shelf under the active list (open by default, like Zeron's Archived). */
  settledOpen: localStorage.getItem("bismuth.settledOpen") !== "0",
  /** Project groups folded shut in the sidebar (organized by project). */
  closedProjects: new Set<string>(JSON.parse(localStorage.getItem("bismuth.closedProjects") ?? "[]") as string[]),
  sidebarCollapsed: localStorage.getItem("bismuth.sidebarCollapsed") === "1",
  error: null as string | null,
};

/** Prompts the harness has recorded in a thread. */
export const promptCount = (t: Thread | null) => t?.turns.reduce((n, turn) => n + turn.items.filter((i) => i.kind === "user").length, 0) ?? 0;

/** Prompts in a thread with this text. */
export const promptsLike = (t: Thread, text: string) =>
  t.turns.reduce((n, turn) => n + turn.items.filter((i) => i.kind === "user" && i.text.trim() === text.trim()).length, 0);

/** The registered project a session's folder belongs to. */
export const projectOf = (cwd: string | null | undefined) => (cwd ? (store.projects.find((p) => p.path === cwd) ?? null) : null);

/** A session's project name, or its folder's when the project was removed. */
export const projectName = (cwd: string | null | undefined) => projectOf(cwd)?.name ?? (cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop()! : "");

/** Where a new session starts: the current project if it still exists, else the most recently used one. */
export function targetProject(): Project | null {
  const current = store.projects.find((p) => p.id === store.currentProject);
  return current ?? [...store.projects].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ?? null;
}

/** The folder the file explorer, editors and file links work in: the open session's, or on the new-session screen the
 *  project the next session starts in (none while a session is on its way). */
export const workFolder = (): string | null => store.thread?.cwd ?? (store.opening ? null : (targetProject()?.path ?? null));

export function setCurrentProject(id: string | null) {
  store.currentProject = id;
  if (id) localStorage.setItem("bismuth.project", id);
}

/** A path with the home folder shown as ~. */
export const tildePath = (path: string) => (store.home && (path === store.home || path.startsWith(store.home + "/")) ? "~" + path.slice(store.home.length) : path);

export function persist() {
  localStorage.setItem("bismuth.done", JSON.stringify([...store.done]));
  localStorage.setItem("bismuth.favorites", JSON.stringify([...store.favorites]));
  localStorage.setItem("bismuth.titles", JSON.stringify(Object.fromEntries(store.titles)));
  localStorage.setItem("bismuth.runningSince", JSON.stringify(Object.fromEntries(store.runningSince)));
  localStorage.setItem("bismuth.settings", JSON.stringify(store.settings));
  localStorage.setItem("bismuth.sessionsOpen", store.sessionsOpen ? "1" : "0");
  localStorage.setItem("bismuth.settledOpen", store.settledOpen ? "1" : "0");
  localStorage.setItem("bismuth.closedProjects", JSON.stringify([...store.closedProjects]));
  localStorage.setItem("bismuth.sidebarCollapsed", store.sidebarCollapsed ? "1" : "0");
  localStorage.setItem("bismuth.view", JSON.stringify(store.view));
}

/** Another window changed one (uisync.ts brings in other addresses' changes the same way): this one takes it before its
 *  next persist() could write the old value back. */
window.addEventListener("storage", (e) => {
  if (e.storageArea !== localStorage || !e.key) return;
  const json = <T>(fallback: T): T => JSON.parse(e.newValue ?? "null") ?? fallback;
  switch (e.key) {
    case "bismuth.done":
      store.done = new Set(json<string[]>([]));
      break;
    case "bismuth.favorites":
      store.favorites = new Set(json<string[]>([]));
      break;
    case "bismuth.titles":
      store.titles = new Map(Object.entries(json<Record<string, string>>({})));
      break;
    case "bismuth.sessionsOpen":
      store.sessionsOpen = e.newValue !== "0";
      break;
    case "bismuth.settledOpen":
      store.settledOpen = e.newValue !== "0";
      break;
    case "bismuth.closedProjects":
      store.closedProjects = new Set(json<string[]>([]));
      break;
    case "bismuth.view":
      store.view = { ...VIEW_DEFAULTS, ...json<Partial<ViewOptions>>({}), v: 2 } as ViewOptions;
      break;
    default:
      return;
  }
  render("sidebar", "header", "composer");
});

// The socket lives in app.ts; modules send through this hook so they don't import it.
export const net = { send: (_msg: ClientMessage) => {}, open: () => false };

// Request/response over the socket: `rpc` out, `rpcResult` back with the same id (app.ts settles it).
let rpcSeq = 0;
const calls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
export function call<M extends keyof RpcMethods>(method: M, params: RpcMethods[M]["params"]): Promise<RpcMethods[M]["result"]> {
  if (!net.open()) return Promise.reject(new Error("Not connected to the core"));
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    calls.set(id, { resolve, reject });
    net.send({ type: "rpc", id, method, params } as ClientMessage);
  });
}
export function settleCall(id: number, result: unknown, error?: string) {
  const c = calls.get(id);
  calls.delete(id);
  if (error !== undefined) c?.reject(new Error(error));
  else c?.resolve(result);
}
/** The socket dropped: nothing in flight will be answered. */
export function failCalls() {
  for (const c of calls.values()) c.reject(new Error("Lost the connection to the core"));
  calls.clear();
}

// Coarse change notifications: modules register renderers, app.ts decides what changed.
type Part = "sidebar" | "header" | "composer" | "transcript" | "providers";
const listeners = new Map<Part, (() => void)[]>();
export const on = (part: Part, fn: () => void) => listeners.set(part, [...(listeners.get(part) ?? []), fn]);
export const render = (...parts: Part[]) => parts.forEach((p) => listeners.get(p)?.forEach((fn) => fn()));

/** Navigation history of opened threads and new-session drafts (null: the new-session screen as it is) for the
 *  titlebar's back/forward. */
export const nav = {
  stack: [null] as (string | null)[],
  index: 0,
  push(id: string | null) {
    if (this.stack[this.index] === id) return;
    this.stack = [...this.stack.slice(0, this.index + 1), id];
    this.index = this.stack.length - 1;
  },
};

// Actions implemented by app.ts (open/new/settle); same reason as `net`.
export const actions = {
  open: (_id: string) => {},
  /** A new session in the current project, or (projectId) in that one; `open` also takes a new-session draft's id. */
  newThread: (_projectId?: string) => {},
  /** Settle a session out of the active list, or bring it back. */
  settle: (_id: string, _settled: boolean) => {},
  /** Name a session (null: back to the harness's title). */
  rename: (_id: string, _name: string | null) => {},
  back: () => {},
  forward: () => {},
};
