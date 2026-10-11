// Auto-compaction: where a session's context gets compacted, which is what its context ring measures against
// (a 1M-token model set to compact at 500K is full at 500K). Settings → Providers can override the point per harness
// (t3code's "Auto-compact after"); bismuth then passes it to each run (Claude's --settings, Codex's thread config)
// and the CLIs' own config files stay untouched. Unset, each CLI's own config decides, resolved here as the CLI does.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoCompactInfo, AutoCompactSnapshot } from "../shared/model";

export type CompactHarness = "claude" | "codex";
type Stored = Partial<Record<CompactHarness, number | null>>;

/** Claude Code accepts 100,000 to 1,000,000 (its autoCompactWindow). */
export const CLAUDE_RANGE = [100_000, 1_000_000] as const;
/** Codex compacts at 90% of the model's raw window by default; it reports 95% of that window as usable. */
const CODEX_DEFAULT_SHARE = 0.9;
const CODEX_REPORTED_SHARE = 0.95;

export class AutoCompact {
  private file: string;
  private stored: Stored;

  constructor(stateDir: string) {
    this.file = join(stateDir, "auto-compact.json");
    this.stored = readJson(this.file) ?? {};
  }

  /** bismuth's override for a harness, or null to follow the CLI's own config. */
  get = (h: CompactHarness) => this.stored[h] ?? null;

  set(h: CompactHarness, value: number | null) {
    if (value != null) {
      if (!Number.isInteger(value) || value <= 0) throw new Error("Auto-compact must be a whole number of tokens");
      if (h === "claude" && (value < CLAUDE_RANGE[0] || value > CLAUDE_RANGE[1])) throw new Error("Claude Code compacts between 100,000 and 1,000,000 tokens");
    }
    this.stored[h] = value;
    writeFileSync(this.file, JSON.stringify(this.stored, null, 2));
  }

  snapshot(codexDefault: { configLimit: number | null; limit: number | null; model: string | null; window: number | null }): AutoCompactSnapshot {
    const claude = claudeConfigured(null, null);
    const codex: AutoCompactInfo = {
      value: this.get("codex"),
      inherited: codexDefault.limit,
      inheritedFrom: codexDefault.configLimit
        ? "~/.codex/config.toml"
        : codexDefault.window
          ? `Codex's default for ${codexDefault.model}: 90% of its ${codexDefault.window.toLocaleString("en-US")}-token window`
          : "Codex's default: 90% of the model's window",
    };
    return {
      claude: { value: this.get("claude"), inherited: claude?.window ?? null, inheritedFrom: claude?.from ?? "Claude Code's default: the model's window" },
      codex,
    };
  }
}

// ---------------- Claude Code ----------------

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Claude's own window setting as its CLI resolves it (env, then settings files; a per-model entry beats the
 *  file's top-level one, and a later file's top-level value replaces everything before it). */
function claudeConfigured(model: string | null, cwd: string | null): { window: number; from: string } | null {
  const env = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (env > 0) return { window: Math.max(CLAUDE_RANGE[0], env), from: "CLAUDE_CODE_AUTO_COMPACT_WINDOW" };
  const files: [string, string][] = [[join(claudeDir(), "settings.json"), "~/.claude/settings.json"]];
  if (cwd) files.push([join(cwd, ".claude", "settings.json"), ".claude/settings.json"], [join(cwd, ".claude", "settings.local.json"), ".claude/settings.local.json"]);
  let top: { value: unknown; from: string } | null = null;
  let byModel: Record<string, { value: unknown; from: string }> = {};
  for (const [file, from] of files) {
    const s = readJson(file);
    if (!s) continue;
    const mine: typeof byModel = {};
    for (const [key, v] of Object.entries<any>(s.modelSettings ?? {})) if (v?.autoCompactWindow !== undefined) mine[canonical(key)] = { value: v.autoCompactWindow, from };
    if (s.autoCompactWindow === undefined) byModel = { ...byModel, ...mine };
    else (top = { value: s.autoCompactWindow, from }), (byModel = mine);
  }
  const pick = (model && byModel[canonical(model)]) || top;
  return pick && typeof pick.value === "number" ? { window: pick.value, from: pick.from } : null;
}

/** "claude-opus-5-5[1m]" and dated spellings key the same model settings. */
const canonical = (model: string) => model.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");

function claudeAutoCompactOff(): boolean {
  if (process.env.DISABLE_AUTO_COMPACT || process.env.DISABLE_COMPACT) return true;
  const global = readJson(join(homedir(), ".claude.json"));
  return global?.autoCompactEnabled === false;
}

/** Where a Claude session compacts: the override or Claude's own setting, never past the model's window. */
export function claudeCompactAt(override: number | null, model: string | null, modelWindow: number | null, cwd: string): number | null {
  if (claudeAutoCompactOff()) return null;
  const window = override ?? claudeConfigured(model, cwd)?.window ?? null;
  if (window == null) return modelWindow;
  return modelWindow ? Math.min(modelWindow, window) : window;
}

// ---------------- Codex ----------------

/** Where a Codex session compacts: the limit it was started or resumed with, else its config's, else 90% of the
 *  model's window (`reportedWindow` is the 95% Codex reports as usable). */
export function codexCompactAt(applied: number | null, configLimit: number | null, reportedWindow: number | null): number | null {
  const limit = applied ?? configLimit ?? (reportedWindow ? Math.round((reportedWindow / CODEX_REPORTED_SHARE) * CODEX_DEFAULT_SHARE) : null);
  return limit != null && reportedWindow ? Math.min(limit, reportedWindow) : limit;
}

function readJson(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
