// The terminal drawer (Zeron's terminal panel, crates/ui/src/terminal): tabs over the core's shells along the bottom
// of the main pane. Unlike Zeron's, the tabs belong to a project rather than a session: every session in a project
// shows the same terminals, and another one is just another tab. Mod+J toggles the drawer for the open session's
// project; its height drags from the top edge (a double click resets it) and is remembered, like the open state
// per project and which tab was last active.
//
// Each tab streams from the core (core/terminals.ts): attaching replays what the core kept, then follows live, so
// tabs come back whole after a reload. Keystrokes coalesce for 12ms before they're sent; size changes reach the
// shell 80ms after the drawer settles.
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import type { TerminalInfo } from "../shared/model";
import { draft } from "./composer";
import { openWebLink } from "./browser";
import { $, el } from "./dom";
import { icon } from "./icons";
import { comboFromEvent, displayCombo, keyContext, shellKeeps, shortcutFor } from "./keymap";
import { animator, EASE_OUT, reducedMotion } from "./motion";
import { isPhone } from "./phone";
import { onPrefs, prefs } from "./prefs";
import { call, net, on, projectOf, store, targetProject } from "./store";
import { activeTheme, onTheme, terminalPalette } from "./theme";

const TAB_W = 118;
const TAB_GAP = 4;
const MIN_H = 160;
const MAX_VH = 0.55;
const DEFAULT_H = 280;
const TOGGLE_MS = 200;
const COALESCE_MS = 12;
const RESIZE_DEBOUNCE_MS = 80;
const DRAG_THRESHOLD = 4;

// ---------------- persisted view state ----------------

type Saved = { height: number; open: string[]; max: string[]; active: Record<string, string> };
const saved: Saved = { height: DEFAULT_H, open: [], max: [], active: {}, ...JSON.parse(localStorage.getItem("bismuth.terminal") ?? "{}") };
const openProjects = new Set(saved.open);
/** Projects whose open drawer is maximized: a modifier of the open drawer, kept across reloads, dropped once hidden. */
const maxProjects = new Set(saved.max);
const persist = () =>
  localStorage.setItem("bismuth.terminal", JSON.stringify({ height: saved.height, open: [...openProjects], max: [...maxProjects], active: saved.active }));

// ---------------- tabs ----------------

type View = {
  info: TerminalInfo;
  term: XTerm;
  fit: FitAddon;
  host: HTMLElement;
  lastSeq: number;
  /** The shell's own title (OSC 0/2), which wins over "Terminal N". */
  title: string;
  input: string;
  inputTimer: Timer | null;
  resizeTimer: Timer | null;
};

let infos: TerminalInfo[] = [];
const views = new Map<string, View>();
/** On the new-session screen the drawer starts hidden and opens only while there (Zeron's canvas). */
let newScreenOpen = false;

let drawer: HTMLElement;
let inner: HTMLElement;
let bar: HTMLElement;
let body: HTMLElement;

/** The project whose terminals show: the open session's, or on the new-session screen the one it starts in. */
function project() {
  return store.thread ? projectOf(store.thread.cwd) : targetProject();
}
const tabsOf = (projectId: string) => infos.filter((t) => t.projectId === projectId);
const isOpen = () => {
  const p = project();
  return !!p && (store.thread ? openProjects.has(p.id) : newScreenOpen);
};
function activeId(projectId: string): string | null {
  const tabs = tabsOf(projectId);
  return tabs.find((t) => t.id === saved.active[projectId])?.id ?? tabs[0]?.id ?? null;
}
/** A program's own title (vim, htop, an agent CLI) names the tab; the shell's default "user@host:cwd" is the same
 *  for every tab of a project, so those keep "Terminal N". */
const titleOf = (v: View | undefined, t: TerminalInfo) => (v?.title && !/^[^@\s]+@[^:\s]+:/.test(v.title) ? v.title : `Terminal ${t.n}`);

// ---------------- xterm ----------------

function xtermTheme(): ITheme {
  const p = terminalPalette(activeTheme());
  const [black, red, green, yellow, blue, magenta, cyan, white, brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = p.ansi;
  return {
    background: p.background,
    foreground: p.foreground,
    cursor: p.cursor,
    cursorAccent: p.background,
    selectionBackground: p.selection,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}
const termFont = () => getComputedStyle(document.documentElement).getPropertyValue("--term").trim() || "monospace";

/** App shortcuts reach the app, not the shell (Mod+J would otherwise type a line feed). */
function appShortcut(e: KeyboardEvent) {
  const combo = comboFromEvent(e);
  const id = combo ? shortcutFor(combo) : undefined;
  return !!combo && (combo === "mod-k" || combo === "mod-," || (!!id && !shellKeeps(combo)));
}

function viewFor(info: TerminalInfo): View {
  const existing = views.get(info.id);
  if (existing) return (existing.info = info), existing;
  const host = el("div", "term-host");
  body.append(host);
  const term = new XTerm({
    fontFamily: termFont(),
    fontSize: prefs.terminalSize,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    // Only glass needs a see-through canvas (it costs xterm some speed).
    allowTransparency: activeTheme().frost,
    theme: xtermTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // A link's address opens as a browser tab (Ctrl+click behind the shown one).
  term.loadAddon(new WebLinksAddon((e, uri) => openWebLink(uri, e.ctrlKey || e.metaKey)));
  const v: View = { info, term, fit, host, lastSeq: 0, title: "", input: "", inputTimer: null, resizeTimer: null };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (appShortcut(e)) return false;
    // Zeron's copy: Ctrl+Shift+C (Cmd+C on macOS), taken only when there's a selection; plain Ctrl+C interrupts.
    // Pasting (Ctrl+V, Ctrl+Shift+V, Cmd+V) is the browser's paste, which xterm already handles.
    if (e.key.toLowerCase() === "c" && (e.metaKey || (e.ctrlKey && e.shiftKey)) && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      e.preventDefault();
      return false;
    }
    // Word deletes, as editors do them: Ctrl+Delete kills the word after the cursor (readline's ESC d), and
    // Ctrl+Backspace the one before it (^W, as VS Code's terminal sends). xterm alone sends codes shells ignore.
    const word = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey ? ({ Delete: "\x1bd", Backspace: "\x17" } as Record<string, string>)[e.key] : undefined;
    if (word) {
      queueInput(v, word);
      e.preventDefault();
      return false;
    }
    return true;
  });
  term.onData((data) => queueInput(v, data));
  term.onBinary((data) => queueInput(v, data));
  term.onTitleChange((title) => {
    v.title = title.trim();
    renderBar();
  });
  term.onResize(({ cols, rows }) => {
    if (v.resizeTimer) clearTimeout(v.resizeTimer);
    v.resizeTimer = setTimeout(() => net.send({ type: "terminal.resize", id: v.info.id, cols, rows }), RESIZE_DEBOUNCE_MS);
  });
  term.open(host);
  views.set(info.id, v);
  net.send({ type: "terminal.attach", id: info.id, afterSeq: 0 });
  // Glyph metrics change once the terminal font has loaded.
  void document.fonts.ready.then(() => fitActive());
  return v;
}

function queueInput(v: View, data: string) {
  if (v.info.exitCode !== null) return;
  v.input += data;
  v.inputTimer ??= setTimeout(() => {
    v.inputTimer = null;
    const input = v.input;
    v.input = "";
    net.send({ type: "terminal.input", id: v.info.id, data: input });
  }, COALESCE_MS);
}

function dispose(id: string) {
  const v = views.get(id);
  if (!v) return;
  if (v.inputTimer) clearTimeout(v.inputTimer);
  if (v.resizeTimer) clearTimeout(v.resizeTimer);
  v.term.dispose();
  v.host.remove();
  views.delete(id);
}

function fitActive() {
  const p = project();
  const id = p && activeId(p.id);
  const v = id ? views.get(id) : undefined;
  if (!v || !isOpen() || !v.host.offsetWidth) return;
  try {
    v.fit.fit();
  } catch {
    // A host that isn't laid out yet has no size to fit.
  }
  // A tab shown again repaints what changed while it was hidden.
  v.term.refresh(0, v.term.rows - 1);
}

// ---------------- from the core ----------------

/** The core's list (after hello and on every change). Re-attaching is how a reconnect resumes: the core sends
 *  only what came after each tab's last seen chunk. */
export function terminalsArrived(list: TerminalInfo[]) {
  infos = list;
  const ids = new Set(list.map((t) => t.id));
  for (const id of [...views.keys()]) if (!ids.has(id)) dispose(id);
  for (const t of list) {
    const v = views.get(t.id);
    if (!v) continue;
    v.info = t;
    net.send({ type: "terminal.attach", id: t.id, afterSeq: v.lastSeq });
  }
  // The last tab of a project closing (anywhere) puts its drawer away.
  for (const id of [...openProjects]) if (!tabsOf(id).length && !pendingOpen.has(id)) openProjects.delete(id), persist();
  render();
}

export function terminalOutput(id: string, seq: number, data: string) {
  const v = views.get(id);
  if (!v || seq <= v.lastSeq) return;
  v.lastSeq = seq;
  v.term.write(data);
}

export function terminalExit(id: string, seq: number, code: number) {
  const v = views.get(id);
  if (!v || seq <= v.lastSeq) return;
  v.lastSeq = seq;
  v.term.write(`\r\n\x1b[2m[process exited ${code}]\x1b[0m\r\n`);
}

// ---------------- actions ----------------

/** Projects waiting on their first terminal to open (so an empty list doesn't close their drawer meanwhile). */
const pendingOpen = new Set<string>();

async function newTab(projectId: string) {
  const v = views.get(activeId(projectId) ?? "");
  pendingOpen.add(projectId);
  try {
    const info = await call("terminals.open", { projectId, cols: v?.term.cols ?? 80, rows: v?.term.rows ?? 24 });
    saved.active[projectId] = info.id;
    persist();
    if (!infos.some((t) => t.id === info.id)) infos = [...infos, info];
    render();
    focusActive();
  } catch (err: any) {
    console.error("terminal:", err?.message ?? err);
  } finally {
    pendingOpen.delete(projectId);
  }
}

function closeTab(id: string) {
  const t = infos.find((x) => x.id === id);
  if (!t) return;
  // The neighbour to the right takes over (else the one to the left), as Zeron's active_after_close.
  const tabs = tabsOf(t.projectId);
  const ix = tabs.findIndex((x) => x.id === id);
  if (saved.active[t.projectId] === id) {
    const next = tabs[ix + 1] ?? tabs[ix - 1];
    if (next) saved.active[t.projectId] = next.id;
    else delete saved.active[t.projectId];
    persist();
  }
  const hadFocus = drawer.contains(document.activeElement);
  void call("terminals.close", { id }).catch(() => {});
  infos = infos.filter((x) => x.id !== id);
  dispose(id);
  if (!tabsOf(t.projectId).length) setOpen(false);
  else {
    render();
    if (hadFocus) focusActive();
  }
}

function selectTab(projectId: string, id: string) {
  saved.active[projectId] = id;
  persist();
  render();
  focusActive();
}

function focusActive() {
  const p = project();
  const id = p && activeId(p.id);
  if (id) views.get(id)?.term.focus();
}

function setOpen(open: boolean, createIfEmpty = true) {
  const p = project();
  if (!p) return;
  if (store.thread) {
    if (open) openProjects.add(p.id);
    else openProjects.delete(p.id);
    persist();
  } else newScreenOpen = open;
  // Hidden, it isn't maximized any more (the glide out keeps the size it had: render holds still while closing).
  if (!open) setMaximized(p.id, false);
  // Putting it away hands the keyboard back to the composer (where focus lives otherwise), not to nowhere.
  if (!open && (drawer.contains(document.activeElement) || document.activeElement === document.body)) {
    (document.activeElement as HTMLElement).blur();
    draft.focus();
  }
  glide();
  render();
  if (open) {
    if (!tabsOf(p.id).length) createIfEmpty && void newTab(p.id);
    else focusActive();
  }
}

const terminalFocused = () => drawer.contains(document.activeElement);

/** Put the drawer away (the phone's back, which takes its screen away). */
export function hideTerminal() {
  if (isOpen()) setOpen(false);
}

/** Mod+J (VS Code's toggle): show the project's terminals, go to them when they show but focus is elsewhere, and
 *  put them away from inside them. */
export function toggleTerminal() {
  if (!project()) return;
  if (isOpen() && !terminalFocused()) return focusActive();
  setOpen(!isOpen());
}

// ---------------- shortcuts (Settings → Shortcuts → Terminal) ----------------

/** New terminal: another tab in the project, opening the drawer if it's away. */
export function newTerminal() {
  const p = project();
  if (!p) return;
  if (!isOpen()) setOpen(true, false);
  void newTab(p.id);
}

/** The project's tabs and the active one's place, when the drawer shows. */
function shownTabs() {
  const p = project();
  if (!p || !isOpen()) return null;
  const tabs = tabsOf(p.id);
  return { p, tabs, ix: tabs.findIndex((t) => t.id === activeId(p.id)) };
}

export function closeTerminal() {
  const s = shownTabs();
  if (s && s.ix >= 0) closeTab(s.tabs[s.ix].id);
}

/** Next / previous terminal, wrapping around. */
export function cycleTerminal(step: 1 | -1) {
  const s = shownTabs();
  if (!s || s.tabs.length < 2) return;
  selectTab(s.p.id, s.tabs[(s.ix + step + s.tabs.length) % s.tabs.length].id);
}

/** The open drawer over the whole main pane, under the titlebar, and back. A modifier of the open drawer: with the
 *  drawer away it does nothing. */
export function toggleMaximize() {
  const p = project();
  if (!p || !isOpen()) return;
  setMaximized(p.id, !maxProjects.has(p.id));
  glide();
  render();
  focusActive();
}

// ---------------- height ----------------

const maxHeight = () => Math.max(MIN_H, $("main").clientHeight * MAX_VH);
const clampHeight = (h: number) => Math.round(Math.min(maxHeight(), Math.max(MIN_H, Number.isFinite(h) ? h : DEFAULT_H)));
/** Maximized, the drawer takes the main pane up to its titlebar (the transcript and composer go under it). */
const isMaximized = () => {
  const p = project();
  return !!p && maxProjects.has(p.id);
};
function setMaximized(projectId: string, on: boolean) {
  if (on === maxProjects.has(projectId)) return;
  if (on) maxProjects.add(projectId);
  else maxProjects.delete(projectId);
  persist();
}
const titlebarH = () => parseFloat(getComputedStyle($("main")).getPropertyValue("--titlebar-h")) || 38;
const fullHeight = () => Math.max(MIN_H, $("main").clientHeight - titlebarH());
// On a phone the terminal is a screen of its own: all of it, its bar in the header band (style.css).
const panelHeight = () => (isPhone() ? $("main").clientHeight : isMaximized() ? fullHeight() : clampHeight(saved.height));

// The drawer's painted height glides between 0 and the panel height on toggles (Zeron's terminal tween); session
// switches and drags snap. The bar rides the drawer's top edge; the shell under it keeps one height for the whole
// glide (the larger of where it was and where it's going), anchored to the bottom and clipped by the edge, so the
// prompt stays put and xterm is fitted once, not every frame.
let shown = 0;
let glideFrom: { from: number; start: number } | null = null;
let snapNext = true;
/** The panel height the shell is laid out for. */
let held = 0;
const BAR_H = 40;
const barHeight = () => (isPhone() ? titlebarH() : BAR_H);

const target = () => (isOpen() ? panelHeight() : 0);
function glide() {
  if (reducedMotion()) return;
  glideFrom = { from: shown, start: performance.now() };
  // Growing, the shell takes its new size at once (revealed as the edge rises); shrinking, it keeps the old one until
  // the edge has come down to it.
  hold(Math.max(held, isOpen() ? panelHeight() : 0));
}
function hold(h: number) {
  if (h === held) return;
  held = h;
  inner.style.setProperty("--term-body-h", `${Math.max(0, h - barHeight())}px`);
  if (h) requestAnimationFrame(fitActive);
}
const frame = animator((now) => {
  const to = target();
  if (glideFrom && !snapNext) {
    const p = Math.min(1, (now - glideFrom.start) / TOGGLE_MS);
    shown = glideFrom.from + (to - glideFrom.from) * EASE_OUT(p);
    if (p >= 1) glideFrom = null;
  } else {
    shown = to;
    glideFrom = null;
  }
  snapNext = false;
  paintHeight();
  // Settled: the shell takes the drawer's height (fitting once if that changed).
  if (!glideFrom && to) hold(to);
  // Put away: once the glide is over, the drawer lets go of what it showed.
  if (!glideFrom && !to && closing) {
    closing = false;
    render();
  }
  return !!glideFrom;
});
function paintHeight() {
  $("main").style.setProperty("--terminal-h", `${Math.round(shown)}px`);
  drawer.hidden = shown < 0.5 && !isOpen();
}

// ---------------- rendering ----------------

let renderedProject: string | null | undefined;
/** Gliding shut: the drawer keeps its tabs and shell on screen until it's down (Zeron's clipped fixed-height inner). */
let closing = false;

function render() {
  const p = project();
  const open = isOpen();
  // Another project (a session switch) snaps the drawer to its own state; a toggle glides.
  if ((p?.id ?? null) !== renderedProject) {
    renderedProject = p?.id ?? null;
    snapNext = true;
    glideFrom = null;
    closing = false;
  }
  if (open) closing = false;
  else if (glideFrom && shown >= 0.5) closing = true;
  // The phone's terminal screen goes as soon as it's put away (it glides down from there).
  $("main").classList.toggle("terminal-open", open);
  frame();
  if (closing) return;
  // Snapped or settled, the shell is laid out for the panel's height (a glide holds it in `frame`).
  if (!glideFrom && open) hold(panelHeight());
  $("main").classList.toggle("terminal-max", open && isMaximized());
  // Terminals measure their glyphs when they open, so the drawer is laid out before any is created.
  if (open) drawer.hidden = false;
  const active = p && open ? activeId(p.id) : null;
  if (p && open) for (const t of tabsOf(p.id)) viewFor(t);
  for (const v of views.values()) v.host.hidden = v.info.id !== active;
  renderBar();
  if (open) requestAnimationFrame(fitActive);
}

let drag: { id: string; from: number; startX: number; over: number; moved: boolean; pointer: number } | null = null;

function renderBar() {
  const p = project();
  if (closing) return;
  if (!p || !isOpen()) return bar.replaceChildren();
  const tabs = tabsOf(p.id);
  const active = activeId(p.id);
  const strip = el("div", "term-tabs");
  tabs.forEach((t, ix) => {
    const v = views.get(t.id);
    const tab = el("div", `term-tab${t.id === active ? " active" : ""}${t.exitCode !== null ? " exited" : ""}`);
    tab.dataset.id = t.id;
    tab.title = `${titleOf(v, t)}${t.exitCode !== null ? ` · exited ${t.exitCode}` : ""}`;
    const close = el("button", "term-close");
    close.title = "Close terminal";
    close.append(icon("x"));
    close.onpointerdown = (e) => e.stopPropagation();
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(t.id);
    };
    tab.append(icon("squareTerminal", undefined, "glyph"), el("span", "label", titleOf(v, t)), close);
    // Middle click closes (Zeron §1.10).
    tab.onauxclick = (e) => e.button === 1 && (e.preventDefault(), closeTab(t.id));
    tab.onmousedown = (e) => e.button === 1 && e.preventDefault(); // no autoscroll
    tab.onpointerdown = (e) => {
      if (e.button !== 0) return;
      drag = { id: t.id, from: ix, startX: e.clientX, over: ix, moved: false, pointer: e.pointerId };
      tab.setPointerCapture(e.pointerId);
    };
    tab.onpointermove = (e) => drag?.id === t.id && dragMove(strip, e.clientX);
    tab.onpointerup = () => {
      if (drag?.id !== t.id) return;
      const d = drag;
      drag = null;
      if (!d.moved) return selectTab(p.id, t.id);
      // The dragged tab comes along as the active one.
      saved.active[p.id] = t.id;
      persist();
      if (d.over !== d.from) {
        // Optimistic: the core's list follows with the same order.
        const ids = tabs.map((x) => x.id);
        ids.splice(d.over, 0, ...ids.splice(d.from, 1));
        const moved = ids.map((id) => infos.find((x) => x.id === id)!);
        let k = 0;
        infos = infos.map((x) => (x.projectId === p.id ? moved[k++] : x));
        void call("terminals.move", { id: t.id, index: d.over }).catch(() => {});
      }
      render();
      focusActive();
    };
    tab.onpointercancel = () => {
      drag = null;
      renderBar();
    };
    strip.append(tab);
  });
  const add = el("button", "term-btn");
  add.title = "New terminal";
  add.append(icon("plus"));
  add.onclick = () => void newTab(p.id);
  const max = el("button", "term-btn max");
  const maxCombo = prefs.keymap.maximizeTerminal;
  max.title = `${isMaximized() ? "Restore terminal size" : "Maximize terminal"}${maxCombo ? ` · ${displayCombo(maxCombo)}` : ""}`;
  max.append(icon(isMaximized() ? "minimize2" : "maximize2"));
  max.onclick = () => toggleMaximize();
  const hide = el("button", "term-btn hide");
  const combo = prefs.keymap.toggleTerminal;
  hide.title = `Hide terminal${combo ? ` · ${displayCombo(combo)}` : ""}`;
  hide.append(icon("chevronDown"));
  hide.onclick = () => setOpen(false);
  bar.replaceChildren(strip, add, el("span", "grow"), max, hide);
}

/** Drag-reorder (Zeron's analytic slide): the dragged tab follows the pointer, the ones it passes slide over. */
function dragMove(strip: HTMLElement, x: number) {
  if (!drag) return;
  const dx = x - drag.startX;
  if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
  drag.moved = true;
  const tabs = [...strip.children] as HTMLElement[];
  const slot = TAB_W + TAB_GAP;
  drag.over = Math.max(0, Math.min(tabs.length - 1, drag.from + Math.round(dx / slot)));
  tabs.forEach((tab, ix) => {
    if (ix === drag!.from) {
      tab.classList.add("dragging");
      tab.style.transform = `translateX(${dx}px)`;
      return;
    }
    const shift = drag!.from < drag!.over && ix > drag!.from && ix <= drag!.over ? -slot : drag!.from > drag!.over && ix < drag!.from && ix >= drag!.over ? slot : 0;
    tab.style.transform = shift ? `translateX(${shift}px)` : "";
  });
}

// ---------------- the resize handle ----------------

function resizeHandle(): HTMLElement {
  const handle = el("div", "term-resize");
  let anchor: { y: number; h: number } | null = null;
  handle.onpointerdown = (e) => {
    if (e.button !== 0) return;
    // Dragging a maximized drawer's edge sizes it again from where it is.
    anchor = { y: e.clientY, h: isMaximized() ? fullHeight() : clampHeight(saved.height) };
    const p = project();
    if (p) setMaximized(p.id, false);
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("active");
    e.preventDefault();
  };
  handle.onpointermove = (e) => {
    if (!anchor) return;
    saved.height = clampHeight(anchor.h + anchor.y - e.clientY);
    snapNext = true;
    render();
  };
  const end = () => {
    if (!anchor) return;
    anchor = null;
    handle.classList.remove("active");
    persist();
  };
  handle.onpointerup = end;
  handle.onpointercancel = end;
  handle.ondblclick = () => {
    const p = project();
    if (p) setMaximized(p.id, false);
    saved.height = DEFAULT_H;
    persist();
    snapNext = true;
    render();
  };
  return handle;
}

// ---------------- mount ----------------

export function initTerminal() {
  drawer = el("div", "terminal-drawer");
  drawer.hidden = true;
  inner = el("div", "inner");
  bar = el("div", "term-bar");
  body = el("div", "term-body");
  inner.append(bar, body);
  drawer.append(inner, resizeHandle());
  $("main").append(drawer);
  body.onmousedown = () => requestAnimationFrame(focusActive);
  keyContext.terminal = terminalFocused;
  keyContext.drawerOpen = isOpen;

  on("header", () => {
    // Arriving on the new-session screen starts with the drawer put away.
    if (!store.thread && renderedThread !== null) newScreenOpen = false;
    renderedThread = store.thread?.id ?? null;
    render();
  });
  new ResizeObserver(() => fitActive()).observe(body);
  // The window resizing changes the 55% cap.
  addEventListener("resize", () => {
    snapNext = true;
    render();
  });
  const paintTheme = () => {
    drawer.style.setProperty("--terminal-bg", terminalPalette(activeTheme()).background);
    for (const v of views.values()) {
      v.term.options.allowTransparency = activeTheme().frost;
      v.term.options.theme = xtermTheme();
    }
  };
  paintTheme();
  onTheme(paintTheme);
  onPrefs(() => {
    const font = termFont();
    for (const v of views.values()) {
      v.term.options.fontFamily = font;
      v.term.options.fontSize = prefs.terminalSize;
    }
    fitActive();
  });
}
let renderedThread: string | null | undefined;
