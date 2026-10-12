// The palettes (Zeron's shell/command_palette.rs and its New project flow in shell/spaces.rs), one card over a
// scrim with three views:
// - commands (Mod+K): the commands, then every session (the sidebar's rows, newest first);
// - projects (Mod+O, "New session in…"): pick the project a new session starts in;
// - folders ("New project"): browse this machine's folders and add one as a project;
// - files (Mod+P, "Go to file"): the open session's files by name (VS Code's Quick Open), its open tabs until typed;
// - mcp ("MCP servers"): every MCP server any harness defines, with each harness's switch for it in a project.
// Typing filters; ↑↓ move, Enter picks, Esc closes.
import type { FolderListing, HarnessId, McpScope, McpServer, McpSnapshot, Project, ThreadSummary } from "../shared/model";
import { el, fitFades } from "./dom";
import { fileGlyph } from "./fileicons";
import { HARNESS_NAMES, harnessIcon, icon, type IconName } from "./icons";
import { displayCombo } from "./keymap";
import { toggleSwitch } from "./popover";
import { prefs, setPrefs, type Scheme, type ShortcutId } from "./prefs";
import { restartApp } from "./restart";
import { closeSettings, openSettings, refresh } from "./settings";
import { projectArt, renameSession, sessionRow, sortedSummaries, toggleSidebar } from "./sidebar";
import { newTerminal, toggleMaximize, toggleTerminal } from "./terminal";
import { newSideChat, openBrowser, closeActiveFile, reopenClosedFile, collapseFolders, copyActivePath, downloadPdf, expandFolders, findFiles, loadSuggestions, openFile, openReview, showChangesSince, showCommit, suggestedFiles, toggleChanges, toggleExpand, toggleFiles, revealActiveFile, toggleHiddenFiles, togglePane, togglePreview } from "./panels";
import { actions, call, on, projectName, store, targetProject, tildePath, workFolder } from "./store";

const HISTORY_RESULT_LIMIT = 30;
/** Folder crumbs shown before the middle folds into `…`, and how many of the deepest stay once it does. */
const CRUMB_FOLDERS_MAX = 3;
const CRUMB_FOLDERS_TAIL = 2;

export type PaletteView = "commands" | "projects" | "folders" | "files" | "mcp";
type Command = { label: string; icon: IconName; combo: () => string | null; run: () => void; keepOpen?: true };
type Entry = { group: string; render: (q: string[]) => HTMLElement; pick: () => void };

const bound = (id: ShortcutId) => prefs.keymap[id] || null;

/** Settings → Appearance's colour scheme; rebuilds Settings when it's open so its cards follow. */
const setScheme = (scheme: Scheme) => (setPrefs({ scheme }), refresh());

const COMMANDS: Command[] = [
  { label: "New session", icon: "squarePen", combo: () => bound("newSession"), run: () => actions.newThread() },
  { label: "New session in…", icon: "squarePen", combo: () => bound("newSessionIn"), run: () => showView("projects"), keepOpen: true },
  { label: "New project", icon: "folderPlus", combo: () => null, run: () => showView("folders"), keepOpen: true },
  {
    label: "Toggle sidebar",
    icon: "panelLeft",
    combo: () => bound("toggleSidebar"),
    // Settings covers the sidebar: leave it so the change shows.
    run: () => (closeSettings(), toggleSidebar()),
  },
  { label: "Toggle right panel", icon: "panelRight", combo: () => bound("toggleRightPane"), run: () => (closeSettings(), togglePane()) },
  { label: "Expand right panel", icon: "maximize2", combo: () => bound("expandRightPane"), run: () => (closeSettings(), toggleExpand()) },
  { label: "Toggle files panel", icon: "folderTree", combo: () => bound("toggleFiles"), run: () => (closeSettings(), toggleFiles()) },
  { label: "Show changes (source control)", icon: "gitBranch", combo: () => bound("showChanges"), run: () => (closeSettings(), showCommit()) },
  { label: "Review changes", icon: "gitCompare", combo: () => bound("showReview"), run: () => (closeSettings(), openReview()) },
  { label: "Go to file", icon: "search", combo: () => bound("quickOpen"), run: () => showView("files"), keepOpen: true },
  { label: "Show or hide ignored files", icon: "eye", combo: () => bound("toggleHiddenFiles"), run: () => (closeSettings(), toggleHiddenFiles()) },
  { label: "Expand all folders", icon: "folderOpen", combo: () => bound("expandFolders"), run: () => (closeSettings(), void expandFolders()) },
  { label: "Collapse all folders", icon: "folder", combo: () => bound("collapseFolders"), run: () => (closeSettings(), collapseFolders()) },
  { label: "Close file", icon: "x", combo: () => bound("closeFile"), run: () => (closeSettings(), closeActiveFile()) },
  { label: "New browser tab", icon: "globe", combo: () => bound("newBrowserTab"), run: () => (closeSettings(), openBrowser()) },
  { label: "New side chat", icon: "messageCirclePlus", combo: () => bound("sideChat"), run: () => (closeSettings(), void newSideChat()) },
  { label: "Reopen closed file", icon: "rotateCcw", combo: () => bound("reopenFile"), run: () => (closeSettings(), reopenClosedFile()) },
  { label: "Copy path of current file", icon: "clipboardCopy", combo: () => null, run: () => (closeSettings(), copyActivePath()) },
  { label: "Reveal current file in file manager", icon: "folderOpen", combo: () => bound("revealFile"), run: () => (closeSettings(), revealActiveFile()) },
  { label: "Toggle preview", icon: "bookOpen", combo: () => bound("togglePreview"), run: () => (closeSettings(), togglePreview()) },
  { label: "Show or hide changes in files", icon: "gitCompare", combo: () => null, run: () => (closeSettings(), toggleChanges()) },
  { label: "Show uncommitted changes", icon: "gitCompare", combo: () => null, run: () => (closeSettings(), showChangesSince("uncommitted")) },
  { label: "Show last turn's changes", icon: "gitCompare", combo: () => null, run: () => (closeSettings(), showChangesSince("turn")) },
  { label: "Show unpushed changes", icon: "gitCompare", combo: () => null, run: () => (closeSettings(), showChangesSince("unpushed")) },
  { label: "Show this branch's changes", icon: "gitCompare", combo: () => null, run: () => (closeSettings(), showChangesSince("branch")) },
  { label: "Download PDF", icon: "download", combo: () => null, run: () => (closeSettings(), downloadPdf()) },
  { label: "Toggle terminal", icon: "squareTerminal", combo: () => bound("toggleTerminal"), run: () => (closeSettings(), toggleTerminal()) },
  { label: "New terminal", icon: "plus", combo: () => bound("newTerminal"), run: () => (closeSettings(), newTerminal()) },
  { label: "Maximize terminal", icon: "maximize2", combo: () => bound("maximizeTerminal"), run: () => (closeSettings(), toggleMaximize()) },
  {
    label: "Rename session",
    icon: "pencil",
    combo: () => bound("renameSession"),
    run: () => store.thread && (closeSettings(), renameSession(store.thread.id)),
  },
  { label: "MCP servers", icon: "plug", combo: () => null, run: () => openMcp(targetProject()), keepOpen: true },
  { label: "MCP servers in…", icon: "plug", combo: () => null, run: () => pickProjectForMcp(), keepOpen: true },
  { label: "Switch to light mode", icon: "sun", combo: () => null, run: () => setScheme("light") },
  { label: "Switch to dark mode", icon: "moon", combo: () => null, run: () => setScheme("dark") },
  { label: "Open settings", icon: "settings", combo: () => "mod-,", run: () => openSettings() },
  // VS Code's restart: the core (and this window) start again with the code on disk, after checking it.
  { label: "Restart bismuth", icon: "rotateCcw", combo: () => null, run: () => void restartApp() },
];

let palette: {
  scrim: HTMLElement;
  card: HTMLElement;
  head: HTMLElement;
  input: HTMLInputElement;
  crumbs: HTMLElement;
  list: HTMLElement;
  error: HTMLElement;
  foot: HTMLElement;
  returnFocus: Element | null;
  view: PaletteView | null; // null until the first view shows
  /** Where Back from the folder browser's top returns to. */
  from: PaletteView | null;
} | null = null;
let entries: Entry[] = [];
let active = 0;

// The folder browser's state: the open folder's listing (null while the first one loads).
let listing: FolderListing | null = null;
let loadingPath: string | null = null;
let browseError: string | null = null;
let adding = false;

// Go to file's matches (null until the first come back) and the query they're for; earlier queries answering late
// are dropped.
let found: string[] | null = null;
let foundFor = "";
let findSeq = 0;
/** Go to file's suggestions are still coming in. */
let suggesting = false;

// MCP servers: the project they're for, its servers (null while they load), the rows as listed, the harness column
// the keyboard is on, why the last switch failed. Answers to an earlier load or switch are dropped once a newer one
// went out.
let mcpProject: Project | null = null;
let mcpSnapshot: McpSnapshot | null = null;
let mcpRows: McpServer[] = [];
let mcpColumn = 0;
let mcpError: string | null = null;
let mcpSeq = 0;
/** The projects view picks a project for MCP servers rather than starting a session. */
let projectForMcp = false;

export const paletteOpen = () => !!palette;

/** Mod+K / Mod+O: open on that view, switch to it, or close it when it's already showing. */
export function togglePalette(view: PaletteView = "commands") {
  if (palette?.view === view) closePalette();
  else if (palette) showView(view);
  else openPalette(view);
}

/** Every query word must appear somewhere in the text (Zeron's matches_query). */
const words = () => palette!.input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
const matches = (q: string[], text: string) => q.every((w) => text.toLowerCase().includes(w));

export function openPalette(view: PaletteView = "commands"): void {
  if (palette) return showView(view);
  const scrim = el("div", "s-scrim palette-scrim");
  const card = el("div", "cmd-palette menu-in");
  card.setAttribute("role", "dialog");
  const head = el("label", "palette-head");
  const input = el("input");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  const crumbs = el("div", "palette-crumbs");
  const list = el("div", "palette-list");
  list.addEventListener("scroll", () => edgeFades(list), { passive: true });
  const error = el("div", "palette-error");
  const foot = el("div", "palette-foot");
  card.append(head, crumbs, list, error, foot);
  scrim.append(card);
  scrim.onpointerdown = (e) => e.target === scrim && closePalette();
  card.addEventListener("keydown", onKey);
  input.oninput = () => {
    active = 0;
    list.scrollTop = 0;
    if (palette?.view === "folders") followTypedPath();
    if (palette?.view === "files") find();
    renderList();
  };
  palette = { scrim, card, head, input, crumbs, list, error, foot, returnFocus: document.activeElement, view: null, from: null };
  document.body.append(scrim);
  showView(view);
}

export function closePalette() {
  if (!palette) return;
  const { scrim, returnFocus } = palette;
  palette = null;
  projectForMcp = false;
  scrim.remove();
  (returnFocus as HTMLElement | null)?.focus?.({ preventScroll: true });
}

function showView(view: PaletteView): void {
  if (!palette) return openPalette(view);
  const p = palette;
  if (view !== "projects") projectForMcp = false;
  if (view === "mcp") {
    mcpSnapshot = null;
    mcpError = null;
    void loadMcp();
  }
  if (view === "folders" && p.view !== "folders") {
    p.from = p.view;
    listing = null;
    browseError = null;
    void load(prefs.projectsDir, true);
  }
  if (view === "files") {
    found = null;
    foundFor = "";
    findSeq++;
    // Shown at once from what's known; the changes and the top folder's files join as they arrive.
    suggesting = true;
    void loadSuggestions()
      .catch(() => {})
      .finally(() => {
        suggesting = false;
        if (palette?.view === "files" && !palette.input.value.trim()) renderList();
      });
  }
  p.view = view;
  p.card.classList.toggle("files", view === "files");
  p.card.classList.toggle("mcp", view === "mcp");
  p.input.value = "";
  active = 0;
  const [placeholder, combo] = {
    commands: ["Search commands and sessions…", "mod-k"],
    projects: ["Search projects…", projectForMcp ? null : bound("newSessionIn")],
    folders: ["Search folders…", null],
    files: ["Search files by name…", bound("quickOpen")],
    mcp: ["Search MCP servers…", null],
  }[view];
  p.input.placeholder = placeholder!;
  p.card.setAttribute(
    "aria-label",
    { commands: "Command palette", projects: projectForMcp ? "MCP servers in…" : "New session in…", folders: "New project", files: "Go to file", mcp: "MCP servers" }[view],
  );
  p.head.replaceChildren(icon("search"), p.input, ...(combo ? [kbd(displayCombo(combo))] : []));
  renderFoot();
  renderList();
  p.input.focus();
}

// ---------------- entries ----------------

function collect(): Entry[] {
  const q = words();
  if (palette!.view === "projects") return projectEntries(q);
  if (palette!.view === "folders") return folderEntries();
  if (palette!.view === "files") return fileEntries();
  if (palette!.view === "mcp") return mcpEntries(q);
  const commands = COMMANDS.filter((c) => matches(q, c.label)).map(commandEntry);
  // Limit after filtering, so every session stays searchable.
  const threads = sortedSummaries()
    .filter((t) => matches(q, `${t.title} ${projectName(t.cwd)} ${store.device} ${t.branch ?? ""}`))
    .slice(0, HISTORY_RESULT_LIMIT)
    .map(threadEntry);
  return [...commands, ...threads];
}

function commandEntry(c: Command): Entry {
  return {
    group: "commands",
    render: (q) => {
      const item = el("button", "palette-command");
      const label = el("span", "label");
      label.append(highlight(c.label, q));
      item.append(icon(c.icon), label);
      const combo = c.combo();
      if (combo) item.append(kbd(displayCombo(combo)));
      return item;
    },
    pick: () => {
      if (!c.keepOpen) closePalette();
      c.run();
    },
  };
}

function threadEntry(t: ThreadSummary): Entry {
  return {
    group: "sessions",
    render: (q) => {
      // The palette's copy of a sidebar row only opens; it never settles.
      const item = sessionRow(t);
      // Search shows settled sessions at full strength, like Zeron's.
      item.classList.remove("selected", "settled");
      item.querySelector(".settle")?.remove();
      item.querySelector(".title")?.replaceChildren(highlight(t.title, q));
      return item;
    },
    pick: () => {
      closePalette();
      actions.open(t.id);
    },
  };
}

/** The projects, the one new sessions start in first, then by last use; New project closes the list. Picking one
 *  starts a session there, or (from MCP servers) shows its servers. */
function projectEntries(q: string[]): Entry[] {
  const target = projectForMcp ? mcpProject : targetProject();
  const sorted = [...store.projects].sort((a, b) => Number(b.id === target?.id) - Number(a.id === target?.id) || b.lastUsedAt - a.lastUsedAt);
  const rows: Entry[] = sorted
    .filter((p) => matches(q, `${p.name} ${tildePath(p.path)}`))
    .map((p) => ({
      group: "projects",
      render: (q) => {
        const item = el("button", "palette-command palette-project");
        const label = el("span", "label");
        const name = el("span", "name");
        name.append(highlight(p.name, q));
        const path = el("span", "path");
        path.append(highlight(tildePath(p.path), q));
        label.append(name, path);
        item.append(projectArt(p), label);
        if (p.id === target?.id) item.append(el("span", "palette-note", "Current"));
        return item;
      },
      pick: () => {
        if (projectForMcp) return openMcp(p);
        closePalette();
        actions.newThread(p.id);
      },
    }));
  const add = COMMANDS.find((c) => c.label === "New project")!;
  if (!projectForMcp && matches(q, add.label)) rows.push({ ...commandEntry(add), group: "actions" });
  return rows;
}

/** The open folder's subfolders, filtered by the query (or by a typed path's last segment). */
function folderEntries(): Entry[] {
  if (!listing) return [];
  const { filter } = typedPath();
  const f = filter.toLowerCase();
  return listing.entries
    .filter((e) => !f || e.name.toLowerCase().includes(f))
    .map((e) => ({
      group: "folders",
      render: () => {
        const item = el("button", "palette-command palette-folder");
        const label = el("span", "label");
        label.append(highlight(e.name, f ? [f] : []));
        item.append(icon("folder"), label);
        if (e.isRepo) {
          const repo = icon("gitBranch", undefined, "repo");
          repo.title = "Git repository";
          item.append(repo);
        }
        return item;
      },
      pick: () => descend(e.path),
    }));
}

/** The files matching the query, best first; before anything's typed, the suggested ones (open, recent, changed,
 *  top level). */
function fileEntries(): Entry[] {
  const q = palette!.input.value.trim();
  return (q ? (found ?? []).map((path) => ({ path, group: "found" })) : suggestedFiles()).map(({ path, group }) => ({
    group,
    render: () => fileRow(path, q),
    pick: () => {
      closePalette();
      // Settings covers the panels: leave it so the file shows.
      closeSettings();
      openFile(path);
    },
  }));
}

function find() {
  const q = palette!.input.value.trim();
  const seq = ++findSeq;
  if (!q) return void ((found = null), (foundFor = ""));
  void findFiles(q)
    .then((paths) => {
      if (seq !== findSeq || palette?.view !== "files") return;
      found = paths;
      foundFor = q;
      active = 0;
      renderList();
    })
    .catch(() => {});
}

/** A file's name, then its folder, with what the query matched marked: the core matches the query's characters in
 *  order (spaces left out), so the name's run of them when it has one, else the first place each appears. Go to
 *  file's rows, and the composer's `@` list's (mentions.ts). */
export function fileRow(entry: string, query: string): HTMLElement {
  // A folder (a nested repository) ends with a slash.
  const dir = entry.endsWith("/");
  const path = dir ? entry.slice(0, -1) : entry;
  const q = query.toLowerCase().replace(/\s+/g, "");
  const lower = path.toLowerCase();
  const nameAt = path.lastIndexOf("/") + 1;
  const hit = new Array<boolean>(path.length).fill(false);
  const run = q ? lower.indexOf(q, nameAt) : -1;
  if (run >= 0) hit.fill(true, run, run + q.length);
  else for (let i = 0, at = -1; i < q.length && (at = lower.indexOf(q[i], at + 1)) >= 0; i++) hit[at] = true;
  const item = el("button", "palette-command palette-file");
  const label = el("span", "label");
  const name = el("span", "name");
  name.append(marked(path.slice(nameAt), hit.slice(nameAt)));
  label.append(name);
  if (nameAt) {
    const dir = el("span", "path");
    // Shown right to left so a long one cuts at its start: the marks keep a leading "." where it is.
    dir.append("\u200e", marked(path.slice(0, nameAt - 1), hit.slice(0, nameAt - 1)), "\u200e");
    label.append(dir);
  }
  item.title = entry;
  item.append(fileGlyph(path, dir), label);
  return item;
}

function renderList() {
  if (!palette) return;
  const { list } = palette;
  entries = collect();
  active = Math.min(active, Math.max(0, entries.length - 1));
  const q = words();
  const rows: HTMLElement[] = [];
  entries.forEach((entry, i) => {
    if (i > 0 && entries[i - 1].group !== entry.group) rows.push(el("div", "palette-sep"));
    const item = entry.render(q);
    item.classList.add("palette-item");
    item.classList.toggle("active", i === active);
    item.onclick = (e) => {
      e.stopPropagation();
      entry.pick();
    };
    // Pointer motion moves the highlight, so hover and keyboard never light two rows; rows scrolling under a
    // resting pointer don't steal the keyboard's place.
    item.onpointermove = () => i !== active && setActive(i);
    rows.push(item);
  });
  if (!rows.length) rows.push(emptyState());
  list.replaceChildren(...rows);
  fitFades(list);
  edgeFades(list);
  if (palette.view === "folders") renderCrumbs();
  else if (palette.view === "mcp") (renderMcpProject(), markMcpColumn());
  else palette.crumbs.hidden = true;
  const error = palette.view === "folders" ? browseError : palette.view === "mcp" ? mcpError : null;
  palette.error.hidden = !error;
  palette.error.textContent = error ?? "";
}

function emptyState(): HTMLElement {
  const empty = el("div", "palette-empty");
  const view = palette!.view;
  const add = displayCombo("mod-enter");
  const [title, hint] =
    view === "folders"
      ? !listing
        ? [loadingPath ? "Loading folders…" : "Couldn't open this folder", ""]
        : palette!.input.value.trim()
          ? ["No folders match", "Type a path like ~/code or /mnt to jump there."]
          : ["No folders here", `Add this folder with ${add}, or go back with ←.`]
      : view === "projects"
        ? ["No projects match", "Try a project name or path."]
        : view === "files"
          ? !workFolder()
            ? ["No project open", "Add a project to find files in its folder."]
            : !palette!.input.value.trim()
              ? suggesting
                ? ["Loading files…", ""]
                : ["No files here", "This folder is empty."]
              : foundFor !== palette!.input.value.trim()
                ? ["Searching…", ""]
                : ["No files match", "Try part of a file's name or path."]
          : view === "mcp"
            ? !mcpProject
              ? ["No project yet", "Add a project to manage its MCP servers."]
              : !mcpSnapshot
                ? ["Loading MCP servers…", ""]
                : palette!.input.value.trim()
                  ? ["No servers match", "Try a server's name, the harness that defines it, or its file."]
                  : ["No MCP servers", "Add them with claude mcp add, codex mcp add, or in ~/.cursor/mcp.json."]
            : ["No results", "Try a command, session title, project, or device."];
  empty.append(el("div", "", title));
  if (hint) empty.append(el("div", "hint", hint));
  return empty;
}

function setActive(i: number, scroll = false) {
  if (!palette) return;
  active = i;
  const items = palette.list.querySelectorAll<HTMLElement>(".palette-item");
  items.forEach((n, j) => n.classList.toggle("active", j === i));
  if (scroll) items[i]?.scrollIntoView({ block: "nearest" });
}

function onKey(e: KeyboardEvent) {
  if (!palette) return;
  const n = entries.length;
  const folders = palette.view === "folders";
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (n) setActive((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n, true);
  } else if (palette.view === "mcp" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    // ←/→ move between the harnesses, not the caret: the list is a grid.
    moveMcpColumn(e.key === "ArrowRight" ? 1 : -1);
  } else if (e.key === "Enter" && mod && palette.view === "mcp") {
    if (!e.repeat && mcpRows[active]) void switchMcp(mcpRows[active], mcpColumns()[mcpColumn], "all");
  } else if (e.key === "Enter" && mod && folders) {
    // Adds the folder that's open (the breadcrumbs' last), never the highlight: that rests on the first row.
    if (!e.repeat) void addOpenFolder();
  } else if (e.key === "Enter") {
    // A held Enter picks once, not again in whatever opens next.
    if (!e.repeat && entries[active]) entries[active].pick();
  } else if (folders && (e.key === "ArrowRight" || e.key === "Tab")) {
    // ←/→ act on the folders, not the text caret: the browser is a navigator first.
    entries[active]?.pick();
  } else if (folders && (e.key === "ArrowLeft" || (e.key === "Backspace" && !palette.input.value))) {
    goUp();
  } else if (e.key === "Escape") closePalette();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

// ---------------- the folder browser ----------------

/** `start`: the browser's first folder (Settings → Projects' base folder), home instead when it's gone. */
async function load(path: string | null, start = false) {
  loadingPath = path ?? "~";
  try {
    const next = await call("fs.list", { path });
    if (!palette || loadingPath !== (path ?? "~")) return;
    listing = next;
    browseError = null;
  } catch (err: any) {
    if (!palette || loadingPath !== (path ?? "~")) return;
    if (start && path) return void load(null);
    browseError = String(err?.message ?? err);
  } finally {
    if (loadingPath === (path ?? "~")) loadingPath = null;
  }
  if (palette?.view === "folders") {
    active = Math.min(active, Math.max(0, folderEntries().length - 1));
    renderList();
    renderFoot();
  }
}

function descend(path: string) {
  if (!palette) return;
  palette.input.value = "";
  active = 0;
  palette.list.scrollTop = 0;
  void load(path);
}

/** Up a folder; from the top of the filesystem, back to the palette this came from. */
function goUp() {
  if (!palette) return;
  if (listing?.parent) return descend(listing.parent);
  if (palette.from) showView(palette.from);
}

/** A query starting with / or ~ is a path: its folder opens and its last segment filters. */
function typedPath(): { dir: string | null; filter: string } {
  const raw = palette?.input.value.trim() ?? "";
  if (!raw.startsWith("/") && !raw.startsWith("~")) return { dir: null, filter: raw };
  const cut = raw.lastIndexOf("/");
  if (cut < 0) return { dir: "~", filter: "" }; // "~"
  return { dir: raw.slice(0, cut + 1), filter: raw.slice(cut + 1) };
}

let followTimer: ReturnType<typeof setTimeout> | null = null;
function followTypedPath() {
  const { dir } = typedPath();
  if (!dir || !listing) return;
  const home = listing.home;
  const full = (dir.startsWith("~") ? home + dir.slice(1) : dir).replace(/(.)\/+$/, "$1");
  if (full === listing.path) return;
  if (followTimer) clearTimeout(followTimer);
  followTimer = setTimeout(() => void load(full), 80);
}

async function addOpenFolder() {
  if (!palette || !listing || adding) return;
  adding = true;
  renderFoot();
  try {
    const project = await call("projects.add", { path: listing.path });
    // The core broadcasts the new list too; have it now so the new session's chip shows it at once.
    store.projects = [...store.projects.filter((p) => p.id !== project.id), project];
    closePalette();
    actions.newThread(project.id);
  } catch (err: any) {
    browseError = String(err?.message ?? err);
    renderList();
  } finally {
    adding = false;
    if (palette) renderFoot();
  }
}

/** Back, then Home (or /) and the folders under it; a deep path folds its middle into `…`. */
function renderCrumbs() {
  const { crumbs } = palette!;
  crumbs.hidden = false;
  const back = el("button", "crumb-back");
  back.title = listing?.parent ? "Up a folder" : "Back";
  back.append(icon("arrowLeft"));
  back.onclick = goUp;
  const trail = el("div", "crumb-trail");
  const path = listing?.path ?? loadingPath ?? "";
  const home = listing?.home ?? store.home;
  const underHome = !!home && (path === home || path.startsWith(home + "/"));
  const root = underHome ? home : "/";
  const parts = path.slice(root.length).split("/").filter(Boolean);
  const folders = parts.map((name, i) => ({ name, full: root.replace(/\/$/, "") + "/" + parts.slice(0, i + 1).join("/") }));
  const hidden = folders.length > CRUMB_FOLDERS_MAX ? folders.splice(0, folders.length - CRUMB_FOLDERS_TAIL) : [];
  const crumb = (label: string, target: string | null, glyph?: IconName) => {
    const c = el("button", `crumb${target === null ? " current" : ""}`);
    if (glyph) c.append(icon(glyph));
    c.append(el("span", "", label));
    if (target !== null) c.onclick = () => descend(target);
    return c;
  };
  const items: HTMLElement[] = [crumb(underHome ? "Home" : "/", path === root ? null : root, underHome ? "house" : undefined)];
  if (hidden.length) {
    const more = crumb("…", hidden[hidden.length - 1].full);
    more.title = hidden.map((h) => h.name).join(" / ");
    items.push(more);
  }
  for (const f of folders) items.push(crumb(f.name, f.full === path ? null : f.full));
  trail.append(...items.flatMap((c, i) => (i ? [icon("chevronRight", undefined, "sep"), c] : [c])));
  crumbs.replaceChildren(back, trail);
  // The trail scrolls sideways rather than wrapping, and follows the open folder.
  requestAnimationFrame(() => (trail.scrollLeft = trail.scrollWidth));
}

// ---------------- MCP servers ----------------

const HARNESS_ORDER: HarnessId[] = ["claude", "codex", "cursor"];
const MCP_STATUS: Record<NonNullable<McpUse["status"]>, string> = {
  connected: "Connected",
  starting: "Starting",
  failed: "Failed",
  needsAuth: "Needs login",
  disabled: "Disabled",
};
type McpUse = NonNullable<McpServer["uses"][HarnessId]>;

/** MCP servers for a project (null: there's none yet), the palette opened on them (the composer's `/mcp`). */
export function openMcp(project: Project | null) {
  mcpProject = project;
  // The keyboard starts on the all-harnesses switch.
  mcpColumn = 0;
  openPalette("mcp");
}

function pickProjectForMcp() {
  mcpProject ??= targetProject();
  projectForMcp = true;
  showView("projects");
}

const mcpHarnesses = () => HARNESS_ORDER.filter((h) => mcpSnapshot?.harnesses.includes(h));
/** One switch for all the harnesses (with more than one): first, as most changes are for all of them. Then one per
 *  harness. */
type McpColumn = HarnessId | "all";
const mcpColumns = (): McpColumn[] => {
  const hs = mcpHarnesses();
  return hs.length > 1 ? ["all", ...hs] : hs;
};
/** The harnesses the all switch flips: those whose switch for the server isn't locked. */
const switchable = (s: McpServer) => mcpHarnesses().filter((h) => s.uses[h] && !s.uses[h]!.locked);
const allOn = (s: McpServer) => switchable(s).length > 0 && switchable(s).every((h) => s.uses[h]!.enabled);

async function loadMcp() {
  const project = mcpProject;
  if (!project) return;
  const seq = ++mcpSeq;
  try {
    const snapshot = await call("mcp.list", { projectId: project.id });
    if (seq !== mcpSeq) return;
    mcpSnapshot = snapshot;
  } catch (err: any) {
    if (seq !== mcpSeq) return;
    mcpSnapshot = { harnesses: [], servers: [] };
    mcpError = String(err?.message ?? err);
  }
  mcpColumn = Math.min(mcpColumn, Math.max(0, mcpColumns().length - 1));
  if (palette?.view === "mcp") renderList();
}

/** The servers in the order their harnesses come, each a row of switches. */
function mcpEntries(q: string[]): Entry[] {
  mcpRows = (mcpSnapshot?.servers ?? [])
    .filter((s) => matches(q, `${s.title ?? ""} ${s.name} ${fromName(s)} ${s.source} ${s.target ?? ""}`))
    // bismuth's own first, then by the harness that defines them.
    .sort((a, b) => fromOrder(a) - fromOrder(b) || a.name.localeCompare(b.name));
  return mcpRows.map((s) => ({ group: "servers", render: (q) => mcpRow(s, q), pick: () => void switchMcp(s, mcpColumns()[mcpColumn], "project") }));
}

const fromName = (s: McpServer) => (s.from === "bismuth" ? "bismuth" : HARNESS_NAMES[s.from]);
const fromOrder = (s: McpServer) => (s.from === "bismuth" ? -1 : HARNESS_ORDER.indexOf(s.from));

/** Name, the harness and file that define it, then a switch for all the harnesses and one per harness. */
function mcpRow(s: McpServer, q: string[]): HTMLElement {
  const item = el("div", "palette-command palette-mcp");
  item.title = s.target ?? "";
  const label = el("span", "label");
  const name = el("span", "name");
  name.append(highlight(s.title ?? s.name, q));
  const where = el("span", "path");
  where.append(highlight(s.from === "bismuth" ? `${s.name} · ${s.source}` : `${fromName(s)} · ${s.source}`, q));
  label.append(name, where);
  item.append(label);
  const all = mcpColumns().includes("all");
  if (all) item.append(mcpAllCell(s));
  mcpHarnesses().forEach((h, i) => {
    const col = i + (all ? 1 : 0);
    const use = s.uses[h];
    const cell = el("span", "mcp-cell");
    cell.dataset.col = String(col);
    if (!use) return void item.append(cell);
    cell.classList.toggle("locked", !!use.locked);
    if (use.scope) cell.classList.add(`scope-${use.scope}`);
    cell.setAttribute("role", "switch");
    cell.setAttribute("aria-checked", String(use.enabled));
    cell.setAttribute("aria-label", `${s.name} for ${HARNESS_NAMES[h]}`);
    cell.title = mcpCellTitle(s, h, use);
    const glyph = el("span", "mcp-glyph");
    glyph.append(harnessIcon(h));
    if (use.status) glyph.append(el("span", `mcp-dot ${use.status}`));
    cell.append(glyph, toggleSwitch(use.enabled));
    cell.onclick = (e) => {
      e.stopPropagation();
      mcpColumn = col;
      void switchMcp(s, h, e.ctrlKey || e.metaKey ? "all" : "project");
    };
    item.append(cell);
  });
  return item;
}

/** Every harness's switch at once: on when they all are. */
function mcpAllCell(s: McpServer): HTMLElement {
  const col = 0;
  const hs = switchable(s);
  const on = allOn(s);
  const cell = el("span", "mcp-cell mcp-all");
  cell.dataset.col = String(col);
  cell.classList.toggle("locked", !hs.length);
  const scopes = new Set(hs.map((h) => s.uses[h]!.scope));
  const scope = scopes.size === 1 ? [...scopes][0] : null;
  if (scope) cell.classList.add(`scope-${scope}`);
  cell.setAttribute("role", "switch");
  cell.setAttribute("aria-checked", String(on));
  cell.setAttribute("aria-label", `${s.title ?? s.name} for every harness`);
  const some = hs.filter((h) => s.uses[h]!.enabled).map((h) => HARNESS_NAMES[h]);
  cell.title = [
    on ? "On for every harness" : some.length ? `On for ${some.join(" and ")}` : "Off for every harness",
    hs.length ? `Click: ${on ? "off" : "on"} for all, this project · ${displayCombo("mod")}-click: all projects` : "Can't be switched here",
  ].join("\n");
  const glyph = el("span", "mcp-glyph");
  glyph.append(icon("layers"));
  cell.append(glyph, toggleSwitch(on));
  cell.onclick = (e) => {
    e.stopPropagation();
    mcpColumn = col;
    void switchMcp(s, "all", e.ctrlKey || e.metaKey ? "all" : "project");
  };
  return cell;
}

function mcpCellTitle(s: McpServer, h: HarnessId, use: McpUse): string {
  const who = HARNESS_NAMES[h];
  const lines = [
    `${who}: ${use.enabled ? "on" : "off"}` +
      (use.scope === "project" ? " for this project" : use.scope === "all" ? " for all projects" : use.native ? ", as its own config has it" : ""),
  ];
  if (s.from === "bismuth") lines.push(`Built into bismuth (${s.name}): ${s.target}`);
  else if (!use.native && !use.locked) lines.push(`Carried over from ${fromName(s)} (${s.source})`);
  if (use.status) lines.push(MCP_STATUS[use.status] + (use.status === "connected" && use.tools != null ? ` · ${use.tools} tool${use.tools === 1 ? "" : "s"}` : ""));
  if (use.locked) lines.push(use.locked);
  else lines.push(`Click: this project · ${displayCombo("mod")}-click: all projects`);
  return lines.join("\n");
}

/** The keyboard's harness column, marked on the highlighted row. */
function moveMcpColumn(step: number) {
  const n = mcpColumns().length;
  if (!n) return;
  mcpColumn = (mcpColumn + step + n) % n;
  markMcpColumn();
}

function markMcpColumn() {
  palette?.list.querySelectorAll<HTMLElement>(".palette-mcp").forEach((row) =>
    row.querySelectorAll<HTMLElement>(".mcp-cell").forEach((c) => c.classList.toggle("current", c.dataset.col === String(mcpColumn))),
  );
}

/** Flips a harness's switch for a server (or every harness's, "all") at once; the core's answer (or its refusal)
 *  settles it. All of them go on unless they all are. */
async function switchMcp(s: McpServer, col: McpColumn | undefined, scope: McpScope) {
  const project = mcpProject;
  if (!project || !mcpSnapshot || !col) return;
  const use = col === "all" ? undefined : s.uses[col];
  if (col !== "all" && !use) return;
  if (use?.locked) {
    mcpError = use.locked;
    return renderList();
  }
  const harnesses = col === "all" ? switchable(s) : [col];
  if (!harnesses.length) return;
  const enabled = col === "all" ? !allOn(s) : !use!.enabled;
  const seq = ++mcpSeq;
  const before = mcpSnapshot;
  mcpError = null;
  const uses = { ...s.uses };
  for (const h of harnesses) uses[h] = { ...uses[h]!, enabled, scope, status: null, tools: null };
  mcpSnapshot = { ...before, servers: before.servers.map((x) => (x === s ? { ...x, uses } : x)) };
  renderList();
  try {
    const snapshot = await call("mcp.set", { projectId: project.id, harnesses, name: s.name, enabled, scope });
    if (seq !== mcpSeq) return;
    mcpSnapshot = snapshot;
  } catch (err: any) {
    if (seq !== mcpSeq) return;
    mcpError = String(err?.message ?? err);
    mcpSnapshot = before;
  }
  if (palette?.view === "mcp") renderList();
}

/** The project the servers are for, and a way to pick another. */
function renderMcpProject() {
  const { crumbs } = palette!;
  crumbs.hidden = !mcpProject;
  if (!mcpProject) return;
  const label = el("span", "mcp-project");
  label.append(projectArt(mcpProject), el("span", "name", mcpProject.name), el("span", "path", tildePath(mcpProject.path)));
  const other = el("button", "crumb");
  other.append(el("span", "", "Other project"), icon("chevronRight"));
  other.onclick = pickProjectForMcp;
  crumbs.replaceChildren(label, other);
}

// ---------------- chrome ----------------

function renderFoot() {
  if (!palette) return;
  const folders = palette.view === "folders";
  const mcp = palette.view === "mcp";
  const hints = mcp
    ? [hint("↑ ↓ ← →", "Navigate"), hint("↵", "This project"), hint(displayCombo("mod-enter"), "All projects")]
    : [hint("↑ ↓", "Navigate"), hint("↵", folders || palette.view === "files" ? "Open" : "Select")];
  if (folders) hints.push(hint("←", "Back"));
  hints.push(hint("Esc", "Close"));
  palette.foot.replaceChildren(...hints);
  if (mcp) palette.foot.append(el("span", "grow"), el("span", "palette-hint", "Sessions pick changes up on their next turn"));
  if (folders) {
    const add = el("button", "palette-add");
    add.disabled = adding || !listing;
    add.append(kbd(displayCombo("mod-enter")), el("span", "", adding ? "Adding…" : "Add project"));
    add.onclick = () => void addOpenFolder();
    palette.foot.append(el("span", "grow"), add);
  }
}

/** The text with every query word's occurrences marked (the composer's `/` and `$` rows' too). */
export function highlight(text: string, q: string[]): DocumentFragment {
  const lower = text.toLowerCase();
  const hit = new Array<boolean>(text.length).fill(false);
  for (const w of q) for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + 1)) hit.fill(true, at, at + w.length);
  return marked(text, hit);
}

/** The text with the characters `hit` flags wrapped in <mark>. */
function marked(text: string, hit: boolean[]): DocumentFragment {
  const out = document.createDocumentFragment();
  for (let i = 0; i < text.length; ) {
    let j = i;
    while (j < text.length && hit[j] === hit[i]) j++;
    out.append(hit[i] ? el("mark", "", text.slice(i, j)) : text.slice(i, j));
    i = j;
  }
  return out;
}

const kbd = (text: string) => el("kbd", "palette-kbd", text);

function hint(keys: string, label: string) {
  const h = el("span", "palette-hint");
  h.append(kbd(keys), label);
  return h;
}

function edgeFades(list: HTMLElement) {
  list.classList.toggle("fade-top", list.scrollTop > 0);
  list.classList.toggle("fade-bottom", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
}

export function initPalette() {
  // Sessions and projects come and go (and change status) while it's open.
  on("sidebar", () => palette?.view !== "folders" && renderList());
}

