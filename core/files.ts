// The right side's file explorer and editor (Zeron's engine/workspace_files.rs, lean): a session's folder listed one
// directory at a time, searched by name, read and written, its entries made, renamed, duplicated and trashed, and its
// git status for the tree's colours. Paths are relative to the folder and stay inside it, or absolute for a file an
// agent pointed at elsewhere; `.git` is never listed, read or written.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileContent, FileEntry, FileRef, GitState, GitStatus, WriteResult } from "../shared/model";
import { changesSince, onOtherBranch, sinceCommit } from "./checkpoints";

/** Zeron's MAX_EDITABLE_FILE_BYTES: text past this shows as too large. */
const MAX_TEXT_BYTES = 1024 * 1024;
/** Notebooks carry their outputs' images inline, so they run far past plain text. */
const MAX_NOTEBOOK_BYTES = 32 * 1024 * 1024;
/** Files read whole past MAX_TEXT_BYTES, up to MAX_NOTEBOOK_BYTES: notebooks (their outputs) and tables (csvview.ts). */
const BIG_TEXT = /\.(ipynb|csv|tsv|tab|psv)$/i;
/** Zeron's MAX_PREVIEW_FILE_BYTES, for images. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_SEARCH_RESULTS = 200;
/** Files a search walks without git (or with ignored ones shown). */
const MAX_WALK = 50_000;

const IMAGE: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp", ".avif": "image/avif",
};

const isGitPart = (rel: string) => rel.split(/[\\/]/).some((p) => p.toLowerCase() === ".git");

/** The folder's real path, which must be a directory. */
function rootOf(root: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(root));
  } catch {
    throw new Error(`No folder at ${root}`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`${root} is not a folder`);
  return real;
}

/** A path under the folder, refused when it would leave it (through `..` or a link) or reach into `.git`. */
function inside(root: string, rel: string): string {
  if (isGitPart(rel)) throw new Error(".git paths are not accessible");
  const abs = resolve(root, rel || ".");
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`${rel || "The folder"} no longer exists`);
  }
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${rel} is outside the folder`);
  return abs;
}

/** A path the right side names: relative to the folder (kept inside it), or absolute, anywhere. */
function locate(root: string, path: string): string {
  if (!isAbsolute(path)) return inside(root, path);
  if (isGitPart(path)) throw new Error(".git paths are not accessible");
  if (!existsSync(path)) throw new Error(`${path} no longer exists`);
  return resolve(path);
}

/** Where a new entry goes: its folder must exist (inside the folder, for a relative path) and the name be free. */
function place(root: string, path: string): string {
  const name = basename(path);
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) throw new Error(`"${name}" isn't a valid name`);
  const parent = locate(root, isAbsolute(path) ? dirname(path) : toWire(dirname(path)) === "." ? "" : toWire(dirname(path)));
  if (isGitPart(name)) throw new Error(".git paths are not accessible");
  const abs = join(parent, name);
  if (existsSync(abs)) throw new Error(`${name} already exists`);
  return abs;
}

/** A path as the UI names it: relative when it's inside the folder, else absolute. */
function named(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? toWire(rel) : abs;
}

async function run(args: string[], input?: string): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(["git", ...args], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" });
    if (input !== undefined) {
      p.stdin!.write(input);
      p.stdin!.end();
    }
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } catch {
    return { code: -1, out: "" };
  }
}

/** Whether each folder is in a repository, asked once. */
const inRepo = new Map<string, Promise<boolean>>();
let scratch: string | null = null;
/** An empty repository to read a folder that isn't in one through: git then still honours its .gitignore files. */
async function scratchRepo(): Promise<string> {
  if (scratch) return scratch;
  // One for every run (init on an existing one leaves it as it is).
  const dir = join(tmpdir(), `bismuth-git-${process.getuid?.() ?? "user"}`);
  await run(["init", "--bare", "-q", dir]);
  return (scratch = dir);
}

const inRepoOf = (root: string) => {
  if (!inRepo.has(root)) inRepo.set(root, run(["-C", root, "rev-parse", "--is-inside-work-tree"]).then((r) => r.code === 0 && r.out.trim() === "true"));
  return inRepo.get(root)!;
};

/** git on the folder: its own repository, or the scratch one with the folder as the work tree. */
async function git(root: string, args: string[], input?: string): Promise<{ ok: boolean; out: string }> {
  const base = (await inRepoOf(root)) ? ["-C", root] : ["--git-dir", await scratchRepo(), "--work-tree", root, "-C", root];
  const { code, out } = await run([...base, ...args], input);
  // check-ignore answers 1 when nothing is ignored.
  return { ok: code === 0 || (args[0] === "check-ignore" && code === 1), out };
}

/** Ignored-file lookups (and git's own file list) work with or without a repository. */
async function ignoredOf(root: string, rels: string[]): Promise<Set<string>> {
  if (!rels.length) return new Set();
  const { ok, out } = await git(root, ["check-ignore", "--stdin", "-z"], rels.join("\0") + "\0");
  return ok ? new Set(out.split("\0").filter(Boolean)) : new Set();
}

const toWire = (rel: string) => rel.split(sep).join("/");

/** The innermost folder from `root` down to `abs` with a .git of its own: whose ignore rules count there. */
function repoAt(root: string, abs: string): string {
  for (let d = abs; d.length > root.length && d.startsWith(root); d = dirname(d)) if (existsSync(join(d, ".git"))) return d;
  return root;
}

/** One directory's entries: folders first, then by name. Ignored ones are left out, or marked when `all`. A repository
 *  nested inside (a folder with a .git of its own) is marked `repo`, is never ignored, and its insides answer to its
 *  own ignore rules, not the outer one's (which may ignore it whole). */
export async function listDirectory(rootPath: string, dir: string, all: boolean): Promise<FileEntry[]> {
  const root = rootOf(rootPath);
  const abs = inside(root, dir);
  const repo = repoAt(root, abs);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch (err: any) {
    throw new Error(err?.code === "EACCES" ? `No permission to open ${dir || "the folder"}` : String(err?.message ?? err));
  }
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (name.toLowerCase() === ".git") continue;
    const path = toWire(relative(root, join(abs, name)));
    let kind: FileEntry["kind"];
    try {
      const st = lstatSync(join(abs, name));
      kind = st.isSymbolicLink() ? (isDirSafe(join(abs, name)) ? "dir" : "file") : st.isDirectory() ? "dir" : "file";
    } catch {
      continue;
    }
    entries.push({ name, path, kind, ignored: false, repo: kind === "dir" && existsSync(join(abs, name, ".git")) });
    if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
  }
  // Directories go to check-ignore with a trailing slash so dir-only patterns ("build/") match them.
  const key = (e: FileEntry) => toWire(relative(repo, join(abs, e.name))) + (e.kind === "dir" ? "/" : "");
  const ignored = await ignoredOf(repo, entries.filter((e) => !e.repo).map(key));
  const out = entries.map((e) => ({ ...e, ignored: !e.repo && (ignored.has(key(e)) || ignored.has(key(e).replace(/\/$/, ""))) })).filter((e) => all || !e.ignored);
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) : a.kind === "dir" ? -1 : 1));
}

function isDirSafe(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A file to view: its text, an image as a data URL, or why it can't show. */
export function readFile(rootPath: string, path: string): FileContent {
  const root = rootOf(rootPath);
  const abs = locate(root, path);
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error(`${path} is a folder`);
  const mtime = st.mtimeMs;
  if (extname(abs).toLowerCase() === ".pdf") return { kind: "pdf", size: st.size, mtime };
  const type = IMAGE[extname(abs).toLowerCase()];
  if (type) {
    if (st.size > MAX_IMAGE_BYTES) return { kind: "tooLarge", size: st.size, mtime };
    return { kind: "image", url: `data:${type};base64,${readFileSync(abs).toString("base64")}`, size: st.size, mtime };
  }
  if (st.size > (BIG_TEXT.test(abs) ? MAX_NOTEBOOK_BYTES : MAX_TEXT_BYTES)) return { kind: "tooLarge", size: st.size, mtime };
  const bytes = readFileSync(abs);
  // A NUL in the first 8KB reads as binary, as git decides it.
  if (bytes.subarray(0, 8192).includes(0)) return { kind: "binary", size: st.size, mtime };
  return { kind: "text", text: bytes.toString("utf8"), size: st.size, mtime };
}

// ---------------- search ----------------

const fileLists = new Map<string, { at: number; files: string[] }>();

/** Every file in the folder: git's own list (tracked and untracked, ignored left out) while ignored files stay
 *  hidden, else a walk. Kept for a few seconds so typing a query doesn't list again per key. */
async function allFiles(root: string, all: boolean): Promise<string[]> {
  const key = `${all ? "all" : "visible"}\0${root}`;
  const hit = fileLists.get(key);
  if (hit && Date.now() - hit.at < 5_000) return hit.files;
  let files: string[] | null = null;
  if (!all) {
    const { ok, out } = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (ok) files = [...new Set(out.split("\0").filter((f) => f && !isGitPart(f)))];
  }
  if (!files) {
    files = [];
    const walk = (dir: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (files!.length >= MAX_WALK) return;
        if (name.toLowerCase() === ".git") continue;
        const abs = join(dir, name);
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(abs);
        else files!.push(toWire(relative(root, abs)));
      }
    };
    walk(root);
  }
  fileLists.set(key, { at: Date.now(), files });
  return files;
}

/** How well `query` matches `path` as a subsequence (higher is better), or null. Matches in the file name, at word
 *  starts and in a row score more; shorter paths win ties. */
function score(path: string, query: string): number | null {
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  let s = 0;
  let at = -1;
  let run = 0;
  for (const ch of query) {
    const next = p.indexOf(ch, at + 1);
    if (next < 0) return null;
    run = next === at + 1 ? run + 1 : 0;
    s += 1 + run * 2;
    if (next >= nameStart) s += 2;
    if (next === 0 || "/._- ".includes(p[next - 1])) s += 3;
    at = next;
  }
  if (p.slice(nameStart).includes(query)) s += 10;
  return s - path.length * 0.01;
}

export async function searchFiles(rootPath: string, query: string, all: boolean): Promise<string[]> {
  const root = rootOf(rootPath);
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const files = await allFiles(root, all);
  const hits: { path: string; s: number }[] = [];
  for (const f of files) {
    const s = score(f, q);
    if (s !== null) hits.push({ path: f, s });
  }
  return hits.sort((a, b) => b.s - a.s).slice(0, MAX_SEARCH_RESULTS).map((h) => h.path);
}

// ---------------- git status ----------------

/** Changed files by path (folder-relative): what the tree colours. Since the last commit (staged or not, and files
 *  git doesn't track yet), or, `since` a session, since its last turn began (see checkpoints.ts). */
export async function gitState(rootPath: string, since: string | null): Promise<GitState> {
  const root = rootOf(rootPath);
  const [state, branched] = await Promise.all([changedFiles(root, since), onOtherBranch(root)]);
  return state.repo ? { ...state, branched } : state;
}

async function changedFiles(root: string, since: string | null): Promise<GitState> {
  const top = await run(["-C", root, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { repo: false, status: {} };
  let repo: string;
  try {
    repo = realpathSync(top.out.trim());
  } catch {
    return { repo: false, status: {} };
  }
  const status: Record<string, GitStatus> = {};
  if (since) {
    const turn = await changesSince(root, since);
    if (!turn) return { repo: true, status, turn: false };
    for (const [code, file] of turn.changes) {
      const rel = toWire(relative(root, join(repo, file)));
      if (!rel.startsWith("..")) status[rel] = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    }
    return { repo: true, status, turn: true };
  }
  // Run often and in the background: it never takes the index lock (which a git command of the user's would trip on).
  const { ok, out } = await git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules"]);
  if (!ok) return { repo: true, status };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const file = line.slice(3);
    // A rename's original path follows it.
    if (xy[0] === "R" || xy[0] === "C") i++;
    const rel = toWire(relative(root, join(repo, file)));
    if (rel.startsWith("..")) continue;
    status[rel] = xy === "??" ? "untracked" : xy.includes("U") || xy === "AA" || xy === "DD" ? "conflict" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : xy.includes("R") ? "renamed" : "modified";
  }
  return { repo: true, status };
}

/** A file as it was in the last commit, or (`since` a session) before its last turn: what the editor's change bars
 *  compare it with. Empty for a file made since (all of it is new); null when there's nothing to compare with
 *  (ignored, outside a repository, no turn kept for the session), or it's binary or too large to show. */
export async function baseText(rootPath: string, path: string, since: string | null): Promise<string | null> {
  const root = rootOf(rootPath);
  if (isAbsolute(path) || isGitPart(path)) return null;
  const abs = inside(root, path);
  if (!(await inRepoOf(root))) return null;
  const rev = since ? await sinceCommit(root, since) : "HEAD";
  if (!rev) return null;
  const { ok, out } = await git(root, ["--no-optional-locks", "show", `${rev}:./${path}`]);
  if (!ok) return existsSync(abs) && !(await ignoredOf(root, [path])).has(path) ? "" : null;
  if (out.length > MAX_TEXT_BYTES || out.slice(0, 8192).includes("\0")) return null;
  return out;
}

/** A file's bytes as the /file route serves them (a PDF for the viewer), and their type. */
export function rawFile(rootPath: string, path: string): { abs: string; type: string } {
  const abs = locate(rootOf(rootPath), path);
  if (statSync(abs).isDirectory()) throw new Error(`${path} is a folder`);
  const ext = extname(abs).toLowerCase();
  return { abs, type: ext === ".pdf" ? "application/pdf" : (IMAGE[ext] ?? "application/octet-stream") };
}

/** A file an HTML preview loads beside it (its CSS, images, scripts): inside the folder only, never absolute. */
export function previewFile(rootPath: string, path: string): string {
  const abs = inside(rootOf(rootPath), path);
  if (statSync(abs).isDirectory()) throw new Error(`${path} is a folder`);
  return abs;
}

// ---------------- changes ----------------

/** Save a file's text, unless it changed on disk since it was read (`expect`: the mtime it was read at; null writes
 *  whatever is there). Written beside it and moved over it, so nothing ever reads it half written; its mode is kept. */
export function writeFile(rootPath: string, path: string, text: string, expect: number | null): WriteResult {
  const root = rootOf(rootPath);
  let abs: string;
  try {
    abs = realpathSync(locate(root, path));
  } catch {
    abs = place(root, path);
  }
  const before = existsSync(abs) ? statSync(abs) : null;
  if (before?.isDirectory()) throw new Error(`${path} is a folder`);
  if (before && expect !== null && before.mtimeMs !== expect) return { ok: false, mtime: before.mtimeMs };
  const tmp = join(dirname(abs), `.${basename(abs)}.bismuth-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, text);
  if (before) chmodSync(tmp, before.mode & 0o7777);
  renameSync(tmp, abs);
  return { ok: true, mtime: statSync(abs).mtimeMs };
}

/** A new empty file, or folder. */
export function createEntry(rootPath: string, path: string, kind: "file" | "dir") {
  const abs = place(rootOf(rootPath), path);
  if (kind === "dir") mkdirSync(abs);
  else writeFileSync(abs, "", { flag: "wx" });
}

/** Rename or move: never over something that's there. */
export function renameEntry(rootPath: string, from: string, to: string) {
  const root = rootOf(rootPath);
  const src = locate(root, from);
  if (src === root) throw new Error("The folder itself can't be renamed here");
  const dest = place(root, to);
  if (dest === src || dest.startsWith(src + sep)) throw new Error("A folder can't move into itself");
  renameSync(src, dest);
}

/** `name` in `dir` if it's free, else a copy's name like Finder's and VS Code's ("name copy.ts", "name copy 2.ts"). */
function freeName(dir: string, name: string, isDir: boolean): string {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const dot = isDir ? -1 : name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let n = 1;
  let dest = join(dir, `${stem} copy${ext}`);
  while (existsSync(dest)) dest = join(dir, `${stem} copy ${++n}${ext}`);
  return dest;
}

/** A copy beside it, named like Finder's and VS Code's ("name copy.ts", "name copy 2.ts"). Answers its path. */
export function duplicateEntry(rootPath: string, path: string): string {
  const root = rootOf(rootPath);
  const src = locate(root, path);
  const dest = freeName(dirname(src), basename(src), statSync(src).isDirectory());
  cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return named(root, dest);
}

/** Files and folders dropped in from outside (`items`' paths relative to the drop, a folder's with no bytes), into
 *  folder `dir`: never over something that's there, a name taken getting a copy's name. Answers where each dropped
 *  item (the drop's top level) went. */
export function importEntries(rootPath: string, dir: string, items: { path: string; data: Uint8Array | null }[]): string[] {
  const root = rootOf(rootPath);
  const into = inside(root, dir);
  if (!statSync(into).isDirectory()) throw new Error(`${dir} is not a folder`);
  const tops = new Map<string, string>();
  for (const { path, data } of items) {
    const parts = path.split(/[\\/]/);
    if (parts.some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error(`Can't add ${path} here`);
    const [top, ...rest] = parts;
    let at = tops.get(top);
    if (!at) tops.set(top, (at = freeName(into, top, !!rest.length || !data)));
    const abs = join(at, ...rest);
    if (data) mkdirSync(dirname(abs), { recursive: true }), writeFileSync(abs, data, { flag: "wx" });
    else mkdirSync(abs, { recursive: true });
  }
  return [...tops.values()].map((abs) => named(root, abs));
}

/** Whether a command succeeded, and what it said when it didn't. */
async function attempt(cmd: string[]): Promise<{ ok: boolean; why: string }> {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const why = await new Response(p.stderr).text();
    return { ok: (await p.exited) === 0, why: why.trim().split("\n")[0].replace(/^gio: (file:\/\/\S+: )?/, "") };
  } catch {
    return { ok: false, why: "" };
  }
}
/** Started and let go (a file manager, the default app): not waited for. */
function launch(cmd: string[]): boolean {
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/** To the system trash (restorable); deleted outright only when asked (`permanent`, once the trash said no). */
export async function trashEntries(rootPath: string, paths: string[], permanent = false) {
  const root = rootOf(rootPath);
  const abs = paths.map((p) => locate(root, p));
  if (abs.includes(root)) throw new Error("The folder itself can't be deleted here");
  if (permanent) {
    for (const a of abs) rmSync(a, { recursive: true, force: true });
    return;
  }
  const { ok, why } =
    process.platform === "darwin"
      ? await attempt(["osascript", "-e", `tell application "Finder" to delete {${abs.map((a) => `POSIX file ${JSON.stringify(a)}`).join(", ")}}`])
      : await attempt(["gio", "trash", "--", ...abs]);
  if (!ok) throw new Error(`Couldn't move ${paths.length === 1 ? basename(abs[0]) : `${paths.length} items`} to the trash${why ? `: ${why}` : ""}`);
}

/** Shown in the system's file manager, selected (its folder opened where that can't be done). */
export async function revealEntry(rootPath: string, path: string) {
  const abs = locate(rootOf(rootPath), path);
  if (process.platform === "darwin") return void launch(["open", "-R", abs]);
  const uri = `file://${abs.split("/").map(encodeURIComponent).join("/")}`;
  const { ok: shown } = await attempt(["dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.FileManager1", "--type=method_call", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems", `array:string:${uri}`, "string:"]);
  if (!shown && !launch(["xdg-open", statSync(abs).isDirectory() ? abs : dirname(abs)])) throw new Error("No file manager to show it in");
}

/** Opened in the system's default app for it (a PDF, a document the viewer can't show). */
export function openExternal(rootPath: string, path: string) {
  const abs = locate(rootOf(rootPath), path);
  if (!launch([process.platform === "darwin" ? "open" : "xdg-open", abs])) throw new Error("No app to open it with");
}

// ---------------- references ----------------

/** Paths an agent wrote (in a link, a citation, inline code), each found on disk or null: absolute or `~/`,
 *  relative to the folder (a diff's `a/` `b/` too), or a bare name or path tail that ends exactly one of its files. */
export async function resolveRefs(rootPath: string, refs: string[]): Promise<(FileRef | null)[]> {
  const root = rootOf(rootPath);
  let files: string[] | null = null;
  const found = (abs: string): FileRef | null => {
    if (isGitPart(abs)) return null;
    try {
      return { path: named(root, abs), dir: statSync(abs).isDirectory() };
    } catch {
      return null;
    }
  };
  const out: (FileRef | null)[] = [];
  for (const raw of refs) {
    const ref = raw.trim().replace(/^file:\/\//, "");
    if (!ref || ref.length > 1024) {
      out.push(null);
      continue;
    }
    if (ref.startsWith("~/")) {
      out.push(found(join(homedir(), ref.slice(2))));
      continue;
    }
    if (isAbsolute(ref)) {
      out.push(found(resolve(ref)));
      continue;
    }
    const direct = found(resolve(root, ref)) ?? (/^[ab]\//.test(ref) ? found(resolve(root, ref.slice(2))) : null);
    if (direct && !direct.path.startsWith("/")) {
      out.push(direct);
      continue;
    }
    // A name or tail: the folder's own files that end with it, when that picks one out.
    files ??= await allFiles(root, false);
    const tail = ref.replace(/^\.\//, "");
    const hits = files.filter((f) => f === tail || f.endsWith(`/${tail}`));
    out.push(hits.length === 1 ? { path: hits[0], dir: false } : null);
  }
  return out;
}
