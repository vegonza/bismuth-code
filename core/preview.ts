// Preview: the project folder shows a worktree's files, so the app already running from it (docker compose watch, a
// dev server, anything that reloads on file changes) runs that worktree's code without being stopped, moved or
// started. Only on request (the Preview command); otherwise the folder keeps its own files.
// - Switching writes only the files that differ (git trees of both folders, compared), and deletes the ones that went:
//   to whatever watches the folder, it's as if an agent had edited them there. A file that's there is written over in
//   place (same inode, one modify event), not replaced: a watcher seeing it deleted and made again (git's checkout
//   does that) syncs and reloads twice (docker compose watch removes it in the container first, uvicorn restarts
//   for each, vite reloads the page instead of swapping the module).
// - While shown, the worktree's edits follow as they happen (its folders watched, core/watch.ts).
// - The folder's own state (uncommitted changes and untracked files too) is kept under refs/bismuth/preview/<project>
//   when a preview starts, and is what it goes back to.
// - A file changed in the project folder itself since the preview wrote it (a session there, a formatter, by hand) is
//   left as it is, every time after too: the preview never overwrites work done in the folder. Each file is checked
//   again right before it's written or deleted (nothing awaited between), so an edit landing mid-switch is kept too.
// Ignored files (node_modules, .env, build output) are never touched: they stay the folder's own.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreviewResult } from "../shared/model";
import { AUTHOR, repoOf, worktreeTree } from "./checkpoints";
import { failure, git } from "./scm";
import { FolderWatch, gitDirOf } from "./watch";

/** A project folder showing a worktree: which, and the tree it was last made to show (what "changed in the folder
 *  since" is measured from). */
type Showing = { folder: string; path: string; base: string };

const homeRef = (projectId: string) => `refs/bismuth/preview/${projectId.replace(/[^A-Za-z0-9._-]/g, "_")}`;

export class Previews {
  private file: string;
  private showing: Record<string, Showing>;
  private chains = new Map<string, Promise<unknown>>();
  /** Projects with a follow-up sync already waiting in their chain. */
  private waiting = new Set<string>();
  /** A project folder started or stopped showing a worktree. */
  onChanged: () => void = () => {};

  constructor(
    stateDir: string,
    private watch: FolderWatch,
  ) {
    this.file = join(stateDir, "previews.json");
    try {
      this.showing = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.showing = {};
    }
  }

  /** The worktree a project folder shows, if any. */
  of = (projectId: string): string | null => this.showing[projectId]?.path ?? null;

  /** After the core starts: previews carry on, catching up on what changed while it was down. A worktree that's gone
   *  gives the folder its own files back. */
  resume(exists: (projectId: string, path: string) => boolean) {
    for (const [id, s] of Object.entries(this.showing)) {
      if (exists(id, s.path)) void this.follow(id).then(() => this.queueSync(id));
      else void this.show(id, s.folder, null).catch((err) => console.error("[preview]", err?.message ?? err));
    }
  }

  /** The project folder shows `target`'s files, or (null) its own again. */
  show(projectId: string, folder: string, target: string | null): Promise<PreviewResult> {
    return this.serially(projectId, async () => {
      const was = this.showing[projectId];
      if (!was && !target) return { written: 0, deleted: 0, kept: [] };
      const repo = await repoOf(folder);
      if (!repo) throw new Error("The project folder isn't a git repository");
      let base = was?.base;
      if (!base) {
        // The folder as it is, kept to come back to.
        const own = await worktreeTree(repo.top, repo.gitDir);
        if (!own) throw new Error("Couldn't read the project folder");
        const commit = await git(repo.top, ["commit-tree", own, "-m", "bismuth: the project folder before a preview"], 30_000, { env: AUTHOR });
        if (!commit.ok || !(await git(repo.top, ["update-ref", homeRef(projectId), commit.out.trim()])).ok) throw failure("Couldn't keep the project folder's state", commit);
        base = own;
      }
      let theirs: string | null;
      if (target) {
        const wt = await repoOf(target);
        theirs = wt && (await worktreeTree(wt.top, wt.gitDir));
        if (!theirs) throw new Error("Couldn't read the worktree");
      } else {
        theirs = (await git(repo.top, ["rev-parse", "--verify", "-q", `${homeRef(projectId)}^{tree}`])).out.trim() || null;
        if (!theirs) throw new Error("The project folder's own state is gone");
      }
      let result: PreviewResult;
      try {
        result = await apply(repo.top, base, theirs);
      } catch (err) {
        // Stopped part way: the files it wrote go back to what the folder showed, so it's never left mixed (and the
        // next preview doesn't keep a mix as the folder's own state).
        await apply(repo.top, theirs, base).catch((e) => console.error("[preview] couldn't undo a failed switch:", e?.message ?? e));
        if (!was) await git(repo.top, ["update-ref", "-d", homeRef(projectId)]);
        throw err;
      }
      if (target) {
        this.showing[projectId] = { folder, path: target, base: theirs };
        if (was?.path !== target) await this.follow(projectId);
      } else {
        delete this.showing[projectId];
        this.watch.drop(watcherOf(projectId));
        await git(repo.top, ["update-ref", "-d", homeRef(projectId)]);
      }
      this.save();
      if (was?.path !== target) this.onChanged();
      return result;
    });
  }

  /** Before a worktree goes: a project folder showing it gets its own files back. */
  async release(path: string) {
    for (const [id, s] of Object.entries(this.showing)) if (s.path === path) await this.show(id, s.folder, null);
  }

  /** The shown worktree's folders watched: each change brings the project folder up to date. */
  private async follow(projectId: string) {
    const s = this.showing[projectId];
    if (!s) return;
    this.watch.drop(watcherOf(projectId));
    this.watch.set(watcherOf(projectId), () => this.queueSync(projectId), s.path, ["."], await gitDirOf(s.path));
  }

  /** One sync after whatever runs now; changes arriving meanwhile ride along with it. */
  private queueSync(projectId: string) {
    if (this.waiting.has(projectId)) return;
    this.waiting.add(projectId);
    void this.serially(projectId, async () => {
      this.waiting.delete(projectId);
      const s = this.showing[projectId];
      if (!s) return;
      const repo = await repoOf(s.folder);
      const wt = await repoOf(s.path);
      const theirs = wt && (await worktreeTree(wt.top, wt.gitDir));
      if (!repo || !theirs || theirs === s.base) return;
      await apply(repo.top, s.base, theirs);
      if (this.showing[projectId] === s) (s.base = theirs), this.save();
    }).catch((err) => console.error("[preview] following the worktree failed:", err?.message ?? err));
  }

  private serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.chains.set(key, next);
    void next.catch(() => {}).finally(() => this.chains.get(key) === next && this.chains.delete(key));
    return next;
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.showing, null, 2));
  }
}

const watcherOf = (projectId: string) => `preview:${projectId}`;

/** Bring the folder at `top` from tree `base` to tree `theirs`: what changed between them is written or deleted,
 *  except where the folder itself moved away from `base` (left as the folder has it). Each file is checked again
 *  right before it's touched: one that a session, an editor or anything else changed since is never overwritten. */
async function apply(top: string, base: string, theirs: string): Promise<PreviewResult> {
  const result: PreviewResult = { written: 0, deleted: 0, kept: [] };
  const incoming = await diffTree(top, base, theirs);
  if (!incoming.length) return result;
  const repo = await repoOf(top);
  const ours = repo && (await worktreeTree(repo.top, repo.gitDir));
  if (!ours) throw new Error("Couldn't read the project folder");
  const local = new Set((await diffTree(top, base, ours)).map((c) => c.path));
  const differs = local.size ? new Set((await diffTree(top, ours, theirs)).map((c) => c.path)) : new Set<string>();
  const writes: Change[] = [];
  const deletes: Change[] = [];
  for (const c of incoming) {
    if (local.has(c.path)) {
      if (differs.has(c.path)) result.kept.push(c.path);
    } else if (c.code === "D") deletes.push(c);
    // A submodule's commit: its folder is its own checkout, left alone.
    else if (c.mode !== "160000") writes.push(c);
  }
  // The worktree's versions, as git would check them out (its filters, links), staged outside the folder first.
  const stage = mkdtempSync(join(tmpdir(), "bismuth-preview-"));
  const index = `${stage}.index`;
  try {
    if (writes.length) {
      const env = { GIT_INDEX_FILE: index };
      const read = await git(top, ["read-tree", theirs], 60_000, { env });
      if (!read.ok) throw failure("Couldn't read the worktree's files", read);
      const out = await git(top, ["checkout-index", "-f", "-z", "--stdin", `--prefix=${stage}/`], 120_000, { env, input: writes.map((c) => c.path).join("\0") + "\0" });
      if (!out.ok) throw failure("Couldn't read the worktree's files", out);
    }
    // Deletions first: a file that became a folder has to be gone before the folder's files are written.
    for (const c of deletes) {
      const file = join(top, c.path);
      const now = await untouched(top, file, c);
      if (now === false) {
        result.kept.push(c.path);
        continue;
      }
      if (now) rmSync(file, { force: true }), result.deleted++;
      pruneEmpty(top, dirname(c.path));
    }
    for (const c of writes) {
      const file = join(top, c.path);
      const staged = join(stage, c.path);
      const link = lstatSync(staged).isSymbolicLink();
      const data = link ? null : readFileSync(staged);
      const now = await untouched(top, file, c);
      // Nothing awaited from here to the write: the file is as checked.
      if (now === false) {
        result.kept.push(c.path);
        continue;
      }
      if (now && (link || now.link)) rmSync(file, { force: true });
      else if (!now) mkdirSync(dirname(file), { recursive: true });
      if (link) symlinkSync(readlinkSync(staged), file);
      else {
        // Written over in place, so whatever watches it sees one change.
        const exec = c.mode === "100755";
        writeFileSync(file, data!, { mode: exec ? 0o755 : 0o644 });
        if (now && !now.link && !!(now.mode & 0o100) !== exec) chmodSync(file, (exec ? now.mode | 0o111 : now.mode & ~0o111) & 0o7777);
      }
      result.written++;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(index, { force: true });
  }
  return result;
}

/** What's at `file` now, if it's still what the preview last left there (`c.from`; nothing for a file that's new):
 *  null when there's nothing, false when it's something else. Compared the way git would store it (its filters). */
async function untouched(top: string, file: string, c: Change): Promise<{ link: boolean; mode: number } | null | false> {
  const read = () => {
    try {
      const st = lstatSync(file);
      if (st.isSymbolicLink()) return { link: true, mode: st.mode, bytes: Buffer.from(readlinkSync(file)) };
      if (st.isFile()) return { link: false, mode: st.mode, bytes: readFileSync(file) };
      return false;
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  };
  const now = read();
  if (!now) return c.from ? false : now;
  if (!c.from) return false;
  if (blobId(now.bytes, c.from) === c.from) return now;
  // A filtered file (line endings, LFS) is stored as something other than its bytes: git says what it'd store, and
  // the file has to still be those bytes after.
  if (now.link) return false;
  const p = Bun.spawn(["git", "-C", top, "hash-object", "--stdin", `--path=${c.path}`], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  p.stdin.write(now.bytes);
  void p.stdin.end();
  const id = (await new Response(p.stdout).text()).trim();
  if (id !== c.from) return false;
  const again = read();
  return again && again.bytes.equals(now.bytes) ? again : false;
}

/** The id git gives these bytes as a blob (SHA-1, or SHA-256 in a repository that uses it: told by the id's length). */
const blobId = (bytes: Buffer, like: string) =>
  createHash(like.length === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

/** A path that's different from tree `a` to `b`: added (A), modified (M), changed type (T) or deleted (D), with the
 *  blob it has in `a` (null when it's new) and its mode in `b`. */
type Change = { code: string; path: string; from: string | null; mode: string };

async function diffTree(top: string, a: string, b: string): Promise<Change[]> {
  if (a === b) return [];
  const r = await git(top, ["diff-tree", "-r", "-z", "--no-renames", "--full-index", a, b], 60_000);
  if (!r.ok) throw failure("Couldn't compare the folders", r);
  // `:<mode a> <mode b> <blob a> <blob b> <code>` NUL `<path>` NUL, for each.
  const parts = r.out.split("\0");
  const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [modeA, mode, from, , code] = parts[i].slice(1).split(" ");
    if (code) out.push({ code, path: parts[i + 1], from: /^0+$/.test(from) || modeA === "160000" ? null : from, mode });
  }
  return out;
}

/** Folders a deletion left empty go too, up to the top. */
function pruneEmpty(top: string, rel: string) {
  for (let dir = rel; dir && dir !== "."; dir = dirname(dir)) {
    try {
      if (readdirSync(join(top, dir)).length) return;
      rmdirSync(join(top, dir));
    } catch {
      return;
    }
  }
}
