// UI builds: web/ is bundled into immutable .bismuth/builds/<id>/ dirs. The core serves one of them and only
// switches when `bun run apply` has validated a new one, so editing web/ never affects the running app by itself.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const STATE = join(ROOT, ".bismuth");
export const BUILDS = join(STATE, "builds");
export const CORES = join(STATE, "cores");
const CURRENT = join(STATE, "current");

/** Changes here are only picked up by a full app restart: the running core (and Electron shell) can't reload them. */
export const CORE_PATHS = ["core", "shared", "desktop", "package.json", "bun.lock"];
/** Inputs of the UI bundle: changes here are hot-appliable. */
export const UI_PATHS = ["web", "shared", "assets", "package.json", "bun.lock"];

export type Fingerprint = Record<string, string>;
export type BuildMeta = { id: string; source: string; createdAt: number };
export type CoreInfo = { pid: number; port: number; token: string; cwd: string; startedAt: number };
export type CoreStatus = { pid: number; build: BuildMeta | null; core: Fingerprint; threads: { id: string; loaded: boolean }[] };

/** Content hash of every file under `paths`, keyed by repo-relative path. */
export function fingerprint(paths: string[]): Fingerprint {
  const out: Fingerprint = {};
  const walk = (rel: string) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const name of readdirSync(abs).sort()) walk(join(rel, name));
    else out[rel] = createHash("sha1").update(readFileSync(abs)).digest("hex");
  };
  for (const p of paths) walk(p);
  return out;
}

export const digest = (fp: Fingerprint) => createHash("sha1").update(JSON.stringify(fp)).digest("hex");

/** Paths whose content differs between two fingerprints (added, removed or changed). */
export function changed(a: Fingerprint, b: Fingerprint): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

export async function buildUI(): Promise<{ ok: true; meta: BuildMeta } | { ok: false; error: string }> {
  const source = digest(fingerprint(UI_PATHS));
  const meta: BuildMeta = { id: `${Date.now().toString(36)}-${source.slice(0, 8)}`, source, createdAt: Date.now() };
  const outdir = join(BUILDS, meta.id);
  try {
    const res = await Bun.build({ entrypoints: [join(ROOT, "web", "index.html")], outdir, sourcemap: "linked" });
    if (!res.success) throw new AggregateError(res.logs, "build failed");
    // What only some views need (diagrams, workbooks) is bundled apart and imported on first use (web/lazy.ts), so
    // the window doesn't load it. (Bun's HTML builds can't split: with `splitting` the page loads the wrong chunk.)
    // `root` pins each file to lazy/<name>.js, where web/lazy.ts imports it: left to itself Bun sometimes nests
    // the outputs under their source path (lazy/web/lazy/<name>.js) and every lazy import 404s.
    const lazyDir = join(ROOT, "web", "lazy");
    const lazy = await Bun.build({ entrypoints: readdirSync(lazyDir).map((f) => join(lazyDir, f)), root: lazyDir, outdir: join(outdir, "lazy"), minify: true, format: "esm", target: "browser" });
    if (!lazy.success) throw new AggregateError(lazy.logs, "build failed");
  } catch (err: any) {
    rmSync(outdir, { recursive: true, force: true });
    const logs: unknown[] = err?.errors ?? [err];
    return { ok: false, error: logs.map((l) => String(l)).join("\n") };
  }
  writeFileSync(join(outdir, "meta.json"), JSON.stringify(meta));
  return { ok: true, meta };
}

export function readBuild(id: string): BuildMeta | null {
  try {
    return JSON.parse(readFileSync(join(BUILDS, id, "meta.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readCurrent(): BuildMeta | null {
  return existsSync(CURRENT) ? readBuild(readFileSync(CURRENT, "utf8").trim()) : null;
}

export function writeCurrent(id: string) {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(CURRENT, id);
}

export function removeBuild(id: string) {
  rmSync(join(BUILDS, id), { recursive: true, force: true });
}

/** Keep the newest `keep` builds plus any in `pinned` (builds that running cores are serving). */
export function pruneBuilds(pinned: string[], keep = 5) {
  if (!existsSync(BUILDS)) return;
  const ids = readdirSync(BUILDS).sort().reverse();
  for (const id of ids.slice(keep)) if (!pinned.includes(id)) removeBuild(id);
}

/** Resolve a URL path inside a build dir; null if it escapes the dir or doesn't exist. */
export function buildFile(id: string, path: string): string | null {
  const dir = join(BUILDS, id);
  const file = resolve(dir, "." + (path === "/" || path === "" ? "/index.html" : decodeURIComponent(path)));
  if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) return null;
  return file;
}
