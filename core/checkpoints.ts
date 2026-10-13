// Snapshots of a session's folder from just before each of its turns (t3code's checkpoints, lean): what the "Last
// turn" changes compare with. The whole working tree, untracked files too (ignored ones not), committed under a ref of
// bismuth's own (refs/bismuth/turns/<thread>) through a scratch index: the user's index, branches and stash are never
// touched. One per session, its latest turn's; it goes when the session is archived.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRANCH, UNPUSHED } from "../shared/model";

/** Who the snapshots' commits are by, so they're made without the user's git identity (which may be unset). */
export const AUTHOR = { GIT_AUTHOR_NAME: "bismuth", GIT_AUTHOR_EMAIL: "bismuth@localhost", GIT_COMMITTER_NAME: "bismuth", GIT_COMMITTER_EMAIL: "bismuth@localhost" };

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ ok: boolean; out: string }> {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, ...env } });
    const out = await new Response(p.stdout).text();
    return { ok: (await p.exited) === 0, out };
  } catch {
    return { ok: false, out: "" };
  }
}

/** The repository a folder is in: its top folder and its git folder (a worktree's own), or null outside one. */
export async function repoOf(dir: string): Promise<{ top: string; gitDir: string } | null> {
  const { ok, out } = await git(dir, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
  const [top, gitDir] = out.trim().split("\n");
  return ok && top && gitDir ? { top, gitDir } : null;
}

const turnRef = (threadId: string) => `refs/bismuth/turns/${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}`;

const chains = new Map<string, Promise<unknown>>();
/** One scratch-index job at a time per repository (two would trip on its lock). */
function serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  void next.catch(() => {}).finally(() => chains.get(key) === next && chains.delete(key));
  return next;
}

/** The working tree as git would commit all of it, as a tree's id. Through a scratch index per repository, kept
 *  between calls so only the files that changed are read again; it starts as a copy of the repository's own (its
 *  record of every file saves reading them all), or from HEAD when that copy won't do (a split or sparse index). */
export function worktreeTree(top: string, gitDir: string): Promise<string | null> {
  return serially(top, async () => {
    const index = join(tmpdir(), `bismuth-tree-${process.getuid?.() ?? "user"}-${createHash("sha1").update(top).digest("hex").slice(0, 12)}`);
    const env = { GIT_INDEX_FILE: index };
    const own = join(gitDir, "index");
    if (!existsSync(index) && existsSync(own)) copyFileSync(own, index);
    const fresh = async () => {
      rmSync(index, { force: true });
      await git(top, ["read-tree", "HEAD"], env);
      return git(top, ["add", "-A", "--", "."], env);
    };
    let added = await git(top, ["add", "-A", "--", "."], env);
    if (!added.ok) added = await fresh();
    if (!added.ok) return null;
    // `add -A` never takes out what it put in before an ignore rule covered it (a folder ignored after it was added):
    // those go, unless the repository's own index tracks them, as git keeps tracking an ignored file it already has.
    const ignored = (e: Record<string, string> = {}) => git(top, ["ls-files", "-z", "-c", "-i", "--exclude-standard"], e).then((r) => r.out.split("\0").filter(Boolean));
    const stale = await ignored(env);
    if (stale.length) {
      const kept = new Set(await ignored());
      const drop = stale.filter((p) => !kept.has(p));
      if (drop.length) await git(top, ["update-index", "--force-remove", "--", ...drop], env);
    }
    let written = await git(top, ["write-tree"], env);
    // The index kept names objects the repository doesn't have (its .git deleted and made again): built anew.
    if (!written.ok && (await fresh()).ok) written = await git(top, ["write-tree"], env);
    return written.ok && written.out.trim() ? written.out.trim() : null;
  });
}

/** Before a session's turn: its folder as it stands, kept as that session's snapshot. Answers whether it was. */
export async function snapshot(cwd: string, threadId: string): Promise<boolean> {
  const repo = await repoOf(cwd);
  const tree = repo && (await worktreeTree(repo.top, repo.gitDir));
  if (!repo || !tree) return false;
  const commit = await git(repo.top, ["commit-tree", tree, "-m", `bismuth: before a turn of ${threadId}`], AUTHOR);
  return commit.ok && (await git(repo.top, ["update-ref", turnRef(threadId), commit.out.trim()])).ok;
}

/** A session's snapshot, as a commit's id; null when it has none (no turn since bismuth began keeping them). */
export async function turnCommit(dir: string, threadId: string): Promise<string | null> {
  const { ok, out } = await git(dir, ["rev-parse", "--verify", "-q", `${turnRef(threadId)}^{commit}`]);
  return ok && out.trim() ? out.trim() : null;
}

/** git's tree with nothing in it: what everything is new against. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Where the branch last stood as pushed: where it meets its upstream, else the newest of its commits some remote has
 *  (the empty tree when none has any). */
async function pushedCommit(dir: string): Promise<string | null> {
  const up = await git(dir, ["merge-base", "HEAD", "@{upstream}"]);
  if (up.ok && up.out.trim()) return up.out.trim();
  const head = await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!head.ok) return EMPTY_TREE;
  // The oldest commit no remote has: the one before it is pushed (none before it: nothing is).
  const ahead = await git(dir, ["rev-list", "--topo-order", "--reverse", "HEAD", "--not", "--remotes"]);
  if (!ahead.ok) return null;
  const first = ahead.out.split("\n")[0]?.trim();
  if (!first) return head.out.trim();
  const before = await git(dir, ["rev-parse", "--verify", "-q", `${first}^`]);
  return before.ok ? before.out.trim() : EMPTY_TREE;
}

/** The default branch: origin's, else origin's or a local main or master, as its ref and its name. Null when there's
 *  none of them. */
export async function defaultBranch(dir: string): Promise<{ ref: string; name: string } | null> {
  const wanted = ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"];
  const { ok, out } = await git(dir, ["for-each-ref", "--format=%(refname) %(symref)", ...wanted]);
  if (!ok) return null;
  const found = new Map(out.trim().split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
  // origin/HEAD names origin's default branch; the rest stand in for it.
  const ref = found.get("refs/remotes/origin/HEAD") || wanted.slice(1).find((r) => found.has(r));
  return ref ? { ref, name: ref.replace(/^refs\/(remotes\/origin|heads)\//, "") } : null;
}

/** Whether the folder is on a branch of its own: a default branch to compare with, and one checked out that isn't it. */
export async function onOtherBranch(dir: string): Promise<boolean> {
  const [head, base] = await Promise.all([git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]), defaultBranch(dir)]);
  return head.ok && !!base && head.out.trim() !== base.name;
}

/** Where the branch left the default branch; null without one (or a commit yet). */
async function branchedCommit(dir: string): Promise<string | null> {
  const base = await defaultBranch(dir);
  const at = base && (await git(dir, ["merge-base", "HEAD", base.ref]));
  return at && at.ok && at.out.trim() ? at.out.trim() : null;
}

/** What changes `since` compare with: a session's snapshot, the branch as pushed (UNPUSHED), or where it left the
 *  default branch (BRANCH). */
export function sinceCommit(dir: string, since: string): Promise<string | null> {
  return since === UNPUSHED ? pushedCommit(dir) : since === BRANCH ? branchedCommit(dir) : turnCommit(dir, since);
}

/** An archived session's snapshot let go. */
export async function dropSnapshot(cwd: string, threadId: string) {
  await git(cwd, ["update-ref", "-d", turnRef(threadId)]);
}

/** What changed in the repository `since` (sinceCommit's): each file (relative to the repository's top) added,
 *  modified or deleted since. Null when there's nothing to compare with. */
export async function changesSince(dir: string, since: string): Promise<{ top: string; changes: [code: string, path: string][] } | null> {
  const repo = await repoOf(dir);
  const base = repo && (await sinceCommit(dir, since));
  const now = repo && base && (await worktreeTree(repo.top, repo.gitDir));
  if (!repo || !base || !now) return null;
  const { ok, out } = await git(repo.top, ["diff-tree", "-r", "-z", "--name-status", "--no-renames", base, now]);
  if (!ok) return null;
  const parts = out.split("\0");
  const changes: [string, string][] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) changes.push([parts[i], parts[i + 1]]);
  return { top: repo.top, changes };
}
