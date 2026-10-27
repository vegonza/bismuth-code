// Agent accounts (Zeron's engine/agent_accounts.rs, for Claude Code, Codex and Cursor): the logins turns run on,
// saved as slots under `.bismuth/agent-accounts/<provider>/<slotId>.json` (0600, dirs 0700), in Zeron's format.
// The model picker chooses one per turn; a project blocks the ones it must never run on.
//
// - Claude Code (Orca's way): each account is its own Claude Code config dir (`claudeHome`), signed in there by
//   `claude auth login` and from then on Claude Code's alone: it refreshes the login under its own lock, as it does for
//   every process sharing a config dir, and bismuth never writes it. A turn runs with CLAUDE_CONFIG_DIR set to it and
//   no token of bismuth's (`claudeLogin`), once its login is checked to be that account's. Everything but the login
//   and who it is links to the user's own config dir, so every account runs with the same config. The CLI's own login
//   (`~/.claude/.credentials.json`, next to the identity in `~/.claude.json`) is neither used nor written.
// - Codex: the machine's login (`~/.codex/auth.json`, identity and tokens in one file), which its app-server holds:
//   each list snapshots it into a slot, and a turn picked on another one switches it (`activate`) while Codex is
//   idle. Cursor: the SDK's store (one file too) is snapshotted likewise, but a turn runs on its slot's API key.
// - Add (`startLogin`): sign a NEW account in: Claude runs the CLI's PKCE flow against our own loopback callback
//   (pasting the code is the fallback), Codex runs `codex login` against a throwaway CODEX_HOME, Cursor runs the
//   SDK's browser login through the shim into a throwaway store file. Codex's and Cursor's become the machine's
//   only when it has none usable, or they are it again.
// - Usage: the rate-limit views the CLIs show (`/usage`, `/status`, Cursor's dashboard), stale-while-revalidate:
//   a list serves each account's last good probe (persisted in usage-cache.json); only a forced list probes,
//   skipping accounts probed in the last 30s or backing off after a failure (Retry-After honoured).
//
// Linux/Windows-style file stores only: macOS keeps Claude's credentials in the Keychain, which isn't read here.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_AUTH_ENV, findClaude } from "./claude-adapter";
import type { AgentAccount, AgentAccountsSnapshot, AgentLoginPoll, AgentLoginStart, HarnessId, UsageWindow } from "../shared/model";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CURSOR_DEFAULT_BACKEND = "https://api2.cursor.sh";
const CURSOR_CURRENT_PERIOD_USAGE = "aiserver.v1.DashboardService/GetCurrentPeriodUsage";

/**
 * Claude Code's config dir entries each account has its own of: its login (which Claude Code alone writes and
 * refreshes), who it is, its organization's policies, and what the CLI caches and reports about it. Every other entry
 * links to the user's own config dir, so every account runs with the same settings, skills, plugins, agents, commands,
 * keybindings, transcripts and history. Claude Code saves settings only into a regular file, never through a link, so
 * a linked file can't fork.
 */
const CLAUDE_OWN = ["backups", "statsig", "cache", "telemetry", "usage-data", "stats-cache.json", "mcp-needs-auth-cache.json", "mcp-discovery-cache", ".session_ingress_token", "hfi-auth.json", "antproto.json"];
const CLAUDE_OWN_PREFIXES = [".credentials.json", ".claude.json", "policy-limits.json", "remote-settings.json"];
/** Folders every account's runs share (Orca's list): made in the user's config dir before an account links to it, so a
 *  CLI never makes one of its own. */
const CLAUDE_SHARED_DIRS = [
  "projects", "sessions", "session-env", "file-history", "shell-snapshots", "todos", "paste-cache", "tasks", "plans", "transcripts",
  "skills", "plugins", "agents", "commands", "output-styles", "rules", "themes", "workflows",
];
/** The user's own state in `~/.claude.json` every account takes up (each project's MCP servers and settings, the user's
 *  MCP servers): copied into each account's under Claude's own lock. */
const CLAUDE_SHARED_CONFIG = ["projects", "mcpServers", "githubRepoPaths"];

/** A forced list re-probes an account only past this (Anthropic's usage endpoint 429s eagerly). */
const FORCED_MIN_INTERVAL = 30_000;
/** An abandoned sign-in (dialog closed without Cancel) is reaped past this. */
const FLOW_TTL = 15 * 60_000;
const HTTP_TIMEOUT = 8_000;

// Zeron's directory names, so slot files stay interchangeable.
const SLUG: Record<HarnessId, string> = { claude: "claude-code", codex: "codex", cursor: "cursor" };
const PROVIDERS: HarnessId[] = ["claude", "codex", "cursor"];
const CLI: Record<HarnessId, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };
const VENDOR: Record<HarnessId, string> = { claude: "Anthropic", codex: "OpenAI", cursor: "Cursor" };
const NAME: Record<HarnessId, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

export type AccountsConfig = {
  /** Slots live under `{dataDir}/agent-accounts/`. */
  dataDir: string;
  /** `$CLAUDE_CONFIG_DIR` or ~/.claude: what each Claude account's own config dir links to. */
  claudeConfigDir: string;
  /** Claude Code's identity and settings file: ~/.claude.json, or `$CLAUDE_CONFIG_DIR/.claude.json`. */
  claudeConfigFile: string;
  /** `$CODEX_HOME` or ~/.codex — holds `auth.json`. */
  codexHome: string;
  /** The Cursor SDK's credential store (separate from `cursor-agent login`). */
  cursorAuthFile: string;
};

export function detectConfig(dataDir: string): AccountsConfig {
  const env = (name: string) => process.env[name] || null;
  // Started from inside one of bismuth's own Claude runs, CLAUDE_CONFIG_DIR is that account's dir, not the user's.
  const claudeDir = env("CLAUDE_CONFIG_DIR")?.includes(`${join("agent-accounts", "claude-homes")}`) ? null : env("CLAUDE_CONFIG_DIR");
  return {
    dataDir,
    claudeConfigDir: claudeDir ?? join(homedir(), ".claude"),
    claudeConfigFile: claudeDir ? join(claudeDir, ".claude.json") : join(homedir(), ".claude.json"),
    codexHome: env("CODEX_HOME") ?? join(homedir(), ".codex"),
    cursorAuthFile: join(homedir(), ".cursor", "sdk", "auth.json"),
  };
}

type Json = Record<string, any>;
type AuthKind = "oauth" | "api-key";
type Profile = { email: string; displayName?: string | null; organization?: string | null; plan?: string | null; authKind: AuthKind };
/** One saved login (`{id}.json`), Zeron's slot format. */
type Slot = {
  id: string;
  harness: string; // Zeron's harness name, kept for interchangeability
  accountKey: string;
  profile: Profile;
  credentials: Json;
  savedAt: number;
  /** First save: the stable sort key (savedAt churns with every auto-snapshot). */
  createdAt?: number;
};
type Detected = { accountKey: string; profile: Profile; credentials: Json };

type UsageSnapshot = { windows: UsageWindow[]; planLabel?: string | null };
type ProbeError =
  | { kind: "unauthorized"; status: number }
  | { kind: "rate-limited"; retryAfterSecs: number | null }
  | { kind: "http"; status: number; retryAfterSecs: number | null }
  | { kind: "network"; timeout: boolean }
  | { kind: "schema" }
  | { kind: "no-credentials"; why: "api-key" | "missing" | "key-expired" | "no-limit" }
  | { kind: "untrusted-endpoint" };
class Probe extends Error {
  constructor(readonly error: ProbeError) {
    super(error.kind);
  }
}
type UsageEntry = { usage?: UsageSnapshot; fetchedAt?: number; error?: ProbeError; checkedAt: number; retryAt?: number; credentials?: string };

type Flow = {
  kind: "spawned";
  harness: HarnessId;
  startedAt: number;
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  /** Claude Code's, which takes a pasted code. */
  stdin: Bun.FileSink | null;
  home: string;
  output: { text: string };
  exit: { code: number | null } | null;
  scan: (out: string, home: string) => { url: string; mode: AgentLoginStart["mode"] } | null;
};

export class AgentAccounts {
  private usage = new Map<string, UsageEntry>();
  private inflight = new Set<string>();
  private flows = new Map<string, Flow>();
  private ops: Promise<unknown> = Promise.resolve();
  /** The machine login of Codex or Cursor changed (switch, sign-out, adopted sign-in): running CLIs may need to reload. */
  onLiveChanged: (harness: HarnessId) => void = () => {};
  /** An account saved for the first time: projects that block any account block it too, until it's unblocked. */
  onAdded: (harness: HarnessId, id: string) => void = () => {};

  constructor(
    private config: AccountsConfig,
    /** argv for the Cursor shim's login mode writing into `store`, or null when Cursor isn't set up. */
    private cursorLogin: (store: string) => string[] | null,
  ) {
    const cache = readJson(this.usageCacheFile());
    for (const [key, entry] of Object.entries(cache?.entries ?? {})) this.usage.set(key, entry as UsageEntry);
  }

  /** One mutation at a time: detection snapshots, swaps and sign-ins all read-modify-write the same files. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.ops.then(fn, fn);
    this.ops = run.catch(() => {});
    return run;
  }

  // ---------------- listing ----------------

  list(forceUsage: boolean): Promise<AgentAccountsSnapshot> {
    return this.serial(() => this.listLocked(forceUsage));
  }

  private async listLocked(forceUsage: boolean): Promise<AgentAccountsSnapshot> {
    // Codex's and Cursor's machine logins, saved as they are (one file each: the identity can't drift from the tokens).
    const codex = this.detectCodex();
    if (codex) this.snapshot("codex", codex);
    const cursor = this.detectCursor();
    if (cursor) this.snapshot("cursor", cursor);

    const slots = new Map(PROVIDERS.map((h) => [h, this.readSlots(h)] as const));
    if (forceUsage) await this.refreshUsage(PROVIDERS.flatMap((h) => slots.get(h)!.map((slot) => ({ harness: h, slot }))));
    const now = Date.now();
    const accounts: AgentAccount[] = [];
    for (const h of PROVIDERS) {
      for (const slot of slots.get(h)!) {
        const entry = this.usage.get(usageKey(h, slot.accountKey));
        const machine = h === "codex" && codex?.accountKey === slot.accountKey;
        accounts.push({
          id: slot.id,
          harness: h,
          email: slot.profile.email,
          displayName: slot.profile.displayName ?? null,
          organization: slot.profile.organization ?? null,
          // A live plan from the probe (Codex's plan_type) beats the login-time snapshot.
          plan: entry?.usage?.planLabel ?? slot.profile.plan ?? null,
          authKind: slot.profile.authKind,
          active: machine,
          windows: entry?.usage?.windows ?? [],
          usageFetchedAt: entry?.fetchedAt ?? null,
          usageError: entry?.error ? usageErrorMessage(h, machine, entry.error, entry, now) : null,
          unusable: this.unusable(h, slot),
          savedAt: slot.savedAt,
        });
      }
    }
    return { accounts, warnings: [] };
  }

  /** Windows a running turn reported for the saved account it ran on: fresher than any probe, and free. */
  noteUsage(harness: HarnessId, windows: UsageWindow[], account: string | null) {
    const key = account ? (this.readSlots(harness).find((s) => s.id === account)?.accountKey ?? null) : null;
    if (!key || !windows.length) return;
    const k = usageKey(harness, key);
    const prev = this.usage.get(k);
    const at = Date.now();
    this.usage.set(k, { ...prev, usage: { windows, planLabel: prev?.usage?.planLabel }, fetchedAt: at, checkedAt: prev?.checkedAt ?? 0, error: undefined, retryAt: undefined, credentials: undefined });
  }

  // ---------------- the account a turn runs on ----------------

  /** Codex's or Cursor's machine login's account id (saved or not yet); Claude Code's is none of bismuth's. */
  liveId(harness: HarnessId): string | null {
    const live = this.liveAccountKey(harness);
    return live ? slotId(harness, live) : null;
  }

  /** A saved account's email, for what a refusal says. */
  savedEmail(harness: HarnessId, id: string | null | undefined): string | null {
    return (id && this.readSlots(harness).find((s) => s.id === id)?.profile.email) || null;
  }

  /** Each account's id, the machine login's (saved or not yet) among them: what a project can block. */
  savedIds(harness: HarnessId): string[] {
    const live = this.liveId(harness);
    return [...new Set([...(live ? [live] : []), ...this.readSlots(harness).map((s) => s.id)])];
  }

  /**
   * The saved account a turn of `harness` runs on in a project (`where`, which blocks `blocked`): `wanted` (the model
   * picker's, or the session's last), else Codex's or Cursor's machine login, else the first saved one the project
   * allows. Throws when it can't run: it's blocked there, no longer saved or needs signing in again, or nothing is
   * saved while the project blocks accounts (it runs only on ones bismuth can name). null: nothing is saved, and the
   * CLI runs as it's set up.
   */
  turnAccount(harness: HarnessId, wanted: string | null, blocked: string[], where: string): string | null {
    const slots = this.readSlots(harness);
    const live = this.liveId(harness);
    const ids = [...new Set([...(live ? [live] : []), ...slots.map((s) => s.id)])];
    const slot = (id: string) => slots.find((s) => s.id === id);
    if (!ids.length) {
      if (blocked.length) throw new Error(`${where} runs only on accounts saved in bismuth: add a ${NAME[harness]} one in Settings → Providers`);
      return null;
    }
    const allowed = (id: string) => !blocked.includes(id) && !(slot(id) && this.unusable(harness, slot(id)!));
    const id = wanted ?? ids.find(allowed);
    if (!id) throw new Error(`No ${NAME[harness]} account can run in ${where}: unblock one in the model picker, or sign in again in Settings → Providers`);
    if (!ids.includes(id)) throw new Error(`That ${NAME[harness]} account is no longer saved: pick another in the model picker`);
    const who = slot(id)?.profile.email ?? `The ${NAME[harness]} account`;
    if (blocked.includes(id)) throw new Error(`${who} is blocked in ${where}: pick another account in the model picker`);
    const why = slot(id) && this.unusable(harness, slot(id)!);
    if (why) throw new Error(`${who} can't run turns: ${why}`);
    return id;
  }

  /**
   * The environment a Claude Code CLI runs on saved account `id` in: the account's own config dir, whose login Claude
   * Code reads and refreshes itself. Throws when no turn may run on it: signed out, or its login is another account's.
   */
  claudeLogin(id: string): { env: Record<string, string> } {
    const slot = this.readSlots("claude").find((s) => s.id === id);
    if (!slot) throw new Error("That Claude Code account is no longer saved: pick another in the model picker");
    const why = this.unusable("claude", slot);
    if (why) throw new Error(`${slot.profile.email} can't run turns: ${why}`);
    return { env: { CLAUDE_CONFIG_DIR: this.claudeHome(slot) } };
  }

  /**
   * Why no turn runs on a saved account until it's signed in again, or null. Cursor's minted keys run out (90 days by
   * default). A Claude account's dir must hold a login Claude Code can still refresh, and Claude Code's word on whose
   * it is must be the account's.
   */
  private unusable(harness: HarnessId, slot: Slot): string | null {
    if (harness === "cursor") return cursorKeyUsable(slot.credentials) ? null : "API key expired — connect again";
    if (harness !== "claude") return null;
    const { oauth, who } = this.claudeState(slot.id);
    if (!str(oauth?.accessToken)) return "Signed out — sign in again";
    if (who?.accountUuid !== slot.accountKey) return `Its sign-in is ${str(who?.emailAddress) ?? "another account"}'s — sign in again`;
    const live = Number(oauth!.expiresAt) > Date.now() || (str(oauth!.refreshToken) && !(Number(oauth!.refreshTokenExpiresAt) <= Date.now()));
    return live ? null : "Sign-in expired — sign in again";
  }

  /** Claude account `id`'s own config dir (CLAUDE_CONFIG_DIR). */
  private claudeDir = (id: string) => join(this.root(), "claude-homes", id);

  /** What Claude account `id`'s config dir holds: Claude Code's login (`.credentials.json`) and whose it is (the
   *  identity in `.claude.json`, which Claude Code re-reads from Anthropic with the login's own token). */
  private claudeState(id: string): { oauth: Json | null; who: Json | null } {
    const dir = this.claudeDir(id);
    return { oauth: readJson(join(dir, ".credentials.json"))?.claudeAiOauth ?? null, who: readJson(join(dir, ".claude.json"))?.oauthAccount ?? null };
  }

  /**
   * Claude account `slot`'s config dir, ready for a run: every entry but its own (CLAUDE_OWN) links to the user's
   * config dir, and the user's own state in `~/.claude.json` is copied into the account's. Its login is never touched.
   */
  private claudeHome(slot: Slot): string {
    const home = this.claudeDir(slot.id);
    privateDir(home);
    const real = this.config.claudeConfigDir;
    for (const dir of CLAUDE_SHARED_DIRS) mkdirSync(join(real, dir), { recursive: true });
    const own = (name: string) => CLAUDE_OWN.includes(name) || CLAUDE_OWN_PREFIXES.some((p) => name.startsWith(p));
    // Links whose target went go too.
    for (const name of readdirSync(home)) if (lstatSync(join(home, name)).isSymbolicLink() && !existsSync(join(home, name))) unlinkSync(join(home, name));
    for (const name of readdirSync(real)) {
      if (own(name) || lstatSync(join(home, name), { throwIfNoEntry: false })) continue;
      try {
        symlinkSync(join(real, name), join(home, name));
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err; // another run of this account linked it first
      }
    }
    const file = join(home, ".claude.json");
    const theirs = readJson(this.config.claudeConfigFile) ?? {};
    const share = (mine: Json) => {
      const next: Json = { ...mine };
      for (const key of CLAUDE_SHARED_CONFIG) {
        if (key in theirs) next[key] = theirs[key];
        else delete next[key];
      }
      return next;
    };
    const mine = readJson(file);
    // Under Claude Code's own lock on the file (proper-lockfile's `<file>.lock` dir), which a CLI of this account may
    // hold: then it's left for the next run. Never a file it couldn't read: that would wipe its login's identity.
    if (mine && JSON.stringify(share(mine)) !== JSON.stringify(mine)) {
      try {
        mkdirSync(`${file}.lock`);
        try {
          const now = readJson(file);
          if (now) writeAtomic(file, JSON.stringify(share(now), null, 2), true);
        } finally {
          rmSync(`${file}.lock`, { recursive: true, force: true });
        }
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
      }
    }
    return home;
  }

  /** Drop a Claude account's own config dir: its links (never what they point at), then its own files. */
  private dropClaudeHome(id: string) {
    const home = join(this.root(), "claude-homes", id);
    if (!existsSync(home)) return;
    for (const name of readdirSync(home)) {
      const at = join(home, name);
      if (lstatSync(at).isSymbolicLink()) unlinkSync(at);
      else rmSync(at, { recursive: true, force: true });
    }
    rmSync(home, { recursive: true, force: true });
  }

  /** The environment a Cursor run goes on saved account `id` with: its API key, which the SDK takes over its own login. */
  cursorKey(id: string): Record<string, string> {
    const slot = this.readSlots("cursor").find((s) => s.id === id);
    if (!slot) throw new Error("That Cursor account is no longer saved: pick another in the model picker");
    if (!cursorKeyUsable(slot.credentials)) throw new Error(`${slot.profile.email}'s Cursor API key has expired: connect it again in Settings → Providers`);
    return { CURSOR_API_KEY: String(slot.credentials.apiKey) };
  }

  // ---------------- switch / forget ----------------

  /** Make a saved slot Codex's machine login (a turn picked it; its app-server then restarts onto it). */
  activate(harness: "codex", id: string): Promise<void> {
    return this.serial(async () => {
      // The login it replaces is saved first.
      await this.listLocked(false);
      const slot = this.readSlots(harness).find((s) => s.id === id);
      if (!slot) throw new Error("That Codex account is no longer saved: pick another in the model picker");
      this.writeLive(harness, slot);
      this.onLiveChanged(harness);
    });
  }

  forget(harness: HarnessId, id: string): Promise<AgentAccountsSnapshot> {
    // The id becomes a path: only a slot id (16 lowercase hex) may reach the filesystem.
    if (!/^[0-9a-f]{16}$/.test(id)) return Promise.reject(new Error("Unknown account."));
    return this.serial(async () => {
      await this.listLocked(false);
      // Removing Codex's or Cursor's machine login signs it out: dropping only the slot would re-detect it on the next
      // list. Claude Code's own login is never bismuth's to touch.
      if (harness !== "claude" && this.liveId(harness) === id) {
        this.signOut(harness);
        this.onLiveChanged(harness);
      }
      rmSync(join(this.slotsDir(harness), `${id}.json`), { force: true });
      if (harness === "claude") this.dropClaudeHome(id);
      return this.listLocked(false);
    });
  }

  private writeLive(harness: "codex" | "cursor", slot: Slot) {
    if (harness === "codex") {
      mkdirSync(this.config.codexHome, { recursive: true });
      writeAtomic(join(this.config.codexHome, "auth.json"), JSON.stringify(slot.credentials, null, 2), true);
    } else {
      mkdirSync(dirname(this.config.cursorAuthFile), { recursive: true });
      writeAtomic(this.config.cursorAuthFile, JSON.stringify(slot.credentials, null, 2), true);
    }
  }

  private signOut(harness: "codex" | "cursor") {
    rmSync(harness === "codex" ? join(this.config.codexHome, "auth.json") : this.config.cursorAuthFile, { force: true });
  }

  /** Codex's or Cursor's machine login's account key. */
  private liveAccountKey(harness: HarnessId): string | null {
    if (harness === "claude") return null;
    return (harness === "codex" ? this.detectCodex() : this.detectCursor())?.accountKey ?? null;
  }

  /**
   * A fresh Codex or Cursor sign-in replaces the machine login only when it IS that account (otherwise the next list
   * would snapshot the old, possibly revoked, tokens back over it) or when there is no usable one at all. Any other
   * stays: Codex switches when a turn picks another account.
   */
  private adoptIfLive(harness: "codex" | "cursor", slot: Slot) {
    const live = this.liveAccountKey(harness);
    const usable = harness === "cursor" ? this.cursorLiveUsable() : live !== null;
    if (usable && live !== slot.accountKey) return;
    this.writeLive(harness, slot);
    this.onLiveChanged(harness);
  }

  // ---------------- sign-in ----------------

  async startLogin(harness: HarnessId): Promise<AgentLoginStart> {
    this.sweepFlows();
    // A new start supersedes earlier ones (`codex login` holds a fixed loopback port; one flow is the sane state).
    for (const [id, f] of this.flows) if (f.harness === harness) this.cancelLogin(id);
    if (harness === "claude") {
      const claude = findClaude();
      if (!claude) throw new Error("Claude Code was not found on this device — install it first.");
      // Claude Code signs in into a dir of its own (Orca's way). The tab it opens through $BROWSER (its loopback sign-in,
      // which finishes by itself) is caught and opened by the app; failing that, its printed page shows a code to paste.
      const started = Date.now();
      return this.spawnLogin(
        "claude",
        (home) => ({
          argv: [claude, "auth", "login", "--claudeai"],
          env: { CLAUDE_CONFIG_DIR: join(home, "claude"), BROWSER: this.browserScript(".capture-browser", '#!/bin/sh\nprintf \'%s\' "$1" > "$BISMUTH_LOGIN_URL"\n'), BISMUTH_LOGIN_URL: join(home, "url") },
        }),
        (out, home) => {
          const url = existsSync(join(home, "url")) ? readFileSync(join(home, "url"), "utf8").trim() : null;
          if (url) return { url, mode: "browser" };
          const printed = /visit:\s*(https:\/\/\S+)/.exec(stripAnsi(out))?.[1];
          return printed && Date.now() - started > 3000 ? { url: printed, mode: "paste-code" } : null;
        },
      );
    }
    const browser = (scan: (out: string) => string | null) => (out: string) => {
      const url = scan(out);
      return url ? { url, mode: "browser" as const } : null;
    };
    if (harness === "codex") {
      const codex = Bun.which("codex");
      if (!codex) throw new Error("The `codex` CLI was not found on this device — install it first.");
      // The CLI opens the authorization tab itself and the app opens it too: a no-op $BROWSER keeps it to one.
      return this.spawnLogin("codex", (home) => ({ argv: [codex, "login"], env: { CODEX_HOME: home, BROWSER: this.browserScript(".noop-browser", "#!/bin/sh\nexit 0\n") } }), browser(scanOpenAiUrl));
    }
    return this.spawnLogin(
      "cursor",
      (home) => {
        const argv = this.cursorLogin(join(home, "auth.json"));
        if (!argv) throw new Error("Cursor isn't set up on this device yet (it needs Node.js and the Cursor SDK).");
        return { argv, env: {} };
      },
      browser(scanCursorUrl),
    );
  }

  /** The code a Claude sign-in's page showed (`code#state`), typed into its `claude auth login`. Resolves once it's in. */
  async completeLogin(loginId: string, pasted: string): Promise<AgentAccountsSnapshot> {
    const flow = this.flows.get(loginId);
    if (!flow || flow.harness !== "claude" || flow.exit) throw new Error("This sign-in attempt expired — start again.");
    if (!pasted.trim()) throw new Error("That code looks empty — paste the whole code.");
    flow.stdin?.write(`${pasted.trim()}\n`);
    flow.stdin?.flush();
    const deadline = Date.now() + 60_000;
    while (!flow.exit && Date.now() < deadline) await Bun.sleep(200);
    const poll = await this.pollLogin(loginId);
    if (poll.status === "error") throw new Error(poll.message);
    if (poll.status !== "done") throw new Error("Claude Code didn't finish signing in — start again.");
    return this.list(false);
  }

  /**
   * A finished `claude auth login` in `dir`: the account Claude Code names there gets the dir as its own (or, signed in
   * again, just the new login, in place, where Claude Code takes it up) and a slot.
   */
  private adoptClaude(dir: string) {
    const who: Json = readJson(join(dir, ".claude.json"))?.oauthAccount ?? {};
    const oauth: Json = readJson(join(dir, ".credentials.json"))?.claudeAiOauth ?? {};
    const accountUuid = str(who.accountUuid);
    const email = str(who.emailAddress);
    if (!accountUuid || !email || !str(oauth.accessToken)) throw new Error("The sign-in finished without credentials.");
    const id = slotId("claude", accountUuid);
    const home = this.claudeDir(id);
    privateDir(dirname(home));
    if (!existsSync(home)) renameSync(dir, home);
    else {
      renameSync(join(dir, ".credentials.json"), join(home, ".credentials.json"));
      if (this.claudeState(id).who?.accountUuid !== accountUuid) renameSync(join(dir, ".claude.json"), join(home, ".claude.json"));
    }
    this.writeSlot("claude", {
      id,
      harness: SLUG.claude,
      accountKey: accountUuid,
      profile: { email, displayName: str(who.displayName), organization: str(who.organizationName), plan: claudePlan(str(oauth.subscriptionType), str(oauth.rateLimitTier)), authKind: "oauth" },
      credentials: {},
      savedAt: Date.now(),
    });
    this.usage.delete(usageKey("claude", accountUuid));
  }

  /** A login child signing in against a throwaway home: Codex's and Cursor's are done once their auth.json appears
   *  there, Claude Code's once it exits having signed in. */
  private async spawnLogin(
    harness: HarnessId,
    command: (home: string) => { argv: string[]; env: Record<string, string> },
    scan: (out: string, home: string) => { url: string; mode: AgentLoginStart["mode"] } | null,
  ): Promise<AgentLoginStart> {
    const loginId = randomUUID();
    const home = join(this.root(), "logins", loginId);
    privateDir(home);
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      const { argv, env } = command(home);
      // Claude Code signs in on nothing but the login it's about to make.
      const base = harness === "claude" ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !CLAUDE_AUTH_ENV.test(k))) : process.env;
      proc = Bun.spawn(argv, { env: { ...base, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (err: any) {
      rmSync(home, { recursive: true, force: true });
      throw new Error(`Could not start the ${CLI[harness]} sign-in: ${err?.message ?? err}`);
    }
    const output = { text: "" };
    const flow: Flow = { kind: "spawned", harness, startedAt: Date.now(), proc, stdin: harness === "claude" ? proc.stdin : null, home, output, exit: null, scan };
    if (harness !== "claude") proc.stdin.end();
    // The url can land on either stream.
    for (const stream of [proc.stdout, proc.stderr]) {
      void (async () => {
        const dec = new TextDecoder();
        for await (const chunk of stream) output.text += dec.decode(chunk, { stream: true });
      })();
    }
    void proc.exited.then((code) => (flow.exit = { code }));
    this.flows.set(loginId, flow);
    // Wait briefly for the sign-in page; a page printed later reaches the app through a poll.
    const deadline = Date.now() + 5000;
    let found = scan(output.text, home);
    while (!found && !flow.exit && Date.now() < deadline) {
      await Bun.sleep(100);
      found = scan(output.text, home);
    }
    return { loginId, url: found?.url ?? "", mode: found?.mode ?? "browser" };
  }

  async pollLogin(loginId: string): Promise<AgentLoginPoll> {
    this.sweepFlows();
    const flow = this.flows.get(loginId);
    if (!flow) throw new Error("This sign-in attempt expired — start again.");
    if (flow.harness === "claude") {
      if (!flow.exit) return { status: "pending", url: flow.scan(flow.output.text, flow.home)?.url };
      if (flow.exit.code === 0) {
        try {
          await this.serial(async () => this.adoptClaude(join(flow.home, "claude")));
        } catch (err: any) {
          this.cancelLogin(loginId);
          return { status: "error", message: redact(String(err?.message ?? err)) };
        }
        this.cancelLogin(loginId);
        return { status: "done" };
      }
    } else {
      const auth = readJson(join(flow.home, "auth.json"));
      const detected = auth ? (flow.harness === "codex" ? parseCodexAuth(auth) : parseCursorAuth(auth)) : null;
      if (detected) {
        await this.serial(async () => {
          this.snapshot(flow.harness, detected);
          const slot = this.readSlots(flow.harness).find((s) => s.id === slotId(flow.harness, detected.accountKey));
          if (slot) this.adoptIfLive(flow.harness as "codex" | "cursor", slot);
        });
        this.cancelLogin(loginId);
        return { status: "done" };
      }
    }
    if (flow.exit) {
      this.cancelLogin(loginId);
      if (flow.exit.code === 0) return { status: "error", message: "The sign-in finished without credentials." };
      // The shim reports failures as a JSONL fatal frame, the CLIs as plain text. Never hand either over raw.
      const lines = stripAnsi(flow.output.text).trim().split("\n");
      return { status: "error", message: redact(scanShimFatal(flow.output.text) ?? lines[lines.length - 1] ?? "sign-in failed") };
    }
    return { status: "pending", url: flow.scan(flow.output.text, flow.home)?.url };
  }

  /** Drop a flow: kill its login child and reclaim its throwaway home (an adopted Claude dir has moved out). Idempotent. */
  cancelLogin(loginId: string) {
    const flow = this.flows.get(loginId);
    this.flows.delete(loginId);
    if (!flow) return;
    flow.proc.kill();
    rmSync(flow.home, { recursive: true, force: true });
  }

  shutdown() {
    for (const id of [...this.flows.keys()]) this.cancelLogin(id);
  }

  private sweepFlows() {
    for (const [id, f] of this.flows) if (Date.now() - f.startedAt > FLOW_TTL) this.cancelLogin(id);
  }

  /** A $BROWSER script for login children: one that opens nothing (the app opens the tab), or catches the url. */
  private browserScript(name: string, script: string): string {
    const path = join(this.root(), name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== script) {
      writeAtomic(path, script, false);
      chmodSync(path, 0o755);
    }
    return path;
  }

  // ---------------- detection ----------------

  private detectCodex = () => {
    const auth = readJson(join(this.config.codexHome, "auth.json"));
    return auth ? parseCodexAuth(auth) : null;
  };

  private detectCursor = () => {
    const auth = readJson(this.config.cursorAuthFile);
    return auth ? parseCursorAuth(auth) : null;
  };

  private cursorLiveUsable() {
    const auth = readJson(this.config.cursorAuthFile);
    return !!auth && cursorKeyUsable(auth);
  }

  // ---------------- slots ----------------

  private root() {
    const root = join(this.config.dataDir, "agent-accounts");
    privateDir(root);
    return root;
  }

  private usageCacheFile = () => join(this.config.dataDir, "agent-accounts", "usage-cache.json");

  private slotsDir(harness: HarnessId) {
    const dir = join(this.root(), SLUG[harness]);
    privateDir(dir);
    return dir;
  }

  private readSlots(harness: HarnessId): Slot[] {
    const dir = this.slotsDir(harness);
    const slots: Slot[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      // One malformed slot skips that slot, not the page.
      const slot = readJson(join(dir, name)) as Slot | null;
      if (slot?.id && slot.accountKey && slot.profile && slot.credentials) slots.push(slot);
    }
    // Creation order, stable across switches; the id breaks ties so the page never reshuffles between restarts.
    return slots.sort((a, b) => (a.createdAt ?? a.savedAt) - (b.createdAt ?? b.savedAt) || a.id.localeCompare(b.id));
  }

  private writeSlot(harness: HarnessId, slot: Slot) {
    const file = join(this.slotsDir(harness), `${slot.id}.json`);
    const existing = readJson(file) as Slot | null;
    // A brand-new slot is stamped after every sibling, so same-millisecond saves still list in save order.
    const newest = Math.max(0, ...this.readSlots(harness).map((s) => (s.createdAt ?? s.savedAt) + 1));
    const createdAt = existing ? (existing.createdAt ?? existing.savedAt) : (slot.createdAt ?? Math.max(newest, slot.savedAt));
    writeAtomic(file, JSON.stringify({ ...slot, createdAt }, null, 2), true);
    if (!existing) this.onAdded(harness, slot.id);
  }

  /** Persist a detected machine login into its slot (refreshing the stored tokens). */
  private snapshot(harness: HarnessId, d: Detected) {
    if (!d.credentials) return;
    this.writeSlot(harness, {
      id: slotId(harness, d.accountKey),
      harness: SLUG[harness],
      accountKey: d.accountKey,
      profile: d.profile,
      credentials: d.credentials,
      savedAt: Date.now(),
    });
  }

  // ---------------- usage ----------------

  /** Probe every due account concurrently; failures keep the last good windows and back off. */
  private async refreshUsage(targets: { harness: HarnessId; slot: Slot }[]) {
    const now = Date.now();
    const probes: Promise<void>[] = [];
    for (const { harness, slot } of targets) {
      const key = usageKey(harness, slot.accountKey);
      // A Claude account's login is in its dir, where Claude Code refreshes it.
      const fingerprint = credentialsFingerprint(harness === "claude" ? (this.claudeState(slot.id).oauth ?? {}) : slot.credentials);
      const entry = this.usage.get(key);
      if ((entry && !probeDue(entry, fingerprint, now)) || this.inflight.has(key)) continue;
      this.inflight.add(key);
      probes.push(
        this.probe(harness, slot)
          .then(
            (usage) => ({ ok: true as const, usage }),
            (err) => ({ ok: false as const, error: err instanceof Probe ? err.error : ({ kind: "network", timeout: false } as ProbeError) }),
          )
          .then((result) => {
            const at = Date.now();
            const next: UsageEntry = { ...(this.usage.get(key) ?? { checkedAt: 0 }), checkedAt: at };
            if (result.ok) Object.assign(next, { usage: result.usage, fetchedAt: at, error: undefined, retryAt: undefined, credentials: undefined });
            else {
              Object.assign(next, { error: result.error, retryAt: at + backoff(result.error), credentials: fingerprint });
              if (result.error.kind !== "no-credentials") console.error(`[accounts] ${harness} usage unavailable: ${result.error.kind}`);
            }
            this.usage.set(key, next);
          })
          .finally(() => this.inflight.delete(key)),
      );
    }
    if (!probes.length) return;
    await Promise.all(probes);
    // Forgotten accounts drop out of the cache.
    const keep = new Set(targets.map((t) => usageKey(t.harness, t.slot.accountKey)));
    for (const key of this.usage.keys()) if (!keep.has(key)) this.usage.delete(key);
    try {
      this.root();
      writeAtomic(this.usageCacheFile(), JSON.stringify({ entries: Object.fromEntries(this.usage) }, null, 2), true);
    } catch (err: any) {
      console.error("[accounts] usage cache write failed:", err?.message ?? err);
    }
  }

  private probe(harness: HarnessId, slot: Slot): Promise<UsageSnapshot> {
    if (harness === "claude") return this.claudeUsage(slot);
    if (harness === "codex") return codexUsage(slot);
    return cursorUsage(slot);
  }

  /** A Claude account's windows, read with its login's current token: Claude Code refreshes it when it next runs on the
   *  account, never bismuth. */
  private async claudeUsage(slot: Slot): Promise<UsageSnapshot> {
    const { oauth } = this.claudeState(slot.id);
    // Signed out, or signed in as another account: whose windows these would be is not this account's.
    if (this.unusable("claude", slot) || !oauth!.scopes?.includes("user:profile")) throw new Probe({ kind: "no-credentials", why: "missing" });
    if (!(Number(oauth!.expiresAt) > Date.now())) throw new Probe({ kind: "unauthorized", status: 401 });
    return claudeUsageRequest(oauth!.accessToken);
  }

}

// ---------------- probes ----------------

async function probeJson(url: string, init: RequestInit = {}): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT) });
  } catch (err: any) {
    throw new Probe({ kind: "network", timeout: err?.name === "TimeoutError" });
  }
  if (!res.ok) {
    const retryAfter = retryAfterSecs(res.headers.get("retry-after"));
    if (res.status === 401 || res.status === 403) throw new Probe({ kind: "unauthorized", status: res.status });
    if (res.status === 429) throw new Probe({ kind: "rate-limited", retryAfterSecs: retryAfter });
    throw new Probe({ kind: "http", status: res.status, retryAfterSecs: retryAfter });
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") throw new Probe({ kind: "schema" });
  return body;
}

async function claudeUsageRequest(token: string): Promise<UsageSnapshot> {
  const body = await probeJson(CLAUDE_USAGE_URL, { headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" } });
  const windows: UsageWindow[] = [];
  for (const [key, label] of [["five_hour", "Session"], ["seven_day", "Week"]] as const) {
    const w = body[key];
    if (typeof w?.utilization === "number") windows.push({ label, usedPercent: w.utilization, resetsAt: parseWhen(w.resets_at) });
  }
  if (!windows.length) throw new Probe({ kind: "schema" });
  return { windows };
}

async function codexUsage(slot: Slot): Promise<UsageSnapshot> {
  const tokens = slot.credentials.tokens;
  // API-key mode has no ChatGPT rate windows.
  if (!tokens) throw new Probe({ kind: "no-credentials", why: str(slot.credentials.OPENAI_API_KEY) ? "api-key" : "missing" });
  const token = str(tokens.access_token);
  if (!token) throw new Probe({ kind: "no-credentials", why: "missing" });
  const body = await probeJson(CODEX_USAGE_URL, { headers: { authorization: `Bearer ${token}`, "chatgpt-account-id": str(tokens.account_id) ?? "" } });
  const windows: UsageWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const w = body.rate_limit?.[key];
    if (typeof w?.used_percent === "number") windows.push({ label: codexWindowLabel(Number(w.limit_window_seconds) || 0), usedPercent: w.used_percent, resetsAt: parseWhen(w.reset_at) });
  }
  if (!windows.length) throw new Probe({ kind: "schema" });
  // The live plan beats the login-time JWT claim, so a plan change shows without a re-login.
  return { windows, planLabel: codexPlan(str(body.plan_type)) };
}

/** The SDK key has no quota view: it's exchanged for a dashboard session, which reads the billing-cycle usage. */
async function cursorUsage(slot: Slot): Promise<UsageSnapshot> {
  const apiKey = str(slot.credentials.apiKey);
  if (!apiKey) throw new Probe({ kind: "no-credentials", why: "missing" });
  if (!cursorKeyUsable(slot.credentials)) throw new Probe({ kind: "no-credentials", why: "key-expired" });
  const backend = (str(slot.credentials.backendUrl) ?? CURSOR_DEFAULT_BACKEND).replace(/\/+$/, "");
  // The key only ever goes to Cursor's own servers, whatever the file names.
  const host = URL.canParse(backend) ? new URL(backend) : null;
  if (!host || host.protocol !== "https:" || !/(^|\.)cursor\.(sh|com)$/.test(host.hostname)) throw new Probe({ kind: "untrusted-endpoint" });
  const session = await probeJson(`${backend}/auth/exchange_user_api_key`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: "{}" });
  const access = str(session.accessToken);
  if (!access) throw new Probe({ kind: "schema" });
  const body = await probeJson(`${backend}/${CURSOR_CURRENT_PERIOD_USAGE}`, {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": "application/json", "connect-protocol-version": "1" },
    body: "{}",
  });
  // Percent from spend/limit (what Cursor's own UI narrates); proto3 omits zeros, so no limit means unknown, not 0%.
  // A plan with no included usage answers with only its billing cycle.
  if (!body.planUsage && !body.billingCycleEnd) throw new Probe({ kind: "schema" });
  const limit = Number(body.planUsage?.limit);
  if (!(limit > 0)) throw new Probe({ kind: "no-credentials", why: "no-limit" });
  const used = Number(body.planUsage?.totalSpend) || 0;
  const end = Number(body.billingCycleEnd);
  return { windows: [{ label: "Month", usedPercent: (used / limit) * 100, resetsAt: end > 0 ? end : null }] };
}

function probeDue(entry: UsageEntry, fingerprint: string, now: number) {
  if (now - entry.checkedAt < FORCED_MIN_INTERVAL) return false;
  if (entry.retryAt && entry.error && now < entry.retryAt) {
    // A rejection is about THAT credential: new credentials (re-login, the CLI refreshed) deserve a probe at once.
    // A rate limit or outage holds regardless.
    return ["unauthorized", "no-credentials", "untrusted-endpoint"].includes(entry.error.kind) && entry.credentials !== fingerprint;
  }
  return true;
}

/** How long to leave a provider alone after a failure; a server's Retry-After wins, within bounds. */
function backoff(e: ProbeError): number {
  const clamp = (s: number, max: number) => Math.min(max, Math.max(30, s)) * 1000;
  switch (e.kind) {
    case "rate-limited":
      return clamp(e.retryAfterSecs ?? 300, 3600);
    case "http":
      return e.status >= 500 ? clamp(e.retryAfterSecs ?? 60, 1800) : 15 * 60_000;
    case "schema":
      return 15 * 60_000;
    case "network":
      return 30_000;
    default:
      return 10 * 60_000;
  }
}

/** The reason line an account shows instead of meters (or beside stale ones). */
function usageErrorMessage(harness: HarnessId, active: boolean, e: ProbeError, entry: UsageEntry, now: number): string | null {
  const vendor = VENDOR[harness];
  const retry = entry.retryAt && entry.retryAt > now ? ` — retrying in ${shortDuration(entry.retryAt - now)}` : "";
  switch (e.kind) {
    case "rate-limited":
      return `Rate limited by ${vendor}${retry}`;
    case "unauthorized":
      // Codex owns (and refreshes) its machine login's token; it just hasn't yet.
      if (active) return `Session expired — it refreshes the next time ${CLI[harness]} runs`;
      // Codex's and Claude's saved logins aren't refreshed in the background (their refresh tokens rotate): their CLIs
      // refresh them when a turn runs on them.
      return harness === "cursor" ? "Signed out — sign in again" : "Session expired — it refreshes when a turn runs on it";
    case "http":
      return e.status >= 500 ? `${vendor} is having trouble (${e.status})${retry}` : `Usage check failed (${e.status})`;
    case "network":
      return e.timeout ? `${vendor} didn't respond${retry}` : `Couldn't reach ${vendor}${retry}`;
    case "schema":
      return "Usage format changed — update bismuth";
    case "untrusted-endpoint":
      return "Usage skipped — this login names a server bismuth doesn't recognize";
    case "no-credentials":
      return { "api-key": "API keys have no plan usage", "key-expired": "API key expired — connect again", "no-limit": "No included-usage limit on this plan", missing: null }[e.why];
  }
}

// ---------------- credential formats ----------------

/** A Codex auth.json (live or a fresh login's): a ChatGPT token set, or a raw API key. */
function parseCodexAuth(auth: Json): Detected | null {
  const idToken = str(auth.tokens?.id_token);
  if (idToken) {
    const claims = jwtClaims(idToken) ?? {};
    const oa: Json = claims["https://api.openai.com/auth"] ?? {};
    const email = str(claims.email);
    if (!email) return null;
    // Team seats share a workspace id: the user id keeps one teammate's login from colliding with another's.
    const workspace = str(oa.chatgpt_account_id);
    const user = str(oa.chatgpt_user_id) ?? str(oa.user_id);
    const accountKey = user && workspace ? `${user}::${workspace}` : (workspace ?? email);
    return { accountKey, profile: { email, displayName: str(claims.name), plan: codexPlan(str(oa.chatgpt_plan_type)), authKind: "oauth" }, credentials: auth };
  }
  const key = str(auth.OPENAI_API_KEY);
  if (!key) return null;
  return {
    accountKey: `api-key:${sha256(key).slice(0, 12)}`,
    profile: { email: `API key ·…${key.slice(-4)}`, plan: "API key", authKind: "api-key" },
    credentials: auth,
  };
}

/** The Cursor SDK's credential store: the named, expiring user API key its browser login minted. */
function parseCursorAuth(auth: Json): Detected | null {
  const apiKey = str(auth.apiKey);
  if (!apiKey) return null;
  const email = str(auth.email);
  const expires = Number(auth.apiKeyExpiresAtMs);
  // With 90-day keys, the expiry is the one fact worth showing as the plan chip.
  const plan = expires > 0 ? (expires < Date.now() ? "Key expired" : `Key expires ${new Date(expires).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`) : null;
  return {
    accountKey: email ?? `api-key:${sha256(apiKey).slice(0, 12)}`,
    profile: { email: email ?? `API key ·…${apiKey.slice(-4)}`, plan, authKind: "oauth" },
    credentials: auth,
  };
}

const cursorKeyUsable = (auth: Json) => !!str(auth.apiKey) && !(Number(auth.apiKeyExpiresAtMs) > 0 && Number(auth.apiKeyExpiresAtMs) <= Date.now());

/** "Max 20×" from Claude Code's subscription type and rate-limit tier. */
function claudePlan(subscription: string | null, tier: string | null): string | null {
  const base = ({ max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" } as Json)[subscription ?? ""];
  if (!base) return null;
  const mult = tier?.match(/_(\d+)x$/)?.[1];
  return mult ? `${base} ${mult}×` : base;
}

const codexPlan = (plan: string | null) => (plan ? `ChatGPT ${plan[0].toUpperCase()}${plan.slice(1)}` : null);

/** Free tier: a 30-day month; Plus: a ~5h primary and a weekly secondary. */
const codexWindowLabel = (secs: number) => (secs >= 28 * 86400 ? "Month" : secs >= 5 * 86400 ? "Week" : "Session");

// ---------------- sign-in output scanning ----------------

const scanOpenAiUrl = (out: string) => scanHttpsUrl(out, ["auth.openai.com"]);

function scanHttpsUrl(out: string, hosts: string[]): string | null {
  for (const m of stripAnsi(out).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const url = URL.canParse(m[0]) ? new URL(m[0]) : null;
    if (url && hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return m[0];
  }
  return null;
}

function shimFrame(out: string, ev: string): Json | null {
  for (const line of out.split("\n")) {
    try {
      const frame = JSON.parse(line.trim());
      if (frame?.ev === ev) return frame;
    } catch {}
  }
  return null;
}

/** The Cursor SDK's sign-in page from the shim's `auth-url` frame — only a Cursor https page. */
function scanCursorUrl(out: string): string | null {
  const url = str(shimFrame(out, "auth-url")?.url);
  return url && scanHttpsUrl(url, ["cursor.com", "cursor.sh"]) ? url : null;
}

const scanShimFatal = (out: string) => str(shimFrame(out, "fatal")?.message);

// ---------------- helpers ----------------

const usageKey = (h: HarnessId, accountKey: string) => `${SLUG[h]}:${accountKey}`;
const slotId = (h: HarnessId, accountKey: string) => sha256(`${SLUG[h]}:${accountKey}`).slice(0, 16);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** A short digest telling "the token that was rejected" from "new credentials" — never the secret itself. */
const credentialsFingerprint = (c: Json) => sha256(JSON.stringify(c)).slice(0, 16);
const randomUUID = () => crypto.randomUUID();
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function readJson(file: string): Json | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Decode a JWT's claims without verifying: identity from a token the user's own CLI already trusts. */
function jwtClaims(jwt: string): Json | null {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** ISO string (Claude) or unix seconds (Codex) → ms. */
function parseWhen(v: unknown): number | null {
  if (typeof v === "number") return v * 1000;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function retryAfterSecs(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - Date.now()) / 1000));
}

function shortDuration(ms: number) {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.ceil(s / 60)}m` : `${Math.ceil(s / 3600)}h`;
}

/** Created (parents too) and made owner-only: it holds tokens and every throwaway sign-in home. */
function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Same-directory temp file (exclusive, final mode from birth, fsynced) renamed over the target: never torn. */
function writeAtomic(file: string, text: string, secret: boolean) {
  const tmp = join(dirname(file), `.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", secret ? 0o600 : 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
}

/** A CLI's last words can carry an authorize url or a token: urls lose their query, long opaque words go. */
function redact(text: string) {
  return stripAnsi(text)
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1?…")
    .replace(/\b(bearer|token|key|secret|password|code)(\s*[:=]\s*|\s+)\S+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9_\-.=+/]{32,}/g, "[redacted]");
}

