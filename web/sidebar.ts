// Left sidebar: titlebar cluster, the "…" view menu, the session list (shaped by the view options), settings.
import type { Project, ThreadSummary } from "../shared/model";
import { isPhone } from "./phone";
import { $, el, faded, fitFades, miniSpinner, timeAgo } from "./dom";
import { discardNewDraft, draftHasContent, draftPreview, hasDraft, isNewDraft, listedNewDrafts, newDraft, openNewDraft, type NewDraft } from "./drafts";
import { HARNESS_NAMES, harnessIcon, icon } from "./icons";
import { withListMotion } from "./listmotion";
import { displayCombo, heldModifiers, modifiersOf, recording } from "./keymap";
import { openPalette } from "./palette";
import { pickerOpen } from "./picker";
import { prefs } from "./prefs";
import { setSettingsJumpHints, settingsOpen, toggleSettings } from "./settings";
import { contextMenu, menuPoint, onPopoverClosed, openPopovers, type Popover } from "./popover";
import { edgePeek, type EdgePeek } from "./edgepeek";
import { actions, call, on, persist, projectName, projectOf, render, store, tildePath, worktreeOf } from "./store";
import { switchPreview } from "./worktrees";
import { toggleViewMenu } from "./viewmenu";
import { dialog } from "./widgets";

// Monogram tones as [dark, light] appearance variants (slate, blue, violet, rose, amber, emerald, teal,
// orange), chosen by a stable FNV-1a hash of the project path.
const MONOGRAM = [
  ["#94a3b8", "#475569"],
  ["#93c5fd", "#2563eb"],
  ["#c4b5fd", "#7c3aed"],
  ["#fda4af", "#be123c"],
  ["#fcd34d", "#a16207"],
  ["#6ee7b7", "#047857"],
  ["#5eead4", "#0f766e"],
  ["#fdba74", "#c2410c"],
];

/** A project's artwork from its folder, else a monogram tile; `cwd` stands in for a removed project. */
export function projectArt(p: Project | null, cwd = p?.path ?? ""): HTMLElement {
  if (p?.icon) {
    const img = el("img", "project-icon");
    img.src = `/project-icon?id=${encodeURIComponent(p.id)}`;
    img.alt = "";
    return img;
  }
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(p?.path ?? cwd)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  const [dark, light] = MONOGRAM[hash % MONOGRAM.length];
  const tile = el("span", "monogram", ((p?.name ?? projectName(cwd)).trim()[0] ?? "?").toUpperCase());
  // style.css picks the variant for the current appearance.
  tile.style.setProperty("--tone-dark", dark);
  tile.style.setProperty("--tone-light", light);
  return tile;
}

/** Whether the titlebar's New session plus is showing. */
let plusShown = false;

function titlebarCluster() {
  const cluster = $("titlebar-cluster");
  const toggle = el("button", "wc-btn");
  // Titles follow the keymap, which can be rebound while the app runs.
  const hint = (b: HTMLElement, label: string, action: "toggleSidebar" | "newSession") =>
    b.addEventListener("pointerenter", () => (b.title = prefs.keymap[action] ? `${label} · ${displayCombo(prefs.keymap[action])}` : label));
  hint(toggle, "Toggle sidebar", "toggleSidebar");
  toggle.append(icon("panelLeft"));
  toggle.onclick = toggleSidebar;
  const plus = el("button", "wc-btn new");
  hint(plus, "New session", "newSession");
  plus.append(icon("plus"));
  plus.onclick = () => actions.newThread();
  cluster.replaceChildren(toggle, plus);
  on("header", () => {
    // The plus fades out on an empty new-session screen, where it would do nothing (from a draft, it starts another).
    const useful = (plusShown = !!store.thread || draftHasContent(openNewDraft().id));
    plus.style.opacity = useful ? "1" : "0";
    plus.style.pointerEvents = useful ? "" : "none";
  });
}

/** With the sidebar put away, touching the window's left edge slides it in over everything (edgepeek.ts). */
let peek: EdgePeek | null = null;
/** The session rows show: docked, or peeking from the window's edge. */
const sidebarShown = () => !$("app").classList.contains("sidebar-collapsed") || !!peek?.peeking;

export function toggleSidebar() {
  store.sidebarCollapsed = !store.sidebarCollapsed;
  if (!store.sidebarCollapsed) peek?.dock();
  $("app").classList.toggle("sidebar-collapsed", store.sidebarCollapsed);
  persist();
}

/** How long a running session has been at it, in whole minutes ("" under one): seconds would tick too much. */
function workingFor(t: ThreadSummary): string {
  // The core's start of the run; a core from before it sent one leaves the UI's own note of it.
  const started = t.runningSince ?? store.runningSince.get(t.id);
  if (started == null) return "";
  const m = Math.floor((Date.now() - started) / 60_000);
  return m < 1 ? "" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Note when sessions start running (and forget the ones that stopped), so the minutes survive reloads and read the
 *  same selected or not. Until a session is opened that's when it was first seen running; once open, its turn's
 *  real start replaces that and is remembered after moving away. */
function trackRunning() {
  let changed = false;
  for (const t of store.summaries.values())
    if (t.status === "running" && !store.runningSince.has(t.id)) store.runningSince.set(t.id, Date.now()), (changed = true);
  const open = store.thread;
  const started = open?.turns.find((x) => x.id === open.activeTurnId)?.startedAt;
  if (open && started != null && store.summaries.get(open.id)?.status === "running" && store.runningSince.get(open.id) !== started)
    store.runningSince.set(open.id, started), (changed = true);
  for (const id of store.runningSince.keys())
    if (store.summaries.get(id)?.status !== "running") store.runningSince.delete(id), (changed = true);
  if (changed) persist();
}

function statusCorner(t: ThreadSummary): HTMLElement {
  const status = el("span", "status");
  if (t.status === "running") {
    status.classList.add("working");
    const time = workingFor(t);
    status.append(miniSpinner(), time ? `Working ${time}` : "Working");
    // Its subagents at work, counted (Zeron's running pill).
    const agents = runningAgents(t.id);
    if (agents) {
      const pill = el("span", "agents");
      pill.title = `${agents} subagent${agents === 1 ? "" : "s"} running`;
      pill.append(icon("bot"), String(agents));
      status.append(pill);
    }
  } else if (t.status === "waiting") {
    status.classList.add("input");
    status.append(el("span", "dot"), "Input");
  } else if (t.status === "error") {
    status.classList.add("failed");
    status.append(el("span", "dot"), "Failed");
  } else if (store.done.has(t.id)) {
    status.classList.add("done");
    status.append(icon("check"), "Done");
  } else return el("span", "time", timeAgo(timeOf(t)));
  return status;
}

/** How many of a session's subagents are at work. */
const runningAgents = (id: string) => {
  let n = 0;
  for (const s of store.summaries.values()) if (s.subagent && s.parent === id && s.status === "running") n++;
  return n;
};

/** Compact rows lead with a 13px status glyph: spinner, check, or a dot in the status colour. */
function statusGlyph(t: ThreadSummary): HTMLElement {
  const slot = el("span", "glyph");
  if (t.status === "running") slot.append(miniSpinner()), slot.classList.add("working");
  else if (t.status === "waiting") slot.append(el("span", "dot")), slot.classList.add("input");
  else if (t.status === "error") slot.append(el("span", "dot")), slot.classList.add("failed");
  else if (store.done.has(t.id)) slot.append(icon("check")), slot.classList.add("done");
  else slot.append(el("span", "dot"));
  return slot;
}

const sortTime = (t: ThreadSummary) => (store.view.sort === "created" ? t.createdAt : t.updatedAt);
/** Settled rows read when the work wrapped up (their shelf's order); active ones follow the sort. */
const timeOf = (t: ThreadSummary) => t.settledAt ?? sortTime(t);

/** t3code's hover action: Settle moves a session to the Settled shelf, Un-settle brings it back. */
function settleButton(t: ThreadSummary, label: boolean): HTMLElement {
  const settled = t.settledAt != null;
  const b = el("button", "settle");
  const combo = prefs.keymap.settleSession;
  b.title = settled ? "Back to the active list" : `Settle session${combo ? ` · ${displayCombo(combo)}` : ""}`;
  b.append(icon(settled ? "undo2" : "circleCheck"));
  if (label) b.append(settled ? "Un-settle" : "Settle");
  b.onclick = (e) => {
    e.stopPropagation();
    actions.settle(t.id, !settled);
  };
  return b;
}

/** A session's row as the sidebar draws it, for lists elsewhere (the command palette). */
export const sessionRow = (t: ThreadSummary) => row(t, false);

/** `label`, then a pencil when the session holds an unsent draft (not on the one being typed in): after the
 *  project name on a card, after the title on a compact row (which has no project name). */
function withDraft(label: HTMLElement, t: ThreadSummary): HTMLElement[] {
  if (!hasDraft(t.id) || (store.opening ?? store.thread?.id) === t.id) return [label];
  label.classList.add("drafted");
  const mark = icon("pencil", undefined, "draft-mark");
  mark.title = "Draft";
  return [label, mark];
}

/** t3code's three-line card: project and status, the title, then branch and harness. Under a project's header
 *  the project line goes (the header already names it): the status moves up beside the title. */
function row(t: ThreadSummary, grouped: boolean): HTMLElement {
  const v = store.view;
  // Settled rows recede like Zeron's archived ones (style.css), at full strength when selected or hovered.
  // On a phone the list is a screen of its own, never beside the session: no row stays marked as the one open.
  const r = el("div", `row${!isPhone() && (store.opening ?? store.thread?.id) === t.id ? " selected" : ""}${v.compact ? " compact" : ""}${t.settledAt != null ? " settled" : ""}`);
  r.dataset.id = t.id;
  r.title = t.title;
  // A double click renames (its first click already opened the session).
  // A double click renames in place; on a phone, where two quick taps are just taps, only the session's ··· does.
  r.onclick = (e) => (e.detail === 2 && !isPhone() ? renameSession(t.id) : actions.open(t.id));
  // A right click, or a long press on a touch screen, opens its menu.
  r.oncontextmenu = (e) => {
    e.preventDefault();
    sessionMenu(t, r, { x: e.clientX, y: e.clientY });
  };

  if (v.compact) {
    // One line: status glyph, title, and a fixed time slot that becomes Archive on hover.
    const title = el("div", "line2");
    title.append(statusGlyph(t));
    if (v.harness) title.append(harnessIcon(t.harness, undefined, "harness"));
    if (v.projectIcon && !grouped) title.append(projectArt(projectOf(t.cwd), t.cwd));
    const corner = el("span", "corner slot");
    // A running session's slot counts its minutes instead.
    corner.append(el("span", "time", t.status === "running" ? workingFor(t) || "now" : timeAgo(timeOf(t))), settleButton(t, false));
    title.append(...withDraft(faded("title", t.title), t), corner);
    r.append(title);
    return r;
  }

  const corner = el("span", "corner");
  corner.append(statusCorner(t), settleButton(t, true));
  const line2 = el("div", "line2");
  if (grouped) {
    line2.append(...withDraft(faded("title", t.title), t), corner);
    r.append(line2);
  } else {
    const line1 = el("div", "line1");
    if (v.projectIcon) line1.append(projectArt(projectOf(t.cwd), t.cwd));
    line1.append(...withDraft(v.location ? faded("meta", projectName(t.cwd)) : el("span", "grow"), t), corner);
    line2.append(faded("title", t.title));
    r.append(line1, line2);
  }
  // With Branch and Harness both off, the card is two lines.
  if (v.branch || v.harness) {
    const line3 = el("div", "line3");
    // A worktree's session shows the branch it came off, then the worktree by its name (its own branch in the
    // tooltip); the one the project folder previews says so.
    const tree = worktreeOf(t.cwd);
    if (v.branch && tree) {
      const mark = icon("folderGit2");
      mark.title = `Worktree ${tree.name}${tree.branch ? ` · ${tree.branch}` : ""}${tree.from ? `, off ${tree.from}` : ""}`;
      if (tree.from) line3.append(icon("gitBranch"), el("span", "from", tree.from));
      line3.append(mark, faded("branch", tree.name));
    } else if (v.branch && t.branch) line3.append(icon("gitBranch"), faded("branch", t.branch));
    else line3.append(el("span", "grow"));
    if (tree && projectOf(t.cwd)?.preview === tree.path) {
      const shown = icon("monitorPlay", undefined, "previewing");
      shown.title = "The project folder is showing this worktree";
      line3.append(shown);
    }
    if (v.harness) {
      const h = harnessIcon(t.harness, undefined, "harness");
      h.title = HARNESS_NAMES[t.harness];
      line3.append(h);
    }
    r.append(line3);
  }
  return r;
}

// ---------------- new-session drafts ----------------
// t3code's draft rows: a new session left holding text or images sits atop its list like a session until it's
// sent or discarded (one still being written for the first time has none). A pen in the warning tone marks it.

/** The new-session screen is showing this draft. */
const draftOpen = (id: string) => !store.thread && !store.opening && openNewDraft().id === id;

/** It has a row: something in it, and moved away from at some point (or now). */
const listable = (d: NewDraft) => draftHasContent(d.id) && (!!d.left || !draftOpen(d.id));

/** The drafts the list was last drawn with, so typing only redraws it when one comes or goes. */
let listedDrafts = new Set<string>();

function discardButton(d: NewDraft, label: boolean): HTMLElement {
  // Rides the settle button's slot and hover swap (style.css).
  const b = el("button", "settle discard");
  const combo = prefs.keymap.settleSession;
  b.title = `Discard draft${combo ? ` · ${displayCombo(combo)}` : ""}`;
  b.append(icon("x"));
  if (label) b.append("Discard");
  b.onclick = (e) => {
    e.stopPropagation();
    // The open one gives way to a fresh, empty draft.
    discardNewDraft(d.id);
    render("sidebar", "header", "composer");
  };
  return b;
}

function draftRow(d: NewDraft, grouped: boolean): HTMLElement {
  const v = store.view;
  const p = store.projects.find((x) => x.id === d.projectId);
  const preview = draftPreview(d.id);
  const r = el("div", `row draft${!isPhone() && draftOpen(d.id) ? " selected" : ""}${v.compact ? " compact" : ""}`);
  r.dataset.id = d.id;
  r.title = preview;
  r.onclick = () => actions.open(d.id);
  r.oncontextmenu = (e) => {
    e.preventDefault();
    menu = contextMenu({ x: e.clientX, y: e.clientY }, [{ icon: "x", label: "Discard draft", danger: true, run: () => (discardNewDraft(d.id), render("sidebar", "header", "composer")) }], { beside: r, onClose: () => (menu = null) });
  };
  const pen = () => icon("squarePen", undefined, "draft-pen");

  if (v.compact) {
    const title = el("div", "line2");
    const glyph = el("span", "glyph");
    glyph.append(pen());
    title.append(glyph);
    if (v.projectIcon && !grouped && p) title.append(projectArt(p));
    const corner = el("span", "corner slot");
    corner.append(el("span", "time"), discardButton(d, false));
    title.append(faded("title", preview), corner);
    r.append(title);
    return r;
  }

  const corner = el("span", "corner");
  corner.append(el("span", "status drafting", "Draft"), discardButton(d, true));
  const line2 = el("div", "line2");
  if (grouped) {
    line2.append(pen(), faded("title", preview), corner);
    r.append(line2);
  } else {
    const line1 = el("div", "line1");
    line1.append(pen());
    if (v.projectIcon && p) line1.append(projectArt(p));
    line1.append(v.location && p ? faded("meta", p.name) : el("span", "grow"), corner);
    line2.append(faded("title", preview));
    r.append(line1, line2);
  }
  // The same height as a session's card: the branch it would start on, when cards show theirs.
  if (v.branch || v.harness) {
    const line3 = el("div", "line3");
    if (v.branch && p?.branch) line3.append(icon("gitBranch"), faded("branch", p.branch));
    else line3.append(el("span", "grow"));
    r.append(line3);
  }
  return r;
}

/** The draft being typed changed: its row comes or goes, or takes the new text in place (no rebuild per key). */
export function draftChanged(id: string) {
  if (!isNewDraft(id)) return;
  const d = newDraft(id);
  if (d && listedDrafts.has(id) !== listable(d)) return render("sidebar", "header");
  // The titlebar's plus shows once the draft on screen holds something.
  if (draftHasContent(id) !== plusShown) render("header");
  const r = $("sidebar-lists").querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`);
  const title = r?.querySelector<HTMLElement>(".title");
  if (!r || !title) return;
  r.title = title.textContent = draftPreview(id);
  fitFades(r);
}

export const sortedSummaries = () => {
  const key = store.view.sort === "created" ? "createdAt" : "updatedAt";
  // Zeron's compare_sidebar_chats: newest first, ties by id so equal times never swap places.
  // Sessions of a project just removed leave with it, before the core's next list arrives. Side chats are tabs of their
  // session's panel (sidechat.ts) until moved here.
  return [...store.summaries.values()].filter((t) => projectOf(t.cwd) && !t.parent).sort((a, b) => b[key] - a[key] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** Session ids top to bottom as the sidebar shows them (what next/previous and the jump shortcuts walk): a
 *  collapsed group reaches nothing, like Zeron's visible order. */
export const sessionOrder = () => [...$("sidebar-lists").querySelectorAll<HTMLElement>(".row[data-id]")].map((r) => r.dataset.id!);

/** The rows the jump shortcuts number, top to bottom: every shown one. Grouped by project, settled ones (history, under
 *  each project's active ones) are left out so the numbers stay on active sessions; the Settled shelf is numbered. */
const jumpRows = () => [...$("sidebar-lists").querySelectorAll<HTMLElement>(store.view.organize === "project" ? ".row[data-id]:not(.settled)" : ".row[data-id]")];
export const jumpOrder = () => jumpRows().map((r) => r.dataset.id!);

// ---------------- jump hints ----------------
// While exactly the jump shortcuts' modifiers are held (Alt by default), the first nine rows trade their
// corner for the key that opens them (Zeron's jump_hints_visible).

const JUMPS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `jump${n}` as `jump${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`);
let hints = false;


function setJumpHints(show: boolean) {
  if (hints === show) return;
  hints = show;
  const lists = $("sidebar-lists");
  lists.classList.toggle("jump-hints", show);
  if (show) labelJumpHints();
}

function labelJumpHints() {
  $("sidebar-lists").querySelectorAll(".jump-hint").forEach((h) => h.remove());
  jumpRows().forEach((r, i) => {
    const combo = i < JUMPS.length ? prefs.keymap[JUMPS[i]] : "";
    if (!combo) return;
    const hint = el("span", "jump-hint", displayCombo(combo));
    // Rides in the row's corner, which it replaces while shown.
    r.querySelector(".corner")?.append(hint);
  });
}

function trackJumpHints(e: KeyboardEvent | MouseEvent) {
  const held = heldModifiers(e);
  const matches = !!held && !recording.active && !pickerOpen() && JUMPS.some((id) => modifiersOf(prefs.keymap[id]) === held);
  // Inside Settings the same keys pick its tabs, so the hints move there.
  setSettingsJumpHints(matches && settingsOpen());
  setJumpHints(matches && store.view.jumpHints && !settingsOpen() && sidebarShown());
}

function renderLists() {
  trackRunning();
  // Mid-rename the list holds still (a rebuild would drop the field); finishing renders it again.
  if (renaming()) return;
  const lists = $("sidebar-lists");
  const all = sortedSummaries();
  const rows = all.filter((t) => t.settledAt == null);
  // Drafts of a removed project leave with it, like its sessions.
  const drafts = listedNewDrafts().filter((d) => listable(d) && store.projects.some((p) => p.id === d.projectId));
  listedDrafts = new Set(drafts.map((d) => d.id));
  let sections: HTMLElement[];
  if (store.view.organize === "project") {
    // A group per project, the one with the newest session first; projects without sessions still show. Settled
    // sessions stay in their project's group (under its active ones) instead of on the Settled shelf.
    const key = store.view.sort === "created" ? "createdAt" : "updatedAt";
    const groups = store.projects.map((p) => ({ p, rows: all.filter((t) => projectOf(t.cwd) === p), drafts: drafts.filter((d) => d.projectId === p.id) }));
    const at = (g: (typeof groups)[number]) => g.rows[0]?.[key] ?? 0;
    groups.sort((a, b) => at(b) - at(a) || a.p.createdAt - b.p.createdAt);
    sections = groups.map((g) => projectSection(g.p, g.rows, g.drafts));
    if (!sections.length) sections = [emptyProjects()];
  } else {
    // One group: all sessions, each row naming its project.
    const label = store.view.organize === "device" ? store.device : "Sessions";
    const head = el("div", `disclosure${store.sessionsOpen ? " open" : ""}`);
    if (store.view.organize === "device") head.append(icon("laptop", undefined, "head-icon"));
    head.append(el("span", "label", store.sessionsOpen ? label : `${label} (${rows.length})`), el("span", "grow"), icon("chevronRight", 12, "chev"));
    head.onclick = () => {
      store.sessionsOpen = !store.sessionsOpen;
      persist();
      renderLists();
    };
    const section = el("div", "section");
    section.dataset.key = "sessions";
    section.append(head);
    if (store.sessionsOpen) {
      const body = el("div", "disclosure-body");
      body.append(...drafts.map((d) => draftRow(d, false)));
      if (rows.length) body.append(...rows.map((t) => row(t, false)));
      else if (!drafts.length) body.append(!store.projects.length ? emptyProjects() : el("div", "sidebar-empty", all.length ? "Nothing active" : "No sessions yet"));
      section.append(body);
    }
    sections = [section];
  }
  const settled = store.view.organize !== "project" && settledShelf(all.filter((t) => t.settledAt != null));
  if (settled) sections.push(settled);
  withListMotion(lists, listPieces, () => {
    const scroll = lists.scrollTop;
    lists.replaceChildren(...sections);
    lists.scrollTop = scroll;
  });
  if (hints) labelJumpHints();
  fitFades(lists);
  edgeFades();
}

/** What the list's motion follows across a rebuild: rows by session or draft, headers and notes by section. */
function listPieces(root: HTMLElement): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>();
  for (const section of root.querySelectorAll<HTMLElement>(":scope > .section"))
    for (const e of section.querySelectorAll<HTMLElement>(".disclosure, .row[data-id], .sidebar-empty, .show-more"))
      out.set(e.dataset.id ?? `${section.dataset.key}:${e.classList[0]}`, e);
  return out;
}

// A project shows its first few sessions (active ones, then settled), the rest behind Show more: twice as many
// one-line compact rows as cards.
const PROJECT_INITIAL_COUNT = 5;
const PROJECT_INITIAL_COUNT_COMPACT = 10;
const PROJECT_PAGE_COUNT = 10;
const projectShown = new Map<string, number>();

/** A project's group: its art and name, New session and a menu on hover, then its drafts, its active sessions and
 *  its settled ones (newest-settled first, like the shelf), up to its cap. */
function projectSection(p: Project, rows: ThreadSummary[], drafts: NewDraft[]): HTMLElement {
  const open = !store.closedProjects.has(p.id);
  const head = el("div", `disclosure project-head${open ? " open" : ""}`);
  head.title = tildePath(p.path);
  if (store.view.projectIcon) head.append(projectArt(p));
  const active = rows.filter((t) => t.settledAt == null);
  const settled = rows.filter((t) => t.settledAt != null).sort((a, b) => b.settledAt! - a.settledAt! || (a.id < b.id ? -1 : 1));
  const label = el("span", "label", p.name);
  const tools = el("span", "group-tools");
  const more = el("button", "group-tool");
  more.title = "Project options";
  more.append(icon("ellipsis"));
  more.onclick = (e) => {
    e.stopPropagation();
    if (menu) return menu.close();
    projectMenu(p, head, menuPoint(e, more), more);
  };
  // A right click, or a long press on a touch screen (where the tools don't show), opens it too.
  head.oncontextmenu = (e) => {
    e.preventDefault();
    projectMenu(p, head, { x: e.clientX, y: e.clientY });
  };
  const plus = el("button", "group-tool");
  plus.title = `New session in ${p.name}`;
  plus.append(icon("squarePen"));
  plus.onclick = (e) => {
    e.stopPropagation();
    actions.newThread(p.id);
  };
  tools.append(more, plus);
  head.append(label, el("span", "grow"), tools, icon("chevronRight", 12, "chev"));
  head.onclick = () => {
    if (open) store.closedProjects.add(p.id);
    else store.closedProjects.delete(p.id);
    persist();
    renderLists();
  };
  const section = el("div", "section");
  section.dataset.project = p.id;
  section.dataset.key = `project:${p.id}`;
  section.append(head);
  if (open) {
    const body = el("div", "disclosure-body");
    body.append(...drafts.map((d) => draftRow(d, true)));
    const list = [...active, ...settled];
    // The open session never hides under Show more.
    const at = list.findIndex((t) => t.id === (store.opening ?? store.thread?.id));
    const shown = Math.max(projectShown.get(p.id) ?? (store.view.compact ? PROJECT_INITIAL_COUNT_COMPACT : PROJECT_INITIAL_COUNT), at + 1);
    const items: HTMLElement[] = list.slice(0, shown).map((t) => row(t, true));
    // Where the settled ones start, headed as the Settled shelf is (the active ones need no heading).
    if (active.length && settled.length && shown > active.length) {
      const head = el("div", "settled-head disclosure");
      head.append(el("span", "label", "Settled"));
      items.splice(active.length, 0, head);
    }
    body.append(...items);
    const hidden = list.length - shown;
    if (hidden > 0) {
      const more = el("button", "show-more");
      more.append(icon("plus"), `Show ${Math.min(hidden, PROJECT_PAGE_COUNT)} more`);
      more.onclick = () => {
        projectShown.set(p.id, shown + PROJECT_PAGE_COUNT);
        renderLists();
      };
      body.append(more);
    }
    if (!rows.length && !drafts.length) body.append(el("div", "sidebar-empty", "No sessions yet"));
    section.append(body);
  }
  return section;
}

// t3code's settled tail: recent history is the usual lookup, the deep tail stays behind Show more.
const SETTLED_TAIL_INITIAL_COUNT = 10;
const SETTLED_TAIL_PAGE_COUNT = 25;
let settledShown = SETTLED_TAIL_INITIAL_COUNT;

/** The Settled shelf under the active list, newest-settled first (Zeron's Archived section: open by default). */
function settledShelf(settled: ThreadSummary[]): HTMLElement | null {
  if (!settled.length) return null;
  settled.sort((a, b) => b.settledAt! - a.settledAt! || (a.id < b.id ? -1 : 1));
  const open = store.settledOpen;
  const head = el("div", `disclosure${open ? " open" : ""}`);
  head.append(el("span", "label", open ? "Settled" : `Settled (${settled.length})`), el("span", "grow"), icon("chevronRight", 12, "chev"));
  head.onclick = () => {
    store.settledOpen = !open;
    settledShown = SETTLED_TAIL_INITIAL_COUNT;
    persist();
    renderLists();
  };
  const section = el("div", "section settled-shelf");
  section.dataset.key = "settled";
  section.append(head);
  if (open) {
    // The open session never hides under Show more.
    const at = settled.findIndex((t) => t.id === (store.opening ?? store.thread?.id));
    const shown = Math.max(settledShown, at + 1);
    const body = el("div", "disclosure-body");
    body.append(...settled.slice(0, shown).map((t) => row(t, false)));
    const hidden = settled.length - shown;
    if (hidden > 0) {
      const more = el("button", "show-more");
      more.append(icon("plus"), `Show ${Math.min(hidden, SETTLED_TAIL_PAGE_COUNT)} more`);
      more.onclick = () => {
        settledShown = shown + SETTLED_TAIL_PAGE_COUNT;
        renderLists();
      };
      body.append(more);
    }
    section.append(body);
  }
  return section;
}

function emptyProjects(): HTMLElement {
  const empty = el("button", "sidebar-empty add-project");
  empty.append(icon("folderPlus"), "Add a project");
  empty.onclick = () => openPalette("folders");
  return empty;
}

let menu: Popover | null = null;

/** The project's "…" menu: New session, Rename, Remove (its sessions stay with the harnesses). */
function projectMenu(p: Project, head: HTMLElement, at: { x: number; y: number }, trigger?: HTMLElement) {
  const rename = () => {
    const label = head.querySelector<HTMLElement>(".label");
    if (label) editInline(label, p.name, (name) => name !== p.name && void call("projects.rename", { id: p.id, name: name || null }));
  };
  menu = contextMenu(
    at,
    [
      { icon: "squarePen", label: "New session", run: () => actions.newThread(p.id) },
      { icon: "pencil", label: "Rename…", run: rename },
      { icon: "circleCheck", label: "Settle all sessions", run: () => void call("projects.settleAll", { id: p.id }) },
      "-",
      { icon: "x", label: "Remove project", danger: true, run: () => void call("projects.remove", { id: p.id }) },
    ],
    { trigger, beside: head, onClose: () => (menu = null) },
  );
}

/** A session row's menu: Rename and Settle (or Bring back), as the session's own ··· on a phone has them. */
function sessionMenu(t: ThreadSummary, r: HTMLElement, at: { x: number; y: number }) {
  const settled = t.settledAt != null;
  menu = contextMenu(
    at,
    [
      { icon: "pencil", label: "Rename…", run: () => renameSession(t.id) },
      { icon: settled ? "rotateCcw" : "circleCheck", label: settled ? "Bring back" : "Settle", run: () => actions.settle(t.id, !settled) },
      ...previewItems(t),
    ],
    { beside: r, onClose: () => (menu = null) },
  );
}

/** A worktree session's: its files in the project folder, or the folder's own back when it's the one shown. */
function previewItems(t: ThreadSummary) {
  const tree = worktreeOf(t.cwd);
  const p = projectOf(t.cwd);
  if (!tree || !p) return [];
  const shown = p.preview === tree.path;
  return [{ icon: shown ? "house" : "monitorPlay", label: shown ? "Stop preview" : "Preview in project folder", run: () => void switchPreview(p, shown ? null : tree.path) } as const];
}

let editing = false;
/** A name is being edited in place: the sidebar and the chat titlebar hold off rebuilding until it's done. */
export const renaming = () => editing;

/** Rename in place: Enter keeps it, Escape or leaving the field drops it; `save` gets the trimmed name ("" asks
 *  for the original back). */
function editInline(label: HTMLElement, value: string, save: (name: string) => void) {
  if (editing) return;
  const input = el("input", "rename");
  input.value = value;
  input.spellcheck = false;
  label.replaceWith(input);
  input.focus();
  input.select();
  editing = true;
  const finish = (keep: boolean) => {
    if (!editing) return;
    editing = false;
    if (keep) save(input.value.trim());
    render("sidebar", "header");
    peek?.released();
  };
  input.onclick = (e) => e.stopPropagation();
  input.ondblclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  };
  input.onblur = () => finish(false);
}

/** Rename a session in place: on its sidebar row when that shows, else in the chat titlebar. An empty name
 *  goes back to the harness's title. */
export function renameSession(id: string) {
  const t = store.summaries.get(id);
  if (!t) return;
  if (isPhone()) return renameDialog(id, t.title);
  const row = sidebarShown() ? $("sidebar-lists").querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"] .title`) : null;
  const header = store.thread?.id === id ? $("chat-titlebar").querySelector<HTMLElement>(".title") : null;
  const label = row ?? header;
  if (!label) return;
  editInline(label, t.title, (name) => name !== t.title && actions.rename(id, name || null));
}

/** A phone renames in a dialog (from the session's ···): the name in a field of its own, with the keyboard up. Left
 *  empty, the session takes back the harness's name for it. */
function renameDialog(id: string, title: string) {
  const body = el("div", "rename-body");
  const input = el("input", "compact-input rename-field") as HTMLInputElement;
  input.value = title;
  input.placeholder = "Session name";
  input.spellcheck = false;
  input.enterKeyHint = "done";
  body.append(input, el("div", "s-dialog-body", "Leave it empty to go back to the original name."));
  dialog("Rename session", body, [
    ["Cancel", "filled", () => {}],
    ["Save", "solid", () => input.value.trim() !== title && actions.rename(id, input.value.trim() || null)],
  ]);
  input.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    input.closest(".s-dialog")?.querySelector<HTMLElement>(".s-dialog-footer > :last-child")?.click();
  };
  input.focus();
  input.select();
}

/** The list fades at an edge only while rows are scrolled past it. */
function edgeFades() {
  const lists = $("sidebar-lists");
  lists.classList.toggle("fade-top", lists.scrollTop > 0);
  lists.classList.toggle("fade-bottom", lists.scrollTop + lists.clientHeight < lists.scrollHeight - 1);
}

/** `refocus`: the composer takes the focus (the sidebar's peek went with it). */
export function initSidebar(refocus: () => void) {
  titlebarCluster();
  peek = edgePeek({
    side: "left",
    panel: $("sidebar"),
    cls: "sidebar-peek",
    peekable: () => store.sidebarCollapsed && !isPhone() && !$("app").classList.contains("settings-open"),
    // A menu (a session's, the view options) or a name being typed in it holds it out.
    holding: () => openPopovers() > 0 || renaming(),
    refocus,
  });
  // A menu closed (or a rename entered) with the pointer out past it: it waits for the pointer to come back.
  onPopoverClosed(() => peek!.released());
  $("app").classList.toggle("sidebar-collapsed", store.sidebarCollapsed);
  // Animate toggles only once the restored state has painted.
  requestAnimationFrame(() => requestAnimationFrame(() => $("app").classList.add("animated")));
  $("sidebar-lists").addEventListener("scroll", edgeFades, { passive: true });

  // The view menu lives in the sidebar's titlebar band, right-aligned, and slides away with the sidebar.
  const dots = el("button", "wc-btn view-btn");
  dots.title = "View options";
  dots.append(icon("ellipsis"));
  dots.onclick = () => toggleViewMenu(dots);
  $("sidebar-top").replaceChildren(dots);

  const settings = el("button", "footer-btn");
  settings.title = "Settings";
  settings.setAttribute("aria-label", "Settings");
  settings.append(icon("settings"));
  settings.onclick = () => toggleSettings();
  $("sidebar-footer").replaceChildren(settings);
  void document.fonts.ready.then(() => fitFades($("sidebar")));
  new ResizeObserver(() => {
    fitFades($("sidebar"));
    edgeFades();
  }).observe($("sidebar-lists"));

  // A hidden window keeps the running times but rebuilds no rows: nobody sees them, and each old list stays alive
  // until it shows (its spinners' animations hold on to it). It catches up when shown.
  let stale = false;
  on("sidebar", () => (document.hidden ? (trackRunning(), (stale = true)) : renderLists()));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !stale) return;
    stale = false;
    renderLists();
  });
  addEventListener("keydown", trackJumpHints, true);
  addEventListener("keyup", trackJumpHints, true);
  addEventListener("blur", () => {
    setJumpHints(false);
    setSettingsJumpHints(false);
  });
  // Clicking away (or a dialog opening) with the modifier still down shouldn't strand the chips.
  addEventListener("pointerdown", trackJumpHints, true);
  setInterval(() => render("sidebar"), 30_000); // keep time-ago fresh
}
