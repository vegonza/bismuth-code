// The right side (Zeron's right pane: shell.rs `render_right_pane`, shell/files_panel.rs, files/): two columns that
// open on their own.
// - The surface host: tabs across its top band, the open tab below, and a short list of what can open while there's
//   none. Files are its only kind of tab for now; others go beside them. Mod+Alt+B toggles it (it never hides the
//   explorer), the expand button gives it the chat's room too, and closing its last tab puts it away.
// - The file explorer, the rightmost column: the session folder's tree (ignored files hidden until the eye shows
//   them, git changes coloured). Mod+E toggles it; opening a file opens the host beside it. Mod+P finds the folder's
//   files by name (the palette's Go to file, palette.ts).
// Both toggles sit at the window's top-right corner, open or not. What's open is kept per session, like Zeron's
// per-chat panels; the new-session screen keeps its own per project, which a session started there begins with.
import { Transaction, type TransactionSpec } from "@codemirror/state";
import { isPhone } from "./phone";
import { BRANCH, UNPUSHED, type FileContent, type FileEntry, type FileLocation, type FileRef, type GitStatus, type WriteResult } from "../shared/model";
import { codeState, codeView, EditorView, type CodeHooks, type EditorState } from "./code";
import { changesStore, changesView, lineCounts, SCOPES, type ChangesStore } from "./changes";
import { graphView } from "./graph";
import { commitSource, reviewView, uncommittedSource } from "./review";
import { baseSpec, changeCount, hasBase, showChangesSpec, showsChanges } from "./gitdiff";
import { $, el, picturesIn, picturesPending } from "./dom";
import { fileGlyph, iconKey, loadIcons } from "./fileicons";
import { icon, type IconName } from "./icons";
import { displayCombo } from "./keymap";
import { csvView, dropCsv, sheetView } from "./csvview";
import { diagrams } from "./diagrams";
import { renderLatex } from "./latex";
import { renderMarkdown } from "./markdown";
import { setOpener, type Cited } from "./refs";
import { dropNotebook, notebookDirty, notebookSaved, notebookText, notebookView } from "./notebook";
import { dropPdf, pdfBar, pdfView } from "./pdfview";
import { canSavePdf, savePdf } from "./printpdf";
import { onPrefs, prefs, setPrefs, type ChangesScope, type ShortcutId } from "./prefs";
import { call, on, store, tildePath, workFolder } from "./store";
import { reducedMotion, RESIZE_MS } from "./motion";
import { contextMenu as openContextMenu, menuPoint, toggleSwitch, type MenuEntry, type Popover } from "./popover";
import { dialog, select as selectMenu } from "./widgets";
import { activeTheme, onTheme, terminalPalette } from "./theme";

// Zeron's settings.rs widths.
const FILES_DEFAULT = 286;
const FILES_MIN = 220;
const FILES_MAX = 440;
const PANE_DEFAULT = 520;
const PANE_MIN = 360;
const CHAT_MIN = 300;
const SIDEBAR_W = 224;
/** Zeron's tree metrics (files/tree.rs). */
const INDENT = 14;
/** Files remembered per folder as recently shown, and how many Go to file suggests before anything's typed. */
const RECENT_MAX = 30;
const SUGGEST_MAX = 50;

// ---------------- persisted state ----------------

/** `preview`: the tab a single click opened, replaced by the next one until it's kept (VS Code's preview editor). */
type SessionPanels = { files: boolean; surfaces: boolean; tabs: string[]; active: string | null; preview?: string | null };
/** `recent`: each folder's files most recently shown, newest first (Go to file lists them before anything's typed). */
/** `view`: what the sidebar shows, the folder's files or its git changes. `changedOnly`: the tree shows only what
 *  changed (in the scope picked), for reviewing. */
type Saved = { filesW: number; paneW: number; showAll: boolean; sessions: Record<string, SessionPanels>; expanded: Record<string, string[]>; recent: Record<string, string[]>; view?: SidebarView; changedOnly?: boolean };
type SidebarView = "files" | "changes";
const saved: Saved = { filesW: FILES_DEFAULT, paneW: PANE_DEFAULT, showAll: false, sessions: {}, expanded: {}, recent: {}, ...JSON.parse(localStorage.getItem("bismuth.panels") ?? "{}") };
const nothingOpen = (s: SessionPanels | undefined) => !s || (!s.files && !s.surfaces && !s.tabs.length);
function persist() {
  // Sessions with nothing open aren't worth keeping.
  for (const [id, s] of Object.entries(saved.sessions)) if (nothingOpen(s)) delete saved.sessions[id];
  localStorage.setItem("bismuth.panels", JSON.stringify(saved));
}

/** Whose panels show: the open session's, or on the new-session screen its project folder's (null while a session is
 *  on its way, or with no project to show). */
function panelsKey(): string | null {
  if (store.thread) return store.thread.id;
  const r = root();
  return r ? NEW_SCREEN + r : null;
}
const NEW_SCREEN = "new@";
/** The open session's panels (made on first use). */
function session(): SessionPanels | null {
  const id = panelsKey();
  return id ? (saved.sessions[id] ??= { files: false, surfaces: false, tabs: [], active: null }) : null;
}
/** The folder the explorer shows. */
const root = workFolder;

/** Takeover: the surface host over the chat's room. Not kept: closing the host leaves it (Zeron). */
let expanded = false;

export const filesOpen = () => !!session()?.files;
export const paneOpen = () => !!session()?.surfaces;

// ---------------- the explorer's model ----------------

type Tree = {
  children: Map<string, FileEntry[]>;
  /** Listings under way, so each folder is asked for once at a time. */
  loading: Map<string, Promise<void>>;
  errors: Map<string, string>;
  expanded: Set<string>;
  selected: string | null;
  git: Record<string, GitStatus>;
  /** Folders holding changes, coloured like the strongest change inside. */
  gitDirs: Map<string, GitStatus>;
  /** In a repository (the changes switch shows); for "Last turn", whether the session has a turn to show. */
  repo: boolean;
  turn: boolean;
  /** On a branch other than the default one: "Branch" is offered. */
  branched: boolean;
  /** The top folder and every folder kept open are listed: the tree shows whole, never filling in row by row. */
  ready: boolean;
};
const trees = new Map<string, Tree>();
function treeOf(r: string): Tree {
  let t = trees.get(r);
  if (!t) {
    t = { children: new Map(), loading: new Map(), errors: new Map(), expanded: new Set(saved.expanded[r] ?? []), selected: null, git: {}, gitDirs: new Map(), repo: false, turn: true, branched: false, ready: false };
    trees.set(r, t);
  }
  return t;
}
function keepExpanded(r: string, t: Tree) {
  if (t.expanded.size) saved.expanded[r] = [...t.expanded];
  else delete saved.expanded[r];
  persist();
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
/** A file's extension ("" for none, or a dotfile like .gitignore). */
const extOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
/** Folders first by name, then files by name or, sorted by type, by extension and then name. */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  const type = prefs.fileSort === "type";
  return entries.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : (type && a.kind === "file" && extOf(a.name).localeCompare(extOf(b.name))) || byName(a, b),
  );
}

/** One folder's listing, with every icon it shows, so its rows appear complete. */
async function list(r: string, dir: string, all = saved.showAll): Promise<FileEntry[]> {
  const entries = await call("files.list", { root: r, path: dir, all });
  await loadIcons(entries.map((e) => iconKey(e.name, e.kind === "dir")));
  return sortEntries(entries);
}

/** A folder listed (again). Resolves once it's in the model; the tree isn't redrawn here. */
function load(r: string, dir: string): Promise<void> {
  const t = treeOf(r);
  const running = t.loading.get(dir);
  if (running) return running;
  const job = list(r, dir)
    .then((entries) => {
      t.children.set(dir, entries);
      t.errors.delete(dir);
    })
    .catch((err: any) => {
      // A folder that went away just folds up; anything else shows with a retry.
      if (dir && /no longer exists/.test(String(err?.message))) t.expanded.delete(dir), t.children.delete(dir);
      else t.errors.set(dir, String(err?.message ?? err));
    })
    .finally(() => t.loading.delete(dir));
  t.loading.set(dir, job);
  return job;
}

/** Folders a click may open next are listed ahead of it (the children of what's in view, and whatever the pointer
 *  rests on), two at a time, so opening one is instant. */
const queued: { r: string; dir: string }[] = [];
let prefetching = 0;
function prefetch(r: string, dirs: string[]) {
  const t = treeOf(r);
  for (const dir of dirs) if (!t.children.has(dir) && !t.loading.has(dir) && !t.errors.has(dir) && !queued.some((q) => q.r === r && q.dir === dir)) queued.push({ r, dir });
  while (prefetching < 2 && queued.length) {
    const next = queued.shift()!;
    prefetching++;
    void load(next.r, next.dir).finally(() => {
      prefetching--;
      markEmpty(next.r, next.dir);
      prefetch(next.r, []);
    });
  }
}
/** A folder found empty ahead of a click greys out where it's drawn, without redrawing the tree. */
function markEmpty(r: string, dir: string) {
  if (root() !== r || treeOf(r).children.get(dir)?.length !== 0) return;
  const row = treeEl.querySelector<HTMLElement>(`.ft-row[data-path="${CSS.escape(dir)}"]`);
  if (row) row.classList.add("empty"), (row.dataset.sig = "");
}
/** The folders in view whose contents aren't listed yet, the first ones first. */
function prefetchVisible(r: string, t: Tree) {
  const dirs: string[] = [];
  for (const row of rowsOf(t, "", 0, [])) if (row.e.kind === "dir" && !t.children.has(row.e.path)) dirs.push(row.e.path);
  prefetch(r, dirs.slice(0, 40));
}

/** How long a first showing waits for git, so the tree appears already coloured; a slower repository's colours follow. */
const GIT_WAIT_MS = 400;

/** First showing: the top folder and the folders kept open, all listed before anything is drawn. */
async function ready(r: string) {
  const t = treeOf(r);
  if (t.ready) return;
  const git = loadGit(r).then(() => t.ready && root() === r && renderExplorer());
  await load(r, "");
  // Open folders inside open folders: list level by level, dropping ones that no longer exist.
  for (let depth = 1; ; depth++) {
    const level = [...t.expanded].filter((d) => d.split("/").length === depth && t.children.has(parentOf(d)) && !t.children.has(d));
    if (!level.length) break;
    await Promise.all(level.map((d) => load(r, d)));
  }
  await Promise.race([git, new Promise((done) => setTimeout(done, GIT_WAIT_MS))]);
  t.ready = true;
  if (root() === r) renderExplorer();
}

/** Every listing in view again, swapped in at once (the tree never empties in between): showing ignored files or not. */
async function relist(r: string) {
  const t = treeOf(r);
  const dirs = ["", ...[...t.expanded].filter((d) => t.children.has(d))];
  const fresh = await Promise.all(dirs.map((d) => list(r, d).then((e) => [d, e] as const, () => null)));
  t.children = new Map(fresh.filter((x) => x !== null) as [string, FileEntry[]][]);
  if (root() === r) renderExplorer();
}

const GIT_RANK: Record<GitStatus, number> = { conflict: 5, modified: 4, renamed: 3, deleted: 3, added: 2, untracked: 1 };
/** VS Code's letter for each change, and what its tooltip calls it. */
const GIT_BADGE: Record<GitStatus, [string, string]> = {
  modified: ["M", "Modified"], added: ["A", "Added"], untracked: ["U", "Untracked"], deleted: ["D", "Deleted"], renamed: ["R", "Renamed"], conflict: ["!", "Conflict"],
};
/** git status runs one at a time per folder; a change while one runs asks for one more after it. */
const gitLoads = new Map<string, { run: Promise<void>; again: boolean }>();
/** The folder's changes into the model (not drawn here). `changed`: something changed on disk just now, so a run
 *  already under way may have missed it. */
function loadGit(r: string, changed = false): Promise<void> {
  const running = gitLoads.get(r);
  if (running) {
    running.again ||= changed;
    return running.run;
  }
  const job = { run: Promise.resolve(), again: false };
  job.run = (async () => {
    let current = true;
    do {
      job.again = false;
      current = await fetchGit(r);
    } while (job.again || !current);
    gitLoads.delete(r);
  })();
  gitLoads.set(r, job);
  return job.run;
}

/** What the changes are since: for "Last turn" the session's id ("" with none open yet), the last push (UNPUSHED), the
 *  branch's start (BRANCH), or null for the last commit. */
const SINCE: Record<ChangesScope, () => string | null> = { turn: () => store.thread?.id ?? "", uncommitted: () => null, unpushed: () => UNPUSHED, branch: () => BRANCH };
/** The scope a folder's changes show: the one picked, but "Branch" only on a branch of its own (else Uncommitted). */
const scopeOf = (t: Tree): ChangesScope => (prefs.changesScope === "branch" && !t.branched ? "uncommitted" : prefs.changesScope);
const changesSince = (r: string) => SINCE[scopeOf(treeOf(r))]();

/** Answers whether what it read is still what's asked for (not another scope's, or another session's turn). */
async function fetchGit(r: string): Promise<boolean> {
  const t = treeOf(r);
  const since = changesSince(r);
  try {
    const state = await call("files.git", { root: r, since: since || null });
    if (changesSince(r) !== since) return false;
    // Onto or off a branch of its own, with "Branch" picked: read again for the scope that now shows.
    t.branched = !!state.branched;
    if (changesSince(r) !== since) return false;
    // No session yet: nothing it did to show (the call still says whether there's a repository).
    Object.assign(t, { git: since === "" ? {} : state.status, repo: state.repo, turn: since !== "" && state.turn !== false });
  } catch {
    if (changesSince(r) !== since) return false;
    t.git = {};
  }
  t.gitDirs = new Map();
  for (const [path, status] of Object.entries(t.git)) {
    // As in VS Code, a deletion marks only itself (in search): the folders it was in stay plain.
    if (status === "deleted") continue;
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) {
      const was = t.gitDirs.get(dir);
      if (!was || GIT_RANK[status] > GIT_RANK[was]) t.gitDirs.set(dir, status);
    }
  }
  // Staging or a commit may have moved git's copy of any file: the one showing reads it again, the rest when shown.
  gitGens.set(r, (gitGens.get(r) ?? 0) + 1);
  const s = session();
  if (root() === r && s?.surfaces && s.active) void loadBase(r, s.active);
  // The Changes view and the review read the repository with it.
  if (root() === r) void changesData.refresh();
  return true;
}

/** What changes are against moved (the other scope, or for "Last turn" another session or a new turn of this one):
 *  the explorer's marks and every file's copy to compare with are read again. */
function rescope() {
  for (const d of docs.values()) d.baseGen = -1;
  const r = root();
  const s = session();
  if (!r || !s) return;
  if (s.files || peeking) void loadGit(r, true).then(() => root() === r && renderExplorer());
  else {
    if (s.surfaces && s.active) void loadBase(r, s.active);
  }
}

/** The explorer's marks and the editors' changes: since the last commit, the open session's last turn, the last push,
 *  or the branch's start. */
export const showChangesSince = (scope: ChangesScope) => setPrefs({ changesScope: scope });

/** A session about to run a turn kept its folder as it stood: "Last turn" now means that one. */
export function turnSnapshot(threadId: string) {
  if (prefs.changesScope === "turn" && store.thread?.id === threadId) rescope();
}

/** Each root's git status reads so far: a file's git copy read since the last is current. */
const gitGens = new Map<string, number>();

/** A text file as it was (at the last commit, or before the session's last turn), for its editor to show what
 *  changed against. */
async function loadBase(r: string, path: string) {
  const key = docKey(r, path);
  const d = docs.get(key);
  const gen = gitGens.get(r) ?? 0;
  if (!d?.state || isAbs(path) || d.baseGen === gen) return;
  d.baseGen = gen;
  const since = changesSince(r);
  let text: string | null = null;
  try {
    if (since !== "") text = await call("files.base", { root: r, path, since });
  } catch {}
  if (docs.get(key) !== d || d.baseGen !== gen) return;
  const st = stateOf(key, d);
  const spec = st && baseSpec(st, text);
  if (spec) changeDoc(key, d, spec);
}

/** Everything shown again from disk: the listed folders, git, the open file. */
let refreshTimer: Timer | null = null;
function refresh(delay = 0) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const r = root();
    const s = session();
    if (!r || !s || (!s.files && !s.surfaces && !peeking)) return;
    if (s.files || peeking) {
      const t = treeOf(r);
      const dirs = t.ready ? ["", ...[...t.expanded].filter((d) => t.children.has(d))] : [];
      void Promise.all([loadGit(r), ...dirs.map((d) => load(r, d))]).then(() => root() === r && renderExplorer());
    }
    if (s.surfaces && s.active) void loadFile(r, s.active, true);
    // The review open without the explorer (which reads git, and with it the changes): read them here.
    if (s.surfaces && s.tabs.includes(REVIEW) && !(s.files || peeking)) void changesData.refresh();
  }, delay);
}

// ---------------- the file viewer's model ----------------

/** An open file. Text opens in the editor: `state` holds it as edited (with its undo history) while it's off screen;
 *  on screen, the live editor holds it. */
type Doc = {
  content: FileContent | null;
  error: string | null;
  loading: boolean;
  /** Markdown and notebooks show rendered (HTML when asked); the source, in the editor, is a toggle away. */
  rendered: boolean;
  state: EditorState | null;
  /** What the edits started from: the text on disk then, and its mtime (a save is refused once the file moved on). */
  disk: string | null;
  mtime: number | null;
  dirty: boolean;
  /** The file changed on disk under unsaved edits: what it is now, for the bar that asks which to keep. */
  theirs: { text: string; mtime: number } | null;
  /** The git status read its editor's git copy is from (see `loadBase`); -1 before one. */
  baseGen: number;
};
const docs = new Map<string, Doc>();
const docKey = (r: string, path: string) => `${r}\0${path}`;
/** Where each file's editor was scrolled, in pixels. */
const scrolls = new Map<string, number>();
/** Where each file's view (a preview, an image, a PDF) was scrolled: see `ScrollSpot`. */
const spots = new Map<string, ScrollSpot>();
/** Each LaTeX or Markdown file's preview as last drawn, and from what: shown again as it was (its figures and diagrams
 *  in) rather than drawn afresh each time its tab comes back. */
const previews = new Map<string, { from: string; node: HTMLElement }>();
const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path);
const isNotebook = (path: string) => /\.ipynb$/i.test(path);
const isHtml = (path: string) => /\.html?$/i.test(path);
const isLatex = (path: string) => /\.(tex|latex|ltx)$/i.test(path);
const isCsv = (path: string) => /\.(csv|tsv|tab|psv)$/i.test(path);
const isSheet = (path: string) => /\.(xlsx|xlsm|xlsb|xls|ods|fods|numbers)$/i.test(path);
/** Past this a workbook isn't read in the window (it's decoded whole). */
const MAX_SHEET_BYTES = 64 * 1024 * 1024;
/** Files with a rendered view beside their source. */
const renders = (path: string) => isMarkdown(path) || isNotebook(path) || isHtml(path) || isLatex(path) || isCsv(path);
/** Files the viewer can't show, opened in their own app instead (a PDF an agent cites, say). */
const EXTERNAL = /\.(docx?|xlsx?|pptx?|od[tsp]|epub|rtf|mp[34]|m4a|mov|mkv|webm|avi|wav|flac|ogg|zip|tar|t?gz|7z|rar|dmg|iso|exe|appimage)$/i;
const isAbs = (path: string) => path.startsWith("/");
const dirOf = (path: string) => (isAbs(path) ? path.slice(0, path.lastIndexOf("/")) || "/" : parentOf(path));

/** The editor on screen, when a text file shows. */
let live: { key: string; view: EditorView } | null = null;
const stateOf = (key: string, d: Doc) => (live?.key === key ? live.view.state : d.state);
/** A doc's text as edited, with the file's own line breaks. */
const textOf = (key: string, d: Doc) => stateOf(key, d)?.sliceDoc() ?? d.disk ?? "";
const isDirty = (r: string, path: string) => !!docs.get(docKey(r, path))?.dirty;

// Unsaved edits outlast a reload of the window (applying a UI update reloads it): kept per file until saved or
// dropped, and taken up again when the file next opens.
type Draft = { text: string; mtime: number | null };
const DRAFTS = "bismuth.fileDrafts";
// Before having their own key these shared "bismuth.drafts" with the composer's prompts (drafts.ts), and each
// side's writes wiped the other's: take any found there back.
const drafts: Record<string, Draft> = JSON.parse(
  localStorage.getItem(DRAFTS) ??
    JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem("bismuth.drafts") ?? "{}")).filter(([, v]) => typeof v === "object"))),
);
let draftTimer: Timer | null = null;
const writeDrafts = () => {
  if (draftTimer) clearTimeout(draftTimer), (draftTimer = null);
  localStorage.setItem(DRAFTS, JSON.stringify(drafts));
};
function keepDraft(key: string, d: Doc) {
  if (d.dirty) drafts[key] = { text: textOf(key, d), mtime: d.mtime };
  else if (key in drafts) delete drafts[key];
  else return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDrafts, 300);
}

/** A change to a doc's text: through its editor when that's on screen. */
function changeDoc(key: string, d: Doc, spec: TransactionSpec) {
  if (live?.key === key) live.view.dispatch(spec);
  else if (d.state) d.state = d.state.update(spec).state;
}

/** A doc's text replaced by `text`, touching only what differs, so the caret and the scroll stay where they were.
 *  `undoable`: the user chose it (taking the disk's version over theirs), so undo brings their edits back. */
function setText(key: string, d: Doc, text: string, undoable: boolean) {
  const st = stateOf(key, d);
  if (!st) return;
  // Positions count a line break as one character, whatever the file's are.
  const cur = st.doc.toString();
  const next = text.replace(/\r\n?/g, "\n");
  if (cur === next) return;
  let a = 0;
  const max = Math.min(cur.length, next.length);
  while (a < max && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
  const insert = next.slice(a, next.length - b).replace(/\n/g, st.lineBreak);
  changeDoc(key, d, { changes: { from: a, to: cur.length - b, insert }, annotations: Transaction.addToHistory.of(undoable) });
}

const shown = (r: string, path: string) => root() === r && session()?.active === path;

function hooksFor(r: string, path: string): CodeHooks {
  return { edited: () => edited(r, path), definition: (pos) => void goToDefinition(r, path, pos), changes: () => (changesShown(docKey(r, path)), shown(r, path) && renderBar()) };
}

/** Read a file (again): a text file's editor follows the disk while it has no unsaved edits; with some, a change
 *  on disk is held for the bar to offer. */
async function loadFile(r: string, path: string, again = false) {
  if (isReviewTab(path)) return;
  const key = docKey(r, path);
  let d = docs.get(key);
  if (d && !again) return;
  if (!d) docs.set(key, (d = { content: null, error: null, loading: true, rendered: isMarkdown(path) || isNotebook(path) || isLatex(path) || isCsv(path), state: null, disk: null, mtime: null, dirty: false, theirs: null, baseGen: -1 }));
  let c: FileContent;
  try {
    c = await call("files.read", { root: r, path });
  } catch (err: any) {
    const was = d.error;
    // Gone from disk: unsaved edits stay (a save writes the file again).
    d.error = String(err?.message ?? err);
    d.loading = false;
    if (was !== d.error && shown(r, path)) renderPane();
    return;
  }
  if (docs.get(key) !== d) return; // closed (or discarded) meanwhile
  let changed = d.loading || d.error !== null || c.kind !== d.content?.kind;
  d.loading = false;
  d.error = null;
  d.content = c;
  if (c.kind !== "text") {
    changed ||= c.mtime !== d.mtime;
    Object.assign(d, { state: null, disk: null, mtime: c.mtime, dirty: false, theirs: null, baseGen: -1 });
  } else if (!d.state) {
    const draft = drafts[key];
    d.state = codeState(draft?.text ?? c.text, path, hooksFor(r, path));
    d.disk = c.text;
    d.mtime = c.mtime;
    d.dirty = !!draft && draft.text !== c.text;
    // Edits kept from before a reload, made to an older version than the one on disk now: saving asks first.
    if (d.dirty && draft!.mtime !== null && draft!.mtime !== c.mtime) (d.mtime = draft!.mtime), (d.theirs = { text: c.text, mtime: c.mtime });
    if (!d.dirty) keepDraft(key, d);
    d.baseGen = -1;
    void loadBase(r, path);
    changed = true;
  } else if (c.mtime !== d.mtime && c.mtime !== d.theirs?.mtime) {
    if (!d.dirty || c.text === textOf(key, d)) {
      setText(key, d, c.text, false);
      Object.assign(d, { disk: c.text, mtime: c.mtime, dirty: false, theirs: null });
      keepDraft(key, d);
    } else if (c.text === d.disk) d.mtime = c.mtime; // only touched
    else d.theirs = { text: c.text, mtime: c.mtime };
    changed = true;
  }
  if (changed && shown(r, path)) renderPane();
}

/** Typing: the tab shows it unsaved (and stops being a preview), and the edits are kept against a reload. */
function edited(r: string, path: string) {
  const key = docKey(r, path);
  const d = docs.get(key);
  if (!d) return;
  const was = d.dirty;
  d.dirty = textOf(key, d) !== d.disk;
  keepDraft(key, d);
  if (session()?.preview === path) pin(path);
  else if (was !== d.dirty) renderBar();
}

/** Mod+S: the file written (refused if it changed on disk meanwhile, which then asks), its tab kept. */
async function saveDoc(r: string, path: string, overwrite = false): Promise<boolean> {
  const key = docKey(r, path);
  const d = docs.get(key);
  pin(path);
  if (!d || !stateOf(key, d)) return false;
  if (isNotebook(path)) syncNotebook(key, d);
  if (!d.dirty && !d.error && !overwrite) return true;
  const text = textOf(key, d);
  let res: WriteResult;
  try {
    res = await call("files.write", { root: r, path, text, expect: overwrite ? null : d.mtime });
  } catch (err: any) {
    flash(`Couldn't save ${baseName(path)}: ${err?.message ?? err}`);
    return false;
  }
  if (!res.ok) {
    askOverwrite(r, path);
    return false;
  }
  Object.assign(d, { disk: text, mtime: res.mtime, theirs: null, error: null });
  if (isNotebook(path)) notebookSaved(key, res.mtime);
  // Typed while it was being written: still unsaved.
  d.dirty = textOf(key, d) !== text;
  keepDraft(key, d);
  if (shown(r, path)) renderPane();
  return !d.dirty;
}

/** Saving found the file changed on disk since the edits began. */
function askOverwrite(r: string, path: string) {
  dialog(`${baseName(path)} changed on disk`, "It was changed (by an agent, or another app) after you started editing it. Keep your version over it, or take the one on disk? Undo brings your edits back if you take theirs.", [
    ["Cancel", "filled", () => {}],
    ["Use the disk version", "filled", () => void takeTheirs(r, path)],
    ["Overwrite", "solid", () => void saveDoc(r, path, true)],
  ]);
}

/** The disk's version over the edits (undoable). */
async function takeTheirs(r: string, path: string) {
  const key = docKey(r, path);
  const d = docs.get(key);
  if (!d) return;
  let c: FileContent;
  try {
    c = await call("files.read", { root: r, path });
  } catch (err: any) {
    return flash(String(err?.message ?? err));
  }
  if (c.kind !== "text") return;
  setText(key, d, c.text, true);
  Object.assign(d, { content: c, disk: c.text, mtime: c.mtime, dirty: false, theirs: null });
  keepDraft(key, d);
  if (isNotebook(path)) dropNotebook(key), (bodyShows = "");
  // Back in the editor (the bar's button that had the focus is gone), where undo brings the edits back.
  if (live?.key === key) pendingAt = { key, at: { line: -1, character: 0 }, focus: true };
  if (shown(r, path)) renderPane();
}

/** A closed file's model and unsaved edits let go. */
function dropDoc(r: string, path: string) {
  const key = docKey(r, path);
  // A commit's review lets go of its editors.
  commitViews.get(key)?.view.destroy();
  commitViews.delete(key);
  if (live?.key === key) retire();
  docs.delete(key);
  if (key in drafts) delete drafts[key], writeDrafts();
  dropViews(key);
}

/** What's kept of a file's views while its tab is away. */
function dropViews(key: string) {
  scrolls.delete(key);
  spots.delete(key);
  previews.delete(key);
  dropPdf(key);
  dropNotebook(key);
  dropCsv(key);
}

/** A notebook's cell edits: the tab shows them unsaved (and stops being a preview). */
function notebookEdited(r: string, path: string, dirty: boolean) {
  const key = docKey(r, path);
  const d = docs.get(key);
  if (!d) return;
  d.dirty = dirty || textOf(key, d) !== d.disk;
  if (dirty && session()?.preview === path) pin(path);
  else renderBar();
}

/** The notebook's edits written into its source (to save it, or to show the source). */
function syncNotebook(key: string, d: Doc) {
  const text = notebookDirty(key) ? notebookText(key) : null;
  if (text === null || !stateOf(key, d)) return;
  setText(key, d, text, true);
  d.dirty = textOf(key, d) !== d.disk;
  keepDraft(key, d);
}

// ---------------- open, close, toggle ----------------

/** Mod+E: dock the explorer (focusing it) or put it away (focus back to the composer). Peeking, it docks where it
 *  already shows: the chat makes room under it, and it settles into the column once that's done. */
export function toggleFiles(focusTree = true) {
  const s = session();
  if (!s) return;
  s.files = !s.files;
  persist();
  // Peeking, it docks where it already shows: the chat makes room under it, and it settles into the column after.
  if (s.files && peeking) {
    peeking = false;
    cancelClose();
    setTimeout(() => !peeking && app.classList.remove("files-peek", "peek-shown"), RESIZE_MS + 20);
  }
  layout();
  renderExplorer();
  if (s.files) {
    refresh();
    if (focusTree) requestAnimationFrame(() => explorer.contains(document.activeElement) || treeEl.focus({ preventScroll: true }));
  } else if (explorer.contains(document.activeElement)) focusComposer();
}

/** Mod+R: the surface host alone; the explorer keeps its own state. */
export function togglePane() {
  const s = session();
  if (!s) return;
  setPane(!s.surfaces);
}

function setPane(open: boolean) {
  const s = session();
  if (!s || s.surfaces === open) return;
  s.surfaces = open;
  if (!open) expanded = false;
  persist();
  layout();
  renderPane();
  if (open) refresh();
  else if (pane.contains(document.activeElement)) focusComposer();
}

/** Mod+Shift+M: the host takes the chat's room too, or gives it back (shut, it opens taken over). Expanding, the
 *  panel's content follows its glide (Zeron's takeover content tween) while the chat holds its width under it; once
 *  there, the content is laid out at the panel's width again. */
let followTimer: Timer | null = null;
export function toggleExpand() {
  const s = session();
  if (!s) return;
  if (!s.surfaces) {
    expanded = true;
    return setPane(true);
  }
  expanded = !expanded;
  if (followTimer) clearTimeout(followTimer);
  app.classList.add("rp-follow");
  followTimer = setTimeout(() => app.classList.remove("rp-follow"), RESIZE_MS + 40);
  layout();
  renderPane();
}

/** Where a file opens to: a 0-based line and character (a definition, a cited line). */
type At = { line: number; character: number };
type OpenOptions = {
  /** A preview (VS Code's): it takes the place of the last preview tab rather than adding one, and is kept once it's
   *  edited, saved or its tab clicked. */
  preview?: boolean;
  at?: At;
  /** The editor gets the focus (a definition, a tab click). */
  focus?: boolean;
};
/** A position waiting for its file's editor to show. */
let pendingAt: { key: string; at: At; focus: boolean } | null = null;

/** A file opens as a tab (a preview from a single click in the tree), the host showing beside the explorer. `path` is
 *  relative to the session folder, or absolute for a file outside it. */
export function openFile(path: string, { preview = false, at, focus = false }: OpenOptions = {}) {
  if (path === REVIEW) return openReview();
  if (path.startsWith(COMMIT_TAB)) return openCommit(path.slice(COMMIT_TAB.length), !preview);
  const s = session();
  const r = root();
  if (!s || !r) return;
  if (!s.tabs.includes(path)) {
    const old = s.preview && s.preview !== path && s.tabs.includes(s.preview) && !isDirty(r, s.preview) ? s.preview : null;
    if (preview && old) {
      // The preview shows this file instead, in its place.
      s.tabs[s.tabs.indexOf(old)] = path;
      dropDoc(r, old);
    } else {
      // New tabs open beside the shown one, as VS Code's do.
      const at = s.active ? s.tabs.indexOf(s.active) : -1;
      s.tabs.splice(at < 0 ? s.tabs.length : at + 1, 0, path);
    }
    if (preview) s.preview = path;
  } else if (!preview && s.preview === path) s.preview = null;
  s.active = path;
  remember(r, path);
  const key = docKey(r, path);
  if (at) {
    pendingAt = { key, at, focus };
    // A line to show in a Markdown file: its source, where lines are.
    const d = docs.get(key);
    if (d?.rendered) d.rendered = false;
  } else if (focus) pendingAt = { key, at: { line: -1, character: 0 }, focus };
  if (!s.surfaces) setPane(true);
  void loadFile(r, path).then(() => {
    const d = docs.get(key);
    if (at && d?.rendered) (d.rendered = false), shown(r, path) && renderPane();
  });
  reveal(path);
  renderPane();
}

/** The preview tab kept (edited, saved, or its tab clicked). */
function pin(path: string) {
  const s = session();
  if (s?.preview !== path) return;
  s.preview = null;
  persist();
  renderBar();
}

function activate(path: string, focus = false) {
  const s = session();
  const r = root();
  if (!s || !r) return;
  s.active = path;
  // The review shown again reads every diff afresh.
  if (path === REVIEW) return void (review.reread(), renderPane(), changesData.refresh());
  if (path.startsWith(COMMIT_TAB)) return void (renderPane(), graph.select(path.slice(COMMIT_TAB.length)));
  remember(r, path);
  if (focus) pendingAt = { key: docKey(r, path), at: { line: -1, character: 0 }, focus };
  void loadFile(r, path, true);
  reveal(path);
  renderPane();
}

/** Tabs closed (a file with unsaved edits asks first: save, or let them go). */
function closeTabs(paths: string[]) {
  const s = session();
  const r = root();
  if (!s || !r) return;
  const dirty = paths.filter((p) => isDirty(r, p));
  if (!dirty.length) return shut(paths);
  const one = dirty.length === 1;
  dialog(
    one ? `Save changes to ${baseName(dirty[0])}?` : `Save changes to ${dirty.length} files?`,
    one ? "Your changes are lost if you don't save them." : `${dirty.map(baseName).join(", ")} ${dirty.length === 2 ? "both" : "all"} have unsaved changes, lost if you don't save them.`,
    [
      ["Cancel", "filled", () => {}],
      ["Don't save", "danger", () => shut(paths)],
      [
        one ? "Save" : "Save all",
        "solid",
        () =>
          void Promise.all(dirty.map((p) => saveDoc(r, p))).then((saved) => {
            // Ones that couldn't save (changed on disk: that asks) stay open.
            const failed = new Set(dirty.filter((_, i) => !saved[i]));
            shut(paths.filter((p) => !failed.has(p)));
          }),
      ],
    ],
  );
}

/** Tabs gone, whatever they held. */
function shut(paths: string[]) {
  const s = session();
  const r = root();
  if (!s || !r || !paths.length) return;
  const at = s.active ? s.tabs.indexOf(s.active) : 0;
  for (const p of paths) {
    const i = s.tabs.indexOf(p);
    if (i < 0) continue;
    s.tabs.splice(i, 1);
    if (s.preview === p) s.preview = null;
    dropDoc(r, p);
  }
  if (s.active && !s.tabs.includes(s.active)) s.active = s.tabs[Math.min(at, s.tabs.length - 1)] ?? null;
  persist();
  // The last tab closing puts the host away (Zeron's collapse_surfaces_if_empty).
  if (!s.tabs.length) setPane(false);
  else {
    if (s.active) void loadFile(r, s.active);
    renderPane();
  }
}

const closeTab = (path: string) => closeTabs([path]);

/** Mod+Tab inside the host steps through its tabs (Zeron's cycle_navigation). True when it did. */
export function cycleTabs(step: 1 | -1): boolean {
  const s = session();
  if (!s?.surfaces || !pane.contains(document.activeElement) || s.tabs.length < 2) return false;
  const at = s.active ? s.tabs.indexOf(s.active) : -1;
  activate(s.tabs[(at + step + s.tabs.length) % s.tabs.length], !!live && live.view.hasFocus);
  return true;
}

/** Mod+W: the file shown in the panel closes. */
export function closeActiveFile() {
  const s = session();
  if (s?.surfaces && s.active) closeTab(s.active);
}

/** The shown file's absolute path copied (the palette's Copy path of current file). */
export function copyActivePath() {
  const s = session();
  const r = root();
  if (!s?.surfaces || !s.active || isReviewTab(s.active) || !r) return flash("No file open");
  copy(absolute(r, s.active));
  flash("Copied path");
}

/** The shown file selected in the system's file manager. */
export function revealActiveFile() {
  const s = session();
  const r = root();
  if (!s?.surfaces || !s.active || isReviewTab(s.active) || !r) return flash("No file open");
  void call("files.reveal", { root: r, path: s.active }).catch((err) => flash(String(err?.message ?? err)));
}

/** Mod+S: the shown file saved. */
export function saveActiveFile() {
  const s = session();
  const r = root();
  if (s?.surfaces && s.active && r) void saveDoc(r, s.active);
}

/** Mod+N: the Nth open file (opening the panel if it was put away). */
export function jumpTab(n: number) {
  const s = session();
  const path = s?.tabs[n - 1];
  if (!s || !path) return;
  if (!s.surfaces) setPane(true);
  activate(path);
}

// ---------------- go to definition, and back ----------------

type Spot = { r: string; path: string } & At;
const backStack: Spot[] = [];
const forwardStack: Spot[] = [];

/** Where the caret is in the shown file. */
function here(): Spot | null {
  const s = session();
  const r = root();
  if (!s?.active || !r) return null;
  const key = docKey(r, s.active);
  const d = docs.get(key);
  const st = d && stateOf(key, d);
  if (!st) return { r, path: s.active, line: 0, character: 0 };
  const head = st.selection.main.head;
  const line = st.doc.lineAt(head);
  return { r, path: s.active, line: line.number - 1, character: head - line.from };
}

function jump(to: At & { path: string }, record = true) {
  const from = here();
  if (record && from) backStack.push(from), (forwardStack.length = 0);
  if (backStack.length > 100) backStack.shift();
  // A preview unless it's open already (an open tab stays as it is, a preview one too).
  openFile(to.path, { preview: true, at: to, focus: true });
}

/** Alt+Left / Alt+Right: back to where a jump left from, and forward again. */
export function goBack() {
  const to = backStack.pop();
  if (!to || to.r !== root()) return;
  const from = here();
  if (from) forwardStack.push(from);
  jump(to, false);
}
export function goForward() {
  const to = forwardStack.pop();
  if (!to || to.r !== root()) return;
  const from = here();
  if (from) backStack.push(from);
  jump(to, false);
}

async function goToDefinition(r: string, path: string, pos: number) {
  const key = docKey(r, path);
  const d = docs.get(key);
  const st = d && stateOf(key, d);
  if (!st) return;
  const line = st.doc.lineAt(pos);
  let found: FileLocation[];
  try {
    found = await call("files.definition", { root: r, path, text: st.sliceDoc(), line: line.number - 1, character: pos - line.from });
  } catch (err: any) {
    return flash(String(err?.message ?? err));
  }
  // The declaration asked from is no place to go.
  const word = st.wordAt(pos);
  found = found.filter((l) => !(l.path === path && l.line === line.number - 1 && word && l.character >= word.from - line.from && l.character <= word.to - line.from));
  if (!found.length) return flash("No definition found");
  if (found.length === 1) return jump(found[0]);
  // Several: a menu at the caret to pick from.
  const box = live?.key === key ? live.view.coordsAtPos(pos) : null;
  const where = box ? { x: box.left, y: box.bottom + 4 } : { x: innerWidth / 2, y: innerHeight / 3 };
  contextMenu(
    where,
    found.slice(0, 20).map((l) => ({ icon: "file" as const, label: `${isAbs(l.path) ? tildePath(l.path) : l.path}:${l.line + 1}`, run: () => jump(l) })),
  );
}

/** Show a path in the tree: its folders open, it selected. */
function reveal(path: string) {
  const r = root();
  const s = session();
  if (!r || !s?.files) return;
  const t = treeOf(r);
  const dirs: string[] = [];
  for (let dir = parentOf(path); dir; dir = parentOf(dir)) dirs.unshift(dir);
  for (const dir of dirs) t.expanded.add(dir);
  keepExpanded(r, t);
  t.selected = path;
  void Promise.all(dirs.filter((d) => !t.children.has(d)).map((d) => load(r, d))).then(() => {
    if (root() !== r) return;
    renderExplorer();
    treeEl.querySelector(".ft-row.selected")?.scrollIntoView({ block: "nearest" });
  });
}

let focusComposer = () => {};

// ---------------- layout ----------------

let app: HTMLElement;
let pane: HTMLElement;
let explorer: HTMLElement;
let toggles: HTMLElement;

/** Widths for what's open (Zeron's files_panel_layout, simplified): the explorer keeps its width before the chat or
 *  the host give up theirs, and the host takes what's left above the chat's minimum. `snap` places everything at once
 *  (a session switch, a reload, the window resizing); toggles glide. */
function layout(snap = false) {
  const s = session();
  const showFiles = !!s?.files;
  const showPane = !!s?.surfaces;
  // Shut, the sidebar still keeps its 1px hairline. On a phone it's a drawer over the chat, and each panel covers the
  // whole screen.
  const avail = isPhone() ? innerWidth : Math.max(0, innerWidth - (store.sidebarCollapsed ? 1 : SIDEBAR_W));
  // The explorer's width when it shows, docked or peeking.
  const fwOpen = isPhone() ? avail : Math.max(Math.min(FILES_MIN, avail * 0.3), Math.min(saved.filesW, avail - CHAT_MIN - (showPane ? PANE_MIN : 0)));
  const fw = showFiles ? fwOpen : 0;
  const normal = !showPane ? 0 : isPhone() ? avail : Math.max(Math.min(PANE_MIN, avail * 0.4), Math.min(saved.paneW, avail - fw - CHAT_MIN));
  const pw = showPane && expanded ? avail - fw : normal;
  // Content widths: kept while a column glides shut, so it slides away whole.
  app.style.setProperty("--fp-w", `${Math.round(fwOpen)}px`);
  if (showPane) app.style.setProperty("--rp-w", `${Math.round(pw)}px`);
  // The most of the panel's glide the conversation gives way to: its normal width, so expanding covers the chat.
  if (showPane) app.style.setProperty("--rp-n", `${Math.round(normal)}px`);
  if (snap) app.classList.add("snap");
  app.classList.toggle("files-open", showFiles);
  app.classList.toggle("pane-open", showPane);
  app.classList.toggle("pane-expanded", showPane && expanded);
  app.classList.toggle("has-panels", !!s);
  if (snap) {
    void app.offsetWidth; // the new widths land with transitions off
    app.classList.remove("snap");
  }
  syncToggles();
}

let filesToggle: HTMLButtonElement;
let paneToggle: HTMLButtonElement;
/** The two right-edge anchors, in the columns' order: the host's, then, outermost, the explorer's. Made once, so the
 *  host's glyph animates between its states. */
function makeToggles() {
  filesToggle = el("button", "wc-btn pt-files");
  filesToggle.append(icon("folderTree"));
  filesToggle.onclick = () => toggleFiles();
  paneToggle = el("button", "wc-btn pt-pane");
  paneToggle.append(icon("panelRight"));
  paneToggle.onclick = togglePane;
  toggles.replaceChildren(paneToggle, filesToggle);
}
/** A control's title with its shortcut. */
const hint = (label: string, id: ShortcutId) => (prefs.keymap[id] ? `${label} · ${displayCombo(prefs.keymap[id])}` : label);
function syncToggles() {
  const s = session();
  filesToggle.classList.toggle("on", !!s?.files);
  filesToggle.title = hint(s?.files ? "Hide files panel" : "Show files panel", "toggleFiles");
  paneToggle.classList.toggle("on", !!s?.surfaces);
  paneToggle.title = hint("Toggle right panel", "toggleRightPane");
}

/** A column's left edge drags its width (a double click resets it), like Zeron's pane grabbers. */
function resizeHandle(which: "files" | "pane"): HTMLElement {
  const handle = el("div", "pane-resize");
  let dragging = false;
  handle.onpointerdown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("active");
    app.classList.add("pane-resizing");
    e.preventDefault();
  };
  handle.onpointermove = (e) => {
    if (!dragging) return;
    if (which === "files") saved.filesW = Math.max(FILES_MIN, Math.min(FILES_MAX, innerWidth - e.clientX));
    else {
      const right = innerWidth - explorer.getBoundingClientRect().width;
      saved.paneW = Math.max(PANE_MIN, right - e.clientX);
      expanded = false;
    }
    layout();
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("active");
    app.classList.remove("pane-resizing");
    persist();
  };
  handle.onpointerup = end;
  handle.onpointercancel = end;
  handle.ondblclick = () => {
    if (which === "files") saved.filesW = FILES_DEFAULT;
    else saved.paneW = PANE_DEFAULT;
    persist();
    layout();
  };
  return handle;
}

// ---------------- the surface host ----------------

let paneBar: HTMLElement;
let paneBody: HTMLElement;
/** The body's notice (a file changed on disk under edits) and its content, rebuilt only when what shows changes. */
let noticeSlot: HTMLElement;
let contentSlot: HTMLElement;
let bodyShows = "";

function renderPane() {
  const s = session();
  const r = root();
  // Closing glides: the last content stays until the column is shut.
  if (!s?.surfaces || !r) return;
  renderBar();
  renderBody();
  syncWatch();
}

/** Previews being saved as PDFs, by doc key: their button waits. */
const saving = new Set<string>();
/** Files whose preview downloads as a PDF. */
const printsPdf = (path: string) => isLatex(path) || isMarkdown(path);

/** The shown file, if it has a preview: Mod+M and the bar's button go between it and the source. */
function shownText() {
  const s = session();
  const r = root();
  if (!s?.surfaces || !s.active || !r) return null;
  const key = docKey(r, s.active);
  const d = docs.get(key);
  return d?.content?.kind === "text" && renders(s.active) ? { r, path: s.active, key, d } : null;
}

/** Files' changes since git's copy, all in place in their editors, or not: in every file, and kept. */
export function toggleChanges() {
  setPrefs({ showChanges: !prefs.showChanges });
  const s = session();
  const r = root();
  const key = s?.active && r ? docKey(r, s.active) : "";
  const d = docs.get(key);
  const st = d && !d.rendered ? stateOf(key, d) : null;
  // Nothing to see in this file: said, so the click did something.
  if (!st || !changeCount(st)) flash(prefs.showChanges ? "Changes shown in files" : "Changes hidden in files");
}

/** A file's editor that showed or hid its changes (its bar clicked): every file's do, from now on. */
function changesShown(key: string) {
  const d = docs.get(key);
  const st = d && stateOf(key, d);
  if (st && showsChanges(st) !== prefs.showChanges) setPrefs({ showChanges: showsChanges(st) });
}

/** Mod+M: the shown file's source and its preview, one for the other. */
export function togglePreview() {
  const at = shownText();
  if (!at) return;
  const { path, key, d } = at;
  if (isNotebook(path)) {
    // The notebook's edits go into the source first; back the other way, it reads the source afresh.
    if (d.rendered) syncNotebook(key, d);
    else if (notebookText(key) !== textOf(key, d)) dropNotebook(key);
  }
  d.rendered = !d.rendered;
  if (!d.rendered) pendingAt = { key, at: { line: -1, character: 0 }, focus: true };
  renderPane();
}

/** The shown file's preview saved as a PDF where the user picks: the preview on screen, or from the source, one
 *  drawn from the text as it stands (unsaved edits too). */
export function downloadPdf() {
  const at = shownText();
  if (!at || !printsPdf(at.path)) return;
  const { r, path, key, d } = at;
  if (!canSavePdf()) return flash("Downloading a PDF needs the desktop app");
  if (saving.has(key)) return;
  const shown = (d.rendered && contentSlot.querySelector<HTMLElement>(".fv-latex, .fv-markdown")) || drawPreview(r, path, key, d);
  saving.add(key);
  renderBar();
  savePdf(shown, `${baseName(path).replace(/\.[^.]+$/, "")}.pdf`)
    .then((to) => to && flash(`Saved ${tildePath(to)}`))
    .catch((err) => flash(String(err?.message ?? err)))
    .finally(() => {
      saving.delete(key);
      renderBar();
    });
}

function renderBar() {
  const s = session();
  const r = root();
  if (!s?.surfaces || !r) return;
  const strip = el("div", "rp-tabs");
  for (const path of s.tabs) {
    const dirty = isDirty(r, path);
    const tab = el("div", `rp-tab${path === s.active ? " active" : ""}${path === s.preview ? " preview" : ""}${dirty ? " dirty" : ""}`);
    const isReview = path === REVIEW;
    const commit = path.startsWith(COMMIT_TAB) ? path.slice(COMMIT_TAB.length) : null;
    const subject = commit ? (reviewFor(r, path) as CommitView).subject() : null;
    const label = isReview ? "Changes" : commit ? (subject ?? commit.slice(0, 7)) : baseName(path);
    tab.title = isReview ? "Changes" : commit ? `${subject ?? "Commit"} · ${commit.slice(0, 7)}` : isAbs(path) ? tildePath(path) : path;
    const lead = el("span", "rp-tab-lead");
    const glyph = isReview ? icon("gitCompare", undefined, "rp-tab-glyph") : commit ? icon("gitCommitHorizontal", undefined, "rp-tab-glyph") : fileGlyph(path);
    const close = el("button", "rp-tab-close");
    close.title = hint("Close", "closeFile");
    close.append(icon("x"));
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(path);
    };
    lead.append(glyph, close);
    tab.append(lead, el("span", "rp-tab-title", label));
    if (dirty) tab.append(el("span", "rp-tab-dot"));
    // A click keeps a preview tab (VS Code keeps it on a double click; a single one is what's asked here).
    tab.onclick = () => {
      pin(path);
      activate(path, true);
    };
    tab.onauxclick = (e) => e.button === 1 && closeTab(path);
    tab.onmousedown = (e) => e.button === 1 && e.preventDefault();
    tab.oncontextmenu = (e) => tabMenu(e, path);
    strip.append(tab);
  }
  // The shown file's own controls, then the expand button, nearest the corner's toggles.
  const controls: HTMLElement[] = [];
  const key = s.active ? docKey(r, s.active) : "";
  const d = s.active ? docs.get(key) : undefined;
  // What changed, all shown in place (VS Code's Open Changes): in a repository it stays put, dimmed while the file has
  // nothing to show (none since the commit, or the last turn), so switching scope doesn't move the buttons.
  const st = d && !d.rendered ? stateOf(key, d) : null;
  const changes = st ? changeCount(st) : 0;
  if (d && st && (changes || hasBase(st) || treeOf(r).repo)) {
    const on = !!changes && showsChanges(st);
    const diff = el("button", `wc-btn rp-ctl${on ? " on" : ""}`) as HTMLButtonElement;
    diff.title = !changes ? "No changes in this file" : on ? "Close changes" : "Open changes";
    diff.disabled = !changes;
    diff.append(icon("gitCompare"));
    diff.onclick = toggleChanges;
    controls.push(diff);
  }
  if (s.active && renders(s.active) && d?.content?.kind === "text") {
    const active = s.active;
    // The preview (LaTeX's, Markdown's) downloaded as a PDF, from either side.
    if (printsPdf(active) && canSavePdf()) {
      const pdf = el("button", "wc-btn rp-ctl") as HTMLButtonElement;
      pdf.title = "Download PDF";
      pdf.append(icon("download"));
      pdf.disabled = saving.has(key);
      pdf.onclick = downloadPdf;
      controls.push(pdf);
    }
    const md = el("button", "wc-btn rp-ctl");
    md.title = hint(d.rendered ? "Edit source" : isNotebook(active) ? "Show notebook" : "Show preview", "togglePreview");
    md.append(icon(d.rendered ? "code" : "bookOpen"));
    md.onclick = togglePreview;
    controls.push(md);
  }
  const expand = el("button", "wc-btn rp-ctl rp-expand");
  expand.title = hint(expanded ? "Collapse panel" : "Expand panel", "expandRightPane");
  expand.append(icon(expanded ? "minimize2" : "maximize2"));
  expand.onclick = toggleExpand;
  const before = paneBar.querySelector<HTMLElement>(".rp-tabs")?.scrollLeft ?? 0;
  paneBar.replaceChildren(strip, ...controls, expand);
  strip.scrollLeft = before;
  // Tabs past the strip's edges fade under them (Zeron's EdgeFade), following the scroll.
  const fades = () => {
    strip.classList.toggle("fade-left", strip.scrollLeft > 1);
    strip.classList.toggle("fade-right", strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1);
  };
  strip.onscroll = fades;
  requestAnimationFrame(() => {
    strip.querySelector(".rp-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    fades();
  });
}

/** The editor going off screen: its state back into its doc, where it was scrolled kept. */
function retire() {
  if (!live) return;
  const d = docs.get(live.key);
  if (d) d.state = live.view.state;
  scrolls.set(live.key, live.view.scrollDOM.scrollTop);
  live.view.destroy();
  live = null;
}

function renderBody() {
  const s = session();
  const r = root();
  if (!s?.surfaces || !r) return;
  const path = s.active;
  const key = path ? docKey(r, path) : "";
  const d = path ? docs.get(key) : undefined;
  renderNotice(r, path, d);
  const what = !path
    ? "picker"
    : isReviewTab(path)
      ? "review"
    : !d || d.loading
      ? "loading"
      : d.state && !d.rendered
        ? "code"
        : d.error
          ? `error:${d.error}`
          : d.content?.kind === "text"
            ? `rendered:${d.mtime}:${d.dirty}`
            : `${d.content?.kind}:${d.mtime}`;
  const next = `${key}|${what}`;
  if (next !== bodyShows || !contentSlot.firstChild) {
    bodyShows = next;
    const prev = contentSlot.querySelector<HTMLElement>(".fv-scroll");
    // Not while the column is shut (nothing's laid out to measure): where it was last seen stays.
    if (prev?.dataset.key && prev.clientHeight) spots.set(prev.dataset.key, spotOf(prev));
    retire();
    // A view kept across redraws (a notebook's) keeps the focus it had: being moved into the new frame drops it.
    const focused = document.activeElement;
    contentSlot.replaceChildren(!path ? picker() : isReviewTab(path) ? reviewFor(r, path).view.el : viewer(r, path, key, d));
    if (path && isReviewTab(path)) reviewFor(r, path).view.shown();
    if (focused instanceof HTMLElement && focused !== document.activeElement && contentSlot.contains(focused)) focused.focus({ preventScroll: true });
    const scroll = contentSlot.querySelector<HTMLElement>(".fv-scroll");
    const spot = scroll?.dataset.key ? spots.get(scroll.dataset.key) : undefined;
    if (scroll && spot) restoreSpot(scroll, spot);
  }
  applyPendingAt();
}

/** A position (or just the focus) waiting for the shown file's editor. */
function applyPendingAt() {
  if (!pendingAt || live?.key !== pendingAt.key) return;
  const { at, focus } = pendingAt;
  pendingAt = null;
  const view = live.view;
  if (at.line >= 0) {
    const doc = view.state.doc;
    const line = doc.line(Math.min(doc.lines, at.line + 1));
    const pos = line.from + Math.min(at.character, line.length);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  }
  if (focus) requestAnimationFrame(() => view.focus());
}

/** Above the file: what changed on disk under unsaved edits, and which version to keep; or that it's gone. */
function renderNotice(r: string, path: string | null, d: Doc | undefined) {
  const bar = el("div", "fv-notice");
  if (path && d?.theirs) {
    bar.append(icon("triangleAlert"), el("span", "grow", "Changed on disk"));
    const take = el("button", "fv-notice-btn", "Use disk version");
    take.onclick = () => void takeTheirs(r, path);
    const keep = el("button", "fv-notice-btn strong", "Keep mine");
    keep.onclick = () => void saveDoc(r, path, true);
    bar.append(take, keep);
  } else if (path && d?.error && d.state) {
    bar.append(icon("triangleAlert"), el("span", "grow", `${d.error}. Saving writes it again.`));
  } else return void noticeSlot.replaceChildren();
  noticeSlot.replaceChildren(bar);
}

/** The host with nothing open: what it can show (Zeron's render_surface_picker). Files for now. */
function picker(): HTMLElement {
  const box = el("div", "rp-picker");
  const list = el("div", "rp-picker-list");
  const row = el("button", "rp-picker-row");
  row.append(icon("folderTree"), el("span", "", "Files"));
  row.onclick = () => {
    if (!filesOpen()) toggleFiles();
    else treeEl.focus();
  };
  list.append(row);
  box.append(list, el("div", "rp-picker-hint", "Open a file from the files panel to view it here."));
  return box;
}

function viewer(r: string, path: string, key: string, d: Doc | undefined): HTMLElement {
  const wrap = el("div", "fv");
  if (d?.state && !d.rendered) {
    const box = el("div", "fv-editor");
    wrap.append(box);
    const view = codeView(d.state, box);
    live = { key, view };
    void loadBase(r, path);
    const top = scrolls.get(key);
    if (top) requestAnimationFrame(() => (view.scrollDOM.scrollTop = top));
    return wrap;
  }
  if (d?.state && d.content?.kind === "text" && isHtml(path)) {
    const box = el("div", "fv-html-box");
    const frame = el("iframe", "fv-html");
    frame.sandbox.add("allow-scripts");
    frame.srcdoc = previewDoc(r, path, textOf(key, d));
    box.append(frame);
    wrap.append(box);
    return wrap;
  }
  // A table scrolls itself (drawing only the rows in view).
  if (d && !d.loading && !d.error && d.content?.kind === "text" && isCsv(path)) {
    wrap.append(csvView(key, textOf(key, d), path));
    return wrap;
  }
  const c = d && !d.loading && !d.error ? d.content : null;
  if (c && (c.kind === "binary" || c.kind === "tooLarge") && isSheet(path) && c.size <= MAX_SHEET_BYTES) {
    const mtime = c.mtime;
    wrap.append(sheetView(key, `/file?root=${encodeURIComponent(r)}&path=${encodeURIComponent(path)}&v=${mtime}`, mtime, path));
    return wrap;
  }
  const scroll = el("div", "fv-scroll");
  scroll.dataset.key = key;
  scroll.tabIndex = -1;
  if (!d || d.loading) scroll.append(el("div", "fv-note", ""));
  else if (d.error) scroll.append(el("div", "fv-note", d.error));
  else if (d.content) scroll.append(body(r, path, key, d));
  wrap.append(scroll);
  const bar = d?.content?.kind === "pdf" && !d.loading && !d.error ? pdfBar(key) : null;
  if (bar) wrap.append(bar);
  return wrap;
}

/** Where a view is scrolled to, as the block at its top and how far into it: a figure or diagram above loading later
 *  (or the column a new width) moves that block, and a pixel offset would then show something else. Blocks taller
 *  than the view are looked into for a smaller one. */
type ScrollSpot = { path: number[]; into: number };
function spotOf(scroll: HTMLElement): ScrollSpot {
  const top = scroll.getBoundingClientRect().top;
  const path: number[] = [];
  let into = 0;
  for (let box = scroll.firstElementChild; box; ) {
    const kids = [...box.children];
    const i = kids.findIndex((k) => k.getBoundingClientRect().bottom > top);
    if (i < 0) break;
    const at = kids[i].getBoundingClientRect();
    path.push(i);
    into = top - at.top;
    box = into > 0 && at.height > scroll.clientHeight ? kids[i] : null;
  }
  return { path, into };
}

/** A view back where it was before it paints (not a frame later), and again once its pictures are in, which move what
 *  they're in, unless the user has scrolled it meanwhile. */
function restoreSpot(scroll: HTMLElement, spot: ScrollSpot) {
  toSpot(scroll, spot);
  if (!picturesPending(scroll)) return;
  const moves = ["wheel", "pointerdown", "keydown", "touchstart"];
  let moved = false;
  const stop = () => (moved = true);
  for (const m of moves) scroll.addEventListener(m, stop, { passive: true });
  void picturesIn(scroll, 3000).then(() => {
    for (const m of moves) scroll.removeEventListener(m, stop);
    if (!moved && scroll.isConnected) toSpot(scroll, spot);
  });
}

/** A view scrolled back to `spot`: the block found again (or as near as the drawing still has), at the same depth. */
function toSpot(scroll: HTMLElement, spot: ScrollSpot) {
  let at: Element | null = null;
  let found = 0;
  for (let box = scroll.firstElementChild; found < spot.path.length; found++) {
    const next: Element | undefined = box?.children[spot.path[found]];
    if (!next) break;
    at = box = next;
  }
  if (!at) return;
  scroll.scrollTop += at.getBoundingClientRect().top - scroll.getBoundingClientRect().top + (found === spot.path.length ? spot.into : 0);
}

/** Each folder's preview base (files.previewBase), asked for once; "" when the core can't give one. */
const previewBases = new Map<string, string | Promise<void>>();

/** An HTML file's text as its preview shows it: unable to connect anywhere (so it can't reach the core), its
 *  relative URLs (CSS, images, scripts) resolving beside it in the folder, and its pointer moves passed up to the
 *  window (for the files panel's edge peek). Shown without the base until it comes. */
function previewDoc(r: string, path: string, text: string): string {
  let base = previewBases.get(r);
  if (base === undefined)
    previewBases.set(
      r,
      (base = call("files.previewBase", { root: r }).then(
        (b) => void previewBases.set(r, b),
        () => void previewBases.set(r, ""),
      ).then(() => {
        // The preview shown without it draws again with it.
        bodyShows = "";
        if (root() === r) renderPane();
      })),
    );
  const dir = isAbs(path) ? "" : dirOf(path);
  const href = typeof base === "string" && base && !isAbs(path) ? base + (dir ? dir.split("/").map(encodeURIComponent).join("/") + "/" : "") : null;
  const pointer = `<script>addEventListener("pointermove",(e)=>parent.postMessage({bismuthPointer:[e.clientX,e.buttons]},"*"),{capture:true,passive:true})</script>`;
  const head = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; form-action 'none'">${href ? `<base href="${href}">` : ""}${pointer}`;
  // After a doctype, which must come first (or the page renders in quirks mode).
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text)?.[0] ?? "";
  return doctype + head + text.slice(doctype.length);
}

/** `rel` from the folder `dir` (both relative to the session's folder), its `.` and `..` resolved. */
function joinRel(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return (dir.startsWith("/") ? "/" : "") + out.join("/");
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A LaTeX or Markdown file's preview on screen: the one drawn before while its text (and so its figures) are the same. */
function preview(r: string, path: string, key: string, d: Doc): HTMLElement {
  const from = `${d.mtime}\0${textOf(key, d)}`;
  const had = previews.get(key);
  if (had?.from === from) {
    // Diagrams that hadn't drawn when it went off screen draw now (or again, in a palette that came meanwhile).
    if (isMarkdown(path)) diagrams(had.node);
    return had.node;
  }
  const node = drawPreview(r, path, key, d);
  const kept = { from, node };
  previews.set(key, kept);
  // The file changed under its preview: the one on screen stays until this one's figures are in, then gives way in
  // its place (shown without them, what's below each would move as they arrive).
  const scroll = contentSlot.querySelector<HTMLElement>(".fv-scroll");
  const shows = scroll?.dataset.key === key ? scroll.firstElementChild : null;
  if (shows instanceof HTMLElement && picturesPending(node)) {
    void picturesIn(node, 3000).then(() => {
      const scroll = shows.parentElement;
      if (previews.get(key) !== kept || !scroll || !shows.isConnected) return;
      const spot = spotOf(scroll);
      shows.replaceWith(node);
      toSpot(scroll, spot);
    });
    return shows;
  }
  return node;
}

/** A LaTeX or Markdown file's preview, from its text as it stands. */
function drawPreview(r: string, path: string, key: string, d: Doc): HTMLElement {
  if (isLatex(path)) {
    const tex = el("div", "fv-latex");
    const dir = dirOf(path);
    renderLatex(textOf(key, d), tex, { image: (p) => `/file?root=${encodeURIComponent(r)}&path=${encodeURIComponent(p.startsWith("/") ? p : joinRel(dir, p))}&v=${d.mtime ?? 0}` });
    return tex;
  }
  const md = el("div", "fv-markdown md");
  const dir = dirOf(path);
  renderMarkdown(textOf(key, d), md, dir);
  // Relative pictures are beside the file in the folder, not under the app's own URL.
  for (const img of md.querySelectorAll("img")) {
    const src = img.getAttribute("src")?.trim();
    if (!src || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(src)) continue;
    let p = src.replace(/[?#].*$/, "");
    try {
      p = decodeURIComponent(p);
    } catch {}
    img.src = `/file?root=${encodeURIComponent(r)}&path=${encodeURIComponent(p.startsWith("/") ? p : joinRel(dir, p))}&v=${d.mtime ?? 0}`;
  }
  return md;
}


function body(r: string, path: string, key: string, d: Doc): HTMLElement {
  const c = d.content!;
  if (c.kind === "image") {
    const box = el("div", "fv-image");
    const img = el("img");
    img.src = c.url;
    img.alt = baseName(path);
    box.append(img);
    return box;
  }
  if (c.kind === "pdf") return pdfView(key, `/file?root=${encodeURIComponent(r)}&path=${encodeURIComponent(path)}&v=${c.mtime}`, c.mtime);
  if (c.kind === "text" && isNotebook(path)) {
    try {
      return notebookView(key, textOf(key, d), d.mtime ?? 0, (dirty) => notebookEdited(r, path, dirty));
    } catch (err: any) {
      return el("div", "fv-note", `${err?.message ?? err}. Its source is a toggle away.`);
    }
  }
  if (c.kind === "text") return preview(r, path, key, d);
  // What the viewer can't show opens in its own app.
  const note = el("div", "fv-note");
  note.append(el("div", "", c.kind === "binary" ? `Binary file · ${size(c.size)}` : `Too large to show · ${size(c.size)}`));
  const open = el("button", "fv-open");
  open.append(icon("externalLink"), el("span", "", "Open in default app"));
  open.onclick = () => openExternally(r, path);
  note.append(open);
  return note;
}

function openExternally(r: string, path: string) {
  call("files.openExternal", { root: r, path }).catch((err) => flash(String(err?.message ?? err)));
}

/** A file the transcript cites, opened: a preview tab at its line; a folder shown in the files panel; what the viewer
 *  can't show, in its own app. */
function openCited(ref: FileRef | null, cited: Cited, keep: boolean) {
  const r = root();
  if (!r) return;
  if (!ref) return flash(`Couldn't find ${cited.path}`);
  if (ref.dir) return isAbs(ref.path) ? void call("files.openExternal", { root: r, path: ref.path }).catch((err) => flash(String(err?.message ?? err))) : revealInTree(ref.path);
  if (EXTERNAL.test(ref.path)) return openExternally(r, ref.path);
  const at = cited.line ? { line: cited.line - 1, character: Math.max(0, (cited.column ?? 1) - 1) } : undefined;
  openFile(ref.path, { preview: !keep, at, focus: keep });
}

/** A passing note at the foot of the host ("No definition found"). */
let flashTimer: Timer | null = null;
function flash(text: string) {
  // With the panel put away, at the foot of the window.
  const host = paneOpen() ? pane : document.body;
  let note = document.querySelector<HTMLElement>(".rp-flash");
  if (note?.parentElement !== host) note?.remove(), host.append((note = el("div", `rp-flash${host === pane ? "" : " free"}`)));
  note.textContent = text;
  note.classList.remove("out");
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => note!.classList.add("out"), 2200);
}

/** Code colours from the theme's terminal palette, so they suit every theme (Zeron's syntax theme does the same job). */
function paintSyntax() {
  const p = terminalPalette(activeTheme()).ansi;
  const root = document.documentElement.style;
  const set = (name: string, value: string) => root.setProperty(`--syn-${name}`, value);
  set("keyword", p[5]);
  set("string", p[2]);
  set("number", p[3]);
  set("type", p[6]);
  set("function", p[4]);
  set("tag", p[1]);
  set("attr", p[3]);
}

// ---------------- the explorer ----------------

let search: HTMLInputElement;
let moreBtn: HTMLButtonElement;
/** The name search's matches (null while the field is empty), the highlighted one, and the query they're for. */
let results: string[] | null = null;
let resultIx = 0;
let searchSeq = 0;
/** The entry under the pointer: F2 renames it (rather than the session). */
let hoveredPath: string | null = null;
let treeEl: HTMLElement;
/** The search's row under the explorer's buttons, shown by its button (or typing in the tree). */
let findRow: HTMLElement;
let searchBtn: HTMLButtonElement;
/** The row under the head, for the files only: what the tree's marks (and the editors' changes) are against, and a new
 *  file or folder at the top. */
let scopeRow: HTMLElement;
let scopePick: HTMLButtonElement;
/** Beside it: only the changed files in the tree, or every file. */
let changedBtn: HTMLButtonElement;
/** What the dropdown was last drawn for (it's made again when that moves). */
let scopeDrawn = "";
/** The sidebar's two views: the files, and the Changes view (changes.ts), picked in the head. */
let filesView: HTMLElement;
let filesPage: HTMLElement;
const viewBtns = new Map<SidebarView, HTMLButtonElement>();
/** The views side by side, slid to the one shown (Zen's spaces): a swipe drags them, a pick slides them over. */
const VIEWS: SidebarView[] = ["files", "changes"];
let deck: HTMLElement;
let strip: HTMLElement;
/** The picker's highlight, slid along with them. */
let viewPill: HTMLElement;
/** The view the strip was last put at, and whether a swipe holds it (nothing else moves it meanwhile). */
let placedView: SidebarView | null = null;
let swiping = false;
let changesData: ChangesStore;
let changes: ReturnType<typeof changesView>;
let review: ReturnType<typeof reviewView>;
/** The review's tab (review.ts) among a session's files: every changed file's diff. */
export const REVIEW = "bismuth:changes";
/** A commit's review tab: this, then its hash. */
const COMMIT_TAB = "bismuth:commit:";
const isReviewTab = (path: string) => path === REVIEW || path.startsWith(COMMIT_TAB);
let graph: ReturnType<typeof graphView>;
type CommitView = { view: ReturnType<typeof reviewView>; subject: () => string | null };
/** The commits' reviews open, by their tab's doc key: read once each, let go of with the tab. */
const commitViews = new Map<string, CommitView>();

/** A review tab's view: the uncommitted changes', or a commit's (made the first time it's shown). */
function reviewFor(r: string, path: string): { view: ReturnType<typeof reviewView>; subject?: () => string | null } {
  if (path === REVIEW) return { view: review };
  const key = docKey(r, path);
  let v = commitViews.get(key);
  if (!v) {
    const { source, subject } = commitSource(r, path.slice(COMMIT_TAB.length));
    v = { view: reviewView(source, (p) => openFile(p)), subject };
    // Read: the tab's title is the commit's subject.
    source.listen(renderBar);
    commitViews.set(key, v);
  }
  return v;
}

/** A commit's changes in a review tab: a preview (the next pick takes its place) unless `keep`. */
export function openCommit(hash: string, keep = false) {
  const s = session();
  const r = root();
  if (!s || !r) return;
  const path = COMMIT_TAB + hash;
  if (!s.tabs.includes(path)) {
    const old = !keep && s.preview && s.preview !== path && s.tabs.includes(s.preview) && !isDirty(r, s.preview) ? s.preview : null;
    if (old) {
      s.tabs[s.tabs.indexOf(old)] = path;
      dropDoc(r, old);
    } else {
      const at = s.active ? s.tabs.indexOf(s.active) : -1;
      s.tabs.splice(at < 0 ? s.tabs.length : at + 1, 0, path);
    }
    if (!keep) s.preview = path;
  } else if (keep && s.preview === path) s.preview = null;
  s.active = path;
  persist();
  if (!s.surfaces) setPane(true);
  renderPane();
  graph.select(hash);
}
const sidebarView = (): SidebarView => saved.view ?? "files";

function renderTabs() {
  const view = sidebarView();
  for (const [v, b] of viewBtns) {
    b.classList.toggle("on", v === view);
    b.setAttribute("aria-checked", String(v === view));
  }
  // The one off to the side out of reach (keys, focus); slid over when the view changed.
  filesPage.inert = view !== "files";
  changes.el.inert = view !== "changes";
  if (!swiping) moveStrip(VIEWS.indexOf(view), placedView !== null && placedView !== view);
  placedView = view;
  syncToggles();
}

/** How long the views take to slide over (and the picker's highlight with them). */
const SLIDE_MS = 360;
let slideEnd: Timer | null = null;

/** The views' strip moved to `at` (0 the files, 1 the changes; between, partway), slid there or put at once, the
 *  picker's highlight along with it. At rest on a view it's laid out plainly, the other out of sight: no transform
 *  left on it, so its text stays crisp. */
function moveStrip(at: number, slide: boolean) {
  if (slideEnd) clearTimeout(slideEnd), (slideEnd = null);
  // Out of rest, from where it shows (the strip's laid out the same at rest: only the other view's hidden).
  strip.classList.remove("rest");
  setStrip(at, slide);
  if (swiping || at !== Math.round(at)) return;
  if (!slide) return toRest();
  slideEnd = setTimeout(toRest, SLIDE_MS + 40);
}

function setStrip(at: number, slide: boolean) {
  strip.classList.toggle("sliding", slide);
  viewPill.classList.toggle("sliding", slide);
  strip.style.transform = `translateX(${(-at * 100) / VIEWS.length}%)`;
  placePill(at);
}

function toRest() {
  slideEnd = null;
  if (swiping) return;
  strip.classList.remove("sliding");
  viewPill.classList.remove("sliding");
  strip.classList.add("rest");
  setStrip(VIEWS.indexOf(sidebarView()), false);
}

/** Where the picker's buttons are (measured once they're laid out: reading them per scroll would lay the page out). */
let pillSpots: { left: number; width: number }[] | null = null;
/** The picker's highlight under the view at `at`, or between two. */
function placePill(at: number) {
  if (!pillSpots) {
    const spots = VIEWS.map((v) => ({ left: viewBtns.get(v)!.offsetLeft, width: viewBtns.get(v)!.offsetWidth }));
    if (!spots[0].width) return;
    pillSpots = spots;
  }
  const c = Math.max(0, Math.min(VIEWS.length - 1, at));
  const a = pillSpots[Math.floor(c)];
  const b = pillSpots[Math.ceil(c)];
  const f = c - Math.floor(c);
  viewPill.style.transform = `translateX(${a.left + (b.left - a.left) * f}px)`;
  viewPill.style.width = `${a.width + (b.width - a.width) * f}px`;
}

/** Where the strip shows right now, in views (mid-slide, partway). */
function stripAt(): number {
  if (strip.classList.contains("rest")) return VIEWS.indexOf(sidebarView());
  const x = new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41;
  return -x / (deck.clientWidth || 1);
}

/** What each scope's changes came to when last read, per folder and scope: shown at once as the menu opens. */
const scopeTallies = new Map<string, { files: number; added: number; removed: number } | null>();

/** A scope's row in the dropdown: how many files it changes and its lines added and removed, read as the menu opens
 *  (the last count meanwhile). Nothing for "Last turn" with no session, or no turn kept. */
function scopeTally(r: string, scope: ChangesScope): HTMLElement {
  const box = el("span", "fp-scope-tally");
  const since = SINCE[scope]();
  const key = `${r}\0${scope}\0${since}`;
  const draw = (n: { files: number; added: number; removed: number } | null | undefined) => {
    if (n === undefined) return;
    box.replaceChildren(...(n ? [el("span", "fp-scope-files", n.files ? `${n.files} ${n.files === 1 ? "file" : "files"}` : "None"), lineCounts(n.added, n.removed)] : []));
  };
  draw(scopeTallies.get(key));
  if (since === "") return box;
  void call("git.changes", { root: r, since })
    .then((c) => {
      const n = c.repo && c.turn !== false ? { files: c.files.length, added: c.files.reduce((a, f) => a + (f.added ?? 0), 0), removed: c.files.reduce((a, f) => a + (f.removed ?? 0), 0) } : null;
      scopeTallies.set(key, n);
      draw(n);
    })
    .catch(() => {});
  return box;
}

function renderScope(r: string, t: Tree) {
  changedBtn.classList.toggle("on", changedOnly(t));
  changedBtn.disabled = !t.repo;
  changedBtn.title = !t.repo ? "Not in a git repository" : saved.changedOnly ? "Show all files" : "Show only changed files";
  // Outside a repository there's nothing to compare with: the dropdown keeps its place, dimmed.
  const shown = scopeOf(t);
  const key = `${r}\0${t.repo}:${t.branched}:${shown}`;
  if (key === scopeDrawn && scopePick.isConnected) return;
  scopeDrawn = key;
  const offered = SCOPES.filter(([scope]) => scope !== "branch" || t.branched);
  const at = offered.findIndex(([scope]) => scope === shown);
  const pick = selectMenu({
    options: offered.map(([scope, label]) => ({ label, trailing: () => scopeTally(r, scope) })),
    selected: at,
    menuWidth: 236,
    onSelect: (i) => showChangesSince(offered[i][0]),
    onClose: released,
  });
  pick.classList.add("fp-scope");
  pick.disabled = !t.repo;
  pick.title = t.repo ? `Changes shown — ${offered[at][1]}: ${offered[at][2]}` : "Not in a git repository";
  scopePick.replaceWith(pick);
  scopePick = pick;
}

/** A sideways scroll over the panel (a touchpad's swipe, Shift+wheel) drags the views under it, as Zen's spaces: they
 *  follow the fingers (held back at first, then slower than a scroll), the next one coming in beside, never past it
 *  nor either end. Each gesture is one way or
 *  the other: begun sideways, its up and down is held off the lists; begun up or down, it's left to them. When it's
 *  let go (its scrolls stop, a touchpad's coasting included) nearly a third of the way over, or flicked, the views slide
 *  the rest; short of that, back. Caught mid-slide, they're taken from where they are. */
/** How long without a scroll a gesture has ended (wheel events don't say). Short: a pause that ends it early is taken
 *  up again, mid-slide, by the next scroll. */
const SWIPE_END_MS = 70;
/** Waiting to know, the views coast on at the fingers' speed, slowing by this much a frame (no stop dead on lifting). */
const SWIPE_COAST = 0.85;
/** How far a gesture goes before it's taken as sideways or not. */
const SWIPE_LOCK_PX = 6;
/** The views move this much of what the fingers do: slower than a scroll, as a page dragged. */
const SWIPE_RATE = 0.5;
/** The views hold back at first, as if stuck: they lag the fingers this far (px) and catch up past it. */
const SWIPE_HOLD_PX = 36;
/** The share of the width past which a let-go swipe goes over, and the speed (px/ms) that goes over sooner. */
const SWIPE_COMMIT = 0.3;
const SWIPE_FLICK = 0.9;
/** How far back a flick's speed counts: the coasting after the fingers lift slows, the throw was before it. */
const SWIPE_FLICK_MS = 300;
function swipeViews(on: HTMLElement) {
  /** The gesture: not begun, taken as a swipe, or left to the lists. */
  let phase: "idle" | "swipe" | "pass" = "idle";
  let sx = 0;
  let sy = 0;
  /** The view it began on, and how far (px) the fingers have moved the views off it. */
  let base = 0;
  /** Off it when caught mid-slide (px), and how far the fingers have moved since (px, at SWIPE_RATE). */
  let from = 0;
  let moved = 0;
  /** Its speeds (views' way, px/ms) and when, the last SWIPE_FLICK_MS of them. */
  let speeds: { t: number; v: number }[] = [];
  let lastAt = 0;
  /** How fast the views go (moved's px/ms), and the frames coasting on it between scrolls. */
  let vel = 0;
  let coastAt = 0;
  let coasting = 0;
  let idle: Timer | null = null;
  const coast = (t: number) => {
    if (phase !== "swipe") return void (coasting = 0);
    // No scroll this frame: on as it was going.
    if (t - lastAt > 20 && vel) {
      moved += vel * (t - coastAt);
      vel *= SWIPE_COAST;
      if (Math.abs(vel) < 0.01) vel = 0;
      moveStrip(at(deck.clientWidth || 1), false);
    }
    coastAt = t;
    coasting = requestAnimationFrame(coast);
  };
  /** The fingers' way (px) to the views': held back at first, then one for one. */
  const held = (x: number) => Math.sign(x) * Math.max(0, Math.abs(x) - SWIPE_HOLD_PX * (1 - Math.exp(-Math.abs(x) / SWIPE_HOLD_PX)));
  const at = (w: number) => {
    const p = base - (from + held(moved)) / w;
    // No further than the next view, nor past either end.
    return Math.max(Math.max(0, base - 1), Math.min(Math.min(VIEWS.length - 1, base + 1), p));
  };
  on.addEventListener("wheel", (e) => {
    const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    if (idle) clearTimeout(idle);
    idle = setTimeout(end, SWIPE_END_MS);
    if (phase === "pass") return;
    if (phase === "idle") {
      sx += dx;
      sy += dy;
      if (Math.hypot(sx, sy) < SWIPE_LOCK_PX && Math.abs(dx) < 40) return;
      let sideways = Math.abs(sx) > Math.abs(sy) * 1.3;
      for (let n = e.target as HTMLElement | null; sideways && n && n !== on; n = n.parentElement)
        if (n.scrollWidth > n.clientWidth && /auto|scroll/.test(getComputedStyle(n).overflowX)) sideways = false;
      if (!sideways) return void (phase = "pass");
      phase = "swipe";
      swiping = true;
      showBoth();
      // From where it shows: caught mid-slide, that's partway.
      const w = deck.clientWidth || 1;
      const now = stripAt();
      base = VIEWS.indexOf(sidebarView());
      from = (base - now) * w;
      moved = -sx * SWIPE_RATE;
      speeds = [];
      vel = 0;
      lastAt = coastAt = e.timeStamp;
      coasting = requestAnimationFrame(coast);
    } else moved -= dx * SWIPE_RATE;
    e.preventDefault();
    const w = deck.clientWidth || 1;
    // How fast it's going: a flick goes over short of the third.
    // (Not the first scroll's: nothing before it to time it by.)
    if (e.timeStamp > lastAt) {
      const v = (dx * SWIPE_RATE) / Math.max(4, e.timeStamp - lastAt);
      speeds.push({ t: e.timeStamp, v });
      vel = vel * 0.5 - v * 0.5;
    }
    while (speeds.length && speeds[0].t < e.timeStamp - SWIPE_FLICK_MS) speeds.shift();
    lastAt = e.timeStamp;
    moveStrip(at(w), false);
  }, { passive: false });
  function end() {
    idle = null;
    const was = phase;
    phase = "idle";
    sx = sy = 0;
    if (was !== "swipe") return;
    swiping = false;
    if (coasting) cancelAnimationFrame(coasting), (coasting = 0);
    const w = deck.clientWidth || 1;
    const off = at(w) - base;
    const way = Math.sign(off);
    const flick = Math.abs(off) > 0.12 && Math.max(0, ...speeds.map((x) => x.v * way)) > SWIPE_FLICK;
    const dir = Math.abs(off) > SWIPE_COMMIT || flick ? way : 0;
    const next = VIEWS[base + dir];
    // The slide first; the switch's own work after it's under way, so it doesn't hold the slide's first frames.
    if (dir && next) moveStrip(base + dir, true), requestAnimationFrame(() => setTimeout(() => showSidebarView(next)));
    else moveStrip(base, true);
  }
}

/** The tree left undrawn while the changes show (drawn when the page is idle, so a swipe finds it current). */
let treeStale = false;
let treeIdle = 0;
function drawTreeIdle(r: string, t: Tree) {
  treeStale = true;
  if (treeIdle) return;
  treeIdle = requestIdleCallback(() => {
    treeIdle = 0;
    if (treeStale && root() === r && explorerShown()) drawTree(r, t);
  }, { timeout: 1500 });
}

/** Both views current, for a swipe that shows them side by side (the changes always are: they draw on every read). */
function showBoth() {
  const r = root();
  if (!r || !treeStale) return;
  const t = treeOf(r);
  if (t.ready) drawTree(r, t);
}

/** The sidebar shows the files, or the changes (the Changes tab, Mod+Shift+G). */
export function showSidebarView(view: SidebarView) {
  const moved = sidebarView() !== view;
  if (moved) {
    saved.view = view;
    persist();
  }
  // Opened when it's away; showing as a peek, it stays one (pinning it is the corner toggle's).
  const s = session();
  if (s && !s.files && !peeking) toggleFiles(view === "files");
  else if (moved && explorerShown()) {
    // Slid over to what's already drawn (the tree when idle, the changes on every read); a tree left behind is
    // drawn once the slide is done, not before it starts.
    renderTabs();
    setTimeout(() => sidebarView() === view && (view === "changes" || treeStale) && renderExplorer(), SLIDE_MS + 60);
  } else renderExplorer();
  syncToggles();
  if (view === "changes") void changesData.refresh();
  // A search left in the field carries over to what shows now.
  if (search.value.trim()) onSearch();
}

/** Ctrl+Shift+G: the changes shown, the commit message focused to write; with them already showing, the files back. */
export function showCommit() {
  if (explorerShown() && sidebarView() === "changes") {
    showSidebarView("files");
    return requestAnimationFrame(() => treeEl.focus({ preventScroll: true }));
  }
  showSidebarView("changes");
  requestAnimationFrame(() => changes.focus());
}

/** The review tab, opened (beside the shown file) and brought to a file's diff, or its top. */
export function openReview(path?: string) {
  const s = session();
  if (!s || !root()) return;
  if (!s.tabs.includes(REVIEW)) {
    const at = s.active ? s.tabs.indexOf(s.active) : -1;
    s.tabs.splice(at < 0 ? s.tabs.length : at + 1, 0, REVIEW);
  }
  const fresh = s.active !== REVIEW;
  s.active = REVIEW;
  persist();
  if (!s.surfaces) setPane(true);
  if (fresh) review.reread();
  renderPane();
  void changesData.refresh().then(() => review.scrollTo(path));
}

function openSearch() {
  findRow.hidden = false;
  searchBtn.classList.add("on");
  search.focus();
}

/** The search emptied and put away. */
function closeSearch() {
  clearSearch();
  renderExplorer();
}

/** Folder opening and closing, Zeron's tree tween: its rows slide out from under it, or back up into it. */
const FOLD_MS = 160;

type Row = { e: FileEntry; depth: number };

/** Only what changed shows (in a repository): files with a change, and the folders holding them. */
const changedOnly = (t: Tree) => !!saved.changedOnly && t.repo;
/** A folder's entries the tree shows. */
function shownIn(t: Tree, dir: string): FileEntry[] {
  const entries = t.children.get(dir) ?? [];
  return changedOnly(t) ? entries.filter((e) => (e.kind === "dir" ? t.gitDirs.has(e.path) : !!t.git[e.path])) : entries;
}

/** What the tree shows, top to bottom: open folders that are listed show their contents. */
function rowsOf(t: Tree, dir: string, depth: number, out: Row[]): Row[] {
  for (const e of shownIn(t, dir)) {
    out.push({ e, depth });
    if (e.kind === "dir" && t.expanded.has(e.path) && t.children.has(e.path)) rowsOf(t, e.path, depth + 1, out);
  }
  return out;
}

/** Shown while the files panel is docked or peeking from the window's edge. */
const explorerShown = () => !!session()?.files || peeking;

/** Rows kept between draws when nothing about them changed, so hover and focus don't flicker under a refresh. */
let rowCache = new Map<string, HTMLElement>();
/** Folds in motion hold the tree still; a draw asked for meanwhile happens once they're done. */
let folding = 0;
let drawAfterFold = false;
/** A name being typed in the tree (a rename, a new file): redraws wait for it. */
let holdDraws = 0;

function renderExplorer() {
  const r = root();
  if (!r || !explorerShown()) return;
  const t = treeOf(r);
  if (!t.ready) return void ready(r);
  renderScope(r, t);
  renderTabs();
  if (sidebarView() === "changes") return changes.render(), drawTreeIdle(r, t);
  drawTree(r, t);
}

/** The tree (or the search's results) drawn. */
function drawTree(r: string, t: Tree) {
  if (folding || holdDraws) return void (drawAfterFold = true);
  treeStale = false;
  if (results) return renderResults(t);
  const top = treeEl.scrollTop;
  const next = new Map<string, HTMLElement>();
  const nodes: HTMLElement[] = [];
  if (t.errors.has("") && !t.children.has("")) {
    const box = el("div", "ft-error");
    const retry = el("button", "ft-retry", "Try again");
    retry.onclick = () => void load(r, "").then(renderExplorer);
    box.append(el("div", "", t.errors.get("")!), retry);
    nodes.push(box);
  } else nodes.push(...group(r, t, "", 0, next));
  if (changedOnly(t) && !shownIn(t, "").length) nodes.push(el("div", "ft-empty", "No changes"));
  rowCache = next;
  treeEl.replaceChildren(...nodes);
  treeEl.scrollTop = top;
  prefetchVisible(r, t);
  syncWatch();
}

/** A folder's rows; an open folder's own follow it in a box of their own (what a fold slides), with its guide. */
function group(r: string, t: Tree, dir: string, depth: number, cache: Map<string, HTMLElement>): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (dir && t.errors.has(dir)) {
    const note = el("button", "ft-row ft-retry-row");
    note.style.paddingLeft = `${8 + depth * INDENT + 18}px`;
    note.append(el("span", "ft-name", "Couldn't open this folder · Try again"));
    note.title = t.errors.get(dir)!;
    note.onclick = () => {
      t.errors.delete(dir);
      void load(r, dir).then(renderExplorer);
    };
    out.push(note);
  }
  for (const e of shownIn(t, dir)) {
    out.push(entryRow(r, t, e, depth, cache));
    if (e.kind !== "dir" || !t.expanded.has(e.path) || !t.children.has(e.path)) continue;
    const kids = el("div", "ft-kids");
    kids.dataset.dir = e.path;
    kids.style.setProperty("--guide", `${8 + 7 + depth * INDENT}px`);
    kids.append(...group(r, t, e.path, depth + 1, cache));
    out.push(kids);
  }
  return out;
}

function entryRow(r: string, t: Tree, e: FileEntry, depth: number, cache: Map<string, HTMLElement>): HTMLElement {
  const isDir = e.kind === "dir";
  const open = isDir && t.expanded.has(e.path);
  const git = isDir ? t.gitDirs.get(e.path) : t.git[e.path];
  // A folder listed with nothing in it (or nothing shown) is greyed, so it needn't be opened to tell.
  const empty = isDir && t.children.get(e.path)?.length === 0;
  const cls = `ft-row${isDir ? " dir" : ""}${empty ? " empty" : ""}${open ? " open" : ""}${t.selected === e.path ? " selected" : ""}${e.ignored && !git ? " ignored" : ""}${git ? ` git-${git}` : ""}`;
  const sig = `${cls}|${depth}|${e.name}`;
  const kept = rowCache.get(e.path);
  if (kept?.dataset.sig === sig) return cache.set(e.path, kept), kept;
  const row = el("div", cls);
  row.dataset.sig = sig;
  row.dataset.path = e.path;
  row.style.paddingLeft = `${8 + depth * INDENT}px`;
  const chev = el("span", "ft-chev");
  if (isDir) chev.append(icon("chevronRight"));
  const glyph = fileGlyph(e.name, isDir);
  glyph.classList.add("ft-icon");
  row.append(chev, glyph, el("span", "ft-name", e.name));
  if (git) row.append(gitBadge(git, isDir));
  row.draggable = true;
  row.onclick = () => {
    treeEl.focus({ preventScroll: true });
    activateEntry(r, t, e, true);
  };
  row.ondblclick = () => e.kind === "file" && pin(e.path);
  row.oncontextmenu = (ev) => treeMenu(ev, r, e);
  cache.set(e.path, row);
  return row;
}

/** A change's letter at the row's end, or on a folder holding changes, a dot (VS Code's decorations). */
function gitBadge(status: GitStatus, dir: boolean): HTMLElement {
  const badge = el("span", dir ? "ft-git dot" : "ft-git", dir ? "" : GIT_BADGE[status][0]);
  badge.title = dir ? "Contains changes" : GIT_BADGE[status][1];
  return badge;
}

/** A folder opens or closes; a file opens (a click previews it; Enter keeps it and moves to it). */
function activateEntry(r: string, t: Tree, e: FileEntry, preview = false) {
  select(t, e.path);
  if (e.kind === "dir") void toggleDir(r, t, e.path);
  else openFile(e.path, { preview, focus: !preview });
}

/** The highlighted row moves without redrawing the tree. */
function select(t: Tree, path: string | null) {
  t.selected = path;
  // The two rows that changed are drawn afresh next time.
  for (const row of treeEl.querySelectorAll<HTMLElement>(".ft-row.selected")) if (row.dataset.path !== path) row.classList.remove("selected"), (row.dataset.sig = "");
  const row = path ? treeEl.querySelector<HTMLElement>(`.ft-row[data-path="${CSS.escape(path)}"]`) : null;
  if (!row) return;
  row.classList.add("selected");
  row.dataset.sig = "";
  row.scrollIntoView({ block: "nearest" });
}

/** Open or close a folder. Opening waits for its listing (usually there already), its chevron turning at once; the
 *  rows then slide out from under it. Closing slides them back up first. */
async function toggleDir(r: string, t: Tree, path: string, open = !t.expanded.has(path)) {
  const row = treeEl.querySelector<HTMLElement>(`.ft-row[data-path="${CSS.escape(path)}"]`);
  // The chevron turns at once, whatever follows.
  if (row) {
    row.classList.toggle("open", open);
    row.dataset.sig = "";
  }
  if (open) {
    t.expanded.add(path);
    keepExpanded(r, t);
    if (!t.children.has(path) || t.errors.has(path)) await load(r, path);
    // Closed again while it was being listed.
    if (!t.expanded.has(path)) return;
    renderExplorer();
    fold(treeEl.querySelector<HTMLElement>(`.ft-kids[data-dir="${CSS.escape(path)}"]`), true);
  } else {
    await fold(treeEl.querySelector<HTMLElement>(`.ft-kids[data-dir="${CSS.escape(path)}"]`), false);
    t.expanded.delete(path);
    keepExpanded(r, t);
    renderExplorer();
  }
}

/** Slide a folder's rows open or shut by their box's height (at once with reduced motion). */
function fold(kids: HTMLElement | null, open: boolean): Promise<void> {
  if (!kids || reducedMotion()) return Promise.resolve();
  const full = kids.scrollHeight;
  folding++;
  return new Promise((done) => {
    const anim = kids.animate(
      { height: open ? ["0px", `${full}px`] : [`${full}px`, "0px"], opacity: open ? [0.4, 1] : [1, 0.4] },
      { duration: FOLD_MS, easing: "cubic-bezier(0, 0, 0.58, 1)" },
    );
    kids.style.overflow = "hidden";
    anim.onfinish = anim.oncancel = () => {
      kids.style.overflow = "";
      folding--;
      done();
      if (!folding && !holdDraws && drawAfterFold) (drawAfterFold = false), renderExplorer();
    };
  });
}

/** Mod+Alt+C: every folder shut, at once: no slide or chevron turn (hundreds of them at a time stutter). */
export function collapseFolders() {
  const r = root();
  if (!r || !explorerShown() || results) return;
  const t = treeOf(r);
  if (!t.expanded.size) return;
  t.expanded.clear();
  keepExpanded(r, t);
  // The selection inside a folder that shut moves up to its top folder.
  if (t.selected?.includes("/")) t.selected = t.selected.slice(0, t.selected.indexOf("/"));
  renderExplorer();
}

/** Arrows walk the tree (Zeron's tree keys): Right opens a folder or steps into it, Left closes it or steps out. */
function treeKey(e: KeyboardEvent) {
  const r = root();
  if (!r || results || e.ctrlKey || e.metaKey || e.altKey) return;
  // Typing in the tree searches it (focused during keydown, the key lands in the field).
  if ([...e.key].length === 1 && e.key !== " ") {
    e.stopPropagation();
    openSearch();
    return;
  }
  const t = treeOf(r);
  const entries = rowsOf(t, "", 0, []).map((row) => row.e);
  if (!entries.length) return;
  const at = entries.findIndex((x) => x.path === t.selected);
  const cur = at >= 0 ? entries[at] : null;
  const go = (x: FileEntry | undefined) => x && select(t, x.path);
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  switch (e.key) {
    case "ArrowDown":
      handled();
      return go(entries[at < 0 ? 0 : Math.min(entries.length - 1, at + 1)]);
    case "ArrowUp":
      handled();
      return go(entries[at < 0 ? 0 : Math.max(0, at - 1)]);
    case "Home":
      handled();
      return go(entries[0]);
    case "End":
      handled();
      return go(entries.at(-1));
    case "ArrowRight":
      if (!cur || cur.kind !== "dir") return;
      handled();
      if (!t.expanded.has(cur.path)) return void toggleDir(r, t, cur.path, true);
      return go(entries[at + 1]?.path.startsWith(cur.path + "/") ? entries[at + 1] : undefined);
    case "ArrowLeft":
      if (!cur) return;
      handled();
      if (cur.kind === "dir" && t.expanded.has(cur.path)) return void toggleDir(r, t, cur.path, false);
      return go(entries.find((x) => x.path === parentOf(cur.path)));
    case "Enter":
    case " ":
      if (!cur) return;
      handled();
      return activateEntry(r, t, cur);
    case "Escape":
      handled();
      if (peeking) return endPeek(true);
      return focusComposer();
    case "F2":
      if (!cur) return;
      handled();
      return beginRename(r, cur);
    case "Delete":
      if (!cur) return;
      handled();
      return confirmTrash(r, [cur.path]);
  }
}

// ---------------- search ----------------

function onSearch() {
  // The same field searches the changes while they show.
  if (sidebarView() === "changes") return changes.filter(search.value);
  const r = root();
  const q = search.value.trim();
  if (!r || !q) {
    results = null;
    renderExplorer();
    return;
  }
  const seq = ++searchSeq;
  void call("files.search", { root: r, query: q, all: saved.showAll })
    .then(async (found) => {
      await loadIcons(found.map((p) => iconKey(p)));
      if (seq !== searchSeq) return;
      results = found;
      resultIx = 0;
      renderExplorer();
    })
    .catch(() => {});
}

function renderResults(t: Tree) {
  if (!results!.length) return void treeEl.replaceChildren(el("div", "ft-empty", "No matching files"));
  treeEl.replaceChildren(
    ...results!.map((path, i) => {
      const git = t.git[path];
      const row = el("div", `ft-row ft-result${i === resultIx ? " selected" : ""}${git ? ` git-${git}` : ""}`);
      const glyph = fileGlyph(path);
      glyph.classList.add("ft-icon");
      row.append(glyph, el("span", "ft-name", baseName(path)), el("span", "ft-dir", parentOf(path)));
      if (git) row.append(gitBadge(git, false));
      row.title = path;
      row.onclick = () => openResult(path);
      return row;
    }),
  );
}

function clearSearch() {
  search.value = "";
  results = null;
  searchSeq++;
  findRow.hidden = true;
  searchBtn.classList.remove("on");
  changes.filter("");
}

function openResult(path: string) {
  clearSearch();
  renderExplorer();
  openFile(path);
}

function searchKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (!search.value && peeking) return endPeek(true);
    closeSearch();
    treeEl.focus({ preventScroll: true });
    return;
  }
  if (sidebarView() === "changes") {
    const path = e.key === "Enter" ? changes.firstMatch() : null;
    if (path) e.preventDefault(), openReview(path);
    return;
  }
  if (!results?.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    resultIx = Math.max(0, Math.min(results.length - 1, resultIx + (e.key === "ArrowDown" ? 1 : -1)));
    renderExplorer();
    treeEl.querySelector(".ft-row.selected")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    openResult(results[resultIx]);
  }
}

// ---------------- the explorer's menu ----------------

/** How many folders Expand all opens at most (level by level, ignored ones left shut). */
const EXPAND_MAX = 300;

/** The "…" by the search: ignored files shown or not, every folder shut or open. */
let moreMenu: Popover | null = null;
function toggleMoreMenu(e?: MouseEvent) {
  if (moreMenu) return moreMenu.close();
  const r = root();
  if (!r) return;
  const t = treeOf(r);
  const row = (glyph: IconName, label: string, run: () => void, trail?: HTMLElement | string) => {
    const it = el("div", "menu-row");
    it.append(icon(glyph, undefined, "lead"), el("span", "grow", label));
    if (typeof trail === "string") it.append(el("span", "value", trail));
    else if (trail) it.append(trail);
    it.onclick = (e) => {
      e.stopPropagation();
      run();
    };
    return it;
  };
  const close = (run: () => void) => () => (moreMenu?.close(), run());
  // Ignored files: switched in place, the menu staying open.
  const sw = toggleSwitch(saved.showAll);
  const eye = row(saved.showAll ? "eye" : "eyeClosed", "Show ignored files", () => {
    toggleHiddenFiles();
    sw.classList.toggle("on", saved.showAll);
    eye.querySelector(".lead")?.replaceWith(icon(saved.showAll ? "eye" : "eyeClosed", undefined, "lead"));
  }, sw);
  eye.title = hint(saved.showAll ? "Hide ignored files" : "Show ignored files", "toggleHiddenFiles");
  // With the changes showing, git's rows instead.
  const git = sidebarView() === "changes" ? changes.menuRows(() => moreMenu?.close()) : null;
  const rows = git ?? [eye, "-" as const, row("folderOpen", "Expand all folders", close(() => void expandFolders()), bound("expandFolders")), row("folder", "Collapse all folders", close(collapseFolders), bound("collapseFolders"))];
  moreMenu = openContextMenu(menuPoint(e, moreBtn), rows, { trigger: moreBtn, className: "fp-menu", onClose: () => ((moreMenu = null), released()) });
}

/** The tree's changed files only, or every file. Switched on, every folder holding changes opens (up to EXPAND_MAX of
 *  them, listed shallowest first), so what changed shows whole. */
async function toggleChangedOnly() {
  const r = root();
  if (!r) return;
  const t = treeOf(r);
  saved.changedOnly = !saved.changedOnly;
  persist();
  if (saved.changedOnly) {
    const dirs = [...t.gitDirs.keys()].sort((a, b) => a.split("/").length - b.split("/").length).slice(0, EXPAND_MAX);
    for (let depth = 1; ; depth++) {
      const level = dirs.filter((d) => d.split("/").length === depth);
      if (!level.length) break;
      await Promise.all(level.filter((d) => !t.children.has(d)).map((d) => load(r, d)));
    }
    for (const d of dirs) t.expanded.add(d);
    keepExpanded(r, t);
  }
  if (root() === r) renderExplorer();
}

/** Mod+Alt+E: every folder open, up to EXPAND_MAX of them; ignored ones stay shut. Listed level by level, then
 *  opened together in one draw, without slides (a draw meanwhile would show, and rebuild, the tree half open). */
export async function expandFolders() {
  const r = root();
  if (!r || !explorerShown() || results) return;
  const t = treeOf(r);
  const open: string[] = [];
  let level = [""];
  for (;;) {
    await Promise.all(level.filter((d) => !t.children.has(d)).map((d) => load(r, d)));
    const next: string[] = [];
    for (const d of level)
      for (const e of t.children.get(d) ?? []) if (e.kind === "dir" && !e.ignored && open.length < EXPAND_MAX) open.push(e.path), next.push(e.path);
    if (!next.length) break;
    level = next;
    if (open.length >= EXPAND_MAX) {
      await Promise.all(level.filter((d) => !t.children.has(d)).map((d) => load(r, d)));
      break;
    }
  }
  for (const d of open) t.expanded.add(d);
  keepExpanded(r, t);
  if (root() === r) renderExplorer();
}

/** F2 with the pointer on an entry in the tree: rename it (true), rather than whatever F2 does elsewhere. */
export function renameHovered(): boolean {
  const r = root();
  if (!r || !hoveredPath || results || !explorerShown()) return false;
  const t = treeOf(r);
  const entry = [...t.children.values()].flat().find((e) => e.path === hoveredPath);
  if (!entry) return false;
  select(t, entry.path);
  beginRename(r, entry);
  return true;
}

// ---------------- Go to file ----------------

/** Go to file's matches in the open session's folder (ignored files only while the tree shows them), best first,
 *  with their icons loaded. */
export async function findFiles(query: string): Promise<string[]> {
  const r = root();
  if (!r || !query.trim()) return [];
  const found = await call("files.search", { root: r, query, all: saved.showAll });
  await loadIcons(found.map((p) => iconKey(p)));
  return found;
}

/** A file shown: first among its folder's recent ones. Saves the panels' state. */
function remember(r: string, path: string) {
  saved.recent[r] = [path, ...(saved.recent[r] ?? []).filter((p) => p !== path)].slice(0, RECENT_MAX);
  persist();
}

export type Suggestion = { path: string; group: "open" | "recent" | "changed" | "files" };

/** Go to file's list before anything's typed, like VS Code's: the open tabs (the shown one first), files shown
 *  lately, the changed ones, then the folder's own (its top level first). What's known now; `loadSuggestions` fills in the rest. */
export function suggestedFiles(): Suggestion[] {
  const s = session();
  const r = root();
  if (!s || !r) return [];
  const t = treeOf(r);
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const add = (group: Suggestion["group"], paths: string[]) => {
    for (const path of paths) if (out.length < SUGGEST_MAX && !seen.has(path)) seen.add(path), out.push({ path, group });
  };
  add("open", s.active ? [s.active, ...s.tabs.filter((p) => p !== s.active)] : s.tabs);
  add("recent", saved.recent[r] ?? []);
  add("changed", Object.keys(t.git).filter((p) => t.git[p] !== "deleted"));
  // The top level's files, then those of every folder listed so far, shallowest first.
  const depth = (dir: string) => (dir ? dir.split("/").length : 0);
  const dirs = [...t.children.keys()].sort((a, b) => depth(a) - depth(b));
  for (const dir of dirs) add("files", t.children.get(dir)!.filter((e) => e.kind === "file").map((e) => e.path));
  return out;
}

/** The changes and top-level listing the suggestions draw on, fetched (again), with every icon they show. */
export async function loadSuggestions(): Promise<void> {
  const r = root();
  if (!r) return;
  await Promise.all([loadGit(r), treeOf(r).children.has("") ? null : load(r, "")]);
  if (root() === r) renderExplorer();
  await loadIcons(suggestedFiles().map((x) => iconKey(x.path)));
}

/** Mod+H: ignored files shown or not. The tree is listed again and swapped in whole. */
export function toggleHiddenFiles() {
  saved.showAll = !saved.showAll;
  persist();
  renderExplorer();
  const r = root();
  if (r && explorerShown()) {
    void relist(r);
    if (search.value.trim()) onSearch();
  }
  // Other folders list afresh when they're next shown.
  for (const [key, t] of trees) if (key !== r) (t.children.clear(), (t.ready = false));
}

// ---------------- watching ----------------

/** What this window watches: the folder's listed folders while the tree shows, and the open files' own. */
let watchSig = "";
let watchRoot: string | null = null;
function syncWatch() {
  const r = root();
  const s = session();
  const dirs = new Set<string>();
  if (r && s) {
    if (explorerShown()) {
      const t = treeOf(r);
      dirs.add("");
      for (const d of t.expanded) if (t.children.has(d)) dirs.add(d);
    }
    if (s.surfaces) for (const p of s.tabs) dirs.add(dirOf(p));
  }
  const sig = r ? `${r}\0${[...dirs].sort().join("\0")}` : "";
  if (sig === watchSig) return;
  // The folder watched before, if this is another (a session switch): let go of it.
  if (watchRoot && watchRoot !== r) void call("files.watch", { root: watchRoot, dirs: [] }).catch(() => {});
  watchSig = sig;
  watchRoot = r;
  if (r) void call("files.watch", { root: r, dirs: [...dirs] }).catch(() => (watchSig = ""));
}

/** The core again (a reconnect): it watches nothing for this window until told. */
export function resyncWatch() {
  watchSig = "";
  watchRoot = null;
  syncWatch();
  refresh();
}

/** Something changed on disk (the core has already let it settle): the listings of the watched folders it was in,
 *  the open files there, and git's colours, drawn together so a new file's row appears with its letter. */
export function filesChanged(r: string, dirs: string[]) {
  if (r !== root()) return;
  const t = treeOf(r);
  const listed = dirs.filter((d) => t.children.has(d));
  void Promise.all([loadGit(r, true), ...listed.map((d) => load(r, d))]).then(() => root() === r && renderExplorer());
  const s = session();
  const changed = new Set(dirs);
  if (s) for (const p of s.tabs) if (changed.has(dirOf(p)) && docs.has(docKey(r, p))) void loadFile(r, p, true);
}

// ---------------- menus ----------------

let menu: Popover | null = null;

/** A menu at a point (the pointer, or a caret). `beside`: the tree row it's for, which stays marked while it's open. */
function contextMenu(at: { x: number; y: number }, items: MenuEntry[], beside?: HTMLElement | null) {
  menu = openContextMenu(at, items, { beside, onClose: () => ((menu = null), released()) });
}

const bound = (id: ShortcutId) => (prefs.keymap[id] ? displayCombo(prefs.keymap[id]) : undefined);
const absolute = (r: string, path: string) => (isAbs(path) ? path : path ? `${r}/${path}` : r);
const copy = (text: string) => void navigator.clipboard.writeText(text);

/** The tree's menu: on an entry, or (null) on the folder itself. */
function treeMenu(e: MouseEvent, r: string, entry: FileEntry | null) {
  e.preventDefault();
  e.stopPropagation();
  const t = treeOf(r);
  if (entry) select(t, entry.path);
  const dir = !entry ? "" : entry.kind === "dir" ? entry.path : parentOf(entry.path);
  const path = entry?.path ?? "";
  const items: MenuEntry[] = [];
  if (entry?.kind === "file") items.push({ icon: "file", label: "Open", run: () => openFile(entry.path) }, { icon: "externalLink", label: "Open in default app", run: () => openExternally(r, entry.path) }, "-");
  items.push({ icon: "filePlus", label: "New file…", run: () => void beginCreate(r, dir, "file") }, { icon: "folderPlus", label: "New folder…", run: () => void beginCreate(r, dir, "dir") });
  if (entry) items.push("-", { icon: "pencil", label: "Rename…", hint: "F2", run: () => beginRename(r, entry) }, { icon: "copyPlus", label: "Duplicate", run: () => void duplicate(r, entry.path) });
  items.push(
    "-",
    { icon: "clipboardCopy", label: "Copy path", run: () => copy(absolute(r, path)) },
    { icon: "folderOpen", label: "Reveal in file manager", run: () => void call("files.reveal", { root: r, path }).catch((err) => flash(String(err?.message ?? err))) },
  );
  // Deleting comes last, apart from the rest.
  if (entry) items.push("-", { icon: "trash2", label: "Delete", hint: "Delete", danger: true, run: () => confirmTrash(r, [entry.path]) });
  contextMenu({ x: e.clientX, y: e.clientY }, items, (e.target as Element).closest<HTMLElement>(".ft-row") ?? treeEl);
}

/** A tab's menu. */
function tabMenu(e: MouseEvent, path: string) {
  e.preventDefault();
  const s = session();
  const r = root();
  if (!s || !r) return;
  const at = s.tabs.indexOf(path);
  const items: MenuEntry[] = [
    { icon: "x", label: "Close", hint: bound("closeFile"), run: () => closeTab(path) },
    { icon: "x", label: "Close others", run: () => closeTabs(s.tabs.filter((p) => p !== path)) },
    { icon: "x", label: "Close to the right", run: () => closeTabs(s.tabs.slice(at + 1)) },
    { icon: "x", label: "Close all", run: () => closeTabs([...s.tabs]) },
  ];
  if (path === REVIEW) return contextMenu({ x: e.clientX, y: e.clientY }, items);
  if (path.startsWith(COMMIT_TAB)) {
    items.push("-", { icon: "clipboardCopy", label: "Copy commit hash", run: () => copy(path.slice(COMMIT_TAB.length)) });
    return contextMenu({ x: e.clientX, y: e.clientY }, items);
  }
  items.push("-", { icon: "clipboardCopy", label: "Copy path", run: () => copy(absolute(r, path)) });
  if (!isAbs(path)) items.push({ icon: "folderTree", label: "Reveal in files panel", run: () => revealInTree(path) });
  items.push({ icon: "folderOpen", label: "Reveal in file manager", run: () => void call("files.reveal", { root: r, path }).catch((err) => flash(String(err?.message ?? err))) });
  contextMenu({ x: e.clientX, y: e.clientY }, items);
}

/** The files panel opened on a path, selected: on the files view (put there when the panel was away; slid over to
 *  when it showed the changes, the tree drawn once the slide is done). */
function revealInTree(path: string) {
  if (!explorerShown()) (saved.view = "files"), (placedView = null);
  if (!filesOpen()) toggleFiles(false);
  if (sidebarView() === "files") return reveal(path);
  showSidebarView("files");
  setTimeout(() => sidebarView() === "files" && reveal(path), SLIDE_MS + 60);
}

// ---------------- changing files ----------------

/** Paths that moved (a rename, a drag): open tabs follow, their unsaved edits with them. */
function moved(r: string, from: string, to: string) {
  const s = session();
  const t = treeOf(r);
  const map = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  if (t.selected) t.selected = map(t.selected);
  t.expanded = new Set([...t.expanded].map(map));
  keepExpanded(r, t);
  if (!s) return;
  for (const [i, p] of s.tabs.entries()) {
    const next = map(p);
    if (next === p) continue;
    s.tabs[i] = next;
    if (s.active === p) s.active = next;
    if (s.preview === p) s.preview = next;
    const old = docKey(r, p);
    const d = docs.get(old);
    if (live?.key === old) retire();
    docs.delete(old);
    dropViews(old);
    // A fresh editor under the new name, keeping unsaved text (not its undo history).
    if (d?.dirty && d.state) {
      const text = textOf(old, d);
      docs.set(docKey(r, next), { ...d, state: codeState(text, next, hooksFor(r, next)), baseGen: -1 });
      drafts[docKey(r, next)] = { text, mtime: d.mtime };
    }
    if (old in drafts) delete drafts[old];
    writeDrafts();
  }
  persist();
  renderPane();
}

async function relistAround(r: string, ...paths: string[]) {
  const dirs = new Set(paths.map(parentOf));
  await Promise.all([...dirs].filter((d) => d === "" || treeOf(r).children.has(d)).map((d) => load(r, d)));
  if (root() === r) renderExplorer();
}

/** An input in place of a row: Enter (or leaving it) keeps the name, Escape drops it. `select`: the part of the name
 *  selected at first (a file's name without its extension). */
function nameInput(row: HTMLElement, value: string, select: [number, number], done: (name: string | null) => void) {
  const name = row.querySelector<HTMLElement>(".ft-name");
  const input = el("input", "ft-input");
  input.value = value;
  input.spellcheck = false;
  (name ?? row).replaceWith(input);
  if (!name) row.append(input);
  input.focus();
  input.setSelectionRange(select[0], select[1]);
  let finished = false;
  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    done(keep && next && next !== value ? next : null);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") e.preventDefault(), finish(true);
    else if (e.key === "Escape") e.preventDefault(), finish(false), treeEl.focus({ preventScroll: true });
  };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  input.onmousedown = (e) => e.stopPropagation();
}

const stemEnd = (name: string) => (name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length);

/** F2: the entry's name edited in place. */
function beginRename(r: string, e: FileEntry) {
  const row = treeEl.querySelector<HTMLElement>(`.ft-row[data-path="${CSS.escape(e.path)}"]`);
  if (!row) return;
  row.dataset.sig = "";
  holdDraws++;
  nameInput(row, e.name, [0, e.kind === "dir" ? e.name.length : stemEnd(e.name)], (name) => {
    holdDraws--;
    released();
    if (!name) return renderExplorer();
    const to = parentOf(e.path) ? `${parentOf(e.path)}/${name}` : name;
    call("files.rename", { root: r, from: e.path, to })
      .then(() => {
        moved(r, e.path, to);
        treeOf(r).selected = to;
        return relistAround(r, e.path, to);
      })
      .catch((err) => (flash(String(err?.message ?? err)), renderExplorer()));
  });
}

/** New file or folder: a row with a name to type, at the top of the folder it goes in (opened first). */
async function beginCreate(r: string, dir: string, kind: "file" | "dir") {
  const t = treeOf(r);
  if (!filesOpen() && !peeking) toggleFiles(false);
  if (dir && !t.expanded.has(dir)) await toggleDir(r, t, dir, true);
  const depth = dir ? dir.split("/").length : 0;
  const row = el("div", `ft-row ft-new${kind === "dir" ? " dir" : ""}`);
  row.style.paddingLeft = `${8 + depth * INDENT}px`;
  const chev = el("span", "ft-chev");
  if (kind === "dir") chev.append(icon("chevronRight"));
  const glyph = fileGlyph(kind === "dir" ? "folder" : "", kind === "dir");
  glyph.classList.add("ft-icon");
  row.append(chev, glyph, el("span", "ft-name", ""));
  const kids = dir ? treeEl.querySelector<HTMLElement>(`.ft-kids[data-dir="${CSS.escape(dir)}"]`) : treeEl;
  if (!kids) return;
  kids.prepend(row);
  row.scrollIntoView({ block: "nearest" });
  holdDraws++;
  nameInput(row, "", [0, 0], (name) => {
    holdDraws--;
    released();
    row.remove();
    if (!name) return renderExplorer();
    const path = dir ? `${dir}/${name}` : name;
    call("files.create", { root: r, path, kind })
      .then(async () => {
        t.selected = path;
        await relistAround(r, path);
        if (kind === "file") openFile(path, { focus: true });
      })
      .catch((err) => (flash(String(err?.message ?? err)), renderExplorer()));
  });
}

async function duplicate(r: string, path: string) {
  try {
    const copied = await call("files.duplicate", { root: r, path });
    treeOf(r).selected = copied;
    await relistAround(r, copied);
  } catch (err: any) {
    flash(String(err?.message ?? err));
  }
}

/** Delete (to the trash), asked first; if the trash can't take it, deleting it outright is offered. */
function confirmTrash(r: string, paths: string[]) {
  const names = paths.map(baseName);
  dialog(paths.length === 1 ? `Delete ${names[0]}?` : `Delete ${paths.length} items?`, `${paths.length === 1 ? "It goes" : "They go"} to the trash, where ${paths.length === 1 ? "it" : "they"} can be restored from.`, [
    ["Cancel", "filled", () => {}],
    ["Move to trash", "danger", () => void trash(r, paths, false)],
  ]);
}

async function trash(r: string, paths: string[], permanent: boolean) {
  try {
    await call("files.trash", { root: r, paths, permanent });
  } catch (err: any) {
    if (permanent) return flash(String(err?.message ?? err));
    return dialog("Couldn't use the trash", `${err?.message ?? err}. Delete permanently instead? This can't be undone.`, [
      ["Cancel", "filled", () => {}],
      ["Delete permanently", "danger", () => void trash(r, paths, true)],
    ]);
  }
  // Their tabs close; unsaved edits there are dropped with the file.
  const s = session();
  const gone = (p: string) => paths.some((x) => p === x || p.startsWith(`${x}/`));
  if (s) shut(s.tabs.filter(gone));
  const t = treeOf(r);
  if (t.selected && gone(t.selected)) t.selected = null;
  await relistAround(r, ...paths);
}

// Dragging entries onto folders (or the tree's empty space: the top folder) moves them.
let dragging: string | null = null;
function dropTarget(e: DragEvent): string | null {
  const row = (e.target as Element).closest<HTMLElement>(".ft-row");
  const kids = (e.target as Element).closest<HTMLElement>(".ft-kids");
  if (row?.dataset.path !== undefined) return row.classList.contains("dir") ? row.dataset.path : parentOf(row.dataset.path);
  return kids?.dataset.dir ?? "";
}
function canDrop(from: string, dir: string) {
  return parentOf(from) !== dir && dir !== from && !dir.startsWith(`${from}/`);
}
function wireDrags() {
  treeEl.addEventListener("dragstart", (e) => {
    const row = (e.target as Element).closest<HTMLElement>(".ft-row");
    if (!row?.dataset.path) return;
    dragging = row.dataset.path;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", dragging);
  });
  const mark = (dir: string | null) => {
    treeEl.classList.remove("drop-into");
    for (const x of treeEl.querySelectorAll(".drop-into")) x.classList.remove("drop-into");
    if (dir === null) return;
    if (!dir) treeEl.classList.add("drop-into");
    else treeEl.querySelector(`.ft-row[data-path="${CSS.escape(dir)}"]`)?.classList.add("drop-into");
  };
  treeEl.addEventListener("dragover", (e) => {
    if (dragging === null) return;
    const dir = dropTarget(e);
    if (dir === null || !canDrop(dragging, dir)) return mark(null);
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    mark(dir);
  });
  treeEl.addEventListener("dragleave", (e) => {
    if (!treeEl.contains(e.relatedTarget as Node)) mark(null);
  });
  treeEl.addEventListener("drop", (e) => {
    const from = dragging;
    const dir = dropTarget(e);
    mark(null);
    dragging = null;
    const r = root();
    if (from === null || dir === null || !r || !canDrop(from, dir)) return;
    e.preventDefault();
    const to = dir ? `${dir}/${baseName(from)}` : baseName(from);
    call("files.rename", { root: r, from, to })
      .then(() => {
        moved(r, from, to);
        treeOf(r).selected = to;
        return relistAround(r, from, to);
      })
      .catch((err) => flash(String(err?.message ?? err)));
  });
  treeEl.addEventListener("dragend", () => {
    dragging = null;
    mark(null);
  });
}

// ---------------- the edge peek ----------------

/** With the files panel put away, touching the window's right edge with the pointer slides it in over everything; it
 *  slides away once the pointer has left it for a moment. Followed by where the
 *  pointer is, not by enter/leave on a panel that moves under it. */
let peeking = false;
let closeTimer: Timer | null = null;
/** How close to the window's edge counts as touching it: past the scrollbars, which stay usable. */
const EDGE_PX = 3;
const PEEK_LINGER = 100;

const peekable = () => {
  const s = session();
  return !!s && !s.files && !app.classList.contains("settings-open");
};

/** Where the pointer last was, across the window. */
let pointerX = 0;
/** A menu beside the peek just closed (or a name typed in it was entered) with the pointer out past the panel: it
 *  stays while the pointer heads back to it, and goes once it strays GRACE_SLACK past the nearest it came, or rests
 *  (GRACE_MS) without coming nearer. */
let grace: { gap: number; timer: Timer } | null = null;
const GRACE_MS = 1200;
const GRACE_SLACK = 16;

/** The pointer moved to `x` across the window, `buttons` held. */
function onPointer(x: number, buttons: number) {
  pointerX = x;
  if (!peeking) {
    // Back over it while it's still sliding away: it comes back.
    if (app.classList.contains("files-peek") && !buttons && x >= explorer.getBoundingClientRect().left) return startPeek();
    if (x >= innerWidth - EDGE_PX && !buttons) startPeek();
    return;
  }
  // Over the panel (or within a few pixels of its edge): it stays. Anywhere else: it goes, after a moment.
  const gap = innerWidth - explorer.offsetWidth - 8 - x;
  if (gap <= 0) return endGrace(), cancelClose();
  if (!grace) return scheduleClose();
  if (gap > grace.gap + GRACE_SLACK) return endPeek();
  if (gap < grace.gap) (grace.gap = gap), restGrace();
}

/** Something that held the peek open let go of it: with the pointer out past the panel, the grace begins. */
function released() {
  const gap = innerWidth - explorer.offsetWidth - 8 - pointerX;
  if (!peeking || holding() || gap <= 0) return;
  cancelClose();
  endGrace();
  grace = { gap, timer: graceTimer() };
}
const graceTimer = () =>
  setTimeout(() => {
    grace = null;
    if (peeking && !holding()) endPeek();
  }, GRACE_MS);
function restGrace() {
  if (!grace) return;
  clearTimeout(grace.timer);
  grace.timer = graceTimer();
}
function endGrace() {
  if (grace) clearTimeout(grace.timer), (grace = null);
}

function cancelClose() {
  if (closeTimer) clearTimeout(closeTimer), (closeTimer = null);
}
/** The peek stays while one of its menus (the scope's list too) is open or a name is being typed in it (its search doesn't hold it: the
 *  pointer leaving takes the search's focus with it). */
const holding = () => !!menu || !!moreMenu || scopePick.classList.contains("open") || holdDraws > 0;
function scheduleClose() {
  if (closeTimer || holding()) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (peeking && !holding()) endPeek();
  }, PEEK_LINGER);
}

function startPeek() {
  if (!peekable() || peeking) return;
  peeking = true;
  renderExplorer();
  // Placed off the edge first (at once: placing it isn't a slide), then slid in, from wherever it is should it still be
  // sliding out.
  if (!app.classList.contains("files-peek")) {
    explorer.style.transition = "none";
    app.classList.add("files-peek");
    void explorer.offsetWidth;
    explorer.style.transition = "";
  }
  app.classList.add("peek-shown");
}

function endPeek(refocus = false) {
  cancelClose();
  endGrace();
  if (!peeking) return;
  peeking = false;
  const hadFocus = explorer.contains(document.activeElement);
  app.classList.remove("peek-shown");
  setTimeout(() => !peeking && app.classList.remove("files-peek"), RESIZE_MS + 20);
  if (hadFocus || refocus) focusComposer();
}

// ---------------- mount ----------------

export function initPanels(refocus: () => void) {
  focusComposer = refocus;
  setOpener(openCited);
  app = $("app");

  pane = el("aside", "rp");
  const paneInner = el("div", "rp-inner");
  paneBar = el("div", "rp-bar");
  paneBody = el("div", "rp-body");
  noticeSlot = el("div", "fv-notice-slot");
  contentSlot = el("div", "fv-slot");
  paneBody.append(noticeSlot, contentSlot);
  paneInner.append(paneBar, paneBody);
  // Mod+A in a rendered file (Markdown, an image's page) selects that file's content, not the whole window.
  paneBody.addEventListener("keydown", (e) => {
    if (e.key !== "a" || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || live?.view.hasFocus) return;
    const scroll = contentSlot.querySelector<HTMLElement>(".fv-scroll");
    if (!scroll) return;
    e.preventDefault();
    getSelection()?.selectAllChildren(scroll);
  });
  pane.append(paneInner, resizeHandle("pane"));
  // A click in the host keeps focus there (not back in the composer), so Mod+Tab steps through its tabs.
  paneInner.tabIndex = -1;
  pane.addEventListener("mousedown", (e) => {
    if ((e.target as Element).closest("button, input, a, .pane-resize")) return;
    requestAnimationFrame(() => pane.contains(document.activeElement) || paneInner.focus({ preventScroll: true }));
  });

  explorer = el("aside", "fp");
  const filesInner = el("div", "fp-inner");
  // The band at the top (the titlebar's height), where the toggles sit.
  const band = el("div", "fp-band");

  changesData = changesStore({
    root,
    review: openReview,
    open: (path) => openFile(path, { preview: true }),
    flash,
    changed: () => {
      const r = root();
      if (r) void loadGit(r, true).then(() => root() === r && renderExplorer());
    },
  });
  changes = changesView(changesData);
  review = reviewView(uncommittedSource(changesData), (path) => openFile(path));
  graph = graphView({ root, open: (hash, keep) => openCommit(hash, keep), flash });
  changes.el.append(graph.el);
  changesData.listen(() => (syncToggles(), explorerShown() && renderTabs(), graph.sync(changesData.current())));
  const seg = (label: string) => {
    const s = el("div", "fp-seg");
    s.setAttribute("role", "radiogroup");
    s.setAttribute("aria-label", label);
    return s;
  };
  const head = el("div", "fp-head");
  // The views, one for the other (Mod+Shift+G too).
  const viewSeg = seg("Sidebar view");
  viewSeg.classList.add("fp-seg-slide");
  viewSeg.append((viewPill = el("span", "fp-seg-pill")));
  for (const [v, label, tip] of [["files", "Files", "Files"], ["changes", "Changes", hint("Changes", "showChanges")]] as const) {
    const b = el("button", "fp-seg-btn", label) as HTMLButtonElement;
    b.title = tip;
    b.setAttribute("role", "radio");
    b.onclick = () => showSidebarView(v);
    viewBtns.set(v, b);
    viewSeg.append(b);
  }
  scopeRow = el("div", "fp-sub");
  scopePick = el("button");
  scopeRow.append(scopePick);
  const tool = (glyph: IconName, tip: string, run: (e: MouseEvent) => void) => {
    const b = el("button", "wc-btn fp-tool");
    b.title = tip;
    b.append(icon(glyph));
    b.onclick = run;
    return b;
  };
  changedBtn = tool("fileDiff", "Show only changed files", () => void toggleChangedOnly());
  scopeRow.append(changedBtn);
  searchBtn = tool("search", "Search", () => {
    if (findRow.hidden) openSearch();
    else closeSearch(), treeEl.focus({ preventScroll: true });
  });
  // A click on it while the field has focus mustn't take it (the field would put itself away first).
  searchBtn.onmousedown = (e) => e.preventDefault();
  searchBtn.classList.add("fp-tools-start");
  moreBtn = tool("ellipsis", "More", (e) => toggleMoreMenu(e));
  moreBtn.classList.add("fp-more");
  head.append(viewSeg, searchBtn, moreBtn);
  const newFile = tool("filePlus", "New file…", () => root() && void beginCreate(root()!, "", "file"));
  newFile.classList.add("fp-tools-start");
  scopeRow.append(newFile, tool("folderPlus", "New folder…", () => root() && void beginCreate(root()!, "", "dir")));
  findRow = el("div", "fp-find");
  findRow.hidden = true;
  const field = el("label", "fp-search");
  search = el("input");
  search.placeholder = "Search";
  search.spellcheck = false;
  search.oninput = onSearch;
  search.onkeydown = searchKey;
  // Left empty, it goes.
  search.onblur = () => !search.value && !findRow.hidden && closeSearch();
  field.append(icon("search"), search);
  findRow.append(field);
  treeEl = el("div", "ft");
  treeEl.tabIndex = 0;
  treeEl.setAttribute("role", "tree");
  treeEl.onkeydown = treeKey;
  treeEl.oncontextmenu = (e) => {
    const r = root();
    if (r && !(e.target as Element).closest(".ft-row")) treeMenu(e, r, null);
  };
  wireDrags();
  addEventListener("beforeunload", () => {
    // What the editor on screen holds, kept with the rest.
    if (live) {
      const d = docs.get(live.key);
      if (d) keepDraft(live.key, d);
    }
    for (const [key, d] of docs) if (notebookDirty(key)) syncNotebook(key, d);
    writeDrafts();
  });
  filesView = el("div", "fp-view");
  filesView.append(treeEl);
  filesPage = el("div", "fp-page");
  filesPage.append(scopeRow, filesView);
  deck = el("div", "fp-deck");
  strip = el("div", "fp-strip rest");
  strip.append(filesPage, changes.el);
  deck.append(strip);
  // The search under the head, for the files or the changes, whichever show.
  filesInner.append(band, head, findRow, deck);
  swipeViews(filesInner);
  explorer.append(filesInner, resizeHandle("files"));
  treeEl.addEventListener("pointerover", (e) => (hoveredPath = (e.target as Element).closest<HTMLElement>(".ft-row:not(.ft-result)")?.dataset.path ?? null));
  treeEl.addEventListener("pointerleave", () => (hoveredPath = null));
  // Resting on a folder lists it ahead of a click.
  treeEl.addEventListener("pointerover", (e) => {
    const row = (e.target as Element).closest<HTMLElement>(".ft-row.dir");
    const r = root();
    if (row?.dataset.path && r) prefetch(r, [row.dataset.path]);
  });

  // The window's right edge, while the explorer is put away: resting there brings it out.
  addEventListener("pointermove", (e: PointerEvent) => e.pointerType === "mouse" && onPointer(e.clientX, e.buttons), { passive: true });
  // An HTML preview's frame keeps the pointer's moves to itself: its page passes them on (see previewDoc).
  addEventListener("message", (e) => {
    const at = e.data?.bismuthPointer;
    if (!Array.isArray(at) || typeof at[0] !== "number" || typeof at[1] !== "number") return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>("iframe.fv-html")].find((f) => f.contentWindow === e.source);
    if (frame) onPointer(frame.getBoundingClientRect().left + at[0], at[1]);
  });
  // The pointer gone from the window: it goes.
  document.documentElement.addEventListener("pointerleave", () => peeking && scheduleClose());

  toggles = el("div", "panel-toggles");
  app.append(pane, explorer, toggles);
  makeToggles();

  paintSyntax();
  // Icons are drawn for the appearance: a new one redraws them.
  onTheme(() => {
    paintSyntax();
    rowCache = new Map();
    renderExplorer();
    renderPane();
  });
  // Changes shown or hidden (here or in another window): every open file's editor follows.
  onPrefs((prev) => {
    if (prev.showChanges === prefs.showChanges) return;
    for (const [key, d] of docs) {
      const st = stateOf(key, d);
      if (st && showsChanges(st) !== prefs.showChanges) changeDoc(key, d, showChangesSpec(prefs.showChanges));
    }
    renderBar();
  });
  // Changes against the other scope (here or in another window).
  onPrefs((prev) => prev.changesScope !== prefs.changesScope && rescope());
  // Another file order: every listed folder is put in it again.
  onPrefs((prev) => {
    if (prev.fileSort === prefs.fileSort) return;
    for (const t of trees.values()) for (const entries of t.children.values()) sortEntries(entries);
    renderExplorer();
  });

  // A new session open (or none): its panels, its folder.
  let shown: string | null | undefined;
  on("header", () => {
    const id = panelsKey();
    if (id === shown) return;
    // A session just started from the new-session screen begins with the panels that were open there.
    const was = shown && shown.startsWith(NEW_SCREEN) ? saved.sessions[shown] : null;
    if (was && id && store.thread?.cwd === shown!.slice(NEW_SCREEN.length) && nothingOpen(saved.sessions[id]) && store.echo?.threadId === id)
      (saved.sessions[id] = structuredClone(was)), persist();
    shown = id;
    expanded = false;
    endPeek();
    clearSearch();
    // Another session's panels are simply there (or not), as Zeron's per-chat panels: no glide.
    layout(true);
    renderExplorer();
    renderPane();
    const s = session();
    if (s?.active && root()) void loadFile(root()!, s.active);
    // "Last turn" is the session's own: its turn's changes replace the last one's.
    if (prefs.changesScope === "turn") rescope();
    refresh();
  });
  // The agent at work changes files: look again once things it ran or edited finish, and when the turn ends.
  let mark = "";
  on("transcript", () => {
    const t = store.thread;
    if (!t) return;
    let done = 0;
    for (const turn of t.turns) for (const i of turn.items) if ((i.kind === "fileChange" || i.kind === "command") && i.status !== "inProgress") done++;
    const next = `${t.id}:${done}:${t.activeTurnId ?? ""}`;
    if (next !== mark) {
      const same = mark.startsWith(`${t.id}:`);
      mark = next;
      if (same) refresh(400);
    }
  });
  addEventListener("focus", () => refresh());
  addEventListener("resize", () => layout(true));
  // The sidebar opening or closing changes the room there is.
  let collapsed = store.sidebarCollapsed;
  new MutationObserver(() => collapsed !== store.sidebarCollapsed && ((collapsed = store.sidebarCollapsed), layout())).observe(app, { attributeFilter: ["class"] });
  layout(true);
}
