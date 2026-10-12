// Settings → Shortcuts (Zeron's settings/shortcuts.rs): every binding grouped by area. Click a chip, press the
// new combination; Escape cancels, a combo another shortcut owns is refused, Reset restores one default.
import { el } from "./dom";
import { comboFromEvent, displayCombo, LABELS, recording } from "./keymap";
import { DEFAULT_KEYMAP, prefs, setPrefs, SHORTCUTS, TERMINAL_SCOPED, type ShortcutId } from "./prefs";
import { refresh } from "./settings";
import { action, card, pageColumn, pageHeader, pageSubtitle, rowText, section } from "./widgets";

const GROUPS: [string, (id: ShortcutId) => boolean][] = [
  ["Panels", (id) => ["toggleSidebar", "toggleRightPane", "expandRightPane", "toggleFiles"].includes(id)],
  ["Sessions", (id) => ["newSession", "newSessionIn", "sideChat", "openModelPicker", "nextSession", "prevSession", "settleSession", "renameSession"].includes(id)],
  ["Jump to session", (id) => id.startsWith("jump")],
  ["Terminal", (id) => ["toggleTerminal", "newTerminal", "closeTerminal", "nextTerminal", "prevTerminal", "maximizeTerminal"].includes(id)],
  ["Files", (id) => ["quickOpen", "saveFile", "closeFile", "reopenFile", "togglePreview", "goBack", "goForward", "toggleHiddenFiles", "expandFolders", "collapseFolders", "revealFile"].includes(id)],
  ["Browser", (id) => ["newBrowserTab", "focusAddress", "reloadPage"].includes(id)],
  ["Source control", (id) => ["showChanges", "showReview"].includes(id)],
  ["Jump to file tab", (id) => /^tab\d$/.test(id)],
  ["Composer", (id) => ["removeImage", "stopTurn"].includes(id)],
];

let recordingId: ShortcutId | null = null;
let notice: string | null = null;

/** Escape inside Settings: cancel a recording first. */
export function shortcutsEscape() {
  if (!recordingId) return false;
  stop();
  return true;
}

function refusal(id: ShortcutId, combo: string): string | null {
  if (combo === "mod-enter") return `${displayCombo(combo)} is reserved for the composer.`;
  if (combo === "mod-f") return `${displayCombo(combo)} is reserved for search.`;
  if (combo === "mod-,") return `${displayCombo(combo)} is reserved for Settings.`;
  // A terminal shortcut may share a combination with a session one (focus decides which acts), not with its own kind.
  const owner = SHORTCUTS.find((s) => s !== id && prefs.keymap[s] === combo && TERMINAL_SCOPED.has(s) === TERMINAL_SCOPED.has(id));
  return owner ? `${displayCombo(combo)} is already assigned to ${LABELS[owner]}.` : null;
}

function onKey(e: KeyboardEvent) {
  if (!recordingId) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") return stop();
  const combo = comboFromEvent(e);
  if (!combo) return; // a bare modifier: keep listening
  const id = recordingId;
  notice = refusal(id, combo);
  if (!notice) setPrefs({ keymap: { ...prefs.keymap, [id]: combo } });
  stop();
}

/** Recording ends on any press outside the chips, like losing focus (another chip just moves it). */
function onPress(e: PointerEvent) {
  if (!(e.target as HTMLElement).closest(".combo")) stop();
}

function start(id: ShortcutId) {
  if (!recordingId) {
    addEventListener("keydown", onKey, true);
    addEventListener("pointerdown", onPress, true);
  }
  recordingId = id;
  recording.active = true;
  notice = null;
  refresh();
}

function stop() {
  removeEventListener("keydown", onKey, true);
  removeEventListener("pointerdown", onPress, true);
  recordingId = null;
  recording.active = false;
  refresh();
}

function bindingRow(id: ShortcutId): HTMLElement {
  const r = el("div", "s-row");
  const combo = prefs.keymap[id];
  const live = recordingId === id;
  const control = el("div", "binding");
  if (combo !== DEFAULT_KEYMAP[id] && !live) {
    const reset = el("button", "binding-reset", "Reset");
    reset.setAttribute("aria-label", `Reset ${LABELS[id]} shortcut`);
    reset.onclick = () => {
      notice = null;
      setPrefs({ keymap: { ...prefs.keymap, [id]: DEFAULT_KEYMAP[id] } });
      refresh();
    };
    control.append(reset);
  }
  const chip = el("button", `combo${live ? " recording" : ""}`, live ? "Press keys…" : displayCombo(combo));
  chip.setAttribute("aria-label", `Change ${LABELS[id]} shortcut: ${displayCombo(combo)}`);
  chip.onclick = () => (live ? stop() : start(id));
  control.append(chip);
  r.append(rowText(LABELS[id], null), control);
  return r;
}

export function renderShortcuts(): HTMLElement {
  const page = pageColumn();
  const customized = SHORTCUTS.some((id) => prefs.keymap[id] !== DEFAULT_KEYMAP[id]);
  const head = el("div", "shortcuts-head");
  const titles = el("div", "shortcuts-titles");
  titles.append(pageHeader("Keyboard shortcuts"), pageSubtitle("Click a binding, then press the new key combination."));
  const restore = action("Restore defaults", "quiet", () => {
    notice = null;
    setPrefs({ keymap: { ...DEFAULT_KEYMAP } });
    refresh();
  }, "rotateCcw");
  restore.disabled = !customized || !!recordingId;
  head.append(titles, restore);
  page.append(head);
  for (const [name, member] of GROUPS) page.append(section(name, card(...SHORTCUTS.filter(member).map(bindingRow))));
  page.append(el("div", "shortcuts-helper", recordingId ? "Press Escape to cancel." : (notice ?? "Shortcuts must be unique, except that a terminal one can share keys with a session one: the terminal's acts while it has focus.")));
  // Focus the chip being recorded so the page's own keys stay out of the way.
  if (recordingId) queueMicrotask(() => page.querySelector<HTMLElement>(".combo.recording")?.focus({ preventScroll: true }));
  return page;
}
