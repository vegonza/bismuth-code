// Device-local preferences behind the Settings pages (Zeron's ui-settings.json): appearance, notifications,
// the keymap and which providers are enabled. Persisted in localStorage; modules subscribe to changes.
import type { HarnessId } from "../shared/model";

export type Scheme = "system" | "light" | "dark";
export type AccentPreset = "zeron" | "orange" | "amber" | "green" | "cyan" | "blue" | "pink";
export type Surface = "theme" | "frosted" | "opaque";
export type ReduceMotion = "system" | "on" | "off";
export type BackgroundEffect = "none" | "dither" | "ascii" | "halftone" | "scanlines";
/** Pan/zoom of the new-thread background: the focal point (0–1 on each axis) and a 1–4× magnification. */
export type Framing = { focalX: number; focalY: number; zoom: number };

export const SHORTCUTS = ["toggleSidebar", "toggleRightPane", "expandRightPane", "toggleFiles", "showChanges", "showReview", "toggleTerminal", "newSession", "newSessionIn", "openModelPicker", "nextSession", "prevSession", "settleSession", "renameSession", "jump1", "jump2", "jump3", "jump4", "jump5", "jump6", "jump7", "jump8", "jump9", "newTerminal", "closeTerminal", "nextTerminal", "prevTerminal", "maximizeTerminal", "closeFile", "reopenFile", "saveFile", "togglePreview", "goBack", "goForward", "toggleHiddenFiles", "expandFolders", "collapseFolders", "revealFile", "quickOpen", "tab1", "tab2", "tab3", "tab4", "tab5", "tab6", "tab7", "tab8", "tab9", "removeImage", "stopTurn", "newBrowserTab", "focusAddress", "reloadPage"] as const;
export type ShortcutId = (typeof SHORTCUTS)[number];
/** Shortcuts that act on the terminal drawer. They may share a combination with one that acts on the session
 *  (Next terminal and Next session are both Mod+Tab): while a terminal has focus its own wins, elsewhere the
 *  session's does. Within either group a combination is unique. */
export const TERMINAL_SCOPED: ReadonlySet<ShortcutId> = new Set<ShortcutId>(["closeTerminal", "nextTerminal", "prevTerminal", "maximizeTerminal"]);
export type Keymap = Record<ShortcutId, string>;

export const DEFAULT_KEYMAP: Keymap = {
  toggleSidebar: "mod-b",
  toggleRightPane: "mod-e",
  expandRightPane: "mod-shift-m",
  toggleFiles: "mod-r",
  // VS Code's Source Control view.
  showChanges: "mod-shift-g",
  // Every changed file's diff, in the review tab (as a click on a changed file opens it).
  showReview: "mod-d",
  // Zeron's terminal drawer (Cmd/Ctrl+J), for the open session's project.
  toggleTerminal: "mod-j",
  openModelPicker: "mod-ç",
  newSession: "mod-shift-o",
  // Mod+O picks the project first (the New session palette); Mod+Shift+O starts in the current one.
  newSessionIn: "mod-o",
  nextSession: "mod-tab",
  prevSession: "mod-shift-tab",
  // t3code's thread.settle: settles the open session (or brings a settled one back).
  settleSession: "mod-shift-s",
  renameSession: "f2",
  // Alt+N opens the Nth most recent session (the sidebar's order).
  jump1: "alt-1",
  jump2: "alt-2",
  jump3: "alt-3",
  jump4: "alt-4",
  jump5: "alt-5",
  jump6: "alt-6",
  jump7: "alt-7",
  jump8: "alt-8",
  jump9: "alt-9",
  // The terminal's own (TERMINAL_SCOPED takes over the session combos while a terminal has focus).
  newTerminal: "mod-shift-j",
  closeTerminal: "mod-shift-w",
  nextTerminal: "mod-tab",
  prevTerminal: "mod-shift-tab",
  maximizeTerminal: "mod-shift-enter",
  // The right panel's open files: Mod+W closes the shown one (Mod+Shift+T brings it back), Mod+N shows the Nth (sessions keep Alt+N).
  closeFile: "mod-w",
  reopenFile: "mod-shift-t",
  saveFile: "mod-s",
  // The shown file's source and its preview (Markdown, LaTeX, a notebook, HTML, CSV).
  togglePreview: "mod-m",
  // Back to where Go to definition (Mod+click, F12) left from, and forward again.
  goBack: "alt-left",
  goForward: "alt-right",
  toggleHiddenFiles: "mod-h",
  expandFolders: "mod-alt-e",
  collapseFolders: "mod-alt-c",
  // The shown file in the system's file manager (a focused terminal keeps it as its copy).
  revealFile: "mod-shift-c",
  // VS Code's Quick Open: the session folder's files, by name, in the palette.
  quickOpen: "mod-p",
  tab1: "mod-1",
  tab2: "mod-2",
  tab3: "mod-3",
  tab4: "mod-4",
  tab5: "mod-5",
  tab6: "mod-6",
  tab7: "mod-7",
  tab8: "mod-8",
  tab9: "mod-9",
  // The composer's newest attached image (Shift+Backspace from the box, or with nothing else focused).
  removeImage: "shift-backspace",
  // Stops the open session's running turn, wherever focus is (Escape doesn't).
  stopTurn: "mod-shift-backspace",
  // Browser tabs, as Zeron has them: Mod+T a new one, Mod+L its address. Reload is F5 (Mod+R is the files panel's).
  newBrowserTab: "mod-t",
  focusAddress: "mod-l",
  reloadPage: "f5",
};

export type Prefs = {
  scheme: Scheme;
  lightTheme: string;
  darkTheme: string;
  /** "theme": the theme's own accent. */
  accent: AccentPreset | "theme";
  surface: Surface;
  /** The image itself is with the core at `path` (an upload), for every window, and in IndexedDB (background.ts);
   *  this is its name and framing. No path: one chosen before images were shared, or one the core wouldn't take. */
  background: ({ name: string; path?: string } & Framing) | null;
  backgroundEffect: BackgroundEffect;
  reduceMotion: ReduceMotion;
  pauseInBackground: boolean;
  uiFont: string;
  uiSize: number;
  terminalFont: string;
  terminalSize: number;
  codeFont: string;
  codeSize: number;
  contentWidth: number;
  notifications: boolean;
  notifyInBackgroundOnly: boolean;
  sounds: boolean;
  soundDone: boolean;
  soundInput: boolean;
  soundError: boolean;
  /** Tell when `bun run apply` changed code only a restart loads. */
  notifyRestart: boolean;
  keymap: Keymap;
  harnesses: Record<HarnessId, boolean>;
  /** Where New project's folder browser opens (null: home), as the user sees it ("~/work"). */
  projectsDir: string | null;
  /** What Enter does with a prompt while the agent works; Ctrl/Cmd+Enter does the other. */
  enterWhileWorking: WorkingSend;
  /** How the file explorer orders a folder's files (folders always come first, by name). */
  fileSort: FileSort;
  /** The colours code is highlighted in: One Dark Pro's (One Light's in light themes), or ones from the theme. */
  codeColors: CodeColors;
  /** The file editor takes Vim's keys (normal, insert and visual modes, : commands). */
  vimKeys: boolean;
  /** Files' changes since git's copy shown in place in their editors (a bar's click, or Open changes). */
  showChanges: boolean;
  /** What the explorer's marks and the editors' changes are against: the last commit, the open session's folder
   *  just before its last turn, the branch as last pushed, or where the branch left the default one. */
  changesScope: ChangesScope;
};

export type CodeColors = "one-dark-pro" | "theme";

export type ChangesScope = "turn" | "uncommitted" | "unpushed" | "branch";

/** "name": alphabetically; "type": files of one extension together, extensions in alphabetical order. */
export type FileSort = "name" | "type";

/** A prompt sent mid-turn: held in the queue until the turn ends, or steered into the running turn at once. */
export type WorkingSend = "queue" | "steer";

/** "Geist" and "Geist Mono" are bundled; "System" is the platform face; anything else is an installed family. */
export const DEFAULTS: Prefs = {
  scheme: "system",
  lightTheme: "zeron-light",
  darkTheme: "andromeda",
  accent: "zeron",
  surface: "theme",
  background: null,
  backgroundEffect: "none",
  reduceMotion: "system",
  pauseInBackground: false,
  uiFont: "Geist",
  uiSize: 16,
  terminalFont: "Geist Mono",
  terminalSize: 13,
  codeFont: "Geist Mono",
  codeSize: 12.5,
  contentWidth: 736,
  notifications: true,
  notifyInBackgroundOnly: true,
  sounds: true,
  soundDone: true,
  soundInput: true,
  soundError: true,
  notifyRestart: true,
  keymap: DEFAULT_KEYMAP,
  harnesses: { codex: true, claude: true, cursor: true },
  projectsDir: null,
  enterWhileWorking: "queue",
  fileSort: "type",
  codeColors: "one-dark-pro",
  vimKeys: false,
  showChanges: false,
  changesScope: "uncommitted",
};

/** The key that does `what` while the agent works. */
export const workingCombo = (what: WorkingSend) => (prefs.enterWhileWorking === what ? "enter" : "mod-enter");

const KEY = "bismuth.prefs";

/** Only bindings that differ from the defaults are stored, so a changed default reaches everyone who kept it. */
const customBindings = (keymap: Keymap) =>
  Object.fromEntries(Object.entries(keymap).filter(([id, combo]) => combo !== DEFAULT_KEYMAP[id as ShortcutId]));

/** v1 defaults since changed (v2 stores only custom bindings, so later default changes need no entry here). */
const V1_DEFAULTS: Record<string, string> = { newSession: "mod-n", openModelPicker: "mod-/" };

function load(): Prefs {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs> & { v?: number };
  // Before v2 the whole keymap was stored, defaults included: drop the defaults of that time (jumps were Mod+N).
  if (!saved.v && saved.keymap)
    saved.keymap = Object.fromEntries(
      Object.entries(saved.keymap).filter(
        ([id, combo]) => combo !== DEFAULT_KEYMAP[id as ShortcutId] && combo !== V1_DEFAULTS[id] && !(id.startsWith("jump") && combo === `mod-${id.slice(4)}`),
      ),
    ) as Keymap;
  // Before v3 Close terminal shipped as Mod+W, which is the shell's delete-word: it moved to Mod+Shift+W.
  if ((saved.v ?? 0) < 3 && saved.keymap?.closeTerminal === "mod-w") delete (saved.keymap as Partial<Keymap>).closeTerminal;
  // Before v4 the whole prefs were stored with the file order's first default, "name": it became "type".
  if ((saved.v ?? 0) < 4 && saved.fileSort === "name") delete saved.fileSort;
  // Bindings of shortcuts that no longer exist (Archive session became Settle session) are dropped.
  const keymap = Object.fromEntries(Object.entries(saved.keymap ?? {}).filter(([id]) => (SHORTCUTS as readonly string[]).includes(id)));
  return { ...DEFAULTS, ...saved, keymap: { ...DEFAULT_KEYMAP, ...keymap }, harnesses: { ...DEFAULTS.harnesses, ...saved.harnesses } };
}

export let prefs: Prefs = load();

const listeners: ((prev: Prefs) => void)[] = [];
/** Called after every change with the previous value. */
export const onPrefs = (fn: (prev: Prefs) => void) => listeners.push(fn);

export function setPrefs(patch: Partial<Prefs>) {
  const prev = prefs;
  prefs = { ...prefs, ...patch };
  localStorage.setItem(KEY, JSON.stringify({ ...prefs, keymap: customBindings(prefs.keymap), v: 4 }));
  listeners.forEach((fn) => fn(prev));
}

/** Another window (or a reload of this one) changed them. */
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  const prev = prefs;
  prefs = load();
  listeners.forEach((fn) => fn(prev));
});

/** Whether a provider's models are offered for new sessions. */
export const harnessEnabled = (h: HarnessId) => prefs.harnesses[h] !== false;
