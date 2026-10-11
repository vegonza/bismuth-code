// The phone layout (a narrow window, typically a phone over remote access): not the desktop squeezed, but screens that
// stack, each over the whole screen: the session list (home), a session or the new-session page, then what a session
// opens over itself (its files or changes, a file, its terminal), and Settings over everything. A round back button
// (and the browser's own back, or a back swipe) takes the top one away. The composer sits at the bottom, under the
// thumb, on the new-session page too. style.css lays the screens out under `html.phone`; the screens' content is the
// desktop's own (the sidebar's list, the chat, the panels), at its own sizes.
import { $, el } from "./dom";
import { icon, type IconName } from "./icons";
import { openPopover, type Popover } from "./popover";
import icon256 from "../assets/icon-256.png";
import icon512 from "../assets/icon.png";

const narrow = matchMedia("(max-width: 640px)");

export const isPhone = () => narrow.matches;
export const onPhoneChange = (fn: () => void) => narrow.addEventListener("change", fn);

/** What the app does for the phone's controls (app.ts wires them; this module stays free of the screens' modules). */
export type PhoneActions = {
  newSession: () => void;
  settings: () => void;
  files: () => void;
  /** The files panel as it was left (its tree or its changes). */
  explorer: () => void;
  changes: () => void;
  terminal: () => void;
  /** The session's own actions (none on the new-session page). */
  session: () => { rename: () => void; settle: (() => void) | null; settled: boolean } | null;
  // Taking each screen away.
  closeSettings: () => void;
  closeFile: () => void;
  closeFiles: () => void;
  closeTerminal: () => void;
};

let actions: PhoneActions;
let app: HTMLElement;
/** The session list shows (nothing stacked over it). */
let home = true;

/** A session asked of the core and not here yet, for which the list waits a moment before the session comes over it. */
let waiting: ReturnType<typeof setTimeout> | undefined;
const WAIT_MS = 150;

/** A session or the new-session page opened: it goes over the list. `loading`: the session is still on its way, so
 *  rather than slide in over what the screen showed before (the last session, the new-session page) it comes once it's
 *  here (sessionReady), or after a moment regardless, empty until it arrives. Called after the screen has rendered
 *  what it opens, so that changes out of sight (offScreen) and only the slide shows. */
export function showSession(loading = false) {
  if (!isPhone()) return;
  clearTimeout(waiting);
  waiting = undefined;
  if (!loading) $("main").classList.remove("ph-loading");
  if (!home) return;
  if (!loading) return cover();
  waiting = setTimeout(() => {
    waiting = undefined;
    $("main").classList.add("ph-loading");
    cover();
  }, WAIT_MS);
}

/** The session asked for has arrived and shows (app.ts show). */
export function sessionReady() {
  if (waiting) showSession();
  else $("main").classList.remove("ph-loading");
}

/** The session screen is out of sight (under the list, or still empty): it changes without its glides. */
export const offScreen = () => isPhone() && (home || $("main").classList.contains("ph-loading"));

function cover() {
  home = false;
  sync();
}

function goHome() {
  home = true;
  sync();
}

/** The screens stacked over the list, bottom first: each is open when its desktop counterpart is. */
const layers = (): (() => void)[] => {
  const stack: (() => void)[] = [];
  if (!home) {
    stack.push(goHome);
    if ($("main").classList.contains("terminal-open")) stack.push(actions.closeTerminal);
    if (app.classList.contains("files-open")) stack.push(actions.closeFiles);
    if (app.classList.contains("pane-open")) stack.push(actions.closeFile);
  }
  if (app.classList.contains("settings-open")) stack.push(actions.closeSettings);
  return stack;
};

// The browser's history holds an entry per screen opened by a tap, so its back (button, gesture) takes the top one
// away: each entry's state says how many screens show there. Browsers skip entries added without a tap, so a screen
// that opens otherwise (a session reopened on load) only notes itself in the current entry. `pushed`: entries this page
// added that are still behind it; `skip`: pops this module made itself (a screen closed some other way).
let pushed = 0;
let skip = 0;
const shown = () => (history.state?.phone as number | undefined) ?? 0;

function syncHistory() {
  if (!isPhone()) return;
  const n = layers().length;
  if (n > shown() && (navigator.userActivation?.isActive ?? true)) {
    history.pushState({ ...history.state, phone: n }, "");
    pushed++;
  } else if (n < shown() && pushed > 0) {
    skip++;
    pushed--;
    history.back();
  } else if (n !== shown()) history.replaceState({ ...history.state, phone: n }, "");
}

function onPop() {
  if (!isPhone()) return;
  if (skip) {
    skip--;
    if (shown() !== layers().length) history.replaceState({ ...history.state, phone: layers().length }, "");
    return;
  }
  pushed = Math.max(0, pushed - 1);
  // Each screen above the entry's count goes once: one that glides shut (the terminal) still counts until it's down.
  const stack = layers();
  while (stack.length > shown()) stack.pop()!();
}

/** The round back button: the browser's back when there's an entry for it, else the top screen goes directly. */
function back() {
  if (pushed > 0) return history.back();
  layers().pop()?.();
}

function sync() {
  app.classList.toggle("ph-home", isPhone() && home);
  syncHistory();
  paintBars();
}

/** The browser's and the system's own bars (the status bar above; a bottom toolbar or the navigation bar below) take
 *  the theme's colour rather than their own light or dark: every phone screen sits on the one plane (style.css). In a
 *  tab, the page's theme-color says it; added to the home screen, the bars come from the app's manifest, which the
 *  launcher reads when it's added, so that carries the colour too (and the name and icon). */
let barsPainted = "";
let manifestUrl = "";
function paintBars() {
  if (!isPhone()) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--main").trim();
  if (!color || color === barsPainted) return;
  barsPainted = color;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
  const manifest = {
    name: "bismuth",
    short_name: "bismuth",
    start_url: `${location.origin}/`,
    scope: `${location.origin}/`,
    display: "standalone",
    theme_color: color,
    background_color: color,
    icons: [
      { src: new URL(icon512, location.href).href, sizes: "512x512", type: "image/png" },
      { src: new URL(icon256, location.href).href, sizes: "256x256", type: "image/png" },
    ],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" }));
  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!link) (link = document.createElement("link")), (link.rel = "manifest"), document.head.append(link);
  link.href = url;
  if (manifestUrl) URL.revokeObjectURL(manifestUrl);
  manifestUrl = url;
}

// ---------------- controls ----------------

let menu: Popover | null = null;

function menuRow(glyph: IconName, label: string, run: () => void): HTMLElement {
  const row = el("div", "menu-row");
  row.append(icon(glyph, undefined, "lead"), el("span", "grow", label));
  row.onclick = (e) => {
    e.stopPropagation();
    menu?.close();
    run();
  };
  return row;
}

/** A session's ··· menu: what it opens over itself, then what it can do. */
function sessionMenu(trigger: HTMLElement) {
  if (menu) return menu.close();
  const card = el("div", "card ctx-menu ph-menu");
  card.append(menuRow("folderTree", "Files", actions.files), menuRow("gitCompare", "Changes", actions.changes), menuRow("squareTerminal", "Terminal", actions.terminal));
  const s = actions.session();
  if (s) {
    card.append(el("div", "menu-separator"), menuRow("pencil", "Rename", s.rename));
    if (s.settle) card.append(menuRow(s.settled ? "rotateCcw" : "circleCheck", s.settled ? "Bring back" : "Settle", s.settle));
  }
  const r = trigger.getBoundingClientRect();
  card.style.top = `${r.bottom + 6}px`;
  card.style.right = `${innerWidth - r.right}px`;
  trigger.classList.add("open");
  menu = openPopover(app, card, { from: "above", keep: [trigger], onClose: () => ((menu = null), trigger.classList.remove("open")) });
}

function button(cls: string, glyph: IconName, label: string, run: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = el("button", `ph-btn ${cls}`) as HTMLButtonElement;
  b.setAttribute("aria-label", label);
  b.append(icon(glyph));
  b.onclick = () => run(b);
  return b;
}

export function initPhone(wire: PhoneActions) {
  actions = wire;
  app = $("app");
  const root = document.documentElement;
  if (matchMedia("(hover: none) and (pointer: coarse)").matches) dropHover();
  if (iOS) longPress();
  swipePanels();

  // Home: new session and Settings at the top right (the list's view options keep their place at the left).
  const homeBar = el("div", "ph-home-bar");
  homeBar.append(button("", "plus", "New session", () => actions.newSession()), button("", "settings", "Settings", () => actions.settings()));
  // Over the list: back at the top left, and a session's ··· at the top right.
  const backBtn = button("ph-back", "chevronLeft", "Back", back);
  const more = button("ph-more", "ellipsis", "Session actions", sessionMenu);
  app.append(homeBar, backBtn, more);

  // A session reopened on load (its address names it) shows over the list.
  home = !location.hash.slice(1);
  const apply = () => {
    root.classList.toggle("phone", narrow.matches);
    sync();
  };
  narrow.addEventListener("change", apply);
  apply();
  addEventListener("popstate", onPop);
  // Screens open and close with the desktop's own state (the panels, the terminal, Settings): history follows.
  const watch = new MutationObserver(() => {
    syncHistory();
    paintBars();
    app.classList.toggle("ph-top-session", !home && layers().length === 1);
  });
  watch.observe(app, { attributeFilter: ["class"] });
  watch.observe($("main"), { attributeFilter: ["class"] });
  // A theme change rewrites the colours on the root.
  new MutationObserver(paintBars).observe(root, { attributeFilter: ["style", "data-appearance"] });

  // The keyboard covers the bottom of the screen without resizing the page (iOS): the app takes the visible height
  // instead, so the composer rides above the keyboard, and the page the browser scrolled to show the caret goes back.
  const vv = visualViewport;
  if (!vv) return;
  const fit = () => {
    if (!narrow.matches) return root.style.removeProperty("--app-h");
    root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    // The keyboard up: it covers the system's bottom bar, so the app goes down to the keyboard.
    root.classList.toggle("ph-keyboard", innerHeight - vv.height > 120);
    if (scrollY) scrollTo(0, 0);
  };
  vv.addEventListener("resize", fit);
  vv.addEventListener("scroll", fit);
  narrow.addEventListener("change", fit);
  fit();
}

// ---------------- touch ----------------

/** A touch screen keeps `:hover` on whatever was tapped last, so a tapped button stays lit: without a pointer that
 *  hovers, hover styles go (each selector that needs a hover is dropped from its rule, and a rule left with none goes).
 *  `:not(:hover)` always holds there, so it's taken out of its selector rather than taking the selector with it (a
 *  settled row stays dimmed). */
function dropHover() {
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // another origin's sheet
    }
    strip(rules);
  }
}

function strip(rules: CSSRuleList) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule instanceof CSSStyleRule) {
      if (!rule.selectorText.includes(":hover")) continue;
      const kept = rule.selectorText
        .split(/,(?![^(]*\))/)
        .map((s) => s.replaceAll(":not(:hover)", ""))
        .filter((s) => !s.includes(":hover"));
      if (kept.length) rule.selectorText = kept.join(",");
      else ((rule.parentRule as CSSGroupingRule | null) ?? rule.parentStyleSheet!).deleteRule(i);
    } else if (rule instanceof CSSGroupingRule) strip(rule.cssRules);
  }
}

/** The files panel sits just off the chat's right edge: a swipe to the left over the chat pulls it in, following the
 *  finger, and a swipe to the right over it pushes it back. Let go past a third of the way (or flicked), it goes on;
 *  short of that, it goes back where it was. A swipe over something that scrolls sideways (a code block, a table) is
 *  that thing's, and the system's own back gesture starts at the screen's edges and never reaches the page. */
function swipePanels() {
  let fp: HTMLElement | null = null;
  let mode: "open" | "close" | null = null;
  let start = { x: 0, y: 0 };
  let target: Element | null = null;
  let dragging = false;
  let last = { x: 0, t: 0, v: 0 };
  const width = () => fp!.offsetWidth || innerWidth;
  // Where the panel is for the finger at `x`: 0 in, width away.
  const at = (x: number) => Math.max(0, Math.min(width(), (mode === "open" ? width() : 0) + x - start.x));
  /** Something under the finger that would scroll that way itself. */
  const scrolls = (dx: number) => {
    for (let n = target; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth <= n.clientWidth + 1 || !/auto|scroll/.test(getComputedStyle(n).overflowX)) continue;
      if (dx > 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
    }
    return false;
  };
  addEventListener("touchstart", (e: TouchEvent) => {
    mode = null;
    if (!isPhone() || home || e.touches.length !== 1 || document.querySelector(".ctx-menu, .card.ph-menu, .s-scrim, .lightbox")) return;
    target = e.target as Element;
    if (target.closest("input, textarea, [contenteditable], .terminal-drawer")) return;
    fp = document.querySelector<HTMLElement>(".fp");
    const top = layers().at(-1);
    if (top === goHome && app.classList.contains("has-panels") && target.closest("#main")) mode = "open";
    else if (top === actions.closeFiles && fp && target.closest(".fp")) mode = "close";
    else return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY };
    last = { x: t.clientX, t: e.timeStamp, v: 0 };
  }, { passive: true });
  addEventListener("touchmove", (e: TouchEvent) => {
    if (!mode) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 10) return;
      // Scrolling up or down, a swipe the other way, or one something else takes: left alone.
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || (mode === "open") !== dx < 0 || scrolls(dx)) return void (mode = null);
      dragging = true;
      fp!.style.transition = "none";
      fp!.style.visibility = "visible";
    }
    e.preventDefault();
    const dt = e.timeStamp - last.t;
    if (dt > 0) last = { x: t.clientX, t: e.timeStamp, v: (t.clientX - last.x) / dt };
    fp!.style.transform = `translateX(${at(t.clientX)}px)`;
  }, { passive: false });
  const end = (e: TouchEvent) => {
    if (!dragging) return void (mode = null);
    dragging = false;
    const out = at(e.changedTouches[0]?.clientX ?? last.x) < width() * (mode === "open" ? 2 / 3 : 1 / 3);
    const keep = e.type === "touchend" && (last.v < -0.3 || (last.v <= 0.3 && out));
    const was = mode;
    mode = null;
    // From where the finger left it, the stylesheet's slide takes it the rest of the way, or back.
    fp!.style.removeProperty("transition");
    fp!.style.removeProperty("visibility");
    fp!.style.removeProperty("transform");
    if (was === "open" && keep) actions.explorer();
    else if (was === "close" && !keep && e.type === "touchend") actions.closeFiles();
    // Nor does a click follow, should the browser send one for the lifted finger.
    addEventListener("click", swallow, true);
    setTimeout(() => removeEventListener("click", swallow, true), 400);
  };
  const swallow = (c: MouseEvent) => {
    c.stopPropagation();
    c.preventDefault();
    removeEventListener("click", swallow, true);
  };
  addEventListener("touchend", end);
  addEventListener("touchcancel", end);
}

/** iOS has no `contextmenu` for a long press (Android has): a press held still for half a second sends one, where the
 *  finger is, and the click that ends it goes nowhere. */
function longPress() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: Touch | null = null;
  let fired = false;
  const cancel = () => (clearTimeout(timer), (start = null));
  addEventListener("touchstart", (e: TouchEvent) => {
    cancel();
    fired = false;
    if (e.touches.length !== 1) return;
    const t = (start = e.touches[0]);
    timer = setTimeout(() => {
      fired = true;
      t.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY, button: 2 }));
    }, 500);
  }, { passive: true });
  addEventListener("touchmove", (e: TouchEvent) => {
    const t = e.touches[0];
    if (start && t && Math.hypot(t.clientX - start.clientX, t.clientY - start.clientY) > 10) cancel();
  }, { passive: true });
  addEventListener("touchend", cancel, { passive: true });
  addEventListener("touchcancel", cancel, { passive: true });
  addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
