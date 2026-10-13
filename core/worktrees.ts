// Worktrees (t3code's and Zeron's, lean): more checkouts of a project's repository, each on a branch of its own, so
// sessions can work side by side without touching each other's files. They stay part of their project: its sessions,
// its terminals. The ones bismuth makes go under ~/.bismuth/worktrees/<repo>/<name> (Settings → Worktrees moves
// that), named with two random words (`mellow-grove`) on a `bismuth/<name>` branch. Only those are a project's: the
// repository's other worktrees (made by hand, by t3code, by Codex) aren't shown.
// Cleanup (off until switched on) removes ones whose branch is merged, or idle for a number of days, never one with
// uncommitted changes or in use; the branch goes only when git calls it merged (`branch -d`).
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Worktree, WorktreeSettings } from "../shared/model";
import { defaultBranch } from "./checkpoints";
import { expandHome, HOME } from "./projects";
import { failure, git } from "./scm";

const DEFAULT_ROOT = join(HOME, ".bismuth", "worktrees");
const PREFIX = "bismuth/";
/** How long a project's worktree list is reused before git is asked again (sessions are listed often). */
const LIST_TTL_MS = 3_000;
const ADJECTIVES = ["amber", "brave", "calm", "clear", "crisp", "eager", "gentle", "golden", "keen", "lucky", "mellow", "nimble", "quiet", "rapid", "silver", "steady", "swift", "tidy", "vivid", "warm"];
const NOUNS = ["brook", "cedar", "cloud", "comet", "delta", "ember", "field", "fjord", "grove", "harbor", "heron", "lake", "maple", "meadow", "orbit", "pine", "reef", "ridge", "river", "stone"];

/** A worktree bismuth made: its repository (the project folder), the commit it started from and the branch that was
 *  (`from`: null when the folder wasn't on one). */
type Made = { path: string; repo: string; base: string; from?: string | null; createdAt: number };
type Saved = { settings: { root: string | null; idleDays: number | null; whenMerged: boolean }; made: Made[] };

export class Worktrees {
  private file: string;
  private saved: Saved;
  private cache = new Map<string, { at: number; list: Worktree[] }>();

  constructor(stateDir: string) {
    this.file = join(stateDir, "worktrees.json");
    let saved: Partial<Saved> = {};
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {}
    this.saved = { settings: { root: null, idleDays: null, whenMerged: false, ...saved.settings }, made: Array.isArray(saved.made) ? saved.made : [] };
    // Ones made before the branch they came from was kept: the branch that still points at where they started.
    const unknown = this.saved.made.filter((m) => m.from === undefined);
    for (const m of unknown) {
      const at = Bun.spawnSync(["git", "-C", m.repo, "for-each-ref", "--points-at", m.base, "--format=%(refname:short)", "refs/heads/"], { stderr: "ignore" });
      m.from = at.stdout.toString().split("\n").find((b) => b && !b.startsWith(PREFIX)) ?? null;
    }
    if (unknown.length) this.save();
  }

  settings(): WorktreeSettings {
    return { ...this.saved.settings, defaultRoot: DEFAULT_ROOT };
  }

  setSettings(patch: Partial<Omit<WorktreeSettings, "defaultRoot">>): WorktreeSettings {
    const s = this.saved.settings;
    if (patch.root !== undefined) s.root = patch.root?.trim() ? patch.root.trim() : null;
    if (patch.idleDays !== undefined) s.idleDays = patch.idleDays == null ? null : Math.max(1, Math.round(Number(patch.idleDays)) || 1);
    if (patch.whenMerged !== undefined) s.whenMerged = !!patch.whenMerged;
    this.save();
    return this.settings();
  }

  /** The worktrees bismuth made of the project's repository that are still there (none when the folder isn't a
   *  repository's top, or its main checkout's linked one: a worktree's sessions are its project's). */
  list(projectPath: string): Worktree[] {
    const hit = this.cache.get(projectPath);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.list;
    const list = this.read(projectPath);
    this.cache.set(projectPath, { at: Date.now(), list });
    return list;
  }

  private read(projectPath: string): Worktree[] {
    const res = Bun.spawnSync(["git", "-C", projectPath, "worktree", "list", "--porcelain", "-z"], { stderr: "ignore" });
    if (res.exitCode !== 0) return [];
    const stanzas: Record<string, string>[] = [];
    let cur: Record<string, string> | null = null;
    for (const field of res.stdout.toString().split("\0")) {
      if (!field) {
        cur = null;
        continue;
      }
      if (!cur) stanzas.push((cur = {}));
      const sp = field.indexOf(" ");
      cur[sp < 0 ? field : field.slice(0, sp)] = sp < 0 ? "" : field.slice(sp + 1);
    }
    const paths = stanzas.map((s) => canonical(s.worktree ?? ""));
    if (!paths.includes(projectPath)) return [];
    return stanzas
      .filter((s, i) => paths[i] !== projectPath && this.made(paths[i]) && !("bare" in s) && !("prunable" in s) && existsSync(paths[i]))
      .map((s) => {
        const path = canonical(s.worktree);
        return { path, name: basename(path), branch: s.branch ? s.branch.replace(/^refs\/heads\//, "") : null, from: this.made(path)?.from ?? null };
      });
  }

  private made = (path: string) => this.saved.made.find((m) => m.path === path) ?? null;

  /** A new worktree of the project's repository, off the branch the project folder is on, on a branch of its own. */
  async create(projectPath: string): Promise<Worktree> {
    const top = await git(projectPath, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) throw new Error("A worktree needs the project to be a git repository");
    if (canonical(top.out.trim()) !== projectPath) throw new Error("A worktree needs the project folder to be its repository's top folder");
    const head = await git(projectPath, ["rev-parse", "--verify", "-q", "HEAD"]);
    const from = (await git(projectPath, ["symbolic-ref", "-q", "--short", "HEAD"])).out.trim() || null;
    if (!head.ok || !head.out.trim()) throw new Error("A worktree needs the repository to have a first commit");
    const dir = join(resolve(expandHome(this.saved.settings.root ?? DEFAULT_ROOT)), basename(projectPath));
    mkdirSync(dir, { recursive: true });
    const branches = new Set((await git(projectPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).out.split("\n"));
    let name: string | null = null;
    for (let i = 0; i < 100 && !name; i++) {
      const pick = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}-${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
      if (!existsSync(join(dir, pick)) && !branches.has(PREFIX + pick)) name = pick;
    }
    if (!name) throw new Error("Couldn't find a free name for the worktree");
    const path = join(dir, name);
    const added = await git(projectPath, ["worktree", "add", "-b", PREFIX + name, path, "HEAD"], 120_000);
    if (!added.ok) throw failure("Couldn't make the worktree", added);
    const real = canonical(path);
    this.saved.made.push({ path: real, repo: projectPath, base: head.out.trim(), from, createdAt: Date.now() });
    this.save();
    this.cache.delete(projectPath);
    return { path: real, name, branch: PREFIX + name, from };
  }

  /** Take a worktree away: its folder (uncommitted changes and ignored files with it), and its branch when git calls
   *  it merged. */
  async remove(projectPath: string, path: string) {
    const wt = this.read(projectPath).find((w) => w.path === path);
    if (!wt) throw new Error("That isn't one of the project's worktrees");
    const removed = await git(projectPath, ["worktree", "remove", "--force", "--force", path], 120_000);
    if (!removed.ok) {
      rmSync(path, { recursive: true, force: true });
      await git(projectPath, ["worktree", "prune"]);
    }
    if (wt.branch) await git(projectPath, ["branch", "-d", "--", wt.branch]);
    this.saved.made = this.saved.made.filter((m) => m.path !== path);
    this.save();
    this.cache.delete(projectPath);
  }

  /** How a worktree stands: files changed and not committed, and whether its branch is in the default one (one made
   *  that never moved from where it started isn't merged: there's nothing of its own in it yet). */
  async state(projectPath: string, wt: Worktree): Promise<{ changed: number; merged: boolean }> {
    const status = await git(wt.path, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
    const changed = status.out.split("\0").filter((l) => /^.. /.test(l)).length;
    let merged = false;
    const base = await defaultBranch(projectPath);
    const tip = (await git(wt.path, ["rev-parse", "--verify", "-q", "HEAD"])).out.trim();
    if (base && tip && wt.branch && wt.branch !== base.name) {
      const started = this.made(wt.path)?.base;
      merged = tip !== started && (await git(projectPath, ["merge-base", "--is-ancestor", tip, base.ref])).ok;
    }
    return { changed, merged };
  }

  /** When something last happened in a worktree that has no sessions to say: its folder's last change. */
  touchedAt(path: string): number | null {
    const m = this.made(path);
    try {
      return Math.max(statSync(path).mtimeMs, m?.createdAt ?? 0);
    } catch {
      return m?.createdAt ?? null;
    }
  }

  /** What cleanup would do with a worktree, given what keeps it in use (`busy`) and when it was last used. */
  async verdict(projectPath: string, wt: Worktree, busy: string | null, lastUsedAt: number | null): Promise<{ remove: boolean; reason: string }> {
    if (busy) return { remove: false, reason: busy };
    const { idleDays, whenMerged } = this.saved.settings;
    const { changed, merged } = await this.state(projectPath, wt);
    if (changed) return { remove: false, reason: `${changed} uncommitted change${changed === 1 ? "" : "s"}` };
    if (whenMerged && merged) return { remove: true, reason: "Merged" };
    if (idleDays != null && lastUsedAt != null && Date.now() - lastUsedAt > idleDays * 86_400_000) return { remove: true, reason: `Idle for ${idleDays}+ days` };
    return { remove: false, reason: whenMerged || idleDays != null ? "Still in use" : "Cleanup is off" };
  }

  /** Whether any cleanup rule is on. */
  cleaning = () => this.saved.settings.whenMerged || this.saved.settings.idleDays != null;

  private save() {
    writeFileSync(this.file, JSON.stringify(this.saved, null, 2));
  }
}

function canonical(path: string) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}
