// Agent accounts (Zeron's engine/agent_accounts.rs, for Claude Code, Codex and Cursor): every login each CLI
// has had on this device, saved as slots, one of them live.
//
// - Detect: each list reads the CLI's live login and snapshots it into a slot under
//   `.bismuth/agent-accounts/<provider>/<slotId>.json` (0600, dirs 0700), so the session a switch replaces is
//   always backed up and refreshed tokens stay current. Slot files use Zeron's format.
// - Switch (`activate`): overwrite the CLI's credential store with a saved slot. Claude's blob also carries
//   machine-shared MCP/plugin tokens next to the account login; the live copies of those are kept. Claude's
//   identity (`oauthAccount`, `userID`) is merged back into `~/.claude.json`, nothing else there is touched.
// - Add (`startLogin`): sign a NEW account in without touching the live one (unless it is the live account
//   again, or there is no live login): Claude runs the CLI's PKCE flow against our own loopback callback
//   (pasting the code is the fallback), Codex runs `codex login` against a throwaway CODEX_HOME, Cursor runs
//   the SDK's browser login through the shim into a throwaway store file.
// - Usage: the rate-limit views the CLIs show (`/usage`, `/status`, Cursor's dashboard), stale-while-revalidate:
//   a list serves each account's last good probe (persisted in usage-cache.json); only a forced list probes,
//   skipping accounts probed in the last 30s or backing off after a failure (Retry-After honoured).
//
// Linux/Windows-style file stores only: macOS keeps Claude's credentials in the Keychain, which isn't read here.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentAccount, AgentAccountsSnapshot, AgentLoginPoll, AgentLoginStart, HarnessId, UsageWindow } from "../shared/model";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_REDIRECT = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_SCOPES = "org:create_api_key user:profile user:inference";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_LOOPBACK_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const CLAUDE_LOOPBACK_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_LOOPBACK_SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code";
const CLAUDE_LOOPBACK_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CURSOR_DEFAULT_BACKEND = "https://api2.cursor.sh";
const CURSOR_CURRENT_PERIOD_USAGE = "aiserver.v1.DashboardService/GetCurrentPeriodUsage";
/** Machine-shared keys in Claude's credential blob (MCP OAuth, plugin secrets): on a switch the live copies win. */
const CLAUDE_SHARED_KEYS = ["mcpOAuth", "mcpOAuthClientConfig", "mcpXaaIdp", "mcpXaaIdpConfig", "pluginSecrets"];

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

export type AccountsConfig = {
  /** Slots live under `{dataDir}/agent-accounts/`. */
  dataDir: string;
  /** `$CLAUDE_CONFIG_DIR` or ~/.claude — holds `.credentials.json`. */
  claudeConfigDir: string;
  /** Claude's identity file: ~/.claude.json, or `$CLAUDE_CONFIG_DIR/.claude.json`. */
  claudeConfigFile: string;
  /** `$CODEX_HOME` or ~/.codex — holds `auth.json`. */
  codexHome: string;
  /** The Cursor SDK's credential store (separate from `cursor-agent login`). */
  cursorAuthFile: string;
};

export function detectConfig(dataDir: string): AccountsConfig {
  const env = (name: string) => process.env[name] || null;
  const claudeDir = env("CLAUDE_CONFIG_DIR");
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
  claudeConfig?: Json;
  savedAt: number;
  /** First save: the stable sort key (savedAt churns with every auto-snapshot). */
  createdAt?: number;
};
type Detected = { accountKey: string; profile: Profile; credentials: Json | null; claudeConfig?: Json };

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

type Flow =
  | { kind: "paste"; harness: "claude"; verifier: string; state: string; startedAt: number }
  | { kind: "task"; harness: HarnessId; startedAt: number; url: string; outcome: { ok: true } | { ok: false; message: string } | null; stop: () => void }
  | { kind: "spawned"; harness: "codex" | "cursor"; startedAt: number; proc: Bun.Subprocess; home: string; output: { text: string }; exit: { code: number | null } | null; scan: (out: string) => string | null };

export class AgentAccounts {
  private usage = new Map<string, UsageEntry>();
  private inflight = new Set<string>();
  private refreshing = new Set<string>();
  private flows = new Map<string, Flow>();
  private ops: Promise<unknown> = Promise.resolve();
  /** The live login of a harness changed (switch, sign-out, adopted sign-in): running CLIs may need to reload. */
  onLiveChanged: (harness: HarnessId) => void = () => {};

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
    const warnings: AgentAccountsSnapshot["warnings"] = [];
    const active = new Map<HarnessId, string>();
    const unreadable: [HarnessId, Detected][] = [];

    const claude = this.detectClaude();
    if (claude) {
      active.set("claude", claude.accountKey);
      if (claude.credentials) this.snapshot("claude", claude);
      else unreadable.push(["claude", claude]);
    }
    const codex = this.detectCodex();
    if (codex) {
      active.set("codex", codex.accountKey);
      this.snapshot("codex", codex);
    }
    const cursor = this.detectCursor();
    if (cursor) {
      active.set("cursor", cursor.accountKey);
      this.snapshot("cursor", cursor);
      // Minted keys expire (90 days by default): an expired live key fails every run, so say so up front.
      if (!this.cursorLiveUsable()) warnings.push({ harness: "cursor", message: "The connected Cursor login's API key has expired — connect again." });
    }

    const slots = new Map(PROVIDERS.map((h) => [h, this.readSlots(h)] as const));
    if (forceUsage) {
      await this.refreshUsage(PROVIDERS.flatMap((h) => slots.get(h)!.map((slot) => ({ harness: h, slot, active: active.get(h) === slot.accountKey }))));
    }
    const now = Date.now();
    const accounts: AgentAccount[] = [];
    for (const h of PROVIDERS) {
      const list = slots.get(h)!;
      for (const slot of list) {
        const isActive = active.get(h) === slot.accountKey;
        const entry = this.usage.get(usageKey(h, slot.accountKey));
        accounts.push({
          id: slot.id,
          harness: h,
          email: slot.profile.email,
          displayName: slot.profile.displayName ?? null,
          organization: slot.profile.organization ?? null,
          // A live plan from the probe (Codex's plan_type) beats the login-time snapshot.
          plan: entry?.usage?.planLabel ?? slot.profile.plan ?? null,
          authKind: slot.profile.authKind,
          active: isActive,
          windows: entry?.usage?.windows ?? [],
          usageFetchedAt: entry?.fetchedAt ?? null,
          usageError: entry?.error ? usageErrorMessage(h, isActive, entry.error, entry, now) : null,
          switchable: true,
          savedAt: slot.savedAt,
        });
      }
      // A live login whose credentials couldn't be read has no slot: shown, active, never switchable.
      for (const [uh, d] of unreadable) {
        if (uh !== h || list.some((s) => s.accountKey === d.accountKey)) continue;
        accounts.push({
          id: slotId(h, d.accountKey),
          harness: h,
          email: d.profile.email,
          displayName: d.profile.displayName ?? null,
          organization: d.profile.organization ?? null,
          plan: d.profile.plan ?? null,
          authKind: d.profile.authKind,
          active: true,
          windows: [],
          usageFetchedAt: null,
          usageError: null,
          switchable: false,
          savedAt: null,
        });
      }
    }
    return { accounts, warnings };
  }

  /** Windows a running turn reported for the live login: fresher than any probe, and free. */
  noteLiveUsage(harness: HarnessId, windows: UsageWindow[]) {
    const key = this.liveAccountKey(harness);
    if (!key || !windows.length) return;
    const k = usageKey(harness, key);
    const prev = this.usage.get(k);
    const at = Date.now();
    this.usage.set(k, { ...prev, usage: { windows, planLabel: prev?.usage?.planLabel }, fetchedAt: at, checkedAt: prev?.checkedAt ?? 0, error: undefined, retryAt: undefined, credentials: undefined });
  }

  // ---------------- switch / forget ----------------

  /** Make a saved slot the CLI's live login. Detection runs first, so the current login is saved before it's replaced. */
  activate(harness: HarnessId, id: string): Promise<AgentAccountsSnapshot> {
    return this.serial(async () => {
      await this.listLocked(false);
      const slot = this.readSlots(harness).find((s) => s.id === id);
      if (!slot) throw new Error("That saved login no longer exists — refresh and try again.");
      this.writeLive(harness, slot);
      this.onLiveChanged(harness);
      return this.listLocked(false);
    });
  }

  forget(harness: HarnessId, id: string): Promise<AgentAccountsSnapshot> {
    // The id becomes a path: only a slot id (16 lowercase hex) may reach the filesystem.
    if (!/^[0-9a-f]{16}$/.test(id)) return Promise.reject(new Error("Unknown account."));
    return this.serial(async () => {
      const snapshot = await this.listLocked(false);
      const row = snapshot.accounts.find((a) => a.harness === harness && a.id === id);
      if (row?.active) {
        // Removing the live login signs the CLI out — dropping only the slot would re-detect it on the next list.
        const live = this.liveAccountKey(harness);
        if (!live || slotId(harness, live) !== id) throw new Error("The live login changed while it was being removed — refresh and try again.");
        this.signOut(harness);
        this.onLiveChanged(harness);
      }
      rmSync(join(this.slotsDir(harness), `${id}.json`), { force: true });
      return this.listLocked(false);
    });
  }

  private writeLive(harness: HarnessId, slot: Slot) {
    if (harness === "claude") this.activateClaude(slot);
    else if (harness === "codex") {
      mkdirSync(this.config.codexHome, { recursive: true });
      writeAtomic(join(this.config.codexHome, "auth.json"), JSON.stringify(slot.credentials, null, 2), true);
    } else {
      mkdirSync(dirname(this.config.cursorAuthFile), { recursive: true });
      writeAtomic(this.config.cursorAuthFile, JSON.stringify(slot.credentials, null, 2), true);
    }
  }

  private activateClaude(slot: Slot) {
    const live = readJson(this.claudeCredsFile());
    this.writeClaudeCredentials(composeClaudeCredentials(slot.credentials, live));
    // Merge the identity into ~/.claude.json. A file that exists but doesn't parse is left alone: writing only our
    // fields would wipe the user's whole Claude config. Only a missing file may start from {}.
    const file = this.config.claudeConfigFile;
    const cfg = readJson(file);
    if (!cfg && existsSync(file)) throw new Error("~/.claude.json exists but could not be parsed — not switching to avoid wiping it. Fix or remove the file and try again.");
    const merged: Json = cfg ?? {};
    merged.oauthAccount = slot.claudeConfig?.oauthAccount ?? {
      accountUuid: slot.accountKey,
      emailAddress: slot.profile.email,
      organizationName: slot.profile.organization ?? null,
      displayName: slot.profile.displayName ?? null,
    };
    if (typeof slot.claudeConfig?.userID === "string") merged.userID = slot.claudeConfig.userID;
    else delete merged.userID;
    // Atomic: Claude Code rewrites this file often; a torn write must never read as an empty config.
    writeAtomic(file, JSON.stringify(merged), false);
  }

  private signOut(harness: HarnessId) {
    if (harness === "claude") {
      const live = readJson(this.claudeCredsFile());
      if (live) {
        // Only the account login goes; machine-shared MCP/plugin OAuth stays.
        delete live.claudeAiOauth;
        this.writeClaudeCredentials(live);
      }
      const cfg = readJson(this.config.claudeConfigFile);
      if (cfg && "oauthAccount" in cfg) {
        delete cfg.oauthAccount;
        writeAtomic(this.config.claudeConfigFile, JSON.stringify(cfg), false);
      }
    } else if (harness === "codex") rmSync(join(this.config.codexHome, "auth.json"), { force: true });
    else rmSync(this.config.cursorAuthFile, { force: true });
  }

  /** The live login's account key, from identity alone. */
  private liveAccountKey(harness: HarnessId): string | null {
    if (harness === "claude") {
      const oauth = readJson(this.config.claudeConfigFile)?.oauthAccount;
      return str(oauth?.accountUuid) ?? str(oauth?.emailAddress);
    }
    return (harness === "codex" ? this.detectCodex() : this.detectCursor())?.accountKey ?? null;
  }

  /**
   * A fresh sign-in replaces the live login only when it IS the live account (otherwise the next list would
   * snapshot the old, possibly revoked, tokens back over it) or when there is no usable live login at all —
   * "add" must then mean "works". Any other live login stays: switching remains explicit.
   */
  private adoptIfLive(harness: HarnessId, slot: Slot) {
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
    if (harness === "claude") return this.startClaudeLogin();
    if (harness === "codex") {
      const codex = Bun.which("codex");
      if (!codex) throw new Error("The `codex` CLI was not found on this device — install it first.");
      // The CLI opens the authorization tab itself and the app opens it too: a no-op $BROWSER keeps it to one.
      return this.spawnLogin("codex", (home) => ({ argv: [codex, "login"], env: { CODEX_HOME: home, BROWSER: this.noopBrowser() } }), scanOpenAiUrl);
    }
    return this.spawnLogin(
      "cursor",
      (home) => {
        const argv = this.cursorLogin(join(home, "auth.json"));
        if (!argv) throw new Error("Cursor isn't set up on this device yet (it needs Node.js and the Cursor SDK).");
        return { argv, env: {} };
      },
      scanCursorUrl,
    );
  }

  /** Claude: the CLI's own automatic login — PKCE against a loopback /callback we serve. */
  private startClaudeLogin(): AgentLoginStart {
    const loginId = randomUUID();
    const verifier = randomToken();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    // 32 random bytes like the CLI's own: Anthropic's authorize page rejects a shorter state.
    const state = randomToken();
    let server: ReturnType<typeof Bun.serve>;
    let redirect = "";
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.claudeCallback(loginId, req, state, verifier, redirect) });
    } catch {
      return this.startClaudePasteLogin(loginId, verifier, challenge, state);
    }
    redirect = `http://localhost:${server.port}/callback`;
    const url =
      `${CLAUDE_LOOPBACK_AUTHORIZE_URL}?code=true&client_id=${CLAUDE_CLIENT_ID}&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(CLAUDE_LOOPBACK_SCOPES)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
    this.flows.set(loginId, { kind: "task", harness: "claude", startedAt: Date.now(), url, outcome: null, stop: () => server.stop(true) });
    return { loginId, url, mode: "browser" };
  }

  /** The browser landing on the loopback: redeem its code, then send it to Claude's success page (or say why not). */
  private async claudeCallback(loginId: string, req: Request, state: string, verifier: string, redirect: string): Promise<Response> {
    const url = new URL(req.url);
    const flow = this.flows.get(loginId);
    // Strays (a favicon, someone else's state) are answered and ignored: they can neither finish nor kill the login.
    if (url.pathname !== "/callback" || !flow || flow.kind !== "task" || flow.outcome) return new Response("", { status: 404 });
    if (url.searchParams.get("state") !== state) return new Response("Unknown sign-in.", { status: 400 });
    const code = url.searchParams.get("code");
    let outcome: { ok: true } | { ok: false; message: string };
    if (!code) outcome = { ok: false, message: `Claude sign-in failed: ${url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no authorization code came back"}` };
    else {
      try {
        await this.serial(() => this.redeemClaudeCode(CLAUDE_LOOPBACK_TOKEN_URL, code, state, verifier, redirect, CLAUDE_LOOPBACK_SCOPES));
        outcome = { ok: true };
      } catch (err: any) {
        outcome = { ok: false, message: redact(String(err?.message ?? err)) };
      }
    }
    flow.outcome = outcome;
    setTimeout(() => flow.stop(), 1000);
    if (outcome.ok) return Response.redirect(CLAUDE_LOOPBACK_SUCCESS_URL, 302);
    return new Response(`<!doctype html><title>Sign-in failed</title><p>${escapeHtml(outcome.message)}</p><p>Return to bismuth to try again.</p>`, {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  /** Fallback when no loopback port can be bound: Anthropic's manual redirect shows a code to paste back. */
  private startClaudePasteLogin(loginId: string, verifier: string, challenge: string, state: string): AgentLoginStart {
    const url =
      `https://claude.ai/oauth/authorize?code=true&client_id=${CLAUDE_CLIENT_ID}&response_type=code` +
      `&redirect_uri=${encodeURIComponent(CLAUDE_REDIRECT)}&scope=${encodeURIComponent(CLAUDE_SCOPES)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
    this.flows.set(loginId, { kind: "paste", harness: "claude", verifier, state, startedAt: Date.now() });
    return { loginId, url, mode: "paste-code" };
  }

  /** The pasted `code#state` for a paste-code sign-in. */
  async completeLogin(loginId: string, pasted: string): Promise<AgentAccountsSnapshot> {
    const flow = this.flows.get(loginId);
    if (!flow || flow.kind !== "paste") throw new Error("This sign-in attempt expired — start again.");
    const [code, state = flow.state] = pasted.trim().split("#");
    if (state !== flow.state) throw new Error("That code belongs to a different sign-in — start again.");
    if (!code) throw new Error("That code looks empty — paste the whole code.");
    await this.serial(() => this.redeemClaudeCode(CLAUDE_TOKEN_URL, code, state, flow.verifier, CLAUDE_REDIRECT, CLAUDE_SCOPES));
    this.flows.delete(loginId);
    return this.list(false);
  }

  /** Exchange a Claude authorization code, save the account as a slot (and make it live when `adoptIfLive` says so). */
  private async redeemClaudeCode(tokenUrl: string, code: string, state: string, verifier: string, redirect: string, scopes: string) {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, state, client_id: CLAUDE_CLIENT_ID, redirect_uri: redirect, code_verifier: verifier }),
      signal: AbortSignal.timeout(15_000),
    }).catch((err) => {
      throw new Error(`token exchange failed: ${err?.message ?? err}`);
    });
    // Never echo the body: it can carry token material, and the loopback page shows this message.
    if (!res.ok) throw new Error(`Anthropic rejected the code (${res.status}) — try again.`);
    const token: Json = await res.json().catch(() => {
      throw new Error("token exchange returned junk");
    });
    const accessToken = str(token.access_token);
    const refreshToken = str(token.refresh_token);
    if (!accessToken || !refreshToken) throw new Error("Anthropic returned no usable tokens — try signing in again.");
    // Best effort, like Claude Code: the profile fills in plan and organization.
    const profile: Json | null = await fetch(CLAUDE_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const pAccount: Json = profile?.account ?? {};
    const pOrg: Json = profile?.organization ?? {};
    const tAccount: Json = token.account ?? {};
    const tOrg: Json = token.organization ?? {};
    const email = str(pAccount.email_address) ?? str(tAccount.email_address);
    if (!email) throw new Error("Could not identify the signed-in account.");
    const accountUuid = str(pAccount.uuid) ?? str(tAccount.uuid) ?? email;
    const orgName = str(pOrg.name) ?? str(tOrg.name);
    const orgType = str(pOrg.organization_type);
    const tier = str(pOrg.rate_limit_tier);
    const displayName = str(pAccount.display_name) ?? str(pAccount.full_name);
    const subscriptionType = ({ claude_max: "max", claude_pro: "pro", claude_team: "team", claude_enterprise: "enterprise" } as Json)[orgType ?? ""];
    const oauth: Json = {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
      scopes: (str(token.scope) ?? scopes).split(" "),
      ...(subscriptionType ? { subscriptionType } : {}),
    };
    const oauthAccount: Json = {
      accountUuid,
      emailAddress: email,
      organizationUuid: str(pOrg.uuid) ?? str(tOrg.uuid),
      organizationName: orgName,
      displayName,
      ...(orgType ? { organizationType: orgType } : {}),
      ...(tier ? { organizationRateLimitTier: tier } : {}),
    };
    const slot: Slot = {
      id: slotId("claude", accountUuid),
      harness: SLUG.claude,
      accountKey: accountUuid,
      profile: { email, displayName, organization: orgName, plan: claudePlan(orgType, tier), authKind: "oauth" },
      credentials: { claudeAiOauth: oauth },
      claudeConfig: { oauthAccount },
      savedAt: Date.now(),
    };
    this.writeSlot("claude", slot);
    this.adoptIfLive("claude", slot);
  }

  /** Codex/Cursor: a login child signing in against a throwaway home; done once its auth.json appears there. */
  private async spawnLogin(harness: "codex" | "cursor", command: (home: string) => { argv: string[]; env: Record<string, string> }, scan: (out: string) => string | null): Promise<AgentLoginStart> {
    const loginId = randomUUID();
    const home = join(this.root(), "logins", loginId);
    privateDir(home);
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      const { argv, env } = command(home);
      proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (err: any) {
      rmSync(home, { recursive: true, force: true });
      throw new Error(`Could not start the ${CLI[harness]} sign-in: ${err?.message ?? err}`);
    }
    const output = { text: "" };
    const flow: Flow = { kind: "spawned", harness, startedAt: Date.now(), proc, home, output, exit: null, scan };
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
    let url = scan(output.text);
    while (!url && !flow.exit && Date.now() < deadline) {
      await Bun.sleep(100);
      url = scan(output.text);
    }
    return { loginId, url: url ?? "", mode: "browser" };
  }

  async pollLogin(loginId: string): Promise<AgentLoginPoll> {
    this.sweepFlows();
    const flow = this.flows.get(loginId);
    if (!flow) throw new Error("This sign-in attempt expired — start again.");
    if (flow.kind === "paste") return { status: "pending" };
    if (flow.kind === "task") {
      if (!flow.outcome) return { status: "pending", url: flow.url };
      this.flows.delete(loginId);
      return flow.outcome.ok ? { status: "done" } : { status: "error", message: flow.outcome.message };
    }
    const auth = readJson(join(flow.home, "auth.json"));
    const detected = auth ? (flow.harness === "codex" ? parseCodexAuth(auth) : parseCursorAuth(auth)) : null;
    if (detected) {
      await this.serial(async () => {
        this.snapshot(flow.harness, detected);
        const slot = this.readSlots(flow.harness).find((s) => s.id === slotId(flow.harness, detected.accountKey));
        if (slot) this.adoptIfLive(flow.harness, slot);
      });
      this.cancelLogin(loginId);
      return { status: "done" };
    }
    if (flow.exit) {
      this.cancelLogin(loginId);
      if (flow.exit.code === 0) return { status: "error", message: "The sign-in finished without credentials." };
      // The shim reports failures as a JSONL fatal frame, the CLIs as plain text. Never hand either over raw.
      const lines = stripAnsi(flow.output.text).trim().split("\n");
      return { status: "error", message: redact(scanShimFatal(flow.output.text) ?? lines[lines.length - 1] ?? "sign-in failed") };
    }
    return { status: "pending", url: flow.scan(flow.output.text) ?? undefined };
  }

  /** Drop a flow: kill its login child or loopback listener and reclaim its throwaway home. Idempotent. */
  cancelLogin(loginId: string) {
    const flow = this.flows.get(loginId);
    this.flows.delete(loginId);
    if (flow?.kind === "spawned") {
      flow.proc.kill();
      rmSync(flow.home, { recursive: true, force: true });
    } else if (flow?.kind === "task") flow.stop();
  }

  shutdown() {
    for (const id of [...this.flows.keys()]) this.cancelLogin(id);
  }

  private sweepFlows() {
    for (const [id, f] of this.flows) if (Date.now() - f.startedAt > FLOW_TTL) this.cancelLogin(id);
  }

  /** A $BROWSER that opens nothing: the app opens the one sign-in tab itself. */
  private noopBrowser(): string {
    const path = join(this.root(), ".noop-browser");
    const script = "#!/bin/sh\nexit 0\n";
    if (!existsSync(path) || readFileSync(path, "utf8") !== script) {
      writeAtomic(path, script, false);
      chmodSync(path, 0o755);
    }
    return path;
  }

  // ---------------- detection ----------------

  private claudeCredsFile = () => join(this.config.claudeConfigDir, ".credentials.json");

  private detectClaude(): Detected | null {
    const cfg = readJson(this.config.claudeConfigFile);
    const oauth = cfg?.oauthAccount;
    const email = str(oauth?.emailAddress);
    if (!email) return null;
    const claudeConfig: Json = { oauthAccount: oauth };
    if (typeof cfg!.userID === "string") claudeConfig.userID = cfg!.userID;
    return {
      accountKey: str(oauth.accountUuid) ?? email,
      profile: {
        email,
        displayName: str(oauth.displayName),
        organization: str(oauth.organizationName),
        plan: claudePlan(str(oauth.organizationType), str(oauth.organizationRateLimitTier)),
        authKind: "oauth",
      },
      credentials: readJson(this.claudeCredsFile()),
      claudeConfig,
    };
  }

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

  private writeClaudeCredentials(credentials: Json) {
    mkdirSync(this.config.claudeConfigDir, { recursive: true });
    writeAtomic(this.claudeCredsFile(), JSON.stringify(credentials), true);
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
  }

  /** Persist a detected live login into its slot (refreshing the stored tokens). */
  private snapshot(harness: HarnessId, d: Detected) {
    if (!d.credentials) return;
    this.writeSlot(harness, {
      id: slotId(harness, d.accountKey),
      harness: SLUG[harness],
      accountKey: d.accountKey,
      profile: d.profile,
      credentials: d.credentials,
      ...(d.claudeConfig ? { claudeConfig: d.claudeConfig } : {}),
      savedAt: Date.now(),
    });
  }

  // ---------------- usage ----------------

  /** Probe every due account concurrently; failures keep the last good windows and back off. */
  private async refreshUsage(targets: { harness: HarnessId; slot: Slot; active: boolean }[]) {
    const now = Date.now();
    const probes: Promise<void>[] = [];
    for (const { harness, slot, active } of targets) {
      const key = usageKey(harness, slot.accountKey);
      const fingerprint = credentialsFingerprint(slot.credentials);
      const entry = this.usage.get(key);
      if ((entry && !probeDue(entry, fingerprint, now)) || this.inflight.has(key)) continue;
      this.inflight.add(key);
      probes.push(
        this.probe(harness, slot, active)
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

  private probe(harness: HarnessId, slot: Slot, active: boolean): Promise<UsageSnapshot> {
    if (harness === "claude") return this.claudeUsage(slot, active);
    if (harness === "codex") return codexUsage(slot);
    return cursorUsage(slot);
  }

  private async claudeUsage(slot: Slot, active: boolean): Promise<UsageSnapshot> {
    const token = str(slot.credentials.claudeAiOauth?.accessToken);
    if (!token) throw new Probe({ kind: "no-credentials", why: "missing" });
    try {
      return await claudeUsageRequest(token);
    } catch (err) {
      // Stored expiry metadata can lie, so rotate only after a real rejection (401/403) — a 429 or 5xx says nothing
      // about the token, and refresh tokens are single-use. The live login is never rotated: the CLI owns it.
      if (!(err instanceof Probe) || err.error.kind !== "unauthorized" || active) throw err;
      const fresh = await this.refreshClaudeSlot(slot);
      if (!fresh) throw err;
      return claudeUsageRequest(fresh);
    }
  }

  /** Refresh a saved (never the live) Claude slot's access token; single-flight per slot. */
  private async refreshClaudeSlot(slot: Slot): Promise<string | null> {
    if (this.refreshing.has(slot.id)) return null;
    this.refreshing.add(slot.id);
    try {
      const oauth = slot.credentials.claudeAiOauth;
      const refreshToken = str(oauth?.refreshToken);
      if (!refreshToken) throw new Probe({ kind: "no-credentials", why: "missing" });
      let body: Json;
      try {
        body = await probeJson(CLAUDE_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }),
        });
      } catch (err) {
        // A refused refresh (400 invalid_grant: revoked or used) means this login is dead: "Sign in again".
        if (err instanceof Probe && err.error.kind === "http" && err.error.status === 400) throw new Probe({ kind: "unauthorized", status: 400 });
        throw err;
      }
      const accessToken = str(body.access_token);
      if (!accessToken) throw new Probe({ kind: "schema" });
      const updated = {
        ...oauth,
        accessToken,
        refreshToken: str(body.refresh_token) ?? refreshToken,
        expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      };
      try {
        this.writeSlot("claude", { ...slot, credentials: { ...slot.credentials, claudeAiOauth: updated }, savedAt: Date.now() });
      } catch (err: any) {
        console.error("[accounts] refreshed slot write failed:", err?.message ?? err);
      }
      return accessToken;
    } finally {
      this.refreshing.delete(slot.id);
    }
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
      // The CLI owns (and refreshes) the live token; it just hasn't yet.
      if (active) return `Session expired — it refreshes the next time ${CLI[harness]} runs`;
      // Codex slots aren't refreshed in the background (their refresh tokens rotate); a switch refreshes on the next run.
      return harness === "codex" ? "Session expired — switch to it to refresh" : "Signed out — sign in again";
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

/** The slot's account login with the machine's live shared fields (MCP/plugin OAuth), present or absent alike. */
function composeClaudeCredentials(target: Json, live: Json | null): Json {
  if (!live || !target.claudeAiOauth) return target;
  const out: Json = {};
  for (const [k, v] of Object.entries(target)) if (!CLAUDE_SHARED_KEYS.includes(k)) out[k] = v;
  for (const k of CLAUDE_SHARED_KEYS) if (k in live) out[k] = live[k];
  return out;
}

/** "Max 20×" from Claude's organization type and rate-limit tier. */
function claudePlan(orgType: string | null, tier: string | null): string | null {
  const base = ({ claude_max: "Max", claude_pro: "Pro", claude_team: "Team", claude_enterprise: "Enterprise" } as Json)[orgType ?? ""];
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
const randomToken = () => randomBytes(32).toString("base64url");
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

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
