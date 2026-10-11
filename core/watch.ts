// Keeping the right side current (Zeron's files/watch.rs): each window names the folders it shows (the tree's listed
// ones, the open files' own), each is watched on its own (not the whole tree: node_modules and the like stay unwatched),
// and a change in one reaches the windows showing it, gathered for a moment. In a repository, every folder git sees
// (ignored ones left out) is watched too, along with its .git folder, so an edit anywhere, a commit or staging
// recolours the tree, even in folders it doesn't list.
import { existsSync, lstatSync, readdirSync, statSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const SETTLE_MS = 80;
/** Folders one window may have watched per root. */
const MAX_DIRS = 2_000;
/** Folders watched across a repository for git, at most; the shallowest go first. */
const MAX_TREE = 10_000;
/** Watches made at a time while a repository's folders are taken on, so the core never stalls (about 0.1ms each). */
const BATCH = 100;
/** How long a folder made again waits before it's watched again (see `renew`). */
const RENEW_MS = 25;

type Sink = (root: string, dirs: string[], git: boolean) => void;
/** A window's watch on a root: each absolute folder it lists, under the name the window gave it; the repository's
 *  folders (`tree`, for git alone) and .git folder; what changed since the last report. */
type Watch = {
  root: string;
  dirs: Map<string, string>;
  git: string | null;
  tree: Set<string> | null;
  growing: Set<string>;
  live: boolean;
  pending: Set<string>;
  gitPending: boolean;
  timer: Timer | null;
};

/** Bun (1.3) remembers each path it watched with the folder that was there, even once closed: a watch on the same
 *  path after the folder was deleted and made again hears nothing. Each new folder at a path is watched through a
 *  path spelled anew (Linux's /proc/self/root leads back to /), so it's a path Bun hasn't seen. */
const spellings = new Map<string, { ino: number; gen: number }>();
function spelled(abs: string, ino: number): string {
  const was = spellings.get(abs);
  const gen = !was ? 0 : was.ino === ino ? was.gen : was.gen + 1;
  spellings.set(abs, { ino, gen });
  const path = process.platform === "linux" ? "/proc/self/root".repeat(gen) + abs : abs;
  return path.length < 4000 ? path : abs;
}

export class FolderWatch {
  /** Each folder's watcher, and the folder it was made on (its inode: one deleted and made again needs a new one). */
  private watchers = new Map<string, { w: FSWatcher; ino: number; watches: Set<Watch> }>();
  private windows = new Map<string, { sink: Sink; watches: Map<string, Watch> }>();

  /** `window`'s folders under `root`, replacing what it listed there before (none stops). The repository's folders
   *  stay watched across these, so opening and closing folders in the tree doesn't take them on again. */
  set(window: string, sink: Sink, root: string, dirs: string[], gitDir: string | null) {
    let win = this.windows.get(window);
    if (!win) this.windows.set(window, (win = { sink, watches: new Map() }));
    const old = win.watches.get(root);
    if (!dirs.length) {
      if (old) this.release(old);
      win.watches.delete(root);
      return;
    }
    const w: Watch = old ?? { root, dirs: new Map(), git: null, tree: null, growing: new Set(), live: true, pending: new Set(), gitPending: false, timer: null };
    win.watches.set(root, w);
    const before = [...w.dirs.keys(), ...(w.git ? [w.git] : [])];
    w.dirs = new Map(dirs.slice(0, MAX_DIRS).map((d) => [isAbsolute(d) ? resolve(d) : resolve(root, d || "."), d]));
    w.git = gitDir;
    for (const abs of before) if (!this.needs(w, abs)) this.unhold(abs, w);
    for (const abs of w.dirs.keys()) this.hold(abs, w);
    if (gitDir) this.hold(gitDir, w);
    if (gitDir && !w.tree) void this.watchTree(w);
  }

  /** A window gone: everything it watched. */
  drop(window: string) {
    const win = this.windows.get(window);
    if (!win) return;
    for (const w of win.watches.values()) this.release(w);
    this.windows.delete(window);
  }

  private needs = (w: Watch, abs: string) => w.dirs.has(abs) || abs === w.git || !!w.tree?.has(abs);

  private hold(abs: string, w: Watch): boolean {
    let entry = this.watchers.get(abs);
    if (!entry) {
      let ino: number;
      try {
        ino = statSync(abs).ino;
      } catch {
        return false;
      }
      const fw = this.open(abs, ino);
      if (!fw) return false;
      this.watchers.set(abs, (entry = { w: fw, ino, watches: new Set() }));
    }
    entry.watches.add(w);
    return true;
  }

  private open(abs: string, ino: number): FSWatcher | null {
    try {
      const fw = watch(spelled(abs, ino), { persistent: false }, (_event, name) => this.changed(abs, name ? String(name) : null));
      // Can't be watched any more: its watcher goes. (A folder deleted just goes quiet: see `renew`.)
      fw.on("error", () => this.watchers.get(abs)?.w === fw && this.close(abs));
      return fw;
    } catch {
      return null;
    }
  }

  /** A watched folder deleted and made again (a checkout, a rebuild) leaves its watcher hearing nothing: when its
   *  parent sees it come back, it's watched afresh for everyone watching it. Answers whether it was. */
  private renew(abs: string): boolean {
    const entry = this.watchers.get(abs);
    if (!entry) return false;
    let ino: number;
    try {
      ino = statSync(abs).ino;
    } catch {
      return false;
    }
    if (ino === entry.ino) return false;
    try {
      entry.w.close();
    } catch {}
    entry.ino = ino;
    // Opened a moment later: opened at once, Bun now and then loses it. What changes meanwhile, git status (run
    // after SETTLE_MS) still sees.
    setTimeout(() => {
      if (this.watchers.get(abs) !== entry || entry.ino !== ino) return;
      const fw = this.open(abs, ino);
      if (fw) entry.w = fw;
      else this.watchers.delete(abs);
    }, RENEW_MS);
    return true;
  }

  private unhold(abs: string, w: Watch) {
    const entry = this.watchers.get(abs);
    if (!entry) return;
    entry.watches.delete(w);
    if (!entry.watches.size) this.close(abs);
  }

  private release(w: Watch) {
    w.live = false;
    if (w.timer) clearTimeout(w.timer);
    for (const abs of new Set([...w.dirs.keys(), ...(w.git ? [w.git] : []), ...(w.tree ?? [])])) this.unhold(abs, w);
  }

  private close(abs: string) {
    const entry = this.watchers.get(abs);
    if (!entry) return;
    this.watchers.delete(abs);
    try {
      entry.w.close();
    } catch {}
  }

  /** Every folder git sees under the root, taken on a batch at a time. */
  private async watchTree(w: Watch) {
    w.tree = new Set();
    const dirs = await seenDirs(w.root, "");
    for (let i = 0; i < dirs.length; i += BATCH) {
      if (!w.live || w.tree.size >= MAX_TREE) return;
      for (const d of dirs.slice(i, i + BATCH)) this.holdTree(w, join(w.root, d));
      await new Promise((done) => setImmediate(done));
    }
  }

  private holdTree(w: Watch, abs: string) {
    if (w.live && w.tree && w.tree.size < MAX_TREE && this.hold(abs, w)) w.tree.add(abs);
  }

  /** Something appeared in one of the repository's folders: a folder git would see is taken on, with what's in it
   *  (all of it again when it was made afresh, `renewed`: its own folders were too). */
  private async grow(w: Watch, abs: string, renewed: boolean) {
    if ((!renewed && this.watchers.get(abs)?.watches.has(w)) || w.growing.has(abs)) return;
    let dir = false;
    try {
      dir = lstatSync(abs).isDirectory();
    } catch {}
    if (!dir || basename(abs).toLowerCase() === ".git" || existsSync(join(abs, ".git"))) return;
    w.growing.add(abs);
    try {
      for (const d of await seenDirs(w.root, relative(w.root, abs))) {
        const sub = join(w.root, d);
        this.renew(sub);
        this.holdTree(w, sub);
      }
    } finally {
      w.growing.delete(abs);
    }
  }

  private changed(abs: string, name: string | null) {
    const entry = this.watchers.get(abs);
    if (!entry) return;
    const renewed = name ? this.renew(join(abs, name)) : false;
    for (const w of entry.watches) {
      if (abs === w.git) {
        // Commits, checkouts and staging touch these (git writes each beside it and renames it over: Bun names the
        // .lock it came from); objects and logs churn on their own.
        if (name && !/^(index|HEAD|ORIG_HEAD|MERGE_HEAD|packed-refs)(\.lock)?$/.test(name)) continue;
        w.gitPending = true;
      } else {
        // An editor's or agent's own temporary file appearing and vanishing: nothing to show for it.
        if (name && /\.bismuth-\d+-\d+$/.test(name)) continue;
        const shown = w.dirs.get(abs);
        // A folder the window lists is listed again (and git asked again with it); any other only moves git.
        if (shown !== undefined) w.pending.add(shown);
        else w.gitPending = true;
        if (name && w.tree?.has(abs)) void this.grow(w, join(abs, name), renewed);
      }
      w.timer ??= setTimeout(() => this.flush(w), SETTLE_MS);
    }
  }

  private flush(w: Watch) {
    w.timer = null;
    for (const win of this.windows.values()) {
      if (win.watches.get(w.root) !== w) continue;
      win.sink(w.root, [...w.pending], w.gitPending);
    }
    w.pending.clear();
    w.gitPending = false;
  }
}

/** The folders under `root`'s folder `rel` (itself included, "" for the root) that git doesn't ignore, relative to
 *  `root`, walked a level at a time so an ignored one (node_modules) is never walked into. Repositories nested inside
 *  are left out too: git shows them as one entry. */
async function seenDirs(root: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  let level = rel ? await unignored(root, [rel]) : [""];
  while (level.length && out.length < MAX_TREE) {
    out.push(...level);
    const next: string[] = [];
    for (const d of level) {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(root, d), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.toLowerCase() === ".git") continue;
        const sub = d ? `${d}/${e.name}` : e.name;
        if (!existsSync(join(root, sub, ".git"))) next.push(sub);
      }
    }
    level = await unignored(root, next);
  }
  return out.slice(0, MAX_TREE);
}

/** The folders git doesn't ignore, of these (check-ignore answers 1 when it ignores none). */
async function unignored(root: string, dirs: string[]): Promise<string[]> {
  if (!dirs.length) return [];
  try {
    const p = Bun.spawn(["git", "-C", root, "check-ignore", "--stdin", "-z"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    p.stdin.write(dirs.map((d) => `${d}/`).join("\0") + "\0");
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    if (code !== 0 && code !== 1) return dirs;
    const ignored = new Set(out.split("\0"));
    return dirs.filter((d) => !ignored.has(`${d}/`));
  } catch {
    return dirs;
  }
}

/** The repository's .git folder for a root, if it's in one with a plain one (worktrees and submodules point elsewhere). */
export async function gitDirOf(root: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", "-C", root, "rev-parse", "--absolute-git-dir"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 && out && existsSync(join(out, "HEAD")) ? out : null;
  } catch {
    return null;
  }
}
