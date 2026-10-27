// A provider's Accounts (Zeron's settings/accounts.rs, embedded in an expanded Providers row): every saved login
// of that CLI with usage meters, a ⋯ menu (Remove), and the one sign-in dialog every provider shares. Which one a
// turn runs on is the model picker's choice, not this page's; Codex's machine login (switched when a turn picks
// another) is ringed and "In use". The list is cached across visits and revalidated in place; removals are
// optimistic, and the core's reply (the fresh list) replaces them.
import type { AgentAccount, AgentAccountsSnapshot, HarnessId, UsageWindow } from "../shared/model";
import { el, miniSpinner } from "./dom";
import { HARNESS_NAMES, icon } from "./icons";
import { contextMenu, menuPoint, type MenuItem, type Popover } from "./popover";
import { call } from "./store";
import { resetText } from "./usage";
import { action, errorStrip, metaLine } from "./widgets";

const WARN = 0.8;
const CRITICAL = 0.95;
export const level = (f: number) => (f >= CRITICAL ? "critical" : f >= WARN ? "warn" : "normal");

/** What the sign-in dialog says while the browser finishes — one sentence per provider. */
const LOGIN_COPY: Record<HarnessId, string> = {
  claude: "Finish signing in to Claude in your browser. The account is saved in bismuth for the model picker; Claude Code's own login is untouched.",
  codex: "Finish signing in to ChatGPT in your browser. The account is saved next to Codex's current one; picking it in the model picker switches Codex to it.",
  cursor: "Finish signing in to Cursor in your browser. This mints a bismuth-named API key you can revoke any time from Cursor's dashboard.",
};

let snapshot: AgentAccountsSnapshot | null = null;
let loadError: string | null = null;
/** A list is in flight over painted rows. */
let refreshing = false;
/** The last Remove refusal or failed revalidation, shown until dismissed. */
let actionError: string | null = null;
let lastForced = 0;
let generation = 0;
const views = new Set<{ h: HarnessId; box: HTMLElement }>();
/** Others showing the accounts (the sidebar's limits, limits.ts), told whenever the list changes. */
const watchers = new Set<() => void>();
export const accountsSnapshot = () => snapshot;
export const watchAccounts = (fn: () => void) => void watchers.add(fn);
export const loadAccounts = (force: boolean) => load(force);

/** The Accounts block for one provider; the first one mounted in a while asks for fresh usage. */
export function accountsSection(h: HarnessId): HTMLElement {
  const box = el("div", "accounts");
  const view = { h, box };
  views.add(view);
  paintView(view);
  // Mount forces a usage probe (the core skips accounts probed in the last 30s anyway).
  if (Date.now() - lastForced > 30_000) void load(true);
  return box;
}

async function load(force: boolean) {
  const gen = ++generation;
  if (force) lastForced = Date.now();
  refreshing = true;
  repaint();
  // No rows yet: paint the plain (offline-fast) list first, then the probed one.
  if (force && !snapshot) {
    try {
      const plain = await call("accounts.list", { forceUsage: false });
      if (gen === generation) snapshot = plain;
      loadError = null;
      repaint();
    } catch {}
  }
  try {
    const next = await call("accounts.list", { forceUsage: force });
    if (gen !== generation) return;
    snapshot = next;
    loadError = null;
  } catch (err: any) {
    if (gen !== generation) return;
    // A failed revalidation keeps the painted rows.
    if (snapshot) actionError = err.message;
    else loadError = err.message;
  }
  refreshing = false;
  repaint();
}

function repaint() {
  watchers.forEach((fn) => fn());
  for (const v of [...views]) {
    // A section that was on the page and left it (page closed, row collapsed) is done; one not attached yet isn't.
    if (v.box.isConnected) v.box.dataset.attached = "1";
    else if (v.box.dataset.attached) {
      views.delete(v);
      continue;
    }
    paintView(v);
  }
}

function paintView(v: { h: HarnessId; box: HTMLElement }) {
  const label = el("div", "details-label");
  const left = el("span", "details-left");
  left.append(el("span", "", "Accounts"));
  if (refreshing && snapshot) left.append(miniSpinner());
  const refresh = el("button", "s-icon-btn accounts-refresh");
  refresh.title = "Refresh usage";
  refresh.setAttribute("aria-label", "Refresh accounts");
  refresh.classList.toggle("busy", refreshing);
  refresh.append(icon("refreshCw"));
  refresh.onclick = () => void load(true);
  label.append(left, refresh);
  const parts: HTMLElement[] = [label];
  if (actionError) {
    const strip = errorStrip(actionError);
    strip.classList.add("accounts-strip", "dismissable");
    strip.title = "Dismiss";
    strip.onclick = () => {
      actionError = null;
      repaint();
    };
    parts.push(strip);
  }
  for (const w of snapshot?.warnings.filter((w) => w.harness === v.h) ?? []) {
    const strip = el("div", "s-warning accounts-strip");
    strip.append(icon("triangleAlert"), el("span", "", w.message));
    parts.push(strip);
  }
  if (snapshot) parts.push(list(v.h, snapshot));
  else if (loadError) {
    const strip = errorStrip(loadError);
    strip.classList.add("accounts-strip", "dismissable");
    strip.append(el("span", "grow"), el("span", "retry", "Retry"));
    strip.onclick = () => void load(true);
    parts.push(strip);
  } else parts.push(skeleton());
  v.box.replaceChildren(...parts);
}

function list(h: HarnessId, s: AgentAccountsSnapshot): HTMLElement {
  const box = el("div", "account-list");
  const rows = s.accounts.filter((a) => a.harness === h);
  rows.forEach((a) => box.append(accountRow(a)));
  // Adding is the list's last row, where the next account will appear.
  const add = el("div", `account-add${rows.length ? " divided" : ""}`);
  add.append(action(rows.length ? "Add account" : `Connect a ${HARNESS_NAMES[h]} account`, "quiet", () => startLogin(h), "plus"));
  box.append(add);
  return box;
}

/**
 * One account: Codex's machine login's avatar wears the accent ring and its meta reads "In use". Every row ends in
 * the same ⋯ menu, so the trailing edge never changes shape.
 */
function accountRow(a: AgentAccount): HTMLElement {
  const email = a.email ?? a.displayName ?? "Unknown account";
  const row = el("div", "account-row");
  const avatar = el("span", `avatar${a.active ? " active" : ""}`);
  avatar.append(el("span", "disc", email[0]?.toUpperCase() ?? "?"));

  // Personal Claude orgs are named "<email>'s Organization": noise under the email itself.
  const org = a.organization && !(a.email && a.organization.startsWith(a.email)) ? a.organization : null;
  const meta: (string | Node)[] = [a.plan, org].filter((x): x is string => !!x);
  if (a.active) meta.push(el("span", "in-use", "In use"));
  // Meters XOR the reason they're missing; the reason joins the meta line so the row never changes height.
  const usage = el("div", "account-usage");
  if (a.windows.length) {
    usage.append(...a.windows.slice(0, 2).map(meter));
    usage.title = a.windows.map((w) => (w.resetsAt ? `${w.label}: ${resetText(w.resetsAt)}` : w.label)).join(" · ");
  } else meta.push(missingNote(a));
  const text = el("div", "s-row-text");
  const line = metaLine(meta);
  line.title = line.textContent ?? "";
  text.append(el("div", "s-row-title email", email), line);

  const slot = el("span", "account-action");
  slot.append(moreButton(a, email));
  row.append(avatar, text, usage, slot);
  return row;
}

function missingNote(a: AgentAccount): string {
  if (a.unusable) return a.unusable;
  if (a.usageError) return a.usageError;
  return refreshing ? "Checking usage…" : "Usage unavailable";
}

/** Label, a short bar, percent; the reset moment rides the row's tooltip. A window past its reset reads empty. */
export function meter(w: UsageWindow): HTMLElement {
  const f = w.resetsAt && w.resetsAt <= Date.now() ? 0 : Math.min(1, Math.max(0, w.usedPercent / 100));
  const m = el("div", `meter ${level(f)}`);
  const bar = el("span", "bar");
  if (f > 0) {
    const fill = el("span", "fill");
    fill.style.width = `${Math.max(f, 0.015) * 100}%`; // a floor keeps tiny usage visible
    bar.append(fill);
  }
  m.append(el("span", "wlabel", w.label), bar, el("span", "wpct", `${Math.round(f * 100)}%`));
  return m;
}

let openMenu: Popover | null = null;

function moreButton(a: AgentAccount, email: string): HTMLElement {
  const wrap = el("span", "account-more-wrap");
  const more = el("button", "s-icon-btn account-more");
  more.title = "Account actions";
  more.setAttribute("aria-label", `Actions for ${email}`);
  more.setAttribute("aria-haspopup", "menu");
  more.append(icon("ellipsis"));
  more.onclick = (e) => {
    e.stopPropagation();
    if (openMenu) return openMenu.close();
    const items: MenuItem[] = [{ label: "Remove account", danger: true, run: () => void forget(a) }];
    more.classList.add("open");
    more.setAttribute("aria-expanded", "true");
    openMenu = contextMenu(menuPoint(e, more), items, {
      trigger: more,
      onClose: () => {
        openMenu = null;
        more.classList.remove("open");
        more.setAttribute("aria-expanded", "false");
      },
    });
  };
  wrap.append(more);
  return wrap;
}

/** Remove, optimistically: the row goes at once; a refusal restores it and says why. */
async function forget(a: AgentAccount) {
  if (!snapshot) return;
  const previous = snapshot;
  snapshot = { ...snapshot, accounts: snapshot.accounts.filter((r) => r.id !== a.id) };
  actionError = null;
  generation++; // a list in flight must not paint over this
  repaint();
  try {
    snapshot = await call("accounts.forget", { harness: a.harness, id: a.id });
  } catch (err: any) {
    snapshot = previous;
    actionError = err.message;
  }
  refreshing = false;
  repaint();
}

function skeleton(): HTMLElement {
  const box = el("div", "account-skeleton");
  for (let i = 0; i < 2; i++) {
    const row = el("div", `account-row ghost${i ? " dim" : ""}`);
    const text = el("div", "s-row-text");
    text.append(el("span", "sk-line w176"), el("span", "sk-line w112"));
    const usage = el("div", "account-usage");
    usage.append(el("span", "sk-line w176"), el("span", "sk-line w176"));
    row.append(el("span", "sk-avatar"), text, usage, el("span", "account-action"));
    box.append(row);
  }
  return box;
}

// ---------------- sign-in ----------------

type Step = { kind: "browser"; message: string | null } | { kind: "paste"; submitting: boolean; error: string | null } | { kind: "failed"; message: string };
type Login = { harness: HarnessId; attempt: number; loginId: string | null; url: string | null; step: Step };

let login: Login | null = null;
let attempts = 0;
let dialog: { scrim: HTMLElement; card: HTMLElement; code: HTMLInputElement } | null = null;

/** Only web sign-in pages and loopback callbacks open — never file:// or custom schemes. */
function openLoginUrl(url: string) {
  const u = URL.canParse(url) ? new URL(url) : null;
  const ok = u && (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
  if (ok) window.open(url, "_blank", "noopener");
}

/** Start (or Retry) a sign-in: the same dialog for every provider. */
async function startLogin(h: HarnessId) {
  const attempt = ++attempts;
  login = { harness: h, attempt, loginId: null, url: null, step: { kind: "browser", message: null } };
  actionError = null;
  paintDialog();
  try {
    const start = await call("accounts.login.start", { harness: h });
    if (login?.attempt !== attempt) return void call("accounts.login.cancel", { loginId: start.loginId }).catch(() => {});
    login.loginId = start.loginId;
    if (start.url) {
      login.url = start.url;
      openLoginUrl(start.url);
    }
    if (start.mode === "paste-code") login.step = { kind: "paste", submitting: false, error: null };
    else void poll(attempt);
  } catch (err: any) {
    if (login?.attempt !== attempt) return;
    login.step = { kind: "failed", message: `Couldn't start the sign-in: ${err.message}` };
  }
  paintDialog();
}

/** Every 1.5s until the login lands or fails — never a silent reset: it ends with the account or an error. */
async function poll(attempt: number) {
  while (login?.attempt === attempt && login.loginId) {
    await sleep(1500);
    if (login?.attempt !== attempt || !login.loginId) return;
    let res;
    try {
      res = await call("accounts.login.poll", { loginId: login.loginId });
    } catch (err: any) {
      if (login?.attempt !== attempt) return;
      login.step = { kind: "failed", message: `Lost track of the sign-in: ${err.message}` };
      return paintDialog();
    }
    if (login?.attempt !== attempt) return;
    if (res.status === "done") {
      closeDialog();
      login = null;
      return void load(true);
    }
    if (res.status === "error") {
      login.step = { kind: "failed", message: res.message ?? "The sign-in failed." };
      return paintDialog();
    }
    // A page only known now (printed after the start's short wait) opens once.
    if (res.url && !login.url) {
      login.url = res.url;
      openLoginUrl(res.url);
    }
    if (login.step.kind === "browser" && login.step.message !== (res.message ?? null)) {
      login.step = { kind: "browser", message: res.message ?? null };
      paintDialog();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submitCode() {
  if (!login || login.step.kind !== "paste" || login.step.submitting || !login.loginId || !dialog) return;
  const code = dialog.code.value.trim();
  if (!code) return;
  const attempt = login.attempt;
  login.step = { kind: "paste", submitting: true, error: null };
  paintDialog();
  try {
    snapshot = await call("accounts.login.complete", { loginId: login.loginId, code });
    if (login?.attempt !== attempt) return;
    closeDialog();
    login = null;
    void load(true);
  } catch (err: any) {
    if (login?.attempt !== attempt) return;
    login.step = { kind: "paste", submitting: false, error: err.message };
    paintDialog();
  }
}

function cancelLogin() {
  if (login?.loginId) void call("accounts.login.cancel", { loginId: login.loginId }).catch(() => {});
  login = null;
  closeDialog();
}

function closeDialog() {
  if (!dialog) return;
  dialog.scrim.remove();
  removeEventListener("keydown", onDialogKey, true);
  dialog = null;
}

function onDialogKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  cancelLogin();
}

/**
 * One layout for every provider: what to do in the browser, a way back to the page, then the progress line
 * (or, on failure, the reason in the same place) with Cancel — or Close and Retry. Claude's paste-code fallback
 * swaps the progress line for the code field.
 */
function paintDialog() {
  if (!login) return closeDialog();
  if (!dialog) {
    const scrim = el("div", "s-scrim");
    const card = el("div", "s-dialog login-dialog menu-in");
    card.tabIndex = -1;
    card.setAttribute("role", "dialog");
    const code = el("input", "login-code");
    code.placeholder = "Paste the authorization code";
    code.spellcheck = false;
    code.autocomplete = "off";
    // A block body: an `on…` handler returning false cancels the key, and nothing could be typed.
    code.onkeydown = (e) => {
      if (e.key === "Enter") void submitCode();
    };
    scrim.append(card);
    scrim.onpointerdown = (e) => e.target === scrim && cancelLogin();
    document.body.append(scrim);
    addEventListener("keydown", onDialogKey, true);
    dialog = { scrim, card, code };
    card.focus({ preventScroll: true });
  }
  const { card, code } = dialog;
  const l = login;
  const step = l.step;
  const title = `Sign in to ${HARNESS_NAMES[l.harness]}`;
  card.setAttribute("aria-label", title);
  const parts: HTMLElement[] = [el("div", "s-dialog-title", title)];
  parts.push(
    el(
      "div",
      "s-dialog-body",
      step.kind === "paste"
        ? "Your browser opened Claude's sign-in page. Approve access, then paste the code Anthropic shows you below. Claude Code's own login is untouched."
        : LOGIN_COPY[l.harness],
    ),
  );
  if (l.url && step.kind !== "failed") {
    const reopen = el("button", "login-reopen", "Reopen the sign-in page");
    const url = l.url;
    reopen.onclick = () => openLoginUrl(url);
    parts.push(reopen);
  }
  const buttons = el("div", "login-buttons");
  if (step.kind === "browser") {
    const line = el("div", "login-progress");
    line.append(miniSpinner(), el("span", "", step.message ?? (l.url ? "Waiting for you to finish in the browser…" : "Starting sign-in…")));
    parts.push(line);
    buttons.append(action("Cancel", "quiet", cancelLogin));
  } else if (step.kind === "paste") {
    const field = el("div", "login-field");
    code.disabled = step.submitting;
    field.append(code);
    if (step.error) field.append(el("div", "login-error", step.error));
    parts.push(field);
    const submit = action(step.submitting ? "Verifying…" : "Add account", "solid", () => void submitCode());
    submit.disabled = step.submitting;
    buttons.append(action("Cancel", "quiet", cancelLogin), submit);
  } else {
    parts.push(el("div", "login-error failed", step.message));
    buttons.append(
      action("Close", "quiet", cancelLogin),
      action("Retry", "solid", () => void startLogin(l.harness)),
    );
  }
  parts.push(buttons);
  card.replaceChildren(...parts);
  if (step.kind === "paste" && !step.submitting) code.focus();
}
