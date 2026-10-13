// Projects (Zeron's spaces, on this one device): the folders sessions run in. A registry in
// .bismuth/projects.json; the adapters list and start sessions per folder. Adding a project never touches the
// folder, and removing one only hides its sessions (the harnesses keep them).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { FolderListing, Project, Worktree } from "../shared/model";

// settleBefore: sessions whose last activity is older than this start settled (set when the project is added, so
// a folder with a long history doesn't flood the active list; Settle all moves it to now).
type Stored = { id: string; path: string; name: string | null; createdAt: number; lastUsedAt: number; settleBefore?: number };

// Project artwork, first match wins (Zeron's order, after Conductor's documented filename priority).
const ICON_PATHS = [
  "public/apple-touch-icon.png", "apple-touch-icon.png", "public/favicon.svg", "favicon.svg", "public/favicon.png",
  "public/icon.png", "public/logo.png", "favicon.png", "app/icon.png", "src/app/icon.png", "public/favicon.ico",
  "favicon.ico", "app/favicon.ico", "static/favicon.ico", "src-tauri/icons/icon.png", "assets/icon.png", "src/assets/icon.png",
];

export const HOME = homedir();

/** `~` and `~/x` from the UI's typed paths. */
export const expandHome = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p);

export class Projects {
  private file: string;
  private stored: Stored[];
  /** Added, renamed or removed: the core re-sends projects and threads. */
  onChanged: () => void = () => {};
  /** A project's worktrees and the one its folder shows (core/worktrees.ts, core/preview.ts). */
  extras: (id: string, path: string) => { worktrees: Worktree[]; preview: string | null } = () => ({ worktrees: [], preview: null });

  constructor(stateDir: string, seed: string | null) {
    this.file = join(stateDir, "projects.json");
    const saved = readJson(this.file);
    this.stored = Array.isArray(saved?.projects) ? saved.projects : [];
    // The first run of a multi-project core keeps the folder it used to be bound to.
    if (!saved && seed && resolve(seed) !== HOME && isDir(seed)) this.ensure(seed);
  }

  list(): Project[] {
    return this.stored.map((s) => ({
      id: s.id,
      path: s.path,
      name: s.name || basename(s.path) || s.path,
      renamed: !!s.name,
      branch: gitBranch(s.path),
      icon: !!this.iconPath(s.id),
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      ...this.extras(s.id, s.path),
    }));
  }

  paths = () => this.stored.map((s) => s.path);
  /** Sessions in this folder last active before this start settled. */
  settleBefore = (cwd: string) => this.stored.find((s) => s.path === cwd)?.settleBefore ?? null;

  /** Settle all: every session in the project whose work is done now counts as settled. */
  settleAll(id: string) {
    this.require(id).settleBefore = Date.now();
    this.save();
  }
  get = (id: string) => this.stored.find((s) => s.id === id) ?? null;

  /** The registered project a folder is, adding it if it isn't one yet. */
  ensure(path: string): Stored {
    const real = canonical(path);
    const found = this.stored.find((s) => s.path === real);
    if (found) return found;
    const now = Date.now();
    const s: Stored = { id: createHash("sha1").update(real).digest("hex").slice(0, 12), path: real, name: null, createdAt: now, lastUsedAt: now, settleBefore: now };
    this.stored.push(s);
    this.save();
    return s;
  }

  add(path: string): Project {
    const full = resolve(expandHome(path.trim()));
    if (!isDir(full)) throw new Error(`Not a folder: ${full}`);
    const s = this.ensure(full);
    this.touch(s.id);
    this.onChanged();
    return this.list().find((p) => p.id === s.id)!;
  }

  rename(id: string, name: string | null) {
    const s = this.require(id);
    s.name = name?.trim() || null;
    this.save();
    this.onChanged();
  }

  remove(id: string) {
    this.require(id);
    this.stored = this.stored.filter((s) => s.id !== id);
    this.save();
    this.onChanged();
  }

  /** A session started there: it rises in the New session list. */
  touch(id: string) {
    const s = this.get(id);
    if (!s) return;
    s.lastUsedAt = Date.now();
    this.save();
  }

  iconPath(id: string): string | null {
    const s = this.get(id);
    return s ? (ICON_PATHS.map((p) => join(s.path, p)).find((p) => existsSync(p)) ?? null) : null;
  }

  private require(id: string) {
    const s = this.get(id);
    if (!s) throw new Error(`unknown project ${id}`);
    return s;
  }

  private save() {
    writeFileSync(this.file, JSON.stringify({ projects: this.stored }, null, 2));
  }
}

/** A folder's subfolders (hidden ones left out), for the New project browser; null lists home. */
export function listFolder(path: string | null): FolderListing {
  const dir = resolve(expandHome(path?.trim() || HOME));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err: any) {
    throw new Error(err?.code === "EACCES" ? `No permission to open ${dir}` : err?.code === "ENOENT" ? `No folder at ${dir}` : String(err?.message ?? err));
  }
  const entries = names
    .filter((n) => !n.startsWith("."))
    .map((name) => ({ name, path: join(dir, name) }))
    .filter((e) => isDir(e.path))
    .map((e) => ({ ...e, isRepo: existsSync(join(e.path, ".git")) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  return { path: dir, home: HOME, parent: dir === "/" ? null : dirname(dir), entries };
}

function canonical(path: string) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isDir(path: string) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function gitBranch(cwd: string): string | null {
  const res = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stderr: "ignore" });
  const branch = res.exitCode === 0 ? res.stdout.toString().trim() : "";
  return branch && branch !== "HEAD" ? branch : null;
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
