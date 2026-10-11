// The sidebar's Changes view: the folder's uncommitted files, each with its lines added and removed, and Commit (a
// message, then exactly the files listed); pulling and pushing are in the files' ··· menu. A file's row opens the review (review.ts), where every file's
// diff shows. The git itself is the core's (core/scm.ts); what's read is kept here for the view and the review alike.
import { isPhone } from "./phone";
import type { GitChange, GitChanges, GitStatus } from "../shared/model";
import { el } from "./dom";
import { fileGlyph } from "./fileicons";
import { icon, type IconName } from "./icons";
import { contextMenu, menuPoint, menuSeparator, type Popover } from "./popover";
import type { ChangesScope } from "./prefs";
import { call } from "./store";
import { dialog } from "./widgets";

export type ChangesHooks = {
  root: () => string | null;
  /** The review, at a file (or its top). */
  review: (path?: string) => void;
  /** A file opened in the editor, as the tree opens it (a middle click: a new tab's gesture). */
  open: (path: string) => void;
  flash: (text: string) => void;
  /** git moved (a commit, a discard): the tree's marks and the editors' changes are read again. */
  changed: () => void;
};

export const LETTER: Record<GitStatus, [string, string]> = {
  modified: ["M", "Modified"], added: ["A", "Added"], untracked: ["U", "Untracked"], deleted: ["D", "Deleted"], renamed: ["R", "Renamed"], conflict: ["!", "Conflict"],
};
/** What the file tree's scope dropdown offers, narrowest first: its name and what it means (the tree's marks and the
 *  editors' changes follow it; this view doesn't). "Branch" only on a branch other than the default one. */
export const SCOPES: [ChangesScope, string, string][] = [
  ["turn", "Last turn", "What this session's last turn changed"],
  ["uncommitted", "Uncommitted", "Everything not committed yet"],
  ["unpushed", "Unpushed", "Everything since the last push: its commits and what's uncommitted"],
  ["branch", "Branch", "Everything since this branch left the default one: its commits and what's uncommitted"],
];

/** Change rows drawn at a time. */
const ROWS_PAGE = 200;

export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** "+12 −3", each half in its colour (a binary file's: nothing). */
export function lineCounts(added: number | null, removed: number | null, cls = "cv-counts"): HTMLElement {
  const box = el("span", cls);
  if (added === null || removed === null) return box;
  if (added) box.append(el("span", "cv-add", `+${added}`));
  if (removed) box.append(el("span", "cv-del", `−${removed}`));
  return box;
}

/** Commit messages being written, per folder: kept over reloads until committed. */
const DRAFTS_KEY = "bismuth.commitDrafts";
const drafts: Record<string, string> = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}");
function keepDraft(r: string, text: string) {
  if (text.trim()) drafts[r] = text;
  else delete drafts[r];
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

/** What the view and the review show, read for the open folder: one read at a time, one more after it when
 *  asked meanwhile. Listeners hear of every read. */
export function changesStore(hooks: ChangesHooks) {
  let data: { key: string; changes: GitChanges } | null = null;
  let reading: Promise<void> | null = null;
  let again = false;
  const listeners = new Set<() => void>();
  /** The folder a read is for: "" when there's none to read. */
  const keyOf = () => hooks.root() ?? "";

  async function read() {
    const r = hooks.root();
    const key = keyOf();
    if (!r) return;
    const changes = await call("git.changes", { root: r, since: null });
    if (keyOf() !== key) return void (again = true);
    data = { key, changes };
  }

  function refresh(): Promise<void> {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        try {
          await read();
        } catch (err: any) {
          hooks.flash(String(err?.message ?? err));
        }
      } while (again);
      reading = null;
      for (const fn of listeners) fn();
    })();
    return reading;
  }

  /** What's read, if it's for the open folder (else null: a read is on its way). */
  const current = () => (data && data.key === keyOf() ? data.changes : null);
  /** The files a commit takes: the uncommitted ones listed (a rename's old path with it). */
  const committable = (c: GitChanges) => c.files.filter((f) => f.dirty);

  /** Files put back as the last commit has them. Asked first, since it can't be undone. */
  function discard(files: GitChange[], after?: () => void) {
    const r = hooks.root();
    if (!r || !files.length) return;
    const one = files.length === 1 ? baseName(files[0].path) : null;
    const made = files.filter((f) => f.status === "untracked" || f.status === "added");
    dialog(
      one ? `Discard changes in ${one}?` : `Discard changes in ${files.length} files?`,
      `${one ? "It goes" : "They go"} back to how the last commit has ${one ? "it" : "them"}${made.length ? `; ${made.length === files.length ? (one ? "it's new, so it's" : "they're new, so they're") : `${made.length} new ${made.length === 1 ? "one is" : "ones are"}`} deleted` : ""}. This can't be undone.`,
      [
        ["Cancel", "filled", () => {}],
        [
          "Discard",
          "danger",
          () =>
            void call("git.discard", { root: r, paths: files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])), since: null })
              .catch((err) => hooks.flash(String(err?.message ?? err)))
              .then(() => (hooks.changed(), refresh(), after?.())),
        ],
      ],
    );
  }

  return { refresh, current, committable, discard, listen: (fn: () => void) => listeners.add(fn), hooks };
}

export type ChangesStore = ReturnType<typeof changesStore>;

/** The sidebar's Changes view, under the files' own head: the commit message and Commit, the files, the branch. */
export function changesView(store: ChangesStore) {
  const { hooks } = store;
  /** What's running (a commit, a sync), which holds the buttons. */
  let busy: string | null = null;
  let menu: Popover | null = null;

  const root = el("div", "cv fp-page");
  // The message, and Commit (with Commit & Push beside it).
  const bar = el("div", "cv-bar");
  const msg = el("textarea", "cv-input") as HTMLTextAreaElement;
  msg.rows = 1;
  msg.placeholder = isPhone() ? "Message" : "Message (Ctrl+Enter to commit)";
  const commitBtn = el("button", "cv-commit") as HTMLButtonElement;
  commitBtn.append(icon("check"), el("span", "", "Commit"));
  const commitMore = el("button", "cv-commit-more") as HTMLButtonElement;
  commitMore.title = "More commit actions";
  commitMore.append(icon("chevronDown"));
  const commitBox = el("div", "cv-commit-box");
  commitBox.append(commitBtn, commitMore);
  bar.append(msg, commitBox);
  const list = el("div", "cv-list");
  // Out of a repository: Initialize Git where the bar would be (outside the list's scrollbar gutter, as the bar is).
  const startBox = el("div", "cv-start");
  startBox.hidden = true;
  root.append(bar, startBox, list);
  store.listen(render);

  /** A git command, with the buttons held while it runs; then everything read again. */
  async function run(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    busy = label;
    render();
    let ok = true;
    try {
      await fn();
    } catch (err: any) {
      ok = false;
      hooks.flash(String(err?.message ?? err));
    }
    // Still busy until what it did is read (the folder's changes, a commit gone from them), then drawn.
    hooks.changed();
    await store.refresh();
    busy = null;
    render();
    return ok;
  }

  function fileRow(f: GitChange): HTMLElement {
    const row = el("div", `ft-row cv-row git-${f.status}${f.status === "deleted" ? " gone" : ""}${f.dirty ? "" : " committed"}`);
    const glyph = fileGlyph(baseName(f.path));
    glyph.classList.add("ft-icon");
    row.append(glyph, el("span", "ft-name", baseName(f.path)), el("span", "ft-dir", f.from ? `${dirName(f.from) === dirName(f.path) ? baseName(f.from) : f.from} →` : dirName(f.path)));
    row.title = `${f.from ? `${f.from} → ` : ""}${f.path}${f.dirty ? "" : " · committed since"}`;
    const discard = el("button", "cv-act") as HTMLButtonElement;
    discard.title = "Discard changes";
    discard.append(icon("undo2"));
    discard.onclick = (e) => (e.stopPropagation(), store.discard([f]));
    const letter = el("span", "ft-git", LETTER[f.status][0]);
    letter.title = LETTER[f.status][1];
    row.append(lineCounts(f.added, f.removed), discard, letter);
    row.onclick = () => hooks.review(f.path);
    if (f.status !== "deleted") {
      row.onauxclick = (e) => e.button === 1 && (e.preventDefault(), hooks.open(f.path));
      row.onmousedown = (e) => e.button === 1 && e.preventDefault(); // no autoscroll
    }
    return row;
  }

  /** The files' search, applied to the list: a subsequence of the path, as the files are searched (files.ts). */
  let query = "";
  const matches = (path: string) => {
    const p = path.toLowerCase();
    let at = -1;
    for (const ch of query) if ((at = p.indexOf(ch, at + 1)) < 0) return false;
    return true;
  };
  const shown = (c: GitChanges) => (query ? c.files.filter((f) => matches(f.path)) : c.files);
  function filter(q: string) {
    query = q.trim().toLowerCase().replace(/\s+/g, "");
    render();
  }

  // A long list (a big folder just put under git: everything untracked) is drawn a page at a time as it's scrolled to,
  // not all at once; a redraw keeps as many as were drawn.
  let rowsFor: string | null = null;
  let rowsShown = ROWS_PAGE;
  let rowsLeft: GitChange[] = [];
  const moreRows = el("div", "cv-more");
  list.addEventListener("scroll", () => rowsLeft.length && list.scrollTop + list.clientHeight > list.scrollHeight - 400 && drawMore(), { passive: true });
  function drawMore() {
    if (!rowsLeft.length) return;
    const next = rowsLeft.splice(0, ROWS_PAGE);
    rowsShown += next.length;
    moreRows.before(...next.map(fileRow));
    if (!rowsLeft.length) moreRows.remove();
  }

  function render() {
    const c = store.current();
    if (!c) {
      if (hooks.root()) void store.refresh();
      return;
    }
    bar.hidden = !c.repo;
    startBox.hidden = c.repo;
    if (!c.repo) {
      // VS Code's Initialize Repository (t3code's Initialize Git): the commit bar's place, its button's look.
      const start = el("button", `cv-commit cv-init${busy ? " busy" : ""}`) as HTMLButtonElement;
      start.append(icon("gitBranchPlus"), el("span", "", busy === "Initializing" ? "Initializing…" : "Initialize Git"));
      start.disabled = !!busy;
      start.title = "Start a git repository in this folder";
      start.onclick = () => void run("Initializing", () => call("git.init", { root: hooks.root()! }));
      startBox.replaceChildren(el("div", "cv-note", "This folder isn't in a git repository."), start);
      return list.replaceChildren();
    }
    // The message kept for this folder, and Commit while there's something uncommitted listed (and a message).
    const r = hooks.root()!;
    if (document.activeElement !== msg && msg.value !== (drafts[r] ?? "")) (msg.value = drafts[r] ?? ""), grow();
    syncCommit();
    // The list, under its totals (a click there reviews them all).
    const top = list.scrollTop;
    const files = shown(c);
    if (files.length) {
      const sum = el("button", "cv-summary");
      const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
      const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
      const count = query ? `${files.length} of ${c.files.length} files` : `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
      sum.append(el("span", "grow", count), lineCounts(added, removed));
      sum.title = "Review all the changes";
      sum.onclick = () => hooks.review();
      if (rowsFor !== r) (rowsFor = r), (rowsShown = ROWS_PAGE);
      rowsLeft = files.slice(rowsShown);
      list.replaceChildren(sum, ...files.slice(0, rowsShown).map(fileRow), ...(rowsLeft.length ? [moreRows] : []));
    } else if (c.files.length) list.replaceChildren(el("div", "cv-note", "No matching changes."));
    else
      list.replaceChildren(
        el("div", "cv-note", "No uncommitted changes."),
      );
    list.scrollTop = top;
  }

  // ---- Commit: the message, then exactly the files listed ----

  /** The message box as tall as what's in it, up to a few lines. */
  function grow() {
    msg.style.height = "auto";
    msg.style.height = `${Math.min(msg.scrollHeight, 120)}px`;
  }

  function syncCommit() {
    const c = store.current();
    const ready = c ? store.committable(c).length : 0;
    commitBtn.disabled = commitMore.disabled = !!busy || !ready || !msg.value.trim();
    commitBtn.title = !ready ? (c?.files.length ? "Already committed" : "Nothing to commit") : !msg.value.trim() ? "Write a commit message first" : `Commit ${ready === 1 ? "this file" : `these ${ready} files`}${c?.branch ? ` to ${c.branch}` : ""} · Ctrl+Enter`;
    commitBtn.classList.toggle("busy", !!busy?.startsWith("Commit"));
  }

  function commit(push: boolean) {
    const r = hooks.root();
    const c = store.current();
    if (!r || !c || busy) return;
    const files = store.committable(c);
    if (!msg.value.trim()) return msg.focus();
    if (!files.length) return;
    const message = msg.value;
    void run(push ? "Committing and pushing" : "Committing", async () => {
      await call("git.commit", { root: r, message, paths: files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])) });
      keepDraft(r, "");
      if (hooks.root() === r) (msg.value = ""), grow();
      if (push) await call("git.push", { root: r });
    });
  }

  msg.oninput = () => {
    const r = hooks.root();
    if (r) keepDraft(r, msg.value);
    grow();
    syncCommit();
  };
  msg.onkeydown = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.preventDefault(), commit(false);
  };
  commitBtn.onclick = () => commit(false);
  commitMore.onclick = (e) => {
    if (menu) return menu.close();
    const c = store.current();
    if (!c) return;
    const rows = [menuRow("arrowUp", c.upstream ? "Commit & Push" : "Commit & Publish", () => commit(true), !c.remotes || !c.branch)];
    menu = contextMenu(menuPoint(e, commitMore), rows, { trigger: commitMore, onClose: () => (menu = null) });
  };

  // ---- More: pull, push, sync, refresh, discard all ----

  function menuRow(glyph: IconName, label: string, fn: () => void, disabled = false, danger = false, close = () => menu?.close()): HTMLElement {
    const it = el("div", `menu-row${disabled ? " disabled" : ""}${danger ? " danger" : ""}`);
    it.append(icon(glyph, undefined, "lead"), el("span", "grow", label));
    it.onclick = (e) => {
      e.stopPropagation();
      if (disabled) return;
      close();
      fn();
    };
    return it;
  }

  /** The rows of the files' ··· while the changes show (the files panel opens it where its own goes): pull, push,
   *  sync, review, refresh, discard all. None outside a repository. */
  function menuRows(close: () => void): HTMLElement[] | null {
    const r = hooks.root();
    const c = store.current();
    if (!r || !c?.repo) return null;
    const remote = c.remotes && !!c.branch;
    return [
      menuRow("arrowDown", c.behind ? `Pull ${c.behind} ${c.behind === 1 ? "commit" : "commits"}` : "Pull", () => void run("Pulling", () => call("git.pull", { root: r })), !c.upstream || !!busy, false, close),
      menuRow("arrowUp", !c.upstream ? "Publish branch" : c.ahead ? `Push ${c.ahead} ${c.ahead === 1 ? "commit" : "commits"}` : "Push", () => void run("Pushing", () => call("git.push", { root: r })), !remote || !!busy, false, close),
      menuRow("refreshCw", "Sync", () => void run("Syncing", () => call("git.sync", { root: r })), !c.upstream || !!busy, false, close),
      menuSeparator(),
      menuRow("gitCompare", "Review changes", () => hooks.review(), !c.files.length, false, close),
      menuRow("rotateCcw", "Refresh", () => void store.refresh(), false, false, close),
      menuSeparator(),
      menuRow("undo2", "Discard all changes…", () => store.discard(c.files), !c.files.length || !!busy, true, close),
    ];
  }

  /** The first file the search leaves (Enter in it reviews that one). */
  const firstMatch = () => {
    const c = store.current();
    return c ? (shown(c)[0]?.path ?? null) : null;
  };

  return { el: root, render, menuRows, filter, firstMatch, focus: () => msg.focus({ preventScroll: true }) };
}
