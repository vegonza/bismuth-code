// Rebindable shortcuts (Zeron's KeymapConfig): combos are stored as "mod-shift-a" (mod = Ctrl, or Cmd on macOS),
// matched against keydown events, and dispatched to the actions app.ts registers.
import { prefs, SHORTCUTS, TERMINAL_SCOPED, type ShortcutId } from "./prefs";

const MAC = /Mac/.test(navigator.platform);
const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph", "CapsLock", "Fn"]);
const NAMED: Record<string, string> = { " ": "space", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Escape: "escape", Enter: "enter", Tab: "tab", Backspace: "backspace", Delete: "delete" };

/** The combo a keydown spells, or null for a bare modifier. Letters and digits come from the physical key so
 *  Shift doesn't turn "1" into "!". */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIERS.has(e.key)) return null;
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : (NAMED[e.key] ?? e.key.toLowerCase());
  const parts: string[] = [];
  if (e.metaKey || (e.ctrlKey && !MAC)) parts.push("mod");
  if (e.ctrlKey && MAC) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("-");
}

/** The shell's own keys (Ctrl+W deletes a word, Ctrl+H is backspace, Ctrl+R searches history, Ctrl+P is the previous command,
 *  Ctrl+D ends the input, Ctrl+L clears the screen, Ctrl+T swaps two characters)
 *  and the terminal's copy (Ctrl+Shift+C): whatever they're bound to, in a focused terminal they're left to it. With Cmd
 *  as mod on macOS, nothing clashes. */
const SHELL_COMBOS = new Set(["mod-w", "mod-h", "mod-r", "mod-p", "mod-d", "mod-l", "mod-t", "mod-shift-c"]);
export const shellKeeps = (combo: string) => !MAC && SHELL_COMBOS.has(combo);

/** "mod-shift-a" → "Ctrl+Shift+A". */
export function displayCombo(combo: string) {
  return combo
    .split(/-(?!$)/)
    .map((p) => ({ mod: MAC ? "Cmd" : "Ctrl", alt: MAC ? "Opt" : "Alt", shift: "Shift", ctrl: "Ctrl" })[p] ?? p.charAt(0).toUpperCase() + p.slice(1))
    .join("+");
}

export const LABELS: Record<ShortcutId, string> = {
  toggleSidebar: "Toggle left sidebar",
  toggleRightPane: "Toggle right panel",
  expandRightPane: "Expand right panel",
  toggleFiles: "Toggle files panel",
  showChanges: "Show changes (source control)",
  showReview: "Review changes",
  toggleTerminal: "Toggle terminal",
  newSession: "New session",
  newSessionIn: "New session in…",
  openModelPicker: "Open model picker",
  nextSession: "Next session",
  prevSession: "Previous session",
  settleSession: "Settle session",
  renameSession: "Rename session",
  jump1: "Jump to session 1",
  jump2: "Jump to session 2",
  jump3: "Jump to session 3",
  jump4: "Jump to session 4",
  jump5: "Jump to session 5",
  jump6: "Jump to session 6",
  jump7: "Jump to session 7",
  jump8: "Jump to session 8",
  jump9: "Jump to session 9",
  newTerminal: "New terminal",
  previewSession: "Preview session in its project folder",
  toggleWorktree: "New session: project folder or new worktree",
  closeTerminal: "Close terminal",
  nextTerminal: "Next terminal",
  prevTerminal: "Previous terminal",
  maximizeTerminal: "Maximize terminal",
  closeFile: "Close file",
  reopenFile: "Reopen closed file",
  saveFile: "Save file",
  togglePreview: "Toggle preview",
  goBack: "Go back",
  goForward: "Go forward",
  toggleHiddenFiles: "Show hidden files",
  expandFolders: "Expand all folders",
  collapseFolders: "Collapse all folders",
  revealFile: "Reveal current file in file manager",
  quickOpen: "Go to file",
  tab1: "File tab 1",
  tab2: "File tab 2",
  tab3: "File tab 3",
  tab4: "File tab 4",
  tab5: "File tab 5",
  tab6: "File tab 6",
  tab7: "File tab 7",
  tab8: "File tab 8",
  tab9: "File tab 9",
  removeImage: "Remove last attached image",
  stopTurn: "Stop generation",
  newBrowserTab: "New browser tab",
  focusAddress: "Focus address bar",
  reloadPage: "Reload page",
  sideChat: "New side chat",
};

const handlers: Partial<Record<ShortcutId, () => void>> = {};
/** `when` lets a shortcut pass on a keystroke it has nothing to do with, which then keeps its usual meaning. */
const guards: Partial<Record<ShortcutId, () => boolean>> = {};
export function bindShortcut(id: ShortcutId, fn: () => void, when?: () => boolean) {
  handlers[id] = fn;
  if (when) guards[id] = when;
}

/** Set while Settings → Shortcuts records a new combo, so the keystroke isn't also acted on. */
export const recording = { active: false };

/** The modifier part of a combo ("mod-shift-1" → "mod-shift"); a combo without one never shows hints. */
export const modifiersOf = (combo: string) => combo.split(/-(?!$)/).slice(0, -1).join("-");

/** The modifiers held during an event, spelled as in combos. */
export function heldModifiers(e: KeyboardEvent | MouseEvent) {
  const parts: string[] = [];
  if (e.metaKey || (e.ctrlKey && !MAC)) parts.push("mod");
  if (e.ctrlKey && MAC) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  return parts.join("-");
}

/** `fn` once the modifiers held through a run of presses (Mod+Tab, Tab, Tab…) are let go, or the window loses the keys.
 *  Shift doesn't count: let go of it, Mod+Tab goes on from where Mod+Shift+Tab got to. */
export function onModifiersReleased(fn: () => void) {
  addEventListener("keyup", (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && fn());
  addEventListener("blur", fn);
}

/** Mod+Tab through what was used most recently first, as browsers go through their tabs. The order is taken at the
 *  first press and kept while the modifier's held, so more presses go further back; only where the walk stops counts
 *  as used (`stopped` runs once the modifier's let go). */
export function recentWalk(stopped: () => void) {
  let order: string[] | null = null;
  onModifiersReleased(() => {
    if (!order) return;
    order = null;
    stopped();
  });
  return {
    /** Mid-walk: what's passed on the way isn't used. */
    walking: () => !!order,
    /** `step` on from `at` through `recent` (newest first), past the ones no longer `there`. */
    next(at: string | null, recent: () => string[], step: 1 | -1, there: (id: string) => boolean): string | undefined {
      order ??= [...new Set([at, ...recent()])].filter((id): id is string => !!id);
      const ids = order.filter(there);
      const i = at ? ids.indexOf(at) : -1;
      return ids.length ? ids[i < 0 ? (step > 0 ? 0 : ids.length - 1) : (i + step + ids.length) % ids.length] : undefined;
    },
  };
}

/** A newest-first list with `id` the newest. */
export const usedNow = (recent: readonly string[], id: string) => [id, ...recent.filter((x) => x !== id)];

/** Where keys are going: a focused terminal gives the terminal's shortcuts priority, and with the drawer closed they
 *  don't apply at all (terminal.ts sets both). */
export const keyContext = { terminal: () => false, drawerOpen: () => false };

/** The shortcut a combination means here: with two bound to it (a terminal one and a session one), the one for
 *  the focused area; with one, that one wherever focus is. */
export function shortcutFor(combo: string): ShortcutId | undefined {
  const bound = SHORTCUTS.filter((s) => prefs.keymap[s] === combo);
  if (bound.length < 2) return bound[0];
  const terminal = keyContext.terminal();
  return bound.find((s) => TERMINAL_SCOPED.has(s) === terminal) ?? bound[0];
}

export function dispatchShortcut(e: KeyboardEvent): boolean {
  if (recording.active) return false;
  const combo = comboFromEvent(e);
  if (!combo) return false;
  const id = shortcutFor(combo);
  if (!id || !handlers[id] || (TERMINAL_SCOPED.has(id) && !keyContext.drawerOpen()) || guards[id]?.() === false) return false;
  e.preventDefault();
  handlers[id]!();
  return true;
}
