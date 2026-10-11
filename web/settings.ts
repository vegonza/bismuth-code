// The Settings view (Zeron's settings shell): it takes over the window with a sidebar-width column — Back, the
// section tabs, the footer — beside the scrolling page. Escape or Back returns to the conversation.
import { renderAppearance } from "./appearance";
import { $, el } from "./dom";
import { icon, type IconName } from "./icons";
import { renderNotifications } from "./notifications";
import { renderGeneral } from "./general";
import { renderProviders, syncProviders } from "./providers";
import { renderRemote } from "./remote";
import { renderShortcuts, shortcutsEscape } from "./shortcuts";
import { renderUsagePage } from "./usagepage";
import { isPhone } from "./phone";
import { prefs } from "./prefs";
import { on } from "./store";
import { closeSelect } from "./widgets";
import { displayCombo } from "./keymap";

export type Section = "general" | "appearance" | "notifications" | "shortcuts" | "providers" | "remote" | "usage";
// `live` pages hold data, not settings: search lists them by name only.
const SECTIONS: { id: Section; label: string; icon: IconName; render: () => HTMLElement; live?: true }[] = [
  { id: "general", label: "General", icon: "settings", render: renderGeneral },
  { id: "appearance", label: "Appearance", icon: "slidersHorizontal", render: renderAppearance },
  { id: "notifications", label: "Notifications", icon: "bell", render: renderNotifications },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard", render: renderShortcuts },
  { id: "providers", label: "Providers", icon: "blocks", render: renderProviders },
  { id: "remote", label: "Remote", icon: "smartphone", render: renderRemote },
  { id: "usage", label: "Usage", icon: "chartNoAxesColumn", render: renderUsagePage, live: true },
];

// Projects (just the base folder) became part of General.
const savedSection = localStorage.getItem("bismuth.settingsSection")?.replace(/^projects$/, "general");
let section: Section = (SECTIONS.find((s) => s.id === savedSection)?.id ?? "general") as Section;
let root: HTMLElement | null = null;
let scroller: HTMLElement;
let nav: HTMLElement;
let returnFocus: Element | null = null;
let search: HTMLInputElement;
let query = "";

export const settingsOpen = () => !!root;

export function openSettings(to?: Section) {
  if (to) section = to;
  if (!root) {
    returnFocus = document.activeElement;
    build();
  }
  show(section);
}

export function closeSettings() {
  if (!root) return;
  shortcutsEscape(); // drop a recording in progress
  closeSelect();
  root.remove();
  root = null;
  removeEventListener("keydown", onEscape);
  query = "";
  $("app").classList.remove("settings-open");
  (returnFocus as HTMLElement | null)?.focus?.({ preventScroll: true });
}

export const toggleSettings = () => (root ? closeSettings() : openSettings());

/** Rebuild the open page in place (after a change that reshapes it), keeping its scroll position. */
export function refresh() {
  if (!root) return;
  const top = scroller.scrollTop;
  scroller.replaceChildren(body());
  scroller.scrollTop = top;
  edgeFades();
}

function build() {
  root = el("div", "settings");
  root.id = "settings";
  root.tabIndex = -1;
  const side = el("div", "s-side");
  const back = el("button", "s-tab");
  back.append(icon("arrowLeft"), "Back");
  back.onclick = closeSettings;
  const backBox = el("div", "s-back");
  backBox.append(back);
  const field = el("label", "s-search");
  search = el("input");
  search.type = "text";
  search.placeholder = "Search settings";
  search.spellcheck = false;
  search.setAttribute("aria-label", "Search settings");
  const clear = el("button", "s-search-clear");
  clear.title = "Clear search";
  clear.append(icon("x"));
  clear.onclick = (e) => {
    e.preventDefault();
    clearSearch(true);
    search.focus();
  };
  field.append(icon("search"), search, el("kbd", "", displayCombo("mod-f")), clear);
  search.oninput = () => setQuery(search.value);
  search.onkeydown = (e) => {
    // Escape clears a query first, then leaves the field; only an empty, unfocused search lets it close settings.
    if (e.key === "Escape") {
      e.preventDefault();
      if (search.value) clearSearch(true);
      else root?.focus({ preventScroll: true });
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      // Into the results: the first control there.
      const first = scroller.querySelector<HTMLElement>("button:not(:disabled), input, [tabindex='0']");
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  nav = el("div", "s-nav");
  nav.setAttribute("role", "tablist");
  const footer = el("div", "sidebar-footer");
  const gear = el("button", "footer-btn active");
  gear.title = "Close settings";
  gear.append(icon("settings"));
  gear.onclick = closeSettings;
  footer.append(gear);
  side.append(backBox, field, nav, footer);

  const main = el("div", "s-main");
  scroller = el("div", "s-scroll");
  scroller.addEventListener("scroll", edgeFades, { passive: true });
  main.append(scroller);
  root.append(side, main);
  // On the window: a page re-render can drop focus out of the settings subtree. Menus and dialogs claim
  // their own Escape first (they prevent it).
  addEventListener("keydown", onEscape);
  $("app").append(root);
  $("app").classList.add("settings-open");
  root.focus({ preventScroll: true });
}

function onEscape(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  e.preventDefault();
  if (!shortcutsEscape()) closeSettings();
}

function show(next: Section) {
  // A phone has no keyboard to record shortcuts with: that page isn't there.
  if (isPhone() && next === "shortcuts") next = "general";
  section = next;
  localStorage.setItem("bismuth.settingsSection", next);
  closeSelect();
  nav.replaceChildren(
    ...SECTIONS.map((s, i) => {
      const tab = el("button", `s-tab${s.id === section && !query ? " selected" : ""}`);
      tab.dataset.section = s.id;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(s.id === section));
      tab.tabIndex = s.id === section ? 0 : -1;
      tab.append(icon(s.icon), s.label);
      // The jump shortcuts pick tabs while Settings is open; their keys show while the modifier is held.
      const combo = prefs.keymap[`jump${i + 1}` as `jump${1 | 2 | 3 | 4 | 5}`];
      if (combo) tab.append(el("span", "jump-hint", displayCombo(combo)));
      tab.onclick = () => {
        clearSearch();
        show(s.id);
      };
      tab.onkeydown = (e) => {
        const n = SECTIONS.length;
        const to = { ArrowUp: i - 1 + n, ArrowLeft: i - 1 + n, ArrowDown: i + 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        clearSearch();
        show(SECTIONS[to % n].id);
        (nav.children[to % n] as HTMLElement).focus();
      };
      return tab;
    }),
  );
  scroller.replaceChildren(body());
  scroller.scrollTop = 0;
  edgeFades();
  // A phone lays the tabs out in a row that scrolls sideways: the picked one comes into view.
  if (isPhone()) nav.querySelector(".s-tab.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const body = () => (query ? searchResults(query) : SECTIONS.find((s) => s.id === section)!.render());

/** A jump shortcut inside Settings: the Nth tab (0-based), leaving any search. False when there's no such tab. */
export function selectSettingsTab(index: number): boolean {
  const target = SECTIONS[index];
  if (!root || !target) return false;
  clearSearch();
  show(target.id);
  return true;
}

export function setSettingsJumpHints(show: boolean) {
  root?.classList.toggle("jump-hints", show);
}

/** Ctrl+F while settings is open: focus its search field. */
export function focusSettingsSearch() {
  if (!root) return;
  search.focus();
  search.select();
}

function setQuery(q: string) {
  const next = q.trim();
  root?.classList.toggle("searching", !!q);
  if (next === query) return;
  const wasSearching = !!query;
  query = next;
  if (!wasSearching || !query) show(section);
  else {
    scroller.replaceChildren(body());
    scroller.scrollTop = 0;
    edgeFades();
  }
}

function clearSearch(rerender = false) {
  if (!search?.value && !query) return;
  search.value = "";
  root?.classList.remove("searching");
  const had = !!query;
  query = "";
  if (rerender && had) show(section);
}

/**
 * Every page, cut down to what matches: a page or section whose title matches keeps all of it; otherwise only
 * the rows whose text does (a row's text includes its description and current value, so "andromeda" or
 * "ctrl+n" find their rows). Results stay live controls, grouped under their page.
 */
function searchResults(q: string): HTMLElement {
  // Each query word must start a word of the text, so "ctrl n" finds Ctrl+N rather than every "n".
  const tokens = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = tokens(q);
  const hit = (text: string | null | undefined) => {
    const t = tokens(text ?? "");
    return words.every((w) => t.some((x) => x.startsWith(w)));
  };
  const out = el("div", "s-page s-results");
  for (const s of words.length ? SECTIONS : []) {
    if (s.live && !hit(s.label)) continue;
    const page = s.live ? el("div") : s.render();
    const header = page.querySelector(":scope > .s-header, :scope > .shortcuts-head");
    if (!hit(s.label)) {
      for (const block of [...page.children] as HTMLElement[]) {
        if (block === header) continue;
        if (!filterBlock(block, hit)) block.remove();
      }
    }
    const blocks = ([...page.children] as HTMLElement[]).filter((b) => b !== header && !b.matches(".shortcuts-helper"));
    if (!blocks.length && !s.live) continue;
    const head = el("button", "s-result-page");
    head.append(icon(s.icon), s.label, icon("chevronRight", undefined, "go"));
    head.onclick = () => {
      clearSearch();
      show(s.id);
    };
    blocks[0]?.classList.add("first");
    out.append(head, ...blocks);
  }
  if (!out.children.length) out.append(el("div", "s-results-empty", `No settings match “${q}”.`));
  return out;
}

/** Keeps the parts of a page block that match; false when nothing in it does. */
function filterBlock(block: HTMLElement, hit: (t: string | null | undefined) => boolean): boolean {
  if (block.matches(".s-section")) {
    const label = block.querySelector(":scope > .s-section-label");
    if (hit(label?.textContent)) return true;
    let any = false;
    for (const child of [...block.children] as HTMLElement[]) {
      if (child === label) continue;
      if (filterBlock(child, hit)) any = true;
      else child.remove();
    }
    return any;
  }
  if (block.matches(".s-card")) {
    // Rows without a title of their own (a strip under a row) go with the row above.
    let keep = false;
    let any = false;
    for (const item of [...block.children] as HTMLElement[]) {
      const title = item.querySelector(".s-row-title");
      if (title) keep = hit(textOf(item));
      if (keep) any = true;
      else item.remove();
    }
    return any;
  }
  return hit(textOf(block));
}

/** Text with node boundaries kept as spaces ("New session" + "Ctrl+N", not "sessionCtrl"). */
function textOf(node: Node): string {
  const parts: string[] = [];
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) parts.push(walk.currentNode.nodeValue ?? "");
  return parts.join(" ");
}

/** The page fades at an edge only while content is scrolled past it. */
function edgeFades() {
  scroller.classList.toggle("fade-top", scroller.scrollTop > 0);
  scroller.classList.toggle("fade-bottom", scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1);
}

export function initSettings() {
  // Providers shows install state and plan usage, which arrive from the core.
  on("providers", syncProviders);
}
