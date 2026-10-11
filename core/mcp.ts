// MCP servers per project (Ctrl+K → MCP servers): every server any harness defines for a project folder, and each
// harness's switch for it. A harness runs what its own config has; bismuth can switch those off (or on), and can carry
// a server another harness defines over to it by passing the definition to each run: Claude's --mcp-config, Codex's
// thread config `mcp_servers.<name>`, Cursor's inline mcpServers. Switches are bismuth's own
// (.bismuth/mcp-overrides.json), set for one project or all; the CLIs' config files stay untouched.
//
// The exception is a server Cursor's own config has: its SDK has no per-run filter short of dropping every user
// setting (hooks, skills, rules with it), so that switch is Cursor's per-project list
// (~/.cursor/projects/<slug>/mcp-disabled.json), the one its CLI's /mcp disable writes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessId, McpScope, McpServer, McpStatus, McpUse } from "../shared/model";

/** A server's definition, whichever harness's config it came from. */
export type McpDef =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string | null }
  | { transport: "http" | "sse"; url: string; headers: Record<string, string> };

/** A server as one harness's own config has it. `def` is null when bismuth can't read one to carry over. `dormant`: defined where bismuth doesn't load it on its own (a project's
 *  .cursor/mcp.json): only a switch turned on brings it in, passed like a server carried over. */
export type McpNative = { name: string; source: string; def: McpDef | null; configured: boolean; locked: string | null; dormant?: true };
/** A harness's servers for a project, and how the ones it ran there were doing (carried ones too). */
export type McpListing = { natives: McpNative[]; status: Record<string, { status: McpStatus | null; tools: number | null }> };
/** A server bismuth itself serves to every run (core/views.ts): on unless switched off. */
export type McpBuiltin = { name: string; source: string; target: string };
/** What a harness's runs in a project get: its own servers forced off or on, and the ones carried over. */
export type McpPlan = { off: string[]; on: string[]; add: Record<string, McpDef> };

const ORDER: HarnessId[] = ["claude", "codex", "cursor"];
const NAMES: Record<HarnessId, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

// ---------------- switches ----------------

const ALL = "*";
type Stored = Record<string, Partial<Record<HarnessId, Record<string, boolean>>>>; // project folder or "*" → harness → name → on

export class McpOverrides {
  private file: string;
  private stored: Stored;

  constructor(stateDir: string) {
    this.file = join(stateDir, "mcp-overrides.json");
    this.stored = readJson(this.file) ?? {};
  }

  /** A harness's switches in a project: the project's own over the ones for all projects. */
  get = (cwd: string, h: HarnessId): Record<string, boolean> => ({ ...this.stored[ALL]?.[h], ...this.stored[cwd]?.[h] });

  private lookup(cwd: string, h: HarnessId, name: string): { value: boolean; scope: McpScope } | null {
    const project = this.stored[cwd]?.[h]?.[name];
    if (project !== undefined) return { value: project, scope: "project" };
    const all = this.stored[ALL]?.[h]?.[name];
    return all !== undefined ? { value: all, scope: "all" } : null;
  }

  /** `base`: what the harness does without bismuth. A switch that matches what it would be anyway is dropped; one for
   *  all projects clears this project's own. */
  set(cwd: string, h: HarnessId, name: string, enabled: boolean, scope: McpScope, base: boolean) {
    if (scope === "all") {
      this.put(ALL, h, name, enabled === base ? undefined : enabled);
      this.put(cwd, h, name, undefined);
    } else {
      const inherited = this.stored[ALL]?.[h]?.[name] ?? base;
      this.put(cwd, h, name, enabled === inherited ? undefined : enabled);
    }
    writeFileSync(this.file, JSON.stringify(this.stored, null, 2));
  }

  private put(key: string, h: HarnessId, name: string, value: boolean | undefined) {
    const at = (this.stored[key] ??= {});
    const mine = (at[h] ??= {});
    if (value === undefined) delete mine[name];
    else mine[name] = value;
    if (!Object.keys(mine).length) delete at[h];
    if (!Object.keys(at).length) delete this.stored[key];
  }

  /** Whether `h`'s runs in the project get a built-in server: unless it's switched off. */
  builtinOn = (cwd: string, h: HarnessId, name: string) => this.get(cwd, h)[name] !== false;

  /** The table the UI shows: one row per server name, one use per available harness; bismuth's own servers first. */
  table(cwd: string, harnesses: HarnessId[], listings: Partial<Record<HarnessId, McpListing>>, builtins: McpBuiltin[] = []): McpServer[] {
    const own: McpServer[] = builtins.map((b) => ({
      name: b.name,
      from: "bismuth",
      source: b.source,
      target: b.target,
      uses: Object.fromEntries(
        harnesses.map((h) => {
          const override = this.lookup(cwd, h, b.name);
          const enabled = override?.value ?? true;
          const live = listings[h]?.status[b.name];
          return [h, { native: false, enabled, scope: override?.scope ?? null, locked: null, status: enabled ? (live?.status ?? null) : null, tools: enabled ? (live?.tools ?? null) : null }];
        }),
      ),
    }));
    const names = new Set(builtins.map((b) => b.name));
    return [...own, ...this.harnessTable(cwd, harnesses, listings).filter((s) => !names.has(s.name))];
  }

  private harnessTable(cwd: string, harnesses: HarnessId[], listings: Partial<Record<HarnessId, McpListing>>): McpServer[] {
    const rows = new Map<string, { from: HarnessId; native: McpNative; def: McpDef | null }>();
    for (const { h, n } of definitions(listings)) {
      const row = rows.get(n.name);
      if (!row) rows.set(n.name, { from: h, native: n, def: n.def });
      else row.def ??= n.def;
    }
    return [...rows].map(([name, { from, native, def }]) => {
      const uses: Partial<Record<HarnessId, McpUse>> = {};
      for (const h of harnesses) {
        const own = listings[h]?.natives.find((n) => n.name === name && !n.dormant);
        const override = this.lookup(cwd, h, name);
        const live = listings[h]?.status[name];
        let use: Omit<McpUse, "status" | "tools">;
        if (own) {
          // Cursor's own servers switch in Cursor's list, never bismuth's.
          const ours = !own.locked && h !== "cursor" ? override : null;
          use = { native: true, enabled: ours?.value ?? own.configured, scope: ours?.scope ?? null, locked: own.locked };
        } else {
          const locked = carryLock(h, name, def, from);
          use = { native: false, enabled: !locked && !!override?.value, scope: locked ? null : (override?.scope ?? null), locked };
        }
        uses[h] = { ...use, status: use.enabled ? (live?.status ?? null) : null, tools: use.enabled ? (live?.tools ?? null) : null };
      }
      return { name, from, source: native.source, target: target(def), uses };
    });
  }

  /** What `h`'s runs in the project get (Cursor's own servers aside: Cursor's list switches those). */
  plan(cwd: string, h: HarnessId, listings: Partial<Record<HarnessId, McpListing>>): McpPlan {
    const plan: McpPlan = { off: [], on: [], add: {} };
    const own = new Map((listings[h]?.natives ?? []).filter((n) => !n.dormant).map((n) => [n.name, n]));
    for (const [name, on] of Object.entries(this.get(cwd, h))) {
      const native = own.get(name);
      if (native) {
        if (!native.locked && h !== "cursor" && on !== native.configured) plan[on ? "on" : "off"].push(name);
        continue;
      }
      if (!on) continue;
      const found = definitions(listings).find(({ n }) => n.name === name && n.def);
      if (found && !carryLock(h, name, found.n.def, found.h)) plan.add[name] = found.n.def!;
    }
    return plan;
  }
}

/** Every definition, in the order a server's row takes its source and definition from: the ones a harness loads
 *  first (by harness), then the dormant ones. */
function definitions(listings: Partial<Record<HarnessId, McpListing>>): { h: HarnessId; n: McpNative }[] {
  const all = ORDER.flatMap((h) => (listings[h]?.natives ?? []).map((n) => ({ h, n })));
  return [...all.filter((x) => !x.n.dormant), ...all.filter((x) => x.n.dormant)];
}

/** Why a server another harness defines can't be carried over to `h`, if it can't. */
function carryLock(h: HarnessId, name: string, def: McpDef | null, from: HarnessId): string | null {
  if (!def) return `Only ${NAMES[from]} can run it: bismuth can't read its definition to carry over`;
  if (h === "codex" && def.transport === "sse") return "Codex can't connect to SSE servers";
  if (h === "codex" && name.includes(".")) return "Codex can't take a server whose name has a dot";
  return null;
}

/** The command a server runs or the URL it talks to, without what's likely a credential. */
function target(def: McpDef | null): string | null {
  if (!def) return null;
  if (def.transport === "stdio") {
    const args = def.args;
    const secret = /token|key|secret|password|auth|bearer/i;
    const shown = args.map((a, i) => (i > 0 && secret.test(args[i - 1]) && args[i - 1].startsWith("-") ? "•••" : a.replace(/^([^=]*(?:token|key|secret|password)[^=]*=).+$/i, "$1•••")));
    return [def.command, ...shown].join(" ");
  }
  try {
    const u = new URL(def.url);
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

// ---------------- definitions ----------------

const strings = (v: unknown): Record<string, string> =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => [k, String(x)])) : {};

/** A definition in the shape Claude Code and Cursor share (`type`, command or url, `headers`). */
function fromJson(config: any, expand: (s: string) => string = (s) => s): McpDef | null {
  if (typeof config?.command === "string") {
    const env = strings(config.env);
    return {
      transport: "stdio",
      command: expand(config.command),
      args: Array.isArray(config.args) ? config.args.map((a: unknown) => expand(String(a))) : [],
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expand(v)])),
      cwd: typeof config.cwd === "string" ? config.cwd : null,
    };
  }
  const url = typeof config?.url === "string" ? config.url : typeof config?.serverUrl === "string" ? config.serverUrl : null;
  if (!url) return null;
  const headers = strings(config.headers);
  return { transport: config.type === "sse" ? "sse" : "http", url: expand(url), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, expand(v)])) };
}

/** Claude's ${VAR} and ${VAR:-default} in .mcp.json, as Claude expands them. */
const expandClaude = (s: string) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => process.env[name] ?? fallback ?? "");

/** Codex's server table: stdio, or streamable HTTP with its headers (static, from env vars, a bearer token's var). */
export function fromCodex(config: any): McpDef | null {
  if (typeof config?.command === "string") {
    const env = strings(config.env);
    for (const name of Array.isArray(config.env_vars) ? config.env_vars : []) if (process.env[name] != null && env[name] == null) env[name] = process.env[name]!;
    return { transport: "stdio", command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [], env, cwd: typeof config.cwd === "string" ? config.cwd : null };
  }
  if (typeof config?.url !== "string") return null;
  const headers = strings(config.http_headers);
  for (const [header, name] of Object.entries(strings(config.env_http_headers))) if (process.env[name] != null) headers[header] = process.env[name]!;
  if (typeof config.bearer_token_env_var === "string" && process.env[config.bearer_token_env_var]) headers.Authorization = `Bearer ${process.env[config.bearer_token_env_var]}`;
  return { transport: "http", url: config.url, headers };
}

export function toClaude(def: McpDef): object {
  return def.transport === "stdio" ? { type: "stdio", command: def.command, args: def.args, env: def.env } : { type: def.transport, url: def.url, headers: def.headers };
}

export function toCodex(def: McpDef): object {
  if (def.transport === "stdio") return { command: def.command, args: def.args, env: def.env, ...(def.cwd ? { cwd: def.cwd } : {}) };
  return { url: def.url, http_headers: def.headers };
}

export function toCursor(def: McpDef): object {
  return def.transport === "stdio"
    ? { type: "stdio", command: def.command, args: def.args, env: def.env, ...(def.cwd ? { cwd: def.cwd } : {}) }
    : { type: def.transport, url: def.url, headers: def.headers };
}

const HOME = homedir();
export const tilde = (p: string) => (p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);

// ---------------- Claude Code ----------------

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(HOME, ".claude");
const CLAUDE_JSON = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(HOME, ".claude.json");

/** A server as Claude's last run in a project reported it; `carried`: bismuth passed it in (not Claude's own). */
export type ClaudeSeen = { status: McpStatus | null; carried: boolean };

/** Claude's own status names (its init message's mcp_servers). */
export function claudeStatus(s: unknown): McpStatus | null {
  return s === "connected" ? "connected" : s === "pending" ? "starting" : s === "failed" ? "failed" : s === "needs-auth" ? "needsAuth" : s === "disabled" ? "disabled" : null;
}

/** Claude's servers for a project as its CLI scopes them (local beats project beats user). The ones only a run
 *  reports (claude.ai connectors, plugins) come with Claude itself: left out, like Codex's built-in ones, and left to
 *  run as Claude has them. `seen` gives the status of the rest, carried ones too. */
export function claudeListing(cwd: string, seen: Record<string, ClaudeSeen>): McpListing {
  const global = readJson(CLAUDE_JSON) ?? {};
  const local = global.projects?.[cwd] ?? {};
  const found = new Map<string, { source: string; config: any; project: boolean }>();
  for (const [name, config] of Object.entries<any>(global.mcpServers ?? {})) found.set(name, { source: tilde(CLAUDE_JSON), config, project: false });
  for (const [name, config] of Object.entries<any>(readJson(join(cwd, ".mcp.json"))?.mcpServers ?? {})) found.set(name, { source: ".mcp.json", config, project: true });
  for (const [name, config] of Object.entries<any>(local.mcpServers ?? {})) found.set(name, { source: `${tilde(CLAUDE_JSON)}, this project`, config, project: false });
  const off = new Set<string>(local.disabledMcpServers ?? []);
  const jsonOff = new Set<string>([...(local.disabledMcpjsonServers ?? []), ...claudeSettingsList(cwd, "disabledMcpjsonServers")]);
  const natives: McpNative[] = [...found].map(([name, f]) => {
    const configured = !off.has(name) && !(f.project && jsonOff.has(name));
    // Claude has no per-run way to bring back a server its config turned off.
    return { name, source: f.source, def: fromJson(f.config, expandClaude), configured, locked: configured ? null : "Off in Claude Code's own config (/mcp)" };
  });
  return { natives, status: Object.fromEntries(Object.entries(seen).map(([name, s]) => [name, { status: s.status, tools: null }])) };
}

/** A list setting from every settings file Claude reads for the project. */
function claudeSettingsList(cwd: string, key: string): string[] {
  const files = [join(CLAUDE_DIR, "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];
  return files.flatMap((f) => {
    const v = readJson(f)?.[key];
    return Array.isArray(v) ? v.map(String) : [];
  });
}

// ---------------- Cursor ----------------

const CURSOR_DIR = join(HOME, ".cursor");
const CURSOR_USER_MCP = join(CURSOR_DIR, "mcp.json");
/** Cursor's per-project state folder: the path's runs of other characters as single dashes. */
const cursorDisabledFile = (cwd: string) => join(CURSOR_DIR, "projects", cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), "mcp-disabled.json");

/** Cursor's servers for a project: the user's ~/.cursor/mcp.json, switched by Cursor's own per-project list, and the
 *  project's .cursor/mcp.json, which bismuth doesn't load on its own (the SDK would start its commands without
 *  asking): those are dormant, off until switched on for a harness (Cursor too), which is the asking. */
export function cursorListing(cwd: string): McpListing {
  const off = new Set<string>(readJson(cursorDisabledFile(cwd)) ?? []);
  const user = Object.entries<any>(readJson(CURSOR_USER_MCP)?.mcpServers ?? {}).map(
    ([name, config]): McpNative => ({ name, source: tilde(CURSOR_USER_MCP), def: fromJson(config), configured: !off.has(name), locked: null }),
  );
  const project = Object.entries<any>(readJson(join(cwd, ".cursor", "mcp.json"))?.mcpServers ?? {}).map(
    ([name, config]): McpNative => ({ name, source: ".cursor/mcp.json", def: fromJson(config), configured: false, locked: null, dormant: true }),
  );
  return { natives: [...user, ...project], status: {} };
}

export function setCursorServer(cwd: string, name: string, enabled: boolean) {
  const file = cursorDisabledFile(cwd);
  const saved = readJson(file);
  const off = new Set<string>(Array.isArray(saved) ? saved : []);
  if (enabled) off.delete(name);
  else off.add(name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify([...off], null, 2));
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
