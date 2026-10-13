// The Changes view's git: a folder's changed files with their line counts, since the last commit or a session's last
// turn, its branch against its upstream, and what the view does with them: discard, commit, pull and push.
// Paths are as the right side names them: relative to the folder when inside it, absolute when elsewhere in the
// repository. Every command runs without a terminal: one that would ask for credentials or an editor fails instead.
import { existsSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitChanges, GitCommit, GitCommitChanges, GitLog, GitRef, GitStatus } from "../shared/model";
import { EMPTY_TREE, repoOf, sinceCommit, worktreeTree } from "./checkpoints";

/** How long a pull or push may take before it's given up on (a network that hangs). */
const REMOTE_TIMEOUT_MS = 120_000;

/** git in `cwd`, never asking anything of a terminal. `input`: what it reads on stdin; `env`: more of its environment. */
export async function git(cwd: string, args: string[], timeout = 30_000, opts: { input?: string; env?: Record<string, string> } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], {
      stdin: opts.input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", LC_ALL: "C", ...opts.env },
    });
    if (opts.input !== undefined) {
      p.stdin!.write(opts.input);
      void p.stdin!.end();
    }
    const timer = setTimeout(() => p.kill(), timeout);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { ok: code === 0, out, err };
  } catch (e: any) {
    return { ok: false, out: "", err: String(e?.message ?? e) };
  }
}

/** git's complaint, as a sentence to show: its last meaningful lines, without the "error:"/"fatal:" labels. */
export function failure(what: string, r: { out: string; err: string }): Error {
  const lines = `${r.err}\n${r.out}`.split("\n").map((l) => l.replace(/^(error|fatal|hint|remote): ?/i, "").trim()).filter(Boolean);
  return new Error(lines.length ? `${what}: ${lines.slice(0, 3).join(" ")}` : what);
}

function rootOf(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    throw new Error(`No folder at ${root}`);
  }
}

async function topOf(root: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return null;
  try {
    return realpathSync(r.out.trim());
  } catch {
    return null;
  }
}

/** A repository path (relative to its top) as the right side names it. */
function named(root: string, top: string, file: string): string {
  const abs = join(top, file);
  const rel = relative(root, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : abs;
}

const LETTER: Record<string, GitStatus> = { M: "modified", T: "modified", A: "added", C: "added", D: "deleted", R: "renamed" };

const NONE: GitChanges = { repo: false, branch: null, upstream: null, ahead: 0, behind: 0, remotes: false, files: [] };

/** The files that differ between two trees (or commits), with their lines added and removed, renames found; paths
 *  as the right side names them, and as the repository does. Null when git can't compare them. */
async function diffTrees(root: string, top: string, base: string, now: string) {
  const [names, counts] = await Promise.all([
    git(top, ["diff-tree", "-r", "-z", "-M", "--name-status", base, now]),
    git(top, ["diff-tree", "-r", "-z", "-M", "--numstat", base, now]),
  ]);
  if (!names.ok || !counts.ok) return null;
  const lines = new Map<string, [number | null, number | null]>();
  const c = counts.out.split("\0");
  for (let i = 0; i < c.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(c[i]);
    if (!m) continue;
    // A rename's paths follow it, its old one first.
    const file = m[3] || (i++, c[++i]);
    lines.set(file, [m[1] === "-" ? null : Number(m[1]), m[2] === "-" ? null : Number(m[2])]);
  }
  const out: { path: string; repoPath: string; status: GitStatus; from?: string; fromRepoPath?: string; added: number | null; removed: number | null }[] = [];
  const n = names.out.split("\0");
  for (let i = 0; i + 1 < n.length; i += 2) {
    const code = n[i][0];
    if (!code) continue;
    const from = code === "R" || code === "C" ? n[++i] : undefined;
    const file = n[i + 1];
    const [added, removed] = lines.get(file) ?? [0, 0];
    out.push({
      path: named(root, top, file),
      repoPath: file,
      status: LETTER[code] ?? "modified",
      ...(from && code === "R" ? { from: named(root, top, from), fromRepoPath: from } : {}),
      added,
      removed,
    });
  }
  return out;
}

/** The folder's changes, since the last commit or `since` (checkpoints.ts: a session's last turn, the last push, the branch):
 *  each file with its lines added and removed, as git commits them (new files counted whole). Both are a diff of two
 *  trees, the working tree as one through the snapshots' scratch index, so the two scopes count alike. */
export async function changes(rootPath: string, since: string | null): Promise<GitChanges> {
  const root = rootOf(rootPath);
  const repo = await repoOf(root);
  if (!repo) return NONE;
  let top: string;
  try {
    top = realpathSync(repo.top);
  } catch {
    return NONE;
  }
  const [st, remotes, now, base] = await Promise.all([
    git(root, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules"]),
    git(root, ["remote"]),
    worktreeTree(repo.top, repo.gitDir),
    since ? sinceCommit(root, since) : git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then((r) => (r.ok ? r.out.trim() : EMPTY_TREE)),
  ]);
  if (!st.ok) throw failure("Couldn't read the repository's status", st);
  const out: GitChanges = { ...NONE, repo: true, remotes: !!remotes.out.trim(), files: [] };
  // What's uncommitted, by repository path: untracked, in conflict, or otherwise changed.
  const dirty = new Map<string, "untracked" | "conflict" | "changed">();
  const parts = st.out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith("# ")) {
      const [key, ...rest] = line.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") out.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") out.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) (out.ahead = Number(m[1])), (out.behind = Number(m[2]));
      }
    } else if (line[0] === "?") dirty.set(line.slice(2), "untracked");
    else if (line[0] === "u") dirty.set(line.split(" ").slice(10).join(" "), "conflict");
    else if (line[0] === "1") dirty.set(line.split(" ").slice(8).join(" "), "changed");
    else if (line[0] === "2") dirty.set(line.split(" ").slice(9).join(" "), "changed"), dirty.set(parts[++i], "changed");
  }
  if (since) out.turn = !!base;
  else out.head = base && base !== EMPTY_TREE ? base : null;
  if (!base || !now) return out;
  const files = await diffTrees(root, top, base, now);
  if (!files) throw new Error("Couldn't compare the changes");
  for (const f of files) {
    const file = f.repoPath;
    const mark = dirty.get(file);
    out.files.push({
      path: f.path,
      status: mark === "conflict" ? "conflict" : mark === "untracked" ? "untracked" : f.status,
      ...(f.from ? { from: f.from } : {}),
      added: f.added,
      removed: f.removed,
      dirty: !!mark || (!!f.fromRepoPath && dirty.has(f.fromRepoPath)) || (!since && f.status === "deleted"),
    });
  }
  // Conflicted files the trees don't tell apart (both sides' text still in the index) show too.
  for (const [file, mark] of dirty) if (mark === "conflict" && !out.files.some((f) => f.path === named(root, top, file))) out.files.push({ path: named(root, top, file), status: "conflict", added: null, removed: null, dirty: true });
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Pathspecs taken as written (no globs), each inside the repository. */
function specs(paths: string[]): string[] {
  if (!paths.length) throw new Error("No files given");
  return paths.map((p) => {
    if (p.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) throw new Error(".git paths are not accessible");
    return `:(literal)${p}`;
  });
}

/** Files put back as they were: at the last commit, or (`since` a session) before its last turn. One that didn't
 *  exist then is deleted. Since the commit, git's index goes back with it; since a turn, only the files do. */
export async function discard(rootPath: string, paths: string[], since: string | null) {
  const root = rootOf(rootPath);
  specs(paths);
  const source = since ? await sinceCommit(root, since) : (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).ok ? "HEAD" : null;
  if (since && !source) throw new Error("This session has no turn to go back to");
  const existed = await Promise.all(paths.map(async (p) => !!source && (await git(root, ["cat-file", "-e", `${source}:./${relative(root, resolve(root, p)).split(sep).join("/")}`])).ok));
  const back = paths.filter((_, i) => existed[i]);
  const gone = paths.filter((_, i) => !existed[i]);
  if (back.length) {
    const r = await git(root, ["restore", `--source=${source}`, ...(since ? [] : ["--staged"]), "--worktree", "--", ...specs(back)]);
    if (!r.ok) throw failure("Couldn't discard", r);
  }
  for (const p of gone) {
    const abs = resolve(root, p);
    if (!since) await git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", `:(literal)${p}`]);
    rmSync(abs, { force: true });
  }
}

/** A commit of exactly these files as they stand (new and deleted ones too), whatever else is staged. */
export async function commit(rootPath: string, message: string, paths: string[]) {
  const root = rootOf(rootPath);
  if (!message.trim()) throw new Error("Write a commit message first");
  const add = await git(root, ["add", "-A", "--", ...specs(paths)]);
  if (!add.ok) throw failure("Couldn't stage the changes", add);
  const r = await git(root, ["commit", "--cleanup=strip", "-m", message, "--", ...specs(paths)]);
  if (!r.ok) throw failure("Couldn't commit", r);
}

/** A rebase or merge the repository is in the middle of, if any. */
async function midway(root: string): Promise<"rebase" | "merge" | null> {
  const dir = (await git(root, ["rev-parse", "--absolute-git-dir"])).out.trim();
  if (!dir) return null;
  if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) return "rebase";
  return existsSync(join(dir, "MERGE_HEAD")) ? "merge" : null;
}

/** What's upstream, merged or rebased in as the repository's pull settings say. One that stops partway (a conflict)
 *  is undone at once: the branch, the index and the files as they were (git's autostash put back too), never left
 *  half done for a view that can't resolve it. */
export async function pull(rootPath: string) {
  const root = rootOf(rootPath);
  const before = await midway(root);
  if (before) throw new Error(`Couldn't pull: a ${before} is in progress; finish or abort it first`);
  const r = await git(root, ["pull", "--no-edit"], REMOTE_TIMEOUT_MS);
  if (r.ok) return;
  const stopped = await midway(root);
  if (!stopped) throw failure("Couldn't pull", r);
  const conflicts = (await git(root, ["diff", "--name-only", "--diff-filter=U", "-z"])).out.split("\0").filter(Boolean);
  const undo = await git(root, [stopped, "--abort"]);
  if (!undo.ok) throw failure(`Couldn't pull, and couldn't undo the ${stopped} it began (run git ${stopped} --abort)`, undo);
  const named = conflicts.slice(0, 3).join(", ") + (conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : "");
  throw new Error(`Couldn't pull: ${conflicts.length ? `${named} ${conflicts.length === 1 ? "conflicts" : "conflict"} with upstream` : "it stopped partway"}. Nothing was changed.`);
}

/** To the branch's upstream; a branch without one is published to the first remote (origin when there is one). */
export async function push(rootPath: string) {
  const root = rootOf(rootPath);
  const upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  let args = ["push"];
  if (!upstream.ok) {
    const remotes = (await git(root, ["remote"])).out.split("\n").filter(Boolean);
    if (!remotes.length) throw new Error("This repository has no remote to push to");
    args = ["push", "-u", remotes.includes("origin") ? "origin" : remotes[0], "HEAD"];
  }
  const r = await git(root, args, REMOTE_TIMEOUT_MS);
  if (!r.ok) throw failure("Couldn't push", r);
}

/** A repository started in the folder, on the branch git is set to start on (init.defaultBranch), or `main`. */
export async function init(rootPath: string) {
  const root = rootOf(rootPath);
  if (await topOf(root)) throw new Error("This folder is in a git repository already");
  const named = (await git(root, ["config", "--get", "init.defaultBranch"])).out.trim();
  const r = await git(root, ["init", ...(named ? [] : ["-b", "main"])]);
  if (!r.ok) throw failure("Couldn't initialize git", r);
}

/** VS Code's Sync: what's upstream first, then what's here. */
export async function sync(rootPath: string) {
  await pull(rootPath);
  await push(rootPath);
}

// ---------------- the graph ----------------

const HASH = /^[0-9a-f]{4,64}$/i;
const FIELD = "\x1f";
const RECORD = "\x1e";
/** git log's fields for a commit, as `parseCommit` reads them. */
const COMMIT_FORMAT = ["%H", "%P", "%an", "%at", "%D", "%s"].join("%x1f");

function parseCommit(record: string, remotes: string[]): GitCommit | null {
  const [hash, parents, author, at, decor, ...subject] = record.replace(/^\n+/, "").split(FIELD);
  if (!hash || !HASH.test(hash)) return null;
  const refs: GitRef[] = [];
  for (const d of (decor ?? "").split(", ").filter(Boolean)) {
    if (d === "HEAD") continue;
    if (d.startsWith("HEAD -> ")) refs.push({ name: d.slice(8), kind: "head" });
    else if (d.startsWith("tag: ")) refs.push({ name: d.slice(5), kind: "tag" });
    else if (d.endsWith("/HEAD")) continue;
    else refs.push({ name: d, kind: remotes.some((r) => d.startsWith(`${r}/`)) ? "remote" : "branch" });
  }
  return { hash, parents: parents ? parents.split(" ").filter(Boolean) : [], subject: subject.join(FIELD), author: author ?? "", date: Number(at) * 1000, refs };
}

/** The graph's commits, a page at a time: the branch checked out and its upstream (so what's ahead and behind both
 *  show), newest first with every commit before its parents. */
export async function log(rootPath: string, skip: number, limit: number): Promise<GitLog> {
  const root = rootOf(rootPath);
  const n = Math.max(1, Math.min(500, Math.floor(limit) || 100));
  const [head, upstream, remotes] = await Promise.all([
    git(root, ["rev-parse", "--verify", "-q", "HEAD"]),
    git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    git(root, ["remote"]),
  ]);
  if (!head.ok) return { head: null, commits: [], more: false };
  const revs = ["HEAD", ...(upstream.ok && upstream.out.trim() ? [upstream.out.trim()] : [])];
  const r = await git(root, ["log", "--topo-order", `--skip=${Math.max(0, Math.floor(skip) || 0)}`, `-n${n + 1}`, `--format=${COMMIT_FORMAT}%x1e`, ...revs, "--"]);
  if (!r.ok) throw failure("Couldn't read the history", r);
  const names = remotes.out.split("\n").filter(Boolean);
  const commits = r.out.split(RECORD).map((x) => parseCommit(x, names)).filter((c): c is GitCommit => !!c);
  return { head: head.out.trim(), commits: commits.slice(0, n), more: commits.length > n };
}

/** A commit's files against its first parent, with its whole message. */
export async function commitChanges(rootPath: string, hash: string): Promise<GitCommitChanges> {
  const root = rootOf(rootPath);
  if (!HASH.test(hash)) throw new Error("Not a commit");
  const top = await topOf(root);
  if (!top) throw new Error("This folder isn't in a git repository");
  const [info, body, remotes] = await Promise.all([
    git(root, ["show", "-s", `--format=${COMMIT_FORMAT}`, hash, "--"]),
    git(root, ["show", "-s", "--format=%B", hash, "--"]),
    git(root, ["remote"]),
  ]);
  const commit = info.ok ? parseCommit(info.out.trim(), remotes.out.split("\n").filter(Boolean)) : null;
  if (!commit) throw failure("Couldn't read the commit", info);
  const parent = commit.parents[0] ?? null;
  const files = await diffTrees(root, top, parent ?? EMPTY_TREE, commit.hash);
  if (!files) throw new Error("Couldn't compare the commit with its parent");
  return {
    commit,
    body: body.out.trim(),
    parent,
    files: files.map((f) => ({ path: f.path, status: f.status, ...(f.from ? { from: f.from } : {}), added: f.added, removed: f.removed, dirty: false })),
  };
}

/** The most text a file at a commit is read as (a larger one isn't shown as a diff). */
const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** A file's text at a commit, by the path the right side names it by (relative to the folder, or absolute elsewhere in
 *  the repository); null when it wasn't there, or is binary or too large. */
export async function blob(rootPath: string, rev: string, path: string): Promise<string | null> {
  const root = rootOf(rootPath);
  if (!HASH.test(rev)) throw new Error("Not a commit");
  specs([path]);
  const top = await topOf(root);
  if (!top) return null;
  const rel = relative(top, isAbsolute(path) ? path : resolve(root, path)).split(sep).join("/");
  if (!rel || rel.startsWith("..")) return null;
  const size = await git(root, ["cat-file", "-s", `${rev}:${rel}`]);
  if (!size.ok || Number(size.out) > MAX_BLOB_BYTES) return null;
  const r = await git(root, ["cat-file", "blob", `${rev}:${rel}`]);
  if (!r.ok || r.out.slice(0, 8192).includes("\0")) return null;
  return r.out;
}
