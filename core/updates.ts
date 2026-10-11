// Provider CLI versions and updates (Zeron's engine/harness_updates.rs, lean): each CLI's installed version
// against its upstream release, an Update that uses whatever installed it, and a per-provider policy — Notify
// (default: surface it, never touch the install unasked), Auto when idle (apply once no turn of that provider
// runs), Off (don't check). Checks run at start and every 6h; Install runs the official installer for a CLI
// that's missing. All probes live here, never in a listing path.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessId, HarnessUpdatePolicy, HarnessUpdateStatus } from "../shared/model";

const CHECK_INTERVAL = 6 * 60 * 60_000;
const COMMAND_TIMEOUT = 20_000;
const UPDATE_TIMEOUT = 15 * 60_000;
const PROVIDERS: HarnessId[] = ["claude", "codex", "cursor"];
const CLI: Record<HarnessId, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };
const NPM_PACKAGE: Partial<Record<HarnessId, string>> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
/** The official installers (Zeron's `install::manual_command`). */
const INSTALL: Record<HarnessId, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "npm install -g @openai/codex",
  cursor: "curl https://cursor.com/install -fsS | bash",
};

/** How a CLI got onto this machine decides how it updates; unknown installs only get a hint. */
type Source = { kind: "native" | "npm" | "brew" | "mise" | "unknown"; update: string[] | null; manual: string };

export class HarnessUpdates {
  private statuses = new Map<HarnessId, HarnessUpdateStatus>();
  private policies: Partial<Record<HarnessId, HarnessUpdatePolicy>>;
  private prefsFile: string;
  private timer: Timer | null = null;
  installing: HarnessId | null = null;
  /** A CLI was replaced on disk (update or install): long-lived processes may need a restart. */
  onChanged: (h: HarnessId) => void = () => {};

  constructor(
    stateDir: string,
    /** Whether a provider has a turn running (auto-updates wait for idle). */
    private busy: (h: HarnessId) => boolean,
  ) {
    this.prefsFile = join(stateDir, "harness-update-prefs.json");
    this.policies = (readJson(this.prefsFile)?.policies as typeof this.policies) ?? {};
    for (const h of PROVIDERS) this.statuses.set(h, { harness: h, policy: this.policy(h), phase: "checking", installedVersion: null, latestVersion: null, canApply: false, manualCommand: null, error: null });
  }

  start() {
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), CHECK_INTERVAL);
  }

  list(): HarnessUpdateStatus[] {
    return PROVIDERS.map((h) => this.statuses.get(h)!);
  }

  private policy = (h: HarnessId): HarnessUpdatePolicy => this.policies[h] ?? "notify";

  setPolicy(h: HarnessId, policy: HarnessUpdatePolicy) {
    this.policies[h] = policy;
    writeFileSync(this.prefsFile, JSON.stringify({ policies: this.policies }, null, 2));
    this.patch(h, { policy });
    if (policy === "off") this.patch(h, { phase: "dormant", latestVersion: null, canApply: false, error: null });
    else void this.check(h);
    return this.list();
  }

  async checkAll() {
    await Promise.all(PROVIDERS.map((h) => this.check(h)));
    return this.list();
  }

  /** Auto-updates that were waiting for a turn to end. */
  idle(h: HarnessId) {
    const s = this.statuses.get(h)!;
    if (s.phase === "waitingForIdle" && !this.busy(h)) void this.apply(h);
  }

  private patch(h: HarnessId, p: Partial<HarnessUpdateStatus>) {
    this.statuses.set(h, { ...this.statuses.get(h)!, ...p });
  }

  async check(h: HarnessId) {
    if (this.policy(h) === "off") return this.patch(h, { phase: "dormant", latestVersion: null, canApply: false, error: null });
    const current = this.statuses.get(h)!.phase;
    if (["installing", "verifying"].includes(current)) return;
    this.patch(h, { phase: "checking", error: null });
    const exe = Bun.which(CLI[h]);
    if (!exe) return this.patch(h, { phase: "notInstalled", installedVersion: null, latestVersion: null, canApply: false, manualCommand: INSTALL[h] });
    const installed = await version(exe);
    const source = sourceOf(h, exe);
    let latest: string | null = null;
    try {
      latest = await latestVersion(h);
    } catch (err: any) {
      return this.patch(h, { phase: "failed", installedVersion: installed, error: `Update check failed · ${err?.message ?? err}`, canApply: false, manualCommand: source.manual });
    }
    if (!latest) {
      // No upstream feed (Cursor): the CLI's own updater decides; offer it.
      return this.patch(h, { phase: "manual", installedVersion: installed, latestVersion: null, canApply: !!source.update, manualCommand: source.manual });
    }
    const available = !!installed && newer(latest, installed);
    this.patch(h, { phase: available ? "available" : "current", installedVersion: installed, latestVersion: latest, canApply: available && !!source.update, manualCommand: available && !source.update ? source.manual : null });
    if (available && source.update && this.policy(h) === "autoWhenIdle") {
      if (this.busy(h)) this.patch(h, { phase: "waitingForIdle" });
      else void this.apply(h);
    }
  }

  /** Run the update with whatever installed the CLI, then re-read its version. */
  async apply(h: HarnessId) {
    const exe = Bun.which(CLI[h]);
    const source = exe ? sourceOf(h, exe) : null;
    if (!source?.update) throw new Error(source?.manual ?? `The ${CLI[h]} CLI isn't installed.`);
    const s = this.statuses.get(h)!;
    if (["installing", "verifying"].includes(s.phase)) return this.list();
    this.patch(h, { phase: "installing", error: null });
    const res = await run(source.update, UPDATE_TIMEOUT);
    if (!res.ok) {
      this.patch(h, { phase: "failed", error: `Update failed · ${lastLine(res.output) || `exit ${res.code}`}`, canApply: true });
      return this.list();
    }
    this.patch(h, { phase: "verifying" });
    const installed = await version(Bun.which(CLI[h]) ?? exe!);
    const latest = this.statuses.get(h)!.latestVersion;
    this.patch(h, { phase: "updated", installedVersion: installed, canApply: !!latest && !!installed && newer(latest, installed) && !!source.update });
    this.onChanged(h);
    return this.list();
  }

  /** The official installer for a missing CLI. */
  async install(h: HarnessId) {
    if (this.installing) throw new Error("Another install is running.");
    this.installing = h;
    try {
      const res = await run(["bash", "-lc", INSTALL[h]], UPDATE_TIMEOUT);
      if (!res.ok) throw new Error(`Installation failed — ${lastLine(res.output) || `exit ${res.code}`}`);
      if (!Bun.which(CLI[h])) throw new Error(`Installed, but \`${CLI[h]}\` isn't on PATH yet — restart bismuth (or your shell) to pick it up.`);
    } finally {
      this.installing = null;
    }
    await this.check(h);
    this.onChanged(h);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Where the resolved binary lives says what installed it. */
function sourceOf(h: HarnessId, exe: string): Source {
  let real = exe;
  try {
    real = realpathSync(exe);
  } catch {}
  const cli = CLI[h];
  const pkg = NPM_PACKAGE[h];
  if (pkg && real.includes(`/node_modules/${pkg}/`)) return { kind: "npm", update: ["npm", "install", "-g", `${pkg}@latest`], manual: `npm install -g ${pkg}@latest` };
  const brew = real.match(/\/(?:Cellar|Caskroom)\/([^/]+)\//);
  if (brew) return { kind: "brew", update: ["brew", "upgrade", brew[1]], manual: `brew upgrade ${brew[1]}` };
  const mise = real.match(/\/mise\/installs\/([^/]+)\/([^/]+)\//);
  if (mise) {
    // A pinned version stays pinned: only a tool tracking "latest" upgrades in place.
    return mise[2] === "latest" || existsSync(join(real.split("/mise/installs/")[0], "mise", "installs", mise[1], "latest"))
      ? { kind: "mise", update: ["mise", "upgrade", mise[1]], manual: `mise upgrade ${mise[1]}` }
      : { kind: "mise", update: null, manual: `Update ${cli} with mise (mise use ${mise[1]}@latest)` };
  }
  // The CLIs' own installers keep versions side by side and update themselves.
  if (h === "claude" && /\/(\.local\/share\/claude|\.claude\/local)\//.test(real)) return { kind: "native", update: [exe, "update"], manual: "claude update" };
  if (h === "cursor" && /\/(cursor-agent|\.cursor)\//.test(real)) return { kind: "native", update: [exe, "update"], manual: "cursor-agent update" };
  return { kind: "unknown", update: null, manual: `Update ${cli} with its original installer or package manager` };
}

async function latestVersion(h: HarnessId): Promise<string | null> {
  if (h === "cursor") return null;
  if (h === "claude") {
    const body: any = await fetchJson("https://registry.npmjs.org/@anthropic-ai/claude-code/latest");
    return typeof body?.version === "string" ? body.version : null;
  }
  const body: any = await fetchJson("https://api.github.com/repos/openai/codex/releases/latest");
  const tag = typeof body?.tag_name === "string" ? body.tag_name : "";
  return tag.startsWith("rust-v") ? tag.slice("rust-v".length) : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "bismuth" }, signal: AbortSignal.timeout(COMMAND_TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function version(exe: string): Promise<string | null> {
  const res = await run([exe, "--version"], COMMAND_TIMEOUT);
  return res.output.match(/\d+\.\d+\.\d+(?:[-.][\w.]+)?|\d{4}\.\d{2}\.\d{2}-\w+/)?.[0] ?? null;
}

async function run(argv: string[], timeout: number): Promise<{ ok: boolean; code: number | null; output: string }> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
    const timer = setTimeout(() => proc.kill(), timeout);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { ok: code === 0, code, output: `${out}\n${err}` };
  } catch (err: any) {
    return { ok: false, code: null, output: String(err?.message ?? err) };
  }
}

const lastLine = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim().split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "";

/** Numeric dotted comparison; anything unparseable never claims to be newer. */
function newer(a: string, b: string) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
