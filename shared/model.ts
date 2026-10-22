// Provider-agnostic model the UI renders. Each harness adapter (Codex, Claude Code, Cursor) normalizes into this;
// nothing here knows a harness's wire shapes.

export type HarnessId = "codex" | "claude" | "cursor";

export type ThreadStatus = "idle" | "running" | "waiting" | "error" | "notLoaded";

export type ThreadSummary = {
  id: string;
  harness: HarnessId;
  title: string;
  updatedAt: number; // ms
  createdAt: number; // ms
  status: ThreadStatus;
  branch: string | null; // git branch the thread was started on
  cwd: string; // the project folder it runs in
  // Set by the core (t3code's settlement): when the session settled out of the active list, null while active.
  settledAt?: number | null;
  // Set by the core: when the run in flight began (its turn's start), null while idle. The sidebar's "Working 4m".
  runningSince?: number | null;
  // Set by the core for a side chat: the session it branched from (a native fork of its context), whose right pane
  // holds it as a tab. Null once moved to the sidebar, and for every other session. A subagent's: the session that
  // spawned it.
  parent?: string | null;
  // Set by the core for a subagent's transcript (Zeron's): a thread the harness runs on its own, opened read-only as a
  // tab in its session's right pane, from its Agent row (the tool item's `agent`).
  subagent?: boolean;
  // Set by the core for a session branched off another (a side chat, then too once moved to the sidebar): the one
  // its context was copied from, by id and by the title it had then, and how many of its first turns came with it.
  forked?: Forked | null;
};

export type Forked = { from: string; title: string; turns: number };

/** A subagent's transcript as a thread: the session that spawned it and the harness's own name for it (the spawning
 *  call, or its own thread). The session comes first so the core finds its harness, and its folder, from it. */
export const subagentThread = (session: string, ref: string) => `${session}~${ref}`;
export function subagentOf(id: string): { session: string; ref: string } | null {
  const at = id.indexOf("~");
  return at < 0 ? null : { session: id.slice(0, at), ref: id.slice(at + 1) };
}

/** A folder sessions run in (Zeron's Space, on this one device). */
export type Project = {
  id: string;
  path: string;
  name: string; // the user's rename, else the folder's name
  renamed: boolean;
  branch: string | null; // the folder's current git branch
  icon: boolean; // /project-icon?id= serves artwork from the folder
  createdAt: number; // ms
  lastUsedAt: number; // ms: a session last started in it
  /** The worktrees bismuth made of the repository, whose sessions are the project's too. */
  worktrees: Worktree[];
  /** The worktree whose files the project folder shows now (Preview, core/preview.ts); null: its own. */
  preview: string | null;
};

/** A git worktree bismuth made of a project's repository (core/worktrees.ts). `from`: the branch the project folder
 *  was on when it was made (what it branched off), null when unknown. */
export type Worktree = { path: string; name: string; branch: string | null; from: string | null };

/** Settings → Worktrees: where new ones go (null: the default, `~/.bismuth/worktrees`), and what's cleaned up on its
 *  own: worktrees whose sessions have all been idle `idleDays` (null: never), and ones whose branch is merged. */
export type WorktreeSettings = { root: string | null; defaultRoot: string; idleDays: number | null; whenMerged: boolean };
/** A worktree as Settings → Worktrees lists it: how many files it has changed (uncommitted), whether its branch is in the
 *  default one, when anything last happened in it, and what stops it being cleaned up now (null: nothing). */
export type WorktreeStatus = Worktree & { projectId: string; changed: number; merged: boolean; lastUsedAt: number | null; busy: string | null };
/** A preview switch: the files written and deleted in the project folder, and the ones left as the folder had them
 *  because they were changed there since (by a session in it, or by hand). */
export type PreviewResult = { written: number; deleted: number; kept: string[] };

/** One folder's subfolders, for the New project browser. */
export type FolderListing = { path: string; home: string; parent: string | null; entries: { name: string; path: string; isRepo: boolean }[] };

/** A session folder's entry, for the file tree. `path` is relative to the folder, "/"-separated. */
/** `repo`: a folder with a .git of its own, a repository nested in the project. */
export type FileEntry = { name: string; path: string; kind: "dir" | "file"; ignored: boolean; repo?: boolean };
/** A file to view: its text, an image (as a data URL), or why it can't show. */
export type FileContent =
  | { kind: "text"; text: string; size: number; mtime: number }
  | { kind: "image"; url: string; size: number; mtime: number }
  // Drawn by the viewer from the core's /file route.
  | { kind: "pdf"; size: number; mtime: number }
  | { kind: "binary" | "tooLarge"; size: number; mtime: number };
/** `since` for what changed since the branch last stood as pushed (its upstream, else what any remote has): the
 *  unpushed commits and what's uncommitted on top. Any other `since` is a session, for since its last turn began. */
export const UNPUSHED = "@unpushed";
/** `since` for what changed on the branch: since it left the default branch (origin's, else main or master), its
 *  commits and what's uncommitted on top. */
export const BRANCH = "@branch";
export type GitStatus = "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflict";
/** A folder's git state for the tree: whether it's in a repository, and each changed file's status, by path relative
 *  to it. Asked `since` a session: `turn` false when it has no turn kept (none since bismuth began keeping them).
 *  `branched`: on a branch other than the default one (what BRANCH compares with). */
export type GitState = { repo: boolean; status: Record<string, GitStatus>; turn?: boolean; branched?: boolean };
/** A changed file in the Changes view: lines added and removed (null for a binary file), a rename's original path,
 *  and whether it's uncommitted (for "Last turn", a file the turn changed may have been committed since). */
export type GitChange = { path: string; status: GitStatus; from?: string; added: number | null; removed: number | null; dirty: boolean };
/** A folder's changes for the Changes view, since the last commit or (`since` a session) its last turn began; with the
 *  branch (null when detached) and how it stands against its upstream. `turn`: false when the session has no turn
 *  kept. */
export type GitChanges = {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  remotes: boolean;
  turn?: boolean;
  files: GitChange[];
  /** The commit checked out (null before the first): the graph is read again when it moves. */
  head?: string | null;
};
/** A branch or tag a commit carries: `head` the branch checked out, `remote` a remote's branch. */
export type GitRef = { name: string; kind: "head" | "branch" | "remote" | "tag" };
/** A commit in the graph. `date`: the author's, in ms. */
export type GitCommit = { hash: string; parents: string[]; subject: string; author: string; date: number; refs: GitRef[] };
/** A page of the graph: the branch checked out and its upstream, newest first, parents after children. `more`:
 *  there are older ones past it. */
export type GitLog = { head: string | null; commits: GitCommit[]; more: boolean };
/** A commit's files against its first parent (the empty tree for the first commit), and its whole message. */
export type GitCommitChanges = { commit: GitCommit; body: string; parent: string | null; files: GitChange[] };
/** A saved file's new mtime, or (`ok` false) the mtime it has on disk now, which changed since it was read. */
export type WriteResult = { ok: true; mtime: number } | { ok: false; mtime: number };
/** A path an agent referenced, found on disk: relative to the session folder, or absolute outside it. */
export type FileRef = { path: string; dir: boolean };
/** Where a definition is (0-based line and UTF-16 character, as the editor counts). */
export type FileLocation = { path: string; line: number; character: number };

export type Thread = ThreadSummary & {
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  activeTurnId: string | null;
  turns: Turn[];
  requests: RuntimeRequest[];
  plan: PlanStep[] | null;
  contextTokens: number | null;
  contextWindow: number | null; // the model's
  compactAt?: number | null; // where it auto-compacts (the core fills it in): what the context ring measures against
  notice: string | null; // transient error / retry message
};

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export type Turn = {
  id: string;
  status: TurnStatus;
  error: string | null;
  durationMs: number | null;
  startedAt: number | null; // ms
  completedAt: number | null; // ms
  items: Item[];
};

export type ItemStatus = "inProgress" | "completed" | "failed" | "declined" | "interrupted";

export type FileChange = { path: string; kind: "add" | "delete" | "update"; movePath: string | null; diff: string };

export type Item =
  | { id: string; kind: "user"; text: string; images: number }
  | { id: string; kind: "assistant"; text: string; phase: "commentary" | "final_answer" | null; done: boolean }
  | { id: string; kind: "reasoning"; summary: string[]; done: boolean }
  // startedAt (ms): when the core first saw the call running, for how long it has been at it.
  | { id: string; kind: "command"; command: string; cwd: string; output: string; exitCode: number | null; durationMs: number | null; status: ItemStatus; startedAt?: number }
  | { id: string; kind: "fileChange"; changes: FileChange[]; status: ItemStatus }
  // agent: a subagent's spawn, the thread its transcript is (subagentThread).
  | { id: string; kind: "tool"; name: string; input: string; output: string; status: ItemStatus; agent?: string; startedAt?: number }
  | { id: string; kind: "webSearch"; query: string }
  | { id: string; kind: "plan"; text: string }
  | { id: string; kind: "notice"; text: string }
  // The agent asked the user (the panel over the composer answers it): the questions, and once answered, each one's
  // answers in order (an empty list: left unanswered).
  | { id: string; kind: "question"; questions: { header: string; question: string }[]; answers: string[][] | null };

export type PlanStep = { step: string; status: "pending" | "inProgress" | "completed" };

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
  allowOther: boolean;
  secret: boolean;
  multiSelect: boolean; // pick any number of the options (else one)
};

// Permissions are always bypassed (full access), so the only thing a harness can ask the user is a question.
export type RuntimeRequest = { id: string; kind: "userInput"; turnId: string; itemId: string; questions: UserInputQuestion[] };

export type RequestResponse = { answers: Record<string, string[]> };

// fastTier: the service tier to request for "fast mode", when the model offers one.
export type ModelOption = { id: string; harness: HarnessId; name: string; efforts: string[]; defaultEffort: string; isDefault: boolean; fastTier: string | null };

/** A skill or command a prompt can use (the composer's `/` and `$` lists). `text`: how a prompt names it (`/simplify`
 *  for Claude Code, `$imagegen` for a Codex skill, `/compact`); `hint`: the arguments it takes. A command is the whole
 *  prompt: bismuth runs `/compact` and `/goal` where the harness has them. */
export type Invocable = { name: string; kind: "skill" | "command"; text: string; description: string; hint: string | null };

// A plan rate-limit window ("Session", "Week", "Month") and how much of it is spent.
export type UsageWindow = { label: string; usedPercent: number; resetsAt: number | null /* ms */ };

// Agent accounts (Settings → Providers): every login a CLI has had on this device, one of them live.
export type AgentAccount = {
  id: string;
  harness: HarnessId;
  email: string | null;
  displayName: string | null;
  organization: string | null;
  plan: string | null;
  authKind: "oauth" | "api-key";
  active: boolean;
  windows: UsageWindow[];
  usageFetchedAt: number | null; // ms; windows may be minutes old while a refresh runs
  usageError: string | null; // why the last probe failed ("Rate limited by Anthropic — retrying in 2m")
  switchable: boolean; // false for a live login whose credentials couldn't be read
  savedAt: number | null;
};
export type AgentAccountsSnapshot = { accounts: AgentAccount[]; warnings: { harness: HarnessId; message: string }[] };
// Open `url`, then poll until the browser lands — or, Claude's fallback, paste the code back.
export type AgentLoginStart = { loginId: string; url: string; mode: "browser" | "paste-code" };
// url: a sign-in page only known after the start reply; the app opens it once.
export type AgentLoginPoll = { status: "pending" | "done" | "error"; message?: string; url?: string };

// A provider CLI's version against upstream (Settings → Providers, Zeron's harness updates).
export type HarnessUpdatePolicy = "notify" | "autoWhenIdle" | "off";
export type HarnessUpdateStatus = {
  harness: HarnessId;
  policy: HarnessUpdatePolicy;
  phase: "dormant" | "checking" | "current" | "available" | "manual" | "waitingForIdle" | "installing" | "verifying" | "updated" | "failed" | "notInstalled";
  installedVersion: string | null;
  latestVersion: string | null;
  canApply: boolean; // bismuth can run the update (it knows what installed the CLI)
  manualCommand: string | null; // what to run otherwise
  error: string | null;
};

// Request/response calls over the socket (`rpc` → `rpcResult` with the same id).
// Terminals (Zeron's terminal panel): login shells the core owns, grouped by project rather than by session, so
// every session in a project shares them. They outlive UI reloads and detached viewers; `n` numbers them within
// their project ("Terminal 2"); exitCode is set once the shell has exited (the tab stays until closed).
export type TerminalInfo = { id: string; projectId: string; n: number; shell: string; cwd: string; exitCode: number | null; createdAt: number };

// The pending-message queue (Zeron's QueuedMessage): prompts typed while a turn ran, held by the core until the turn
// ends (then the head goes out as the next turn) or the user steers one in. `gate` keeps a row from going out:
// "editing" while a window has it in its composer, "review" when that window went away mid-edit (it never silently
// becomes sendable again). `paused`: why the queue is held until the next send or Resume: an explicit Stop, a turn that
// failed (the next would likely fail too), a core restart, or a queued message the harness refused (`message` says why).
export type QueuedMessage = { id: string; text: string; queuedAt: number; editedAt: number | null; gate: "editing" | "review" | null };
export type QueuePause = { reason: "stop" | "failed" | "restart" | "error"; message: string | null };
export type ThreadQueue = { items: QueuedMessage[]; paused: QueuePause | null };

export type RpcMethods = {
  "accounts.list": { params: { forceUsage: boolean }; result: AgentAccountsSnapshot };
  "accounts.activate": { params: { harness: HarnessId; id: string }; result: AgentAccountsSnapshot };
  "accounts.forget": { params: { harness: HarnessId; id: string }; result: AgentAccountsSnapshot };
  "accounts.login.start": { params: { harness: HarnessId }; result: AgentLoginStart };
  "accounts.login.poll": { params: { loginId: string }; result: AgentLoginPoll };
  "accounts.login.complete": { params: { loginId: string; code: string }; result: AgentAccountsSnapshot };
  "accounts.login.cancel": { params: { loginId: string }; result: null };
  "updates.list": { params: {}; result: HarnessUpdateStatus[] };
  "updates.check": { params: {}; result: HarnessUpdateStatus[] };
  "updates.apply": { params: { harness: HarnessId }; result: HarnessUpdateStatus[] };
  "updates.policy": { params: { harness: HarnessId; policy: HarnessUpdatePolicy }; result: HarnessUpdateStatus[] };
  "harness.install": { params: { harness: HarnessId }; result: null };
  "projects.add": { params: { path: string }; result: Project };
  "projects.rename": { params: { id: string; name: string | null }; result: null };
  "projects.remove": { params: { id: string }; result: null };
  "fs.list": { params: { path: string | null }; result: FolderListing };
  // A session folder's files (`root` is the folder; paths are relative to it): the right side's explorer and viewer.
  "files.list": { params: { root: string; path: string; all: boolean }; result: FileEntry[] };
  "files.read": { params: { root: string; path: string }; result: FileContent };
  "files.search": { params: { root: string; query: string; all: boolean }; result: string[] };
  // `since`: a session, for what changed since its last turn began, UNPUSHED or BRANCH (else since the last commit).
  "files.git": { params: { root: string; since?: string | null }; result: GitState };
  // A file as git has it staged (the index), for its changes in the editor: null when git has none of it.
  "files.base": { params: { root: string; path: string; since?: string | null }; result: string | null };
  // Paths here may also be absolute, for files outside the folder (ones an agent referenced).
  // expect: the mtime the text was read at (null: write whatever is there).
  "files.write": { params: { root: string; path: string; text: string; expect: number | null }; result: WriteResult };
  "files.create": { params: { root: string; path: string; kind: "file" | "dir" }; result: null };
  "files.rename": { params: { root: string; from: string; to: string }; result: null };
  // Answers the copy's path.
  "files.duplicate": { params: { root: string; path: string }; result: string };
  // To the system trash; `permanent` deletes outright (offered when the trash refused).
  "files.trash": { params: { root: string; paths: string[]; permanent?: boolean }; result: null };
  "files.reveal": { params: { root: string; path: string }; result: null };
  // The Changes view's git on the folder's repository (paths as above). A commit takes exactly `paths`, new files too.
  "git.changes": { params: { root: string; since?: string | null }; result: GitChanges };
  // `since`: back to before the session's last turn, or as pushed or branched (UNPUSHED, BRANCH) (else to the last commit).
  "git.discard": { params: { root: string; paths: string[]; since?: string | null }; result: null };
  "git.commit": { params: { root: string; message: string; paths: string[] }; result: null };
  "git.pull": { params: { root: string }; result: null };
  "git.push": { params: { root: string }; result: null };
  "git.sync": { params: { root: string }; result: null };
  /** A repository started in the folder (on `main`, unless git is set to start on another branch). */
  "git.init": { params: { root: string }; result: null };
  "git.log": { params: { root: string; skip?: number; limit?: number }; result: GitLog };
  "git.commitChanges": { params: { root: string; hash: string }; result: GitCommitChanges };
  /** A file's text at a commit (as the right side names it), or null: not there then, binary, or too large. */
  "git.blob": { params: { root: string; rev: string; path: string }; result: string | null };
  "files.openExternal": { params: { root: string; path: string }; result: null };
  // Where an HTML preview's relative URLs resolve: a base that serves the folder's files to the preview alone.
  "files.previewBase": { params: { root: string }; result: string };
  // Paths an agent wrote, each found (or null): absolute, relative, or a name that ends one of the folder's files.
  "files.resolve": { params: { root: string; refs: string[] }; result: (FileRef | null)[] };
  // The folders this window shows (relative, or absolute): a change in one arrives as `files.changed`. Replaces
  // the window's earlier set for that root; an empty list stops watching it.
  "files.watch": { params: { root: string; dirs: string[] }; result: null };
  // Go to definition: the language server for the file (the text as edited), else a search for where the word under
  // the position is defined.
  "files.definition": { params: { root: string; path: string; text: string; line: number; character: number }; result: FileLocation[] };
  // Settle every finished session in a project.
  "projects.settleAll": { params: { id: string }; result: null };
  // Settle a session (out of the active list) or bring it back.
  "threads.settle": { params: { id: string; settled: boolean }; result: null };
  // A side chat off a session: a new one in its harness with the same context (a native fork, so the prompt cache
  // carries over) through its last finished turn. A turn still running isn't part of it.
  "threads.fork": { params: { id: string }; result: ThreadSummary };
  // A side chat becomes a session of its own, in the sidebar.
  "threads.promote": { params: { id: string }; result: null };
  "app.restart": { params: { mode: RestartMode }; result: RestartResult };
  "autoCompact.get": { params: {}; result: AutoCompactSnapshot };
  // cwd: where the shell starts, the project folder or one of its worktrees (the project folder when left out).
  "terminals.open": { params: { projectId: string; cwd?: string; cols: number; rows: number }; result: TerminalInfo };
  // Settings → Worktrees.
  "worktrees.settings": { params: {}; result: WorktreeSettings };
  "worktrees.setSettings": { params: Partial<Omit<WorktreeSettings, "defaultRoot">>; result: WorktreeSettings };
  "worktrees.status": { params: {}; result: WorktreeStatus[] };
  // Remove a worktree (its folder; its branch too when bismuth made it and it's merged).
  "worktrees.remove": { params: { path: string }; result: null };
  // Run the cleanup rules now: what was removed, and what was kept and why.
  "worktrees.cleanup": { params: {}; result: { removed: string[]; kept: { path: string; reason: string }[] } };
  // The project folder shows a worktree's files (path), or its own again (null).
  "preview.set": { params: { projectId: string; path: string | null }; result: PreviewResult };
  "terminals.close": { params: { id: string }; result: null };
  // Reorder within its project's tabs.
  "terminals.move": { params: { id: string; index: number }; result: null };
  // value: tokens, or null to follow the CLI's own config.
  // Loaded Codex sessions reopen to pick it up: idle ones now, ones mid-turn when their turn ends.
  // Queue rows (the thread's queue comes back as a `queue` message; these settle once the core has applied them).
  "queue.move": { params: { threadId: string; id: string; index: number }; result: null };
  "queue.remove": { params: { threadId: string; id: string }; result: null };
  // Steer it into the running turn, or start the next turn with it when none runs. Resumes a paused queue.
  "queue.steer": { params: { threadId: string; id: string }; result: null };
  "queue.resume": { params: { threadId: string }; result: null };
  // Take a row into this window's composer: it keeps its place but can't go out until the edit finishes.
  "queue.edit.begin": { params: { threadId: string; id: string }; result: { text: string } };
  // text: the new text (empty removes the row), or null to cancel and keep the old one.
  "queue.edit.finish": { params: { threadId: string; id: string; text: string | null; settings: TurnSettings | null }; result: null };
  "autoCompact.set": { params: { harness: "claude" | "codex"; value: number | null }; result: AutoCompactSnapshot & { reopened: { now: number; afterTurn: number } | null } };
  "mcp.list": { params: { projectId: string }; result: McpSnapshot };
  // The skills and commands a prompt can use: a session's, or a new one's (its harness in that project).
  "invocables.list": { params: { threadId: string } | { harness: HarnessId; projectId: string }; result: Invocable[] };
  // Harnesses' switches for a server (one, or every one at once), in this project or all of them. Switching it back
  // to what it would be anyway drops the override. Loaded Codex sessions reopen to pick it up (idle ones now, ones
  // mid-turn when their turn ends); Claude's and Cursor's next runs get it.
  "mcp.set": { params: { projectId: string; harnesses: HarnessId[]; name: string; enabled: boolean; scope: McpScope }; result: McpSnapshot };
  // Which session holds which browser page (by its DevTools target; null: none any more). `all`: every page the
  // window has (a reconnected window's), the rest forgotten. Agents see their own session's pages (core/browser.ts).
  "browser.owners": { params: { owners: [string, string | null][]; all?: boolean }; result: null };
  // The window's answer to a `browser` ask: the page's target (an opened tab's), or why it couldn't.
  "browser.done": { params: { id: string; targetId?: string; error?: string }; result: null };
  "remote.get": { params: {}; result: RemoteAccess };
  "remote.set": { params: { enabled: boolean }; result: RemoteAccess };
};

// Settings → General's remote access: the UI on this machine's tailnet address (`tailscale serve`), for the devices
// signed in as `login`. `taken`: that port on the tailnet already serves something else.
export type RemoteAccess = { state: "unavailable"; reason: string } | { state: "on" | "off"; url: string; login: string; taken: boolean };

// Restart bismuth (command palette): the core checks the code it would start with, then restarts under the
// desktop shell. "ifIdle" only restarts when nothing runs (else reports how many do); "whenIdle" waits for them;
// "now" stops them; "cancel" drops a wait.
export type RestartMode = "ifIdle" | "whenIdle" | "now" | "cancel";
export type RestartResult = { running: number; state: "running" | "scheduled" | "restarting" | "cancelled" };

// Settings → Providers' auto-compact point: bismuth's override, and what the CLI's own config says without it.
export type AutoCompactInfo = { value: number | null; inherited: number | null; inheritedFrom: string };
export type AutoCompactSnapshot = { claude: AutoCompactInfo; codex: AutoCompactInfo };

// MCP servers (Ctrl+K → MCP servers): every server any harness defines, and each harness's switch for it in a project.
// A harness runs the servers its own config has (bismuth can switch those off, or on), and bismuth can carry a
// server another harness defines over to it, passing the definition to each run. Switches are bismuth's (the CLIs'
// configs stay untouched), set for one project or for all of them; Cursor's switch for a server its own config has
// is Cursor's own per-project list, which its CLI shares.
export type McpStatus = "connected" | "starting" | "failed" | "needsAuth" | "disabled";
/** One harness's side of a server in a project. */
export type McpUse = {
  native: boolean; // the harness's own config has it (else bismuth carries the definition over)
  enabled: boolean; // what new runs in the project get
  scope: "project" | "all" | null; // where bismuth's switch for it is set (null: the harness's own config decides)
  locked: string | null; // why it can't be switched for this harness
  status: McpStatus | null; // as a run in the project last reported it
  tools: number | null;
};
export type McpServer = {
  name: string;
  from: HarnessId | "bismuth"; // the harness whose config defines it (the first, when several do), or bismuth's own
  title?: string; // bismuth's own: what it's called in the list (name is what the agents see)
  source: string; // where: "~/.codex/config.toml", ".mcp.json", "Plugin"…
  target: string | null; // the command it runs or the URL it talks to
  uses: Partial<Record<HarnessId, McpUse>>; // one per available harness
};
export type McpSnapshot = { harnesses: HarnessId[]; servers: McpServer[] };
export type McpScope = "project" | "all";

// harness: which harness a new session starts on (an existing thread keeps its own).
export type TurnSettings = { harness: HarnessId; model: string | null; effort: string | null; serviceTier: string | null };

// A harness the core knows: available once its CLI started (or was found).
export type HarnessInfo = { id: HarnessId; name: string; available: boolean; error: string | null };

// Token usage across the subscriptions (Settings → Usage), from local transcripts and Cursor's account history.
export type UsageProvider = "claude" | "codex" | "cursor";
// input is uncached input; reasoning is part of output, never added to totals.
export type UsageTokens = { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
export type UsageModelRow = { provider: UsageProvider; model: string; tokens: number; cost: number; unpriced: boolean };
export type UsageReport = {
  days: number;
  since: number; // ms
  until: number; // ms
  hourly: boolean; // periods are hour starts (ms, as strings) instead of local days (YYYY-MM-DD)
  totalTokens: number;
  tokens: UsageTokens;
  cost: number; // USD: provider-reported where given, else LiteLLM list prices (an API-rate estimate)
  costSplit: { input: number; cacheRead: number; cacheWrite: number; output: number; unsplit: number };
  cacheSavings: number;
  unpricedShare: number; // share of tokens no price was found for
  sessions: number;
  providers: { provider: UsageProvider; tokens: number; cost: number; sessions: number }[];
  periods: { key: string; byProvider: Partial<Record<UsageProvider, { tokens: number; cost: number }>> }[];
  models: UsageModelRow[];
  notes: string[];
};

// ---------- wire protocol between server and browser ----------

export type ThreadEvent =
  | { type: "thread.upsert"; thread: Omit<Thread, "turns" | "requests"> }
  | { type: "turn.upsert"; turn: Omit<Turn, "items"> }
  | { type: "thread.archived" }
  | { type: "item.upsert"; turnId: string; item: Item }
  | { type: "item.delta"; turnId: string; itemId: string; field: "text" | "output" | "summary"; index?: number; delta: string }
  | { type: "request.upsert"; request: RuntimeRequest }
  | { type: "request.remove"; requestId: string };

export type ServerMessage =
  // device: this machine's name; launch: the project the app was opened on (`bun run app <dir>`), if any.
  | { type: "hello"; device: string; home: string; projects: Project[]; launch: string | null; harnesses: HarnessInfo[]; models: ModelOption[]; threads: ThreadSummary[]; queues: Record<string, ThreadQueue>; uiState: Record<string, string>; ready: boolean; error: string | null }
  // A thread's queue changed (every window gets every queue). `sent`: a row left it because it's going to the agent
  // now (the window shows it in the conversation until the harness records it).
  | { type: "queue"; threadId: string; queue: ThreadQueue; sent?: { id: string; text: string; at: number } }
  | { type: "threads"; threads: ThreadSummary[] }
  | { type: "projects"; projects: Project[] } // added, renamed or removed (the thread list follows)
  | { type: "settlement"; threadId: string; settledAt: number | null } // settled, un-settled, or woken by a new turn
  // A restart was scheduled, cancelled, is happening now, or failed its checks when the wait ended.
  | { type: "restart"; state: "scheduled" | "cancelled" | "restarting" | "failed"; running: number; error: string | null }
  // `bun run apply` changed code only a restart loads (core/, shared/): the files, for the "Restart needed" notice.
  | { type: "restartNeeded"; files: string[] }
  // A session's agent driving the browser (core/browser.ts) wants a tab opened at `url` in its session's panel, or
  // the one holding a page's DevTools target closed or shown. The desktop window does it and answers with browser.done.
  | { type: "browser"; id: string; op: "open"; session: string; url: string }
  | { type: "browser"; id: string; op: "close" | "show"; session: string; targetId: string }
  // The pages agents hold now (by DevTools target): kept awake, rendering and laid out, wherever their tabs are.
  | { type: "browserAwake"; targets: string[] }
  // Another window changed a shared UI setting (core/uistate.ts): a localStorage entry, null when removed.
  | { type: "uiState"; key: string; value: string | null }
  | { type: "harnesses"; harnesses: HarnessInfo[]; models: ModelOption[] } // a harness came up (install) or went down
  | { type: "thread"; thread: Thread } // full snapshot for the thread a client opened
  | { type: "event"; threadId: string; event: ThreadEvent }
  | { type: "usageReport"; days: number; report: UsageReport }
  | { type: "usageReportFailed"; days: number; message: string }
  | { type: "rpcResult"; id: number; result?: unknown; error?: string }
  | { type: "terminals"; terminals: TerminalInfo[] } // every terminal, in tab order: after hello and on any change
  // Watched folders (`files.watch`) whose entries or files changed, as the window named them; `git`: the repository's
  // state moved (a commit, staging).
  | { type: "files.changed"; root: string; dirs: string[]; git: boolean }
  // A session's folder was snapshotted as its turn began: what its "Last turn" changes now compare with.
  | { type: "turnSnapshot"; threadId: string }
  // A shell's output (seq numbers each chunk, so a re-attach resumes after the last one seen) and its exit.
  | { type: "terminal.output"; id: string; seq: number; data: string }
  | { type: "terminal.exit"; id: string; seq: number; code: number }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "open"; threadId: string }
  // projectId: where a new session (threadId null) starts.
  // worktree: the new session gets a worktree of its own (core/worktrees.ts) off the project's branch.
  | { type: "send"; threadId: string | null; projectId: string | null; text: string; settings: TurnSettings; worktree?: boolean }
  // Hold a prompt until the thread's turn ends (sent at once if none is running).
  | { type: "queue.add"; threadId: string; text: string; settings: TurnSettings }
  | { type: "interrupt"; threadId: string }
  | { type: "archive"; threadId: string }
  // This window changed a shared UI setting. `seed`: a value it had before the core held one (core/main.ts).
  | { type: "uiState.set"; key: string; value: string | null; seed?: boolean }
  | { type: "usage.report"; days: number } // token usage over the last `days` (1 = past 24h, hourly)
  | { type: "respond"; threadId: string; requestId: string; response: RequestResponse }
  // Stream a terminal: the replay after `afterSeq` (its last ~1 MB), then live output, until detached.
  | { type: "terminal.attach"; id: string; afterSeq: number }
  | { type: "terminal.detach"; id: string }
  | { type: "terminal.input"; id: string; data: string }
  | { type: "terminal.resize"; id: string; cols: number; rows: number }
  | { [M in keyof RpcMethods]: { type: "rpc"; id: number; method: M; params: RpcMethods[M]["params"] } }[keyof RpcMethods];
