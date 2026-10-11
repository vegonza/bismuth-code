// Settings → Providers (Zeron's settings/harnesses.rs): one row per harness with its version, enable switch and
// (when missing) Install; an enabled one expands to its update policy and its Accounts (accounts.ts) — every saved
// login, switchable, plus sign-in for more. Claude Code and Codex also get their auto-compact point. A disabled provider's models leave the picker; threads already on it
// keep working.
import type { AutoCompactSnapshot, HarnessId, HarnessUpdatePolicy, HarnessUpdateStatus } from "../shared/model";
import { accountsSection } from "./accounts";
import { el, miniSpinner } from "./dom";
import { HARNESS_NAMES, harnessIcon, icon } from "./icons";
import { harnessEnabled, prefs, setPrefs } from "./prefs";
import { motionReduced } from "./theme";
import { call, store } from "./store";
import { card, errorStrip, metaLine, pageColumn, pageHeader, select, toggle } from "./widgets";

// Zeron's order: Claude Code, Codex, Cursor.
const ORDER: HarnessId[] = ["claude", "codex", "cursor"];
const CLI: Record<HarnessId, string> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };

// Update policies in menu order: the short label, and the note shown under the row title for the chosen one.
const POLICIES: [HarnessUpdatePolicy, string, string][] = [
  ["notify", "Notify", "Install only when you choose Update."],
  ["autoWhenIdle", "Auto when idle", "Install automatically after active runs finish."],
  ["off", "Off", "Don't check for new versions."],
];
const BUSY_PHASES = ["checking", "installing", "verifying", "waitingForIdle"];

const expanded = new Set<HarnessId>();
/** Rows of the rendered page, updated in place (a re-render would restart the switches and the details' entrance). */
let live: { h: HarnessId; sync: () => void }[] = [];
let updates: HarnessUpdateStatus[] = [];
let installing: HarnessId | null = null;
/** The last refused toggle, failed install or update, shown in the page's error strip. */
let pageError: string | null = null;
let errorSlot: HTMLElement | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
// The last snapshot is kept, so the row shows at once (from it, or as loading) while the core re-reads the CLIs'.
const COMPACT_KEY = "bismuth.autoCompact";
let compact: AutoCompactSnapshot | null = JSON.parse(localStorage.getItem(COMPACT_KEY) ?? "null");
const keepCompact = (c: AutoCompactSnapshot) => {
  compact = { claude: c.claude, codex: c.codex };
  localStorage.setItem(COMPACT_KEY, JSON.stringify(compact));
};
/** What the last Codex change did to its loaded sessions, until the page closes. */
let reopenNote: string | null = null;

export function renderProviders(): HTMLElement {
  const page = pageColumn();
  live = [];
  const head = pageHeader("Providers");
  head.classList.add("providers-head");
  const check = el("button", "providers-check", "Check now");
  check.onclick = () => void refreshUpdates("updates.check");
  head.append(check);
  errorSlot = el("div", "providers-error");
  page.append(head, errorSlot, card(...ORDER.map(providerRow)));
  paintError();
  void refreshUpdates("updates.list");
  reopenNote = null;
  void call("autoCompact.get", {}).then((c) => (keepCompact(c), syncProviders()), () => {});
  return page;
}

/** Install state, versions and accounts arrive from the core; fold them into the open page. */
export function syncProviders() {
  live = live.filter((r) => r.sync());
}

function paintError() {
  errorSlot?.replaceChildren(...(pageError ? [errorStrip(pageError)] : []));
  if (errorSlot) errorSlot.onclick = () => ((pageError = null), paintError());
}

/** Statuses, then a poll while any check or update is in flight (and the page is open). */
async function refreshUpdates(method: "updates.list" | "updates.check") {
  try {
    updates = await call(method, {});
  } catch {
    return;
  }
  syncProviders();
  if (pollTimer) clearTimeout(pollTimer);
  if (live.length && updates.some((u) => BUSY_PHASES.includes(u.phase))) pollTimer = setTimeout(() => void refreshUpdates("updates.list"), 1500);
}

async function applyUpdate(h: HarnessId) {
  updates = updates.map((u) => (u.harness === h ? { ...u, phase: "installing" } : u));
  syncProviders();
  const poll = setTimeout(() => void refreshUpdates("updates.list"), 1500);
  try {
    updates = await call("updates.apply", { harness: h });
  } catch (err: any) {
    pageError = `Update failed — ${err.message}`;
    paintError();
  }
  clearTimeout(poll);
  syncProviders();
}

async function install(h: HarnessId) {
  installing = h;
  syncProviders();
  try {
    await call("harness.install", { harness: h });
  } catch (err: any) {
    pageError = err.message;
    paintError();
  }
  installing = null;
  syncProviders();
  void refreshUpdates("updates.list");
}

/** The version line (Zeron's `harness_update_label`) and its tone. */
function versionLabel(s: HarnessUpdateStatus): [string, string] | null {
  // Date-stamped builds (cursor-agent's 2026.10.01-e373342) read by their date.
  const v = s.installedVersion ? `v${s.installedVersion.replace(/^(\d{4}\.\d{2}\.\d{2})-\w+$/, "$1")}` : "Version unavailable";
  switch (s.phase) {
    case "dormant":
      return ["Update monitoring off", ""];
    case "checking":
      return ["Checking for updates…", ""];
    case "current":
      return [`${v} · Up to date`, ""];
    case "available": {
      const label = `${v} · ${s.latestVersion ? `v${s.latestVersion}` : "Update"} available`;
      return [s.manualCommand ? `${label} · ${s.manualCommand}` : label, "accent"];
    }
    case "manual":
      // No release feed (Cursor's agent updates itself): just the version.
      return [v, ""];
    case "waitingForIdle":
      return [`${v} · Waiting for agent to be idle`, ""];
    case "installing":
      return [`${v} · Installing…`, ""];
    case "verifying":
      return ["Verifying updated CLI…", ""];
    case "updated":
      return [`${v} · Updated`, "success"];
    case "failed":
      return [s.error ?? "Update check failed", "danger"];
    case "notInstalled":
      return null;
  }
}

function providerRow(h: HarnessId): HTMLElement {
  const wrap = el("div", "s-row-wrap");
  const r = el("div", "s-row provider");
  const trigger = el("button", "provider-trigger");
  trigger.setAttribute("aria-label", `${HARNESS_NAMES[h]} preferences`);
  const tile = el("span", "brand-tile");
  tile.append(harnessIcon(h));
  const text = el("div", "s-row-text");
  const hint = el("span", "install-hint", `Install the ${CLI[h]} CLI to enable`);
  text.append(el("div", "s-row-title", HARNESS_NAMES[h]));
  const meta = el("div", "provider-meta");
  text.append(meta);
  // The row's one update action sits inside the trigger before the chevron, so its appearing never moves it.
  const updateSlot = el("span", "provider-update");
  const chev = el("span", "provider-chev");
  trigger.append(tile, text, updateSlot, chev);
  const installBtn = el("button", "s-action filled provider-install", "Install");
  installBtn.onclick = () => void install(h);
  trigger.onclick = () => {
    if (expanded.has(h)) expanded.delete(h);
    else expanded.add(h);
    syncProviders();
  };

  const sw = toggle(harnessEnabled(h), `Enable ${HARNESS_NAMES[h]}`, (next) => {
    if (!next) expanded.delete(h);
    setPrefs({ harnesses: { ...prefs.harnesses, [h]: next } });
    syncProviders();
  });
  r.append(trigger, installBtn, sw);
  wrap.append(r);

  let box: HTMLElement | null = null;
  const sync = () => {
    const info = store.harnesses.find((x) => x.id === h);
    const installed = info?.available ?? false;
    const enabled = harnessEnabled(h);
    const open = enabled && expanded.has(h);
    // Zeron: switching off is never blocked by a missing CLI, switching on is; the last enabled one stays on.
    const last = enabled && !ORDER.some((x) => x !== h && harnessEnabled(x));
    // Missing entirely reads as an install hint; any other start failure (sign-in, SDK install) says what failed.
    const missing = !installed && (!info?.error || /not installed/i.test(info.error));
    r.classList.toggle("missing", !installed && installing !== h);
    const parts: (string | Node)[] = [];
    // Installing replaces the hint in place, so the row's text never shifts while it runs.
    if (installing === h) {
      const busy = el("span", "provider-installing");
      busy.append(miniSpinner(), `Installing ${HARNESS_NAMES[h]}…`);
      parts.push(busy);
    } else if (!installed) {
      hint.textContent = !missing ? info!.error!.split("\n")[0] : enabled ? `${CLI[h]} CLI not installed — turn it off or install it` : `Install the ${CLI[h]} CLI to enable`;
      hint.title = info?.error ?? "";
      parts.push(hint);
    }
    const status = updates.find((u) => u.harness === h);
    const version = status && versionLabel(status);
    if (version) parts.push(el("span", `provider-version ${version[1]}`, version[0]));
    // How bismuth drives Cursor (Zeron's note): its SDK, not the CLI.
    if (h === "cursor") parts.push(el("span", "provider-note", "Cursor SDK · Managed by bismuth"));
    meta.replaceChildren(...(parts.length ? [metaLine(parts)] : []));
    installBtn.hidden = !missing || installing === h;
    installBtn.disabled = !!installing;
    updateSlot.replaceChildren();
    if (status?.canApply && (status.phase === "available" || status.phase === "failed")) {
      const b = el("span", "provider-update-btn primary", "Update");
      b.setAttribute("role", "button");
      b.onclick = (e) => {
        e.stopPropagation(); // inside the details trigger: act, don't expand
        void applyUpdate(h);
      };
      updateSlot.append(b);
    }
    trigger.disabled = !enabled;
    trigger.setAttribute("aria-expanded", String(open));
    chev.replaceChildren(...(enabled ? [icon(open ? "chevronDown" : "chevronRight")] : []));
    sw.disabled = last || (!enabled && !installed);
    sw.title = last ? "At least one provider stays enabled" : "";
    sw.firstElementChild!.classList.toggle("on", enabled);
    sw.setAttribute("aria-checked", String(enabled));
    if (open && !box) {
      box = el("div", "provider-details");
      box.append(updatesSection(h), compactSection(h), accountsSection(h));
      // Entrance only on opening; account updates repaint inside without replaying it.
      if (!motionReduced()) box.classList.add("menu-in-down");
      wrap.append(box);
    } else if (!open && box) {
      box.remove();
      box = null;
    }
  };
  live.push({
    h,
    sync: () => wrap.isConnected && (sync(), box?.querySelector(".updates-section")?.replaceWith(updatesSection(h)), compactPainters.get(h)?.(), true),
  });
  sync();
  return wrap;
}

/** The expanded provider's Updates: the policy, short labels in the menu and the chosen one explained. */
function updatesSection(h: HarnessId): HTMLElement {
  const box = el("div", "updates-section");
  const status = updates.find((u) => u.harness === h);
  if (!status) return box;
  const selected = Math.max(0, POLICIES.findIndex(([p]) => p === status.policy));
  const row = el("div", "updates-row");
  const text = el("div", "s-row-text");
  text.append(el("div", "s-row-title", "Update policy"), metaLine([POLICIES[selected][2]]));
  row.append(
    text,
    select({
      options: POLICIES.map(([, label]) => ({ label })),
      selected,
      // Fits the longest label, so switching never resizes the trigger.
      width: 136,
      onSelect: async (i) => {
        try {
          updates = await call("updates.policy", { harness: h, policy: POLICIES[i][0] });
        } catch (err: any) {
          pageError = err.message;
          paintError();
        }
        syncProviders();
        void refreshUpdates("updates.list");
      },
    }),
  );
  box.append(el("div", "details-label", "Updates"), row);
  return box;
}

// ---------------- auto-compact ----------------

// Claude Code takes 100K–1M (its autoCompactWindow); Codex any limit, but below 10K it would compact every turn.
const COMPACT_RANGE: Record<"claude" | "codex", [number, number]> = { claude: [100_000, 1_000_000], codex: [10_000, 10_000_000] };

const tokens = (n: number) => n.toLocaleString("en-US");

/** "300000", "300,000", "300k", "1.5m" → tokens; "" → null (follow the CLI); anything else → NaN. */
function parseTokens(raw: string): number | null {
  const t = raw.trim().toLowerCase().replace(/[,_\s]/g, "");
  if (!t) return null;
  const m = t.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return NaN;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1));
}

/** Repaints of each provider's auto-compact row (built once, updated in place so typing is never disturbed). */
const compactPainters = new Map<HarnessId, () => void>();

/** Where sessions compact (and so what the composer's context ring counts toward). The field shows what applies:
 *  the CLI's own configured value, or bismuth's override of it. Typing a different number overrides it (saved on
 *  Enter or leaving the field); Reset, clearing it or typing the configured value goes back to the CLI's. */
function compactSection(h: HarnessId): HTMLElement {
  const box = el("div", "compact-section");
  if (h !== "claude" && h !== "codex") return box;
  const cli = h === "claude" ? "Claude" : "Codex";
  const [min, max] = COMPACT_RANGE[h];
  const title = el("div", "s-row-title", "Auto-compact at");
  const note = el("div", "compact-note");
  const effectLine = el("div", "compact-effect");
  const text = el("div", "s-row-text");
  text.append(title, note, effectLine);
  const input = el("input", "compact-input");
  input.inputMode = "numeric";
  input.spellcheck = false;
  input.setAttribute("aria-label", `${cli} auto-compact tokens`);
  const reset = el("button", "compact-reset", "Reset");
  reset.title = `Back to ${cli}'s own setting`;
  const controls = el("div", "compact-controls");
  controls.append(reset, input);
  const row = el("div", "updates-row");
  row.append(text, controls);
  box.append(el("div", "details-label", "Context"), row);

  let error: string | null = null;
  let saving = false;
  const shown = () => {
    const info = compact?.[h];
    const v = info?.value ?? info?.inherited ?? null;
    return v ? tokens(v) : "";
  };
  const paint = () => {
    const info = compact?.[h];
    input.disabled = reset.hidden = !info;
    if (!info) {
      note.textContent = `Reading ${cli}'s setting…`;
      input.placeholder = "Loading…";
      effectLine.textContent = "";
      return;
    }
    // A file or variable it comes from, or a sentence about the CLI's default.
    const from = /^[~/]|^[A-Z_]+$/.test(info.inheritedFrom) ? `From ${info.inheritedFrom}.` : `${info.inheritedFrom}.`;
    note.textContent = info.value
      ? `Overrides ${cli}'s ${info.inherited ? tokens(info.inherited) : "default"} for sessions run here; ${cli}'s config is untouched.`
      : from;
    reset.hidden = !info.value;
    input.placeholder = info.inherited ? tokens(info.inherited) : "Model window";
    if (document.activeElement !== input) input.value = shown();
    input.classList.toggle("overridden", !!info.value);
    input.classList.toggle("invalid", !!error);
    // Claude starts a process per turn, so the next turn simply uses it. Codex fixes it when a session loads.
    const effect = error ?? (h === "codex" ? (reopenNote ?? "Changing it reopens your open Codex sessions to apply it. Their history is kept; one mid-turn reopens when its turn ends.") : "Applies from each session's next turn.");
    effectLine.textContent = effect;
    effectLine.className = `compact-effect${error ? " error" : h === "codex" && !reopenNote ? " warn" : ""}`;
  };
  const save = async (value: number | null) => {
    saving = true;
    try {
      const res = await call("autoCompact.set", { harness: h, value });
      keepCompact(res);
      if (res.reopened) reopenNote = reopenSummary(res.reopened);
    } catch (err: any) {
      error = err.message;
    }
    saving = false;
    paint();
  };
  const commit = () => {
    const info = compact?.[h];
    if (!info || saving) return;
    const parsed = parseTokens(input.value);
    if (parsed !== null && Number.isNaN(parsed)) return ((error = "Enter a number of tokens, like 300000 or 300k."), paint());
    // Empty, or the value the CLI already has: no override.
    const next = parsed === null || parsed === info.inherited ? null : parsed;
    if (next !== null && (next < min || next > max)) return ((error = `${cli} compacts between ${tokens(min)} and ${tokens(max)} tokens.`), paint());
    error = null;
    if (next === info.value) return ((input.value = shown()), paint());
    void save(next);
  };
  input.oninput = () => {
    if (error) ((error = null), paint());
  };
  // Leaving the field is the one place a change is saved; Enter and Escape just leave it.
  input.onkeydown = (e) => {
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
      input.value = shown();
      error = null;
      input.blur();
    }
  };
  input.onblur = commit;
  reset.onclick = () => {
    error = null;
    void save(null);
  };
  compactPainters.set(h, paint);
  paint();
  return box;
}

function reopenSummary({ now, afterTurn }: { now: number; afterTurn: number }): string {
  const n = (k: number) => `${k} session${k === 1 ? "" : "s"}`;
  if (!now && !afterTurn) return "No open Codex sessions needed reopening; new ones start with it.";
  const parts = [...(now ? [`Reopened ${n(now)}`] : []), ...(afterTurn ? [`${n(afterTurn)} will reopen when ${afterTurn === 1 ? "its turn ends" : "their turns end"}`] : [])];
  const text = parts.join("; ");
  return `${text[0].toUpperCase()}${text.slice(1)}. History is kept.`;
}
