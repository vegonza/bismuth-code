// A review tab in the editor area: every file's diff, one under another (GitHub's and t3code's review), each read-only
// with the language's colours and the unchanged lines between changes folded; a file's diff is read when it comes near
// the screen. What it reviews is its source's: the uncommitted changes (the Changes view's, so the two agree), or a
// commit picked in the graph.
import type { GitChange, GitCommitChanges } from "../shared/model";
import { diffView, type EditorView } from "./code";
import { baseName, dirName, LETTER, lineCounts, type ChangesStore } from "./changes";
import { el, timeAgo } from "./dom";
import { fileGlyph } from "./fileicons";
import { icon } from "./icons";
import { call } from "./store";

/** What a review shows: its files (null while they're read), a file's text before and after, and its heading. */
export type ReviewSource = {
  /** What the files are for: another drops the diffs drawn. */
  key: () => string;
  files: () => GitChange[] | null;
  before: (f: GitChange) => Promise<string | null>;
  after: (f: GitChange) => Promise<string | null>;
  head: (files: GitChange[]) => HTMLElement[];
  /** What shows above the files (a commit's message), if anything. */
  intro?: () => HTMLElement | null;
  /** Why there's nothing to show (no files, or no repository). */
  empty: () => string;
  /** A file's changes undone (the uncommitted ones only). */
  discard?: (f: GitChange) => void;
  listen: (fn: () => void) => void;
};

/** A commit's changes against its first parent (the graph's pick): read once, as a commit doesn't change. */
export function commitSource(root: string, hash: string) {
  let data: GitCommitChanges | null = null;
  let error: string | null = null;
  const listeners = new Set<() => void>();
  void call("git.commitChanges", { root, hash })
    .then((d) => (data = d))
    .catch((err) => (error = String(err?.message ?? err)))
    .finally(() => listeners.forEach((fn) => fn()));
  const source: ReviewSource = {
    key: () => `${root}\0${hash}`,
    files: () => data?.files ?? (error ? [] : null),
    before: (f) => (data?.parent ? call("git.blob", { root, rev: data.parent, path: f.from ?? f.path }) : Promise.resolve("")),
    after: (f) => call("git.blob", { root, rev: hash, path: f.path }),
    head: (files) => {
      const c = data!.commit;
      const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
      const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
      const title = el("span", "rv-title", c.subject);
      title.title = c.subject;
      const meta = el("span", "rv-meta", `${hash.slice(0, 7)} · ${c.author} · ${timeAgo(c.date)}`);
      meta.title = `${hash}\n${c.author}, ${new Date(c.date).toLocaleString()}`;
      return [title, meta, lineCounts(added, removed)];
    },
    intro: () => {
      // The message past its subject line.
      const rest = data?.body.split("\n").slice(1).join("\n").trim();
      return rest ? el("div", "rv-body", rest) : null;
    },
    empty: () => error ?? "This commit changes no files.",
    listen: (fn) => listeners.add(fn),
  };
  return { source, subject: () => data?.commit.subject ?? null };
}

/** The uncommitted changes, as the Changes view lists them. */
export function uncommittedSource(store: ChangesStore): ReviewSource {
  const { hooks } = store;
  return {
    key: () => hooks.root() ?? "",
    files: () => store.current()?.files ?? null,
    before: (f) => call("files.base", { root: hooks.root()!, path: f.from ?? f.path, since: null }),
    after: (f) => (f.status === "deleted" ? Promise.resolve("") : call("files.read", { root: hooks.root()!, path: f.path }).then((c) => (c.kind === "text" ? c.text : null))),
    head: (files) => {
      const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
      const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
      return [el("span", "rv-title", "Uncommitted changes"), el("span", "rv-meta", `${files.length} ${files.length === 1 ? "file" : "files"}`), lineCounts(added, removed)];
    },
    empty: () => (store.current()?.repo === false ? "This folder isn't in a git repository." : "No uncommitted changes."),
    discard: (f) => store.discard([f]),
    listen: (fn) => store.listen(fn),
  };
}

/** A diff this many changed lines long waits for a click to be drawn. */
const LARGE_DIFF = 3000;

type Section = { sig: string; el: HTMLElement; slot: HTMLElement; view: EditorView | null; loaded: Promise<void> | null; file: GitChange };

export function reviewView(source: ReviewSource, open: (path: string) => void) {
  const root = el("div", "rv fv-scroll");
  root.dataset.key = "review";
  const head = el("div", "rv-head");
  const filesEl = el("div", "rv-files");
  root.append(head, filesEl);
  const sections = new Map<string, Section>();
  const folded = new Set<string>();
  /** What the sections were read for (the folder, the scope, the session): another drops them. */
  let shownFor = "";
  const near = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) for (const s of sections.values()) if (s.el === e.target) void load(s);
  }, { root, rootMargin: "800px 0px" });
  // Drawn while it shows; read meanwhile, it's drawn when next shown (a folder just put under git can list thousands).
  let stale = false;
  source.listen(() => (root.isConnected ? render() : (stale = true)));


  function drop(s: Section) {
    s.view?.destroy();
    near.unobserve(s.el);
  }

  /** A file's diff, read and drawn (once). */
  function load(s: Section, large = false): Promise<void> {
    if (s.loaded) return s.loaded;
    const f = s.file;
    if (!large && (f.added ?? 0) + (f.removed ?? 0) > LARGE_DIFF) {
      const show = el("button", "rv-note-btn", "Show this diff");
      show.onclick = () => void load(s, true);
      s.slot.replaceChildren(el("div", "rv-note", `${(f.added ?? 0) + (f.removed ?? 0)} lines changed: a large diff`), show);
      return Promise.resolve();
    }
    s.slot.replaceChildren(el("div", "rv-note", "Reading…"));
    s.loaded = (async () => {
      let before: string | null = null;
      let after: string | null = "";
      try {
        [before, after] = await Promise.all([source.before(f), f.status === "deleted" ? Promise.resolve("") : source.after(f)]);
      } catch (err: any) {
        s.slot.replaceChildren(el("div", "rv-note", String(err?.message ?? err)));
        return;
      }
      if (sections.get(f.path) !== s) return;
      // A file new since has nothing before it.
      if (before === null && (f.status === "untracked" || f.status === "added")) before = "";
      if (before === null || after === null) return void s.slot.replaceChildren(el("div", "rv-note", f.added === null ? "Binary file" : "This file's changes can't be shown"));
      if (before === after) return void s.slot.replaceChildren(el("div", "rv-note", f.status === "renamed" ? "Renamed, unchanged" : "No changes to show"));
      s.slot.replaceChildren();
      s.view = diffView(s.slot, before, after, f.path);
    })();
    return s.loaded;
  }

  function section(f: GitChange): Section {
    const sec = el("section", `rv-file git-${f.status}${folded.has(f.path) ? " folded" : ""}`);
    const top = el("div", "rv-file-head");
    const chev = el("span", "ft-chev");
    chev.append(icon("chevronRight"));
    const glyph = fileGlyph(baseName(f.path));
    glyph.classList.add("ft-icon");
    const name = el("span", "rv-name");
    const dir = dirName(f.path);
    if (dir) name.append(el("span", "rv-dir", `${dir}/`));
    name.append(el("span", "rv-base", baseName(f.path)));
    if (f.from) name.append(el("span", "rv-dir", ` ← ${f.from}`));
    name.title = f.path;
    const openBtn = el("button", "cv-act") as HTMLButtonElement;
    openBtn.title = "Open file";
    openBtn.append(icon("file"));
    openBtn.disabled = f.status === "deleted";
    openBtn.onclick = (e) => (e.stopPropagation(), open(f.path));
    const acts = el("span", "rv-acts");
    acts.append(openBtn);
    if (source.discard) {
      const discard = el("button", "cv-act") as HTMLButtonElement;
      discard.title = "Discard changes";
      discard.append(icon("undo2"));
      discard.onclick = (e) => (e.stopPropagation(), source.discard!(f));
      acts.append(discard);
    }
    const letter = el("span", "ft-git", LETTER[f.status][0]);
    letter.title = LETTER[f.status][1];
    top.append(chev, glyph, name, lineCounts(f.added, f.removed), acts, letter);
    top.onclick = () => {
      sec.classList.toggle("folded");
      if (sec.classList.contains("folded")) folded.add(f.path);
      else folded.delete(f.path);
    };
    const slot = el("div", "rv-diff");
    sec.append(top, slot);
    const s: Section = { sig: sigOf(f), el: sec, slot, view: null, loaded: null, file: f };
    near.observe(sec);
    return s;
  }

  const sigOf = (f: GitChange) => `${f.status}|${f.from ?? ""}|${f.added}|${f.removed}|${f.dirty}`;

  function render() {
    const files = source.files();
    if (!files) return;
    stale = false;
    const key = source.key();
    if (key !== shownFor) {
      for (const s of sections.values()) drop(s);
      sections.clear();
      shownFor = key;
    }
    head.replaceChildren(...source.head(files));
    // The files: kept while they're unchanged, read again when they changed.
    const next = new Set(files.map((f) => f.path));
    for (const [path, s] of sections) if (!next.has(path)) drop(s), sections.delete(path);
    const els: HTMLElement[] = [];
    for (const f of files) {
      let s = sections.get(f.path);
      if (s && s.sig !== sigOf(f)) drop(s), (s = undefined);
      if (!s) sections.set(f.path, (s = section(f)));
      els.push(s.el);
    }
    const intro = source.intro?.();
    if (!els.length) filesEl.replaceChildren(...(intro ? [intro] : []), el("div", "rv-empty", source.empty()));
    else filesEl.replaceChildren(...(intro ? [intro] : []), ...els);
  }

  /** Every file's diff read again (the tab shown afresh: a file may have changed without its counts moving). */
  function reread() {
    for (const s of sections.values()) drop(s);
    sections.clear();
    render();
  }

  /** A file's diff brought to the top (those above it drawn first, so it stays put). */
  async function scrollTo(path?: string) {
    if (!path) return void root.scrollTo({ top: 0 });
    const s = sections.get(path);
    if (!s) return;
    folded.delete(path);
    s.el.classList.remove("folded");
    const above = [...sections.values()].slice(0, [...sections.values()].indexOf(s) + 1);
    await Promise.all(above.map((x) => load(x)));
    root.scrollTo({ top: s.el.offsetTop - head.offsetHeight });
  }

  /** Its editors let go of (the tab closed). */
  const destroy = () => {
    for (const s of sections.values()) drop(s);
    sections.clear();
    near.disconnect();
  };

  /** Put on screen: drawn if what it shows was read while it was away. */
  const shown = () => stale && render();

  return { el: root, render, reread, scrollTo, shown, destroy };
}
