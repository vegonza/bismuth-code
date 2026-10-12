// Browser tabs (Zeron's browser/): a web page as a tab of the right panel, among the files, beside the chat. Each page
// is an Electron <webview> in the desktop app, signed in as Zen is (desktop/browser.ts syncs its cookies in and holds
// every page to a web page's rights). A page that leaves the document is gone, so the pages live in one layer over the
// panel's body for as long as their tabs are open, the shown one visible: a tab away, or another session's, keeps its
// page where it was. Pages are made the first time their tab shows. Phones and plain browsers can't hold a page: the
// tab offers it in a browser instead.
import { el, miniSpinner } from "./dom";
import { icon } from "./icons";
import { displayCombo } from "./keymap";
import { contextMenu, menuItem, type MenuEntry } from "./popover";
import { onPrefs, prefs, SHORTCUTS } from "./prefs";

export type SyncStatus = { enabled: boolean; source: string | null; profile: string | null; cookies: number; at: number | null; error: string | null };
type KeyInit = { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };
type Api = {
  partition: string;
  onOpen(fn: (url: string, from: number | null, background: boolean) => void): void;
  setKeys(combos: string[]): void;
  onKey(fn: (k: KeyInit) => void): void;
  sync(change?: { enabled?: boolean }): Promise<SyncStatus>;
  onSync(fn: (s: SyncStatus) => void): void;
  target(webContentsId: number): Promise<string | null>;
  awake(webContentsId: number, on: boolean): void;
  /** A page drawn as `viewport` (null: as its frame is): whether what it tells sites it is changed. Missing from (or
   *  refused by) a shell from before viewports were (desktop/ changes need the app quit and reopened). */
  viewport?(webContentsId: number, viewport: Viewport | null): Promise<boolean>;
};
const desktop = (window as { bismuthDesktop?: { browser?: Api } }).bismuthDesktop;
const api = desktop?.browser ?? null;

/** What a <webview> offers the page that holds it (Electron's WebviewTag, as much as is used here). */
interface Webview extends HTMLElement {
  src: string;
  partition: string;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  setUserAgent(ua: string): void;
  stop(): void;
  getTitle(): string;
  getWebContentsId(): number;
  inspectElement(x: number, y: number): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
}

/** A browser tab's path among the panel's tabs: this, then the page's id. */
export const BROWSER_TAB = "bismuth:browser:";
export const isBrowserTab = (path: string) => path.startsWith(BROWSER_TAB);
const idOf = (tab: string) => tab.slice(BROWSER_TAB.length);

// ---------------- the pages ----------------

/** What's kept of a page across launches: where it was, and what's typed into its address and not gone to yet (kept
 *  with its tab, as a browser's tab keeps it). */
type Kept = { url: string; title: string; typed?: string; viewport?: View };
type Page = Kept & {
  id: string;
  favicon: string | null;
  loading: boolean;
  back: boolean;
  forward: boolean;
  /** The last load failed (or the page crashed): said over it, with a way to try again. */
  error: { text: string; detail: string } | null;
  frame: HTMLElement | null;
  view: Webview | null;
  /** Its page has loaded once, so the <webview>'s methods work. */
  ready: boolean;
  /** Its DevTools target, as agents driving the browser name it (core/browser.ts): known once it's ready. */
  target: string | null;
  /** When it was last loaded again for being made a phone (or not), so that never happens over and over. */
  remadeAt?: number;
  /** The phone's size, of its own (1: as large as it is). */
  scale: number;
  /** The viewport the shell was last asked to draw it as (as JSON), and whether it's still answering. */
  sized: string | null;
  sizing: boolean;
  /** Why the shell can't draw it as its view has it ("old": from before it could), said over it; null: it can. */
  unemulated: string | null;
};

const KEY = "bismuth.browser";
const kept: Record<string, Kept> = JSON.parse(localStorage.getItem(KEY) ?? "{}");
const pages = new Map<string, Page>();
const save = () => localStorage.setItem(KEY, JSON.stringify(kept));

function pageOf(tab: string): Page {
  const id = idOf(tab);
  let p = pages.get(id);
  if (!p) {
    p = { id, url: kept[id]?.url ?? "", title: kept[id]?.title ?? "", typed: kept[id]?.typed, viewport: kept[id]?.viewport, favicon: null, loading: false, back: false, forward: false, error: null, frame: null, view: null, ready: false, target: null, scale: 1, sized: null, sizing: false, unemulated: null };
    pages.set(id, p);
  }
  return p;
}

function keep(p: Page) {
  kept[p.id] = { url: p.url, title: p.title, ...(p.typed !== undefined && { typed: p.typed }), ...(p.viewport && { viewport: p.viewport }) };
  save();
}

/** A new page's tab (blank, or at `url`). */
export function newPage(url = ""): string {
  const id = Math.random().toString(36).slice(2, 10);
  kept[id] = { url, title: "" };
  save();
  return BROWSER_TAB + id;
}

/** Pages no tab holds any more (their tabs closed in an earlier run) forgotten. */
export function forgetPages(tabs: Iterable<string>) {
  const open = new Set([...tabs].filter(isBrowserTab).map(idOf));
  for (const id of Object.keys(kept)) if (!open.has(id)) delete kept[id];
  save();
}

/** A tab closed: its page let go of (where it was stays, for reopening it). */
export function dropPage(tab: string) {
  const p = pages.get(idOf(tab));
  if (!p) return;
  p.frame?.remove();
  pages.delete(p.id);
  targetWaiters.delete(p.id);
  if (p.target) hooks.target(p.target, null);
  if (shown === p) shown = null;
}

export const pageUrl = (tab: string) => pageOf(tab).url;

// ---------------- agents ----------------

/** Whether this window can hold pages (the desktop app's), so an agent's tabs can open here. */
export const holdsPages = () => !!api;
const targetWaiters = new Map<string, ((target: string) => void)[]>();

/** A tab's page's DevTools target, once its page is up (an agent opened it: it's shown, so it's being made). */
export function targetOf(tab: string, timeout = 20_000): Promise<string> {
  const p = pageOf(tab);
  if (p.target) return Promise.resolve(p.target);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The page didn't open")), timeout);
    const list = targetWaiters.get(p.id) ?? [];
    list.push((t) => (clearTimeout(timer), resolve(t)));
    targetWaiters.set(p.id, list);
  });
}

/** The pages agents hold (core/browser.ts): kept awake, laid out and rendering though their tabs aren't shown (an
 *  agent in a session not shown, or the panel showing a file), so they can be driven and seen. */
let awake = new Set<string>();
export function setAwake(targets: string[]) {
  awake = new Set(targets);
  for (const p of pages.values()) wake(p);
}

function wake(p: Page) {
  const on = !!p.target && awake.has(p.target);
  if (!p.frame || p.frame.classList.contains("awake") === on) return;
  p.frame.classList.toggle("awake", on);
  if (p.ready && p.view) api?.awake(p.view.getWebContentsId(), on);
}

/** A tab's page made without showing it (an agent opened it in a session not shown): it loads where it'll show. */
export function makePage(tab: string) {
  const p = pageOf(tab);
  if (!p.frame) build(p);
}

/** Every page whose DevTools target is known, and its tab. */
export const pageTargets = (): [string, string][] => [...pages.values()].filter((p) => p.target).map((p) => [p.target!, BROWSER_TAB + p.id]);

/** The tab holding a page an agent names by its DevTools target. */
export function tabOfTarget(target: string): string | null {
  for (const p of pages.values()) if (p.target === target) return BROWSER_TAB + p.id;
  return null;
}
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};
const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
/** A page's title as Chromium has it, "" for none (it gives the address, as it shows it, then). */
function titleOf(v: Webview, url: string): string {
  const shown = (s: string) => {
    const bare = s.replace(/^https?:\/\//, "").replace(/\/$/, "");
    try {
      return decodeURI(bare);
    } catch {
      return bare;
    }
  };
  const title = v.getTitle();
  return shown(title) === shown(url) ? "" : title;
}
/** The tab's label: the page's title, else where it is. */
export const pageLabel = (tab: string) => {
  const p = pageOf(tab);
  return p.title || hostOf(p.url) || "New tab";
};

/** The tab's glyph: the activity spinner while loading, else the site's icon (a globe without one). */
export function pageGlyph(tab: string): HTMLElement {
  const p = pageOf(tab);
  if (p.loading) {
    const box = el("span", "rp-tab-glyph bw-tab-spin");
    box.append(miniSpinner());
    return box;
  }
  if (p.favicon) {
    const img = el("img", "rp-tab-glyph bw-favicon");
    img.src = p.favicon;
    img.alt = "";
    img.onerror = () => img.replaceWith(icon("globe", undefined, "rp-tab-glyph"));
    return img;
  }
  return icon("globe", undefined, "rp-tab-glyph");
}

// ---------------- addresses ----------------

const LOCAL = /^(localhost|[\w-]+\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[[\d:a-f]+\])(:\d+)?(\/|\?|#|$)/i;
const HOSTLIKE = /^([\w-]+\.)+[a-z][\w-]*(:\d+)?(\/|\?|#|$)|^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|\?|#|$)|^[\w-]+:\d+(\/|\?|#|$)/i;

/** What's typed into the address: a web address as it is, a host (localhost:3000, example.com/path) as one, anything
 *  else searched for. */
export function addressOf(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return URL.canParse(t) ? t : null;
  if (/^about:blank$/i.test(t)) return t;
  if (!/\s/.test(t) && LOCAL.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && HOSTLIKE.test(t)) return `${/^(\d{1,3}\.){3}\d{1,3}|^[\w-]+:\d+/.test(t) ? "http" : "https"}://${t}`;
  return searchUrl(t);
}

const searchUrl = (text: string) => `https://www.google.com/search?q=${encodeURIComponent(text)}`;

// ---------------- the layer ----------------

type Hooks = {
  /** A tab's page changed (its title, icon, loading): its tab is drawn again. */
  changed: (tab: string) => void;
  /** A page (or a link in the app) wants a new tab: beside `from`'s tab, or the shown one. */
  open: (url: string, from: string | null, background: boolean) => void;
  /** A page's DevTools target is known, held by `tab` (null: its tab closed), for agents (core/browser.ts). */
  target: (target: string, tab: string | null) => void;
  /** What a new tab's page offers besides an address: the panel's other things to open (panels.ts). */
  tools: () => HTMLElement;
  /** The pointer moved over a page, at `x` across it (`width` wide), `buttons` held: the window's edge peek follows it. */
  pointer: (page: HTMLElement, x: number, buttons: number, width: number) => void;
};
let hooks: Hooks;
let layer: HTMLElement;
let stack: HTMLElement;
let backBtn: HTMLButtonElement;
let forwardBtn: HTMLButtonElement;
let reloadBtn: HTMLButtonElement;
let field: HTMLElement;
let input: HTMLInputElement;
let externalBtn: HTMLButtonElement;
let viewBtn: HTMLButtonElement;
let shown: Page | null = null;
/** The page whose address the field last showed. */
let fieldFor: Page | null = null;

/** The layer over `body` (the panel's body), and the app's links and keys routed to the pages. */
export function mountBrowser(body: HTMLElement, h: Hooks) {
  hooks = h;
  layer = el("div", "bw");
  const bar = el("div", "bw-bar");
  const button = (glyph: Parameters<typeof icon>[0], tip: string, run: () => void) => {
    const b = el("button", "wc-btn bw-btn") as HTMLButtonElement;
    b.title = tip;
    b.append(icon(glyph));
    b.onclick = run;
    return b;
  };
  backBtn = button("arrowLeft", "Back", () => goBackPage());
  forwardBtn = button("arrowRight", "Forward", () => goForwardPage());
  reloadBtn = button("rotateCw", "Reload", () => (shown?.loading ? shown.view?.stop() : reloadPage()));
  field = el("label", "bw-field");
  input = el("input") as HTMLInputElement;
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "Website or localhost:3000";
  input.setAttribute("aria-label", "Address");
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const url = addressOf(input.value);
      if (url && shown) navigate(shown, url);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (shown) (shown.typed = undefined), keep(shown);
      input.value = shown?.url ?? "";
      if (shown?.view) shown.view.focus();
      else input.blur();
    }
  };
  // Clicked into, the whole address is selected (as browsers do), so typing replaces it.
  input.onfocus = () => requestAnimationFrame(() => document.activeElement === input && input.select());
  input.oninput = () => {
    if (!shown) return;
    shown.typed = input.value === shown.url ? undefined : input.value;
    keep(shown);
  };
  input.onblur = () => shown && (input.value = shown.typed ?? shown.url);
  field.append(icon("globe"), input);
  externalBtn = button("externalLink", "Open in default browser", () => shown?.url && openExternally(shown.url));
  viewBtn = button("monitorSmartphone", "Viewport", () => shown && viewMenu(shown));
  bar.append(backBtn, forwardBtn, reloadBtn, field, viewBtn, externalBtn);
  stack = el("div", "bw-pages");
  layer.append(bar, stack);
  body.append(layer);

  if (api) {
    api.onOpen((url, from, background) => {
      const opener = from == null ? null : [...pages.values()].find((p) => p.ready && p.view?.getWebContentsId() === from);
      hooks.open(url, opener ? BROWSER_TAB + opener.id : null, background);
    });
    // The app's shortcuts, taken from a focused page by the shell, act as if pressed in the app.
    api.onKey((k) => dispatchEvent(new KeyboardEvent("keydown", { ...k, bubbles: true, cancelable: true })));
    // Mod+W always: unbound, it would reach the window's menu and close bismuth.
    const sendKeys = () => api.setKeys([...new Set([...SHORTCUTS.map((s) => prefs.keymap[s]).filter(Boolean), "mod-k", "mod-,", "mod-w"])]);
    sendKeys();
    onPrefs((prev) => prev.keymap !== prefs.keymap && sendKeys());
    api.onSync((s) => ((sync = s), syncListeners.forEach((fn) => fn())));
    void api.sync().then((s) => ((sync = s), syncListeners.forEach((fn) => fn())));
    wireLinks((url, background) => hooks.open(url, null, background));
  }
}

/** The layer showing `tab`'s page (made now, the first time), or hidden (null: the panel shows something else). */
export function showPage(tab: string | null) {
  if (!tab) return void layer.classList.remove("shown");
  const p = pageOf(tab);
  if (shown !== p) shown?.frame?.classList.remove("shown");
  shown = p;
  if (!p.frame) build(p);
  p.frame!.classList.add("shown");
  layer.classList.add("shown");
  syncBar();
}

/** A page's frame: its <webview> (once it has somewhere to go), what it says while it has nowhere, or that it failed.
 *  The <webview> sits in a device (a phone, or nothing to see) that it never leaves: moved, it would reload. */
function build(p: Page) {
  p.frame = el("div", "bw-page");
  p.frame.dataset.id = p.id;
  const device = el("div", "bw-device");
  const glass = el("div", "bw-glass");
  const status = el("div", "bw-status");
  status.append(el("span", "bw-clock", clock()), statusIcons());
  glass.append(status, el("div", "bw-camera"), el("div", "bw-screen"), navBar(p));
  device.append(el("span", "bw-key power"), el("span", "bw-key volume"), glass);
  p.frame.append(device);
  stack.append(p.frame);
  new ResizeObserver(() => placeView(p)).observe(p.frame);
  placeView(p);
  if (p.url && api) attach(p);
  drawState(p);
}

// ---------------- viewports ----------------

/** How a page is laid out: at the panel's size, or on a device's screen (a desktop's, a phone's) drawn in the panel,
 *  as large as it takes, up to its own size. */
type View = "fit" | "desktop" | "phone";
/** A device: its screen (style.css draws it), where on it the page is (a phone's bars take the rest), its body round
 *  the screen (bezel and band, a side), and the room kept round that in the panel. */
type Device = { screen: [number, number]; page: [number, number]; body: number; margin: number };
/** A desktop: this computer's screen, as a page shown full screen on it has it (a desktop's own size, landscape), or
 *  a common one's should this one not be one (a phone's, a tablet's on its side). Bare, the panel's width. */
const DESKTOP: Device = (() => {
  const own = screen.width >= 1280 && screen.width > screen.height;
  const size: [number, number] = own ? [screen.width, screen.height] : [1920, 1080];
  return { screen: size, page: size, body: 0, margin: 0 };
})();
/** A Pixel's screen (412×915) less its status bar and its navigation bar (40 and 48). */
const PHONE: Device = { screen: [412, 915], page: [412, 915 - 40 - 48], body: 14, margin: 24 };

/** What the shell draws a page as (desktop/browser.ts), as Chrome's DevTools does its devices: a `width`×`height`
 *  viewport drawn at `scale` (the page itself drawn smaller, sharp, not a picture of it shrunk), and as a phone, what
 *  it tells sites it is. */
type Viewport = { width: number; height: number; scale: number; phone: Phone | null };
/** What a phone tells sites it is: its user agent, the platform scripts read, and its client hints (Chromium's
 *  UserAgentMetadata: a shell from before them goes without). */
type Phone = { ua: string; platform: string; metadata?: object };

const VIEWS: [View, Parameters<typeof icon>[0], string, Device | null][] = [
  ["fit", "panelRight", "Fit the panel", null],
  ["desktop", "monitor", "Desktop", DESKTOP],
  ["phone", "smartphone", "Phone", PHONE],
];
const deviceOf = (p: Page) => VIEWS.find(([v]) => v === p.viewport)?.[3] ?? null;

/** The page's device fitted to the frame (its lengths are style.css's, at --k: its screen's as --sw and --sh), and
 *  the shell asked to draw the page so. */
function placeView(p: Page) {
  const frame = p.frame;
  if (!frame) return;
  frame.dataset.view = p.viewport ?? "fit";
  const device = deviceOf(p);
  const w = frame.clientWidth;
  const h = frame.clientHeight;
  p.scale = device && w && h ? Math.max(0.1, Math.min(1, (w - 2 * device.margin) / (device.screen[0] + 2 * device.body), (h - 2 * device.margin) / (device.screen[1] + 2 * device.body))) : 1;
  frame.style.setProperty("--k", String(p.scale));
  frame.style.setProperty("--sw", String(device?.screen[0] ?? 0));
  frame.style.setProperty("--sh", String(device?.screen[1] ?? 0));
  sizePage(p);
}

/** The viewport the page is drawn as, for its view (null: its frame's, as it is). */
function viewportOf(p: Page): Viewport | null {
  const device = deviceOf(p);
  if (!device) return null;
  return { width: device.page[0], height: device.page[1], scale: p.scale, phone: device === PHONE ? ANDROID : null };
}

/** The shell asked to draw the page as its view has it, once it's up: one ask at a time, then the latest (a panel
 *  gliding open asks every frame). Made a phone or unmade one, the page is loaded again as what it is now (its site
 *  sends that version). */
function sizePage(p: Page) {
  const v = p.view;
  if (!v || !p.ready || p.sizing) return;
  const want = viewportOf(p);
  const key = JSON.stringify(want);
  if (key === p.sized) return;
  p.sized = key;
  if (!api?.viewport) return unsized(p, want && "old");
  p.sizing = true;
  api.viewport(v.getWebContentsId(), want).then(
    (remade) => {
      p.sizing = false;
      unsized(p, null);
      if (remade) remake(p);
      sizePage(p);
    },
    (err) => {
      p.sizing = false;
      // Not asked again until something changes (the view, the panel's size, a new page).
      unsized(p, want && (/No handler registered/.test(String(err)) ? "old" : String(err?.message ?? err)));
      sizePage(p);
    },
  );
}

/** Whether (and why) the page can't be drawn as its view has it, said over it. */
function unsized(p: Page, why: string | null) {
  if (p.unemulated === why) return;
  p.unemulated = why;
  drawState(p);
}

/** What a phone tells sites it is, as Firefox's and Chrome's phone modes do: Chrome on an Android phone, the version
 *  the page really runs on (sites send their phone versions by it, not by the screen's size). Its user agent as Chrome
 *  sends it now (Android's version and the model left out of it, told in the client hints instead). Out of phone
 *  mode, the browser's own, as the shell has it (desktop/browser.ts: the app's, less Electron's and bismuth's names). */
const CHROME = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? "140";
const PHONE_UA = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME}.0.0.0 Mobile Safari/537.36`;
const ANDROID: Phone = {
  ua: PHONE_UA,
  platform: "Linux armv81",
  metadata: {
    ...((navigator as any).userAgentData?.brands ? { brands: (navigator as any).userAgentData.brands } : {}),
    platform: "Android",
    platformVersion: "16.0.0",
    architecture: "",
    model: "Pixel 9",
    mobile: true,
  },
};
const BROWSER_UA = navigator.userAgent.replace(/\s(Electron|bismuth)\/\S+/g, "");

/** The page shown as `view`. */
function setView(p: Page, view: View) {
  const was = p.viewport ?? "fit";
  if (was === view) return;
  p.viewport = view === "fit" ? undefined : view;
  keep(p);
  syncBar();
  if (p.view && (was === "phone") !== (view === "phone")) {
    // What the page itself was made with too (a phone's, if it was made as one), under the shell's; not up yet, what
    // its first page loads with.
    const ua = view === "phone" ? PHONE_UA : BROWSER_UA;
    if (p.ready) p.view.setUserAgent(ua);
    else p.view.setAttribute("useragent", ua);
  }
  placeView(p);
}

/** The page loaded again as what it is now, at most once in a while: should its emulation keep going (the shell's
 *  debugger let go of), it isn't loaded over and over. */
function remake(p: Page) {
  if (!p.view || !p.ready || !p.url || Date.now() - (p.remadeAt ?? 0) < 10_000) return;
  p.remadeAt = Date.now();
  p.view.reload();
}

function viewMenu(p: Page) {
  const r = viewBtn.getBoundingClientRect();
  contextMenu(
    { x: r.right, y: r.bottom + 4 },
    VIEWS.map(([view, glyph, label, device]) => {
      const row = menuItem({ icon: glyph, label, hint: device ? device.screen.join("×") : undefined, run: () => setView(p, view) });
      const check = el("span", "check-slot");
      if ((p.viewport ?? "fit") === view) check.append(icon("check"));
      row.append(check);
      return row;
    }),
    { trigger: viewBtn },
  );
}

/** The time as a phone's status bar shows it (hours and minutes, no AM or PM), kept current in every phone. */
const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]\.?M\.?$/i, "");
setInterval(() => document.querySelectorAll(".bw-clock").forEach((c) => (c.textContent = clock())), 15_000);

/** A phone's status bar's right side, Android's: wifi, signal, battery (sized in em, a pixel at the phone's scale:
 *  style.css). */
function statusIcons(): HTMLElement {
  const box = el("span", "bw-status-icons");
  box.innerHTML =
    '<svg viewBox="0 0 24 24" width="17em" height="17em"><path d="M12 20.5 1.3 8.2a16.6 16.6 0 0 1 21.4 0Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
    '<svg viewBox="0 0 24 24" width="16em" height="16em"><path d="M20.5 3.5v17h-17Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
    '<svg viewBox="0 0 27 14" width="25em" height="13em"><rect x="0.5" y="0.5" width="23" height="13" rx="4" opacity=".35"/><path d="M4.5.5h14v13h-14a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4Z"/><path d="M25 4.5v5a1.6 1.6 0 0 0 1.5-1.6V6.1A1.6 1.6 0 0 0 25 4.5Z" opacity=".35"/></svg>';
  return box;
}

/** A phone's navigation bar, Android's three buttons: Back goes back in the page, as a phone's does; Home and Recents
 *  are the phone's, drawn (nothing a page has to go to). */
function navBar(p: Page): HTMLElement {
  const nav = el("div", "bw-nav");
  const back = el("button", "bw-nav-key") as HTMLButtonElement;
  back.title = "Back";
  back.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16.5 5.5v13L6.5 12Z" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  back.addEventListener("click", () => goBackPage(p));
  const home = el("span", "bw-nav-key");
  home.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/></svg>';
  const recents = el("span", "bw-nav-key");
  recents.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/></svg>';
  nav.append(back, home, recents);
  return nav;
}

function attach(p: Page) {
  const v = document.createElement("webview") as Webview;
  // The session before the address: a <webview> takes its partition only before it first loads.
  v.setAttribute("partition", api!.partition);
  v.setAttribute("allowpopups", "");
  if (p.viewport === "phone") v.setAttribute("useragent", PHONE_UA);
  v.src = p.url;
  p.view = v;
  const nav = () => {
    if (!p.ready) return;
    p.back = v.canGoBack();
    p.forward = v.canGoForward();
  };
  v.addEventListener("dom-ready", () => {
    if (!p.ready)
      void api!.target(v.getWebContentsId()).then((t) => {
        if (!t || !pages.has(p.id)) return;
        p.target = t;
        wake(p);
        hooks.target(t, BROWSER_TAB + p.id);
        targetWaiters.get(p.id)?.splice(0).forEach((fn) => fn(t));
      });
    p.ready = true;
    // Each new document: the shell asked again (nothing changes if nothing has; should its emulation have gone, it's
    // made again), so a page made as a phone is loaded again once it is one (its scripts ran before, seeing no phone).
    p.sized = null;
    sizePage(p);
    nav();
    changed(p);
  });
  v.addEventListener("did-start-loading", () => {
    p.loading = true;
    p.error = null;
    drawState(p);
    changed(p);
  });
  v.addEventListener("did-stop-loading", () => {
    p.loading = false;
    nav();
    changed(p);
  });
  v.addEventListener("did-navigate", (e: any) => {
    // A new document: whatever was typed into the address is dropped. Its title, Chromium's for it: a page gone back
    // to or loaded again keeps its own (and isn't told again: the same title set again is no change), a new one's is
    // on its way. Its icon stays while it's the same site's (one that changes is told), another site's is on its way.
    if (originOf(e.url) !== originOf(p.url)) p.favicon = null;
    p.url = e.url;
    p.typed = undefined;
    p.title = titleOf(v, e.url);
    nav();
    keep(p);
    changed(p);
  });
  v.addEventListener("did-navigate-in-page", (e: any) => {
    if (!e.isMainFrame) return;
    p.url = e.url;
    nav();
    keep(p);
    changed(p);
  });
  v.addEventListener("page-title-updated", (e: any) => {
    p.title = e.title;
    keep(p);
    changed(p);
  });
  v.addEventListener("page-favicon-updated", (e: any) => {
    p.favicon = e.favicons?.[0] ?? null;
    changed(p);
  });
  v.addEventListener("did-fail-load", (e: any) => {
    // -3: the load was stopped, or another one took its place.
    if (!e.isMainFrame || e.errorCode === -3) return;
    // Not the page it was: its title and icon go, so the tab names where it failed.
    if (e.validatedURL && e.validatedURL !== p.url) (p.url = e.validatedURL), (p.title = ""), (p.favicon = null);
    p.error = failure(e.errorCode, e.errorDescription, p.url);
    keep(p);
    drawState(p);
    changed(p);
  });
  v.addEventListener("render-process-gone", () => {
    p.loading = false;
    p.error = { text: "This page stopped working", detail: "Reload it to start it again." };
    drawState(p);
    changed(p);
  });
  v.addEventListener("context-menu", (e: any) => pageMenu(p, e.params));
  // A page keeps the pointer's moves to itself: its preload passes them on (desktop/page-preload.cjs).
  v.addEventListener("ipc-message", (e: any) => {
    const [x, buttons, width] = e.args ?? [];
    if (e.channel === "bismuth-pointer" && typeof x === "number" && typeof buttons === "number" && typeof width === "number") hooks.pointer(v, x, buttons, width);
  });
  p.frame!.querySelector(".bw-screen")!.append(v);
}

/** Chromium's error, as something to read. */
function failure(code: number, description: string, url: string): Page["error"] {
  const host = hostOf(url) || url;
  if (code === -102) return { text: `Nothing is answering at ${host}`, detail: "Is the server running? Start it, then try again." };
  if (code === -105) return { text: `${host} wasn't found`, detail: "Check the address, or your connection." };
  if (code === -106) return { text: "You're offline", detail: "Connect to the internet, then try again." };
  if (code === -312) return { text: `${host} is on a blocked port`, detail: "Browsers refuse this port: serve it on another one." };
  // ERR_CERT_DATE_INVALID → "Cert date invalid".
  const said = description.replace(/^(net::)?ERR_/, "").replace(/_/g, " ").toLowerCase();
  return { text: `Couldn't open ${host}`, detail: said ? said.charAt(0).toUpperCase() + said.slice(1) : `Error ${code}` };
}

/** Over the page: a new tab's page (a blank tab), that it failed, or (without the desktop app's browser) where it opens. */
function drawState(p: Page) {
  if (!p.frame) return;
  p.frame.querySelector(".bw-state")?.remove();
  const state = el("div", "bw-state");
  const tile = el("div", "bw-state-tile");
  const say = (title: string, text: string) => state.append(tile, el("div", "bw-state-title", title), el("div", "bw-state-text", text));
  const action = (label: string, run: () => void) => {
    const b = el("button", "bw-state-btn", label);
    b.onclick = run;
    state.append(b);
  };
  if (!p.url) {
    // A new tab's page (Codex's): an address to type above, and the panel's other things to open below.
    state.classList.add("bw-newtab");
    state.append(hooks.tools());
  } else if (!api) {
    tile.append(icon("globe"));
    // A shell from before the browser came (desktop/ changes need the app quit and reopened), or no shell at all.
    if (desktop) say("Reopen bismuth", "Quit and reopen the app to browse here.");
    else say("Pages open in the desktop app", "Here, they open in your browser.");
    action("Open in browser", () => openExternally(p.url));
  } else if (p.error) {
    tile.append(icon("triangleAlert"));
    say(p.error.text, p.error.detail);
    action("Try again", () => reloadPage());
  } else if (p.unemulated) {
    const as = p.viewport === "phone" ? "a phone" : "a desktop";
    tile.append(icon(p.viewport === "phone" ? "smartphone" : "monitor"));
    // A shell from before viewports (desktop/ changes need the app quit and reopened).
    if (p.unemulated === "old") say("Quit and reopen bismuth", `Showing pages as ${as} needs the app restarted once.`);
    else say(`Couldn't show it as ${as}`, p.unemulated);
    action("Fit the panel", () => setView(p, "fit"));
  } else return;
  p.frame.append(state);
}

function changed(p: Page) {
  if (p === shown) syncBar();
  hooks.changed(BROWSER_TAB + p.id);
}

function syncBar() {
  const p = shown;
  if (!p) return;
  backBtn.disabled = !p.back;
  forwardBtn.disabled = !p.forward;
  reloadBtn.disabled = !p.view;
  reloadBtn.replaceChildren(icon(p.loading ? "x" : "rotateCw"));
  reloadBtn.title = p.loading ? "Stop" : prefs.keymap.reloadPage ? `Reload · ${displayCombo(prefs.keymap.reloadPage)}` : "Reload";
  externalBtn.disabled = !p.url;
  const view = VIEWS.find(([v]) => v === (p.viewport ?? "fit"))!;
  viewBtn.replaceChildren(icon(p.viewport ? view[1] : "monitorSmartphone"));
  viewBtn.classList.toggle("on", !!p.viewport);
  viewBtn.title = `Viewport: ${view[2]}`;
  // Typing into it stays as typed; another tab shown, its own address (or what's typed into it).
  if (document.activeElement !== input || fieldFor !== p) input.value = p.typed ?? p.url;
  fieldFor = p;
}

function navigate(p: Page, url: string) {
  p.url = url;
  p.typed = undefined;
  p.error = null;
  keep(p);
  if (!api) return void (drawState(p), changed(p));
  if (!p.view) attach(p);
  else if (p.ready) void p.view.loadURL(url).catch(() => {});
  else p.view.src = url;
  drawState(p);
  changed(p);
  p.view!.focus();
}

/** Opened in the system's browser (the shell sends a window's web address there). */
const openExternally = (url: string) => void window.open(url, "_blank", "noopener");

// ---------------- what the panel asks of the shown page ----------------

export const showsPage = () => !!shown && layer.classList.contains("shown");

/** Mod+L: the address, selected for typing. */
export function focusAddress() {
  if (!showsPage()) return;
  input.focus();
  input.select();
}

/** The shown page focused (a tab clicked). */
export function focusPage() {
  if (shown?.view) shown.view.focus();
  else if (shown && !shown.url) focusAddress();
}

export function reloadPage() {
  const p = shown;
  if (!p?.url) return;
  p.error = null;
  drawState(p);
  if (!p.view) return api ? attach(p) : undefined;
  if (p.ready) p.view.reload();
  else p.view.src = p.url;
}
export function goBackPage(p = shown) {
  if (p?.ready && p.view?.canGoBack()) p.view.goBack();
}
export function goForwardPage() {
  if (shown?.ready && shown.view?.canGoForward()) shown.view.goForward();
}

// ---------------- menus ----------------

const copy = (text: string) => void navigator.clipboard.writeText(text);

/** A page's right-click menu (Chromium's own isn't drawn in a <webview>): for the link, image, selection or field
 *  under the pointer, then the page's. */
function pageMenu(p: Page, at: any) {
  const v = p.view!;
  const items: MenuEntry[] = [];
  const tab = BROWSER_TAB + p.id;
  if (at.linkURL && /^https?:/i.test(at.linkURL)) {
    items.push(
      { icon: "plus", label: "Open link in new tab", run: () => hooks.open(at.linkURL, tab, false) },
      { icon: "externalLink", label: "Open link in default browser", run: () => openExternally(at.linkURL) },
      { icon: "clipboardCopy", label: "Copy link address", run: () => copy(at.linkURL) },
      "-",
    );
  }
  if (at.mediaType === "image" && /^https?:/i.test(at.srcURL)) {
    items.push({ icon: "image", label: "Open image in new tab", run: () => hooks.open(at.srcURL, tab, false) }, { icon: "clipboardCopy", label: "Copy image address", run: () => copy(at.srcURL) }, "-");
  }
  const flags = at.editFlags ?? {};
  if (at.isEditable) {
    items.push(
      { label: "Undo", disabled: !flags.canUndo, run: () => v.undo() },
      { label: "Redo", disabled: !flags.canRedo, run: () => v.redo() },
      "-",
      { label: "Cut", disabled: !flags.canCut, run: () => v.cut() },
      { icon: "copy", label: "Copy", disabled: !flags.canCopy, run: () => v.copy() },
      { label: "Paste", disabled: !flags.canPaste, run: () => v.paste() },
      { label: "Select all", disabled: !flags.canSelectAll, run: () => v.selectAll() },
      "-",
    );
  } else if (at.selectionText?.trim()) {
    const text = at.selectionText.trim();
    items.push(
      { icon: "copy", label: "Copy", run: () => v.copy() },
      { icon: "search", label: `Search for “${text.length > 24 ? `${text.slice(0, 24)}…` : text}”`, run: () => hooks.open(searchUrl(text), tab, false) },
      "-",
    );
  }
  if (!items.length) {
    items.push(
      { icon: "arrowLeft", label: "Back", disabled: !p.back, run: () => goBackPage() },
      { icon: "arrowRight", label: "Forward", disabled: !p.forward, run: () => goForwardPage() },
      { icon: "rotateCw", label: "Reload", hint: prefs.keymap.reloadPage ? displayCombo(prefs.keymap.reloadPage) : undefined, run: () => reloadPage() },
      "-",
    );
  }
  items.push({ icon: "code", label: "Inspect", run: () => v.inspectElement(at.x, at.y) });
  const box = v.getBoundingClientRect();
  const pop = contextMenu({ x: box.left + at.x, y: box.top + at.y }, items);
  // The app's document takes the focus back from the page, so a press in the page again (the window losing focus to
  // it) closes the menu, as an outside press does.
  pop.card.focus({ preventScroll: true });
}

// ---------------- links in the app ----------------

/** A web address from the app (a link in a reply, the terminal) in a new tab; without the desktop app's browser, in
 *  the system's. */
export function openWebLink(url: string, background = false) {
  if (api && hooks) hooks.open(url, null, background);
  else openExternally(url);
}

/** Web links the app renders (Markdown's, marked `data-web`) open as tabs: a click in front, a middle click behind.
 *  Right-click offers the other ways. `open` makes the tab (a side chat's frame asks the window around it). */
export function wireLinks(open: (url: string, background: boolean) => void) {
  const linkAt = (e: MouseEvent) => (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[data-web]") ?? null;
  document.addEventListener("click", (e) => {
    const a = linkAt(e);
    if (!a || e.defaultPrevented || e.button !== 0) return;
    e.preventDefault();
    open(a.href, e.ctrlKey || e.metaKey);
  });
  document.addEventListener("auxclick", (e) => {
    const a = linkAt(e);
    if (!a || e.button !== 1) return;
    e.preventDefault();
    open(a.href, true);
  });
  document.addEventListener("contextmenu", (e) => {
    const a = linkAt(e);
    if (!a) return;
    e.preventDefault();
    const url = a.href;
    contextMenu({ x: e.clientX, y: e.clientY }, [
      { icon: "globe", label: "Open in new tab", run: () => open(url, false) },
      { icon: "externalLink", label: "Open in default browser", run: () => openExternally(url) },
      { icon: "clipboardCopy", label: "Copy link address", run: () => copy(url) },
    ]);
  });
}

// ---------------- Zen's sign-ins ----------------

let sync: SyncStatus | null = null;
const syncListeners = new Set<() => void>();
/** How the cookie sync stands (null outside the desktop app, or until the shell answers). */
export const syncStatus = () => sync;
export const canSync = () => !!api;
export function onSyncStatus(fn: () => void) {
  syncListeners.add(fn);
  return () => void syncListeners.delete(fn);
}
export function setSync(enabled: boolean) {
  if (!api) return;
  if (sync) sync = { ...sync, enabled };
  void api.sync({ enabled }).then((s) => ((sync = s), syncListeners.forEach((fn) => fn())));
}
