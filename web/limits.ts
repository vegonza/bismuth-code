// The sidebar footer's plan limits, left of the gear: a ring per Claude Code and Codex account, the window
// nearest its limit always in sight, every window in a card on hover. The list is the one Settings → Providers shows
// (accounts.ts); turns feed it for free as they finish, and an occasional probe catches the accounts that sat idle. Cursor has no rate windows, only a month's bill.
import type { AgentAccount, HarnessId, UsageWindow } from "../shared/model";
import { accountsSnapshot, level, loadAccounts, meter, watchAccounts } from "./accounts";
import { el } from "./dom";
import { harnessIcon, HARNESS_NAMES } from "./icons";
import { isPhone } from "./phone";
import { reducedMotion } from "./motion";
import { openSettings, settingsOpen } from "./settings";
import { net, on, store } from "./store";
import { resetText, ring } from "./usage";

const SHOWN: HarnessId[] = ["claude", "codex"];
/** Re-reading the list is local (cached windows); probing asks Anthropic and OpenAI, which rate-limit it. */
const READ_EVERY = 30_000;
const PROBE_EVERY = 10 * 60_000;

let box: HTMLElement;
let painted = "";

/** Every saved Claude Code and Codex account (turns run on whichever the model picker puts them on), Codex's machine
 *  login first. */
function shownAccounts(accounts: AgentAccount[]): AgentAccount[] {
  return SHOWN.flatMap((h) => accounts.filter((a) => a.harness === h).sort((a, b) => Number(b.active) - Number(a.active)));
}

/** How much of a window is used now: one past its reset is empty. */
const used = (w: UsageWindow) => (w.resetsAt && w.resetsAt <= Date.now() ? 0 : w.usedPercent);

/** Rebuilt only when what it shows changed: the sidebar renders on every session event. */
function paint() {
  const shown = shownAccounts(accountsSnapshot()?.accounts ?? []);
  const key = JSON.stringify([shown, Math.floor(Date.now() / 60_000)]);
  if (key === painted) return;
  painted = key;
  box.replaceChildren(...shown.map(chip));
  box.hidden = !shown.length;
  if (box.hidden) closeCard();
  else card?.replaceChildren(...cardBody());
}

/** The window that limits the account now, and how full it is (0–1): the shortest one (the 5-hour session; the core
 *  lists windows shortest first), unless a longer one is close to running out (from 80%) and fuller. */
function worstOf(a: AgentAccount): { w: UsageWindow | null; f: number } {
  const [first, ...rest] = a.windows;
  const w = rest.reduce<UsageWindow | undefined>((m, x) => (used(x) >= 80 && used(x) > used(m!) ? x : m), first) ?? null;
  return { w, f: w ? Math.min(1, Math.max(0, used(w) / 100)) : 0 };
}

const nameOf = (a: AgentAccount) => a.email ?? a.displayName ?? HARNESS_NAMES[a.harness];

/** A ring round the account's initial, its harness's logo on the rim. */
function face(a: AgentAccount, f: number): HTMLElement {
  const box = el("span", "limit-face");
  const r = ring();
  r.set(f);
  box.append(r.svg, el("span", "limit-initial", nameOf(a)[0]?.toUpperCase() ?? "?"), harnessIcon(a.harness, 10, "limit-logo"));
  return box;
}

/** An account in the footer: the arc and the number are its window nearest the limit. */
function chip(a: AgentAccount): HTMLElement {
  const { w, f } = worstOf(a);
  const c = el("div", `limit-chip ${w ? level(f) : "none"}`);
  c.append(face(a, f), el("span", "limit-pct", w ? `${Math.round(f * 100)}%` : "–"));
  return c;
}

// ---------------- the hover card ----------------
// Every account's every window with its reset, over the footer while the pointer is on the chips or the card.
// It takes no focus (the composer keeps typing), and a click goes to Settings → Providers, where they're managed.

let card: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const OPEN_MS = 120;
const CLOSE_MS = 160;

function cardBody(): HTMLElement[] {
  const shown = shownAccounts(accountsSnapshot()?.accounts ?? []);
  const fetched = Math.max(0, ...shown.map((a) => a.usageFetchedAt ?? 0));
  const head = el("div", "lc-head");
  head.append(el("span", "lc-title", "Plan limits"), el("span", "lc-when", fetched ? `Updated ${ago(fetched)}` : ""));
  return [head, ...shown.map(cardAccount)];
}

function cardAccount(a: AgentAccount): HTMLElement {
  const { w, f } = worstOf(a);
  const box = el("div", `lc-account ${w ? level(f) : "none"}`);
  const top = el("div", "lc-who");
  const text = el("div", "lc-text");
  text.append(el("div", "lc-email", nameOf(a)), el("div", "lc-meta", [HARNESS_NAMES[a.harness], a.plan, a.active ? "In use" : null].filter(Boolean).join(" · ")));
  top.append(face(a, f), text);
  box.append(top);
  if (a.windows.length) {
    for (const x of a.windows) {
      const line = el("div", "lc-window");
      line.append(meter(x), el("span", "lc-reset", x.resetsAt && x.resetsAt > Date.now() ? resetText(x.resetsAt) : ""));
      box.append(line);
    }
  } else box.append(el("div", "lc-note", a.usageError ?? "Usage unavailable"));
  return box;
}

function ago(at: number) {
  const m = Math.floor((Date.now() - at) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

function openCard() {
  if (card || box.hidden) return;
  card = el("div", "card limits-card menu-in");
  card.onpointerenter = () => clearTimeout(timer);
  card.onpointerleave = () => closeSoon();
  card.onclick = () => {
    closeCard();
    openSettings("providers");
  };
  card.replaceChildren(...cardBody());
  document.body.append(card);
  const r = box.getBoundingClientRect();
  card.style.left = `${r.left}px`;
  card.style.bottom = `${innerHeight - r.top + 6}px`;
}

function closeCard() {
  clearTimeout(timer);
  const c = card;
  if (!c) return;
  card = null;
  c.classList.replace("menu-in", "menu-out");
  c.style.pointerEvents = "none";
  setTimeout(() => c.remove(), reducedMotion() ? 0 : 120);
}

function closeSoon() {
  clearTimeout(timer);
  timer = setTimeout(closeCard, CLOSE_MS);
}

export function initLimits(): HTMLElement {
  box = el("div", "footer-limits");
  box.hidden = true;
  box.onpointerenter = () => {
    clearTimeout(timer);
    if (!card) timer = setTimeout(openCard, OPEN_MS);
  };
  box.onpointerleave = () => closeSoon();
  box.onclick = () => {
    closeCard();
    openSettings("providers");
  };
  watchAccounts(paint);
  on("sidebar", paint);
  // A turn ending has just reported its account's windows to the core.
  let running = 0;
  on("sidebar", () => {
    const now = [...store.summaries.values()].filter((t) => t.status === "running").length;
    if (now < running) setTimeout(() => void loadAccounts(false), 1000);
    running = now;
  });
  let probed = 0;
  const tick = () => {
    // Settings → Providers keeps its own list fresh, and a phone has no footer.
    if (!net.open() || document.hidden || settingsOpen() || isPhone()) return;
    const probe = Date.now() - probed > PROBE_EVERY;
    if (probe) probed = Date.now();
    void loadAccounts(probe);
  };
  // The first list goes once the core is connected (its sessions arriving render the sidebar).
  on("sidebar", () => !probed && tick());
  setInterval(tick, READ_EVERY);
  // Past its reset a window reads empty: the key turns over each minute, so a repaint shows it without a reload.
  setInterval(() => !document.hidden && paint(), 60_000);
  return box;
}
