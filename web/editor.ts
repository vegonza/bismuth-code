// The composer's input: plain text with attachment chips inline (Zeron's composer mentions). A chip is an atomic,
// non-editable span; the text it stands for is its label ("Image 2", "@web/app.ts"), which is what the draft stores
// and the agent reads. Typing, pasting and dropping stay plain text (contenteditable="plaintext-only").
import { basename, el } from "./dom";
import { fileGlyph } from "./fileicons";
import { icon } from "./icons";

/** An image chip: the icon and its label. */
export function mentionChip(label: string): HTMLElement {
  const chip = el("span", "mention");
  chip.dataset.label = label;
  chip.append(icon("image"), el("span", "", label));
  return chip;
}

/** How a mentioned file reads in the text: `@` and its path from the session's folder (quoted when it has spaces),
 *  as Claude Code and Codex take a file mention. */
export const fileLabel = (path: string) => (/[\s"]/.test(path) ? `@"${path.replace(/"/g, "")}"` : `@${path}`);
/** A file mention's path, or null for an `@` that doesn't name one (`@someone`). */
export function labelFile(label: string): string | null {
  const path = label.startsWith('@"') ? label.slice(2, -1) : label.slice(1);
  return /[/.]/.test(path) && !/^\.+$/.test(path) ? path : null;
}

/** A file chip: its icon and name (the full path on hover). */
export function fileChip(path: string): HTMLElement {
  const chip = el("span", "mention file");
  chip.dataset.label = fileLabel(path);
  chip.dataset.file = path;
  chip.contentEditable = "false";
  chip.title = path;
  chip.append(fileGlyph(path, path.endsWith("/")), el("span", "", basename(path)));
  return chip;
}

export type Editor = {
  root: HTMLElement;
  value(): string;
  /** Replace the contents; `chip` turns a label in the text into a chip (or null to leave it as text). The caret
   *  goes to `caret` (an offset into the text; the end by default), now if the editor has focus, else on focus. */
  set(text: string, chip: (label: string) => HTMLElement | null, caret?: number): void;
  /** Where the caret last was, as an offset into the text (kept while focus is elsewhere). */
  caret(): number;
  /** Insert chips where the caret is (at the end when the editor doesn't have it), each followed by a space;
   *  `replace`: characters just before the caret they take the place of (a typed `@`). */
  insertChips(chips: HTMLElement[], replace?: number): void;
  /** Insert text where the caret is (as `set` takes it), replacing the selection. */
  insert(text: string, chip: (label: string) => HTMLElement | null): void;
  chips(): HTMLElement[];
  focus(): void;
};

export function createEditor(placeholder: string): Editor {
  const root = el("div", "editor");
  root.contentEditable = "plaintext-only";
  root.spellcheck = true;
  root.setAttribute("role", "textbox");
  root.setAttribute("aria-multiline", "true");
  root.dataset.placeholder = placeholder;

  function value(): string {
    return textOf(root);
  }

  function textOf(container: Node): string {
    let out = "";
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? "";
      else if (n instanceof HTMLElement && n.classList.contains("mention")) out += n.dataset.label ?? "";
      else if (n.nodeName === "BR") out += "\n";
      else {
        // A block Chromium wrapped a line in starts a new line.
        if ((n.nodeName === "DIV" || n.nodeName === "P") && out && !out.endsWith("\n")) out += "\n";
        n.childNodes.forEach(walk);
      }
    };
    container.childNodes.forEach(walk);
    // The trailing <br> Chromium keeps so an ending newline shows (or the caret can sit after an ending chip) isn't
    // part of the text. Empty text nodes can trail it.
    if (container === root) {
      let last = root.lastChild;
      while (last?.nodeType === Node.TEXT_NODE && !last.nodeValue) last = last.previousSibling;
      if (last?.nodeName === "BR") out = out.slice(0, -1);
    }
    return out.replace(/\u00a0/g, " ");
  }

  // ---------------- caret ----------------
  // Kept as an offset into value() so it survives the contents being rebuilt (a draft saved and loaded again).

  let lastCaret = 0;
  /** A caret to place when focus next arrives (set() while unfocused). */
  let pendingCaret: number | null = null;

  /** The selection's end as an offset into the text, or null when it isn't in the editor. */
  function selectionOffset(): number | null {
    const sel = getSelection();
    if (!sel?.rangeCount || !root.contains(sel.focusNode)) return null;
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(sel.focusNode!, sel.focusOffset);
    return textOf(range.cloneContents()).length;
  }

  function placeCaret(offset: number) {
    let left = Math.max(0, offset);
    const range = document.createRange();
    const walk = (n: Node): boolean => {
      if (n.nodeType === Node.TEXT_NODE) {
        const len = n.nodeValue?.length ?? 0;
        if (left <= len) return range.setStart(n, left), true;
        left -= len;
      } else if ((n instanceof HTMLElement && n.classList.contains("mention")) || n.nodeName === "BR") {
        // Chips are atomic: an offset inside one lands before it.
        const len = n.nodeName === "BR" ? 1 : ((n as HTMLElement).dataset.label?.length ?? 0);
        if (left < len || left === 0) return range.setStartBefore(n), true;
        left -= len;
      } else for (const c of n.childNodes) if (walk(c)) return true;
      return false;
    };
    if (![...root.childNodes].some(walk)) range.selectNodeContents(root), range.collapse(false);
    range.collapse(true);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    lastCaret = selectionOffset() ?? offset;
  }

  // Focus from anywhere but a click (a closing palette or dialog handing it back, Tab) would put the caret at the
  // start: it goes back where it was (or where a loaded draft asked for), which for a fresh draft is the end.
  let clicking = false;
  root.addEventListener("mousedown", () => (clicking = true));
  document.addEventListener("mouseup", () => (clicking = false));
  root.addEventListener("focus", () => {
    if (clicking) return;
    placeCaret(pendingCaret ?? lastCaret);
    pendingCaret = null;
  });

  document.addEventListener("selectionchange", () => {
    if (document.activeElement !== root) return;
    const at = selectionOffset();
    if (at !== null) (lastCaret = at), (pendingCaret = null);
  });

  const syncEmpty = () => root.classList.toggle("empty", !value());

  /** The text as nodes, each label `chip` takes as a chip. */
  function nodesOf(text: string, chip: (label: string) => HTMLElement | null): Node[] {
    const nodes: Node[] = [];
    let last = 0;
    for (const m of text.matchAll(/Image \d+|(?<=^|\s)@(?:"[^"\n]+"|[^\s"]+)/g)) {
      const c = chip(m[0]);
      if (!c) continue;
      if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
      nodes.push(c);
      last = m.index + m[0].length;
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    return nodes;
  }

  function set(text: string, chip: (label: string) => HTMLElement | null, caret = text.length) {
    const nodes = nodesOf(text, chip);
    // An ending newline needs a <br> after it to show (and to be typed after).
    if (text.endsWith("\n")) nodes.push(el("br"));
    root.replaceChildren(...nodes);
    syncEmpty();
    lastCaret = caret;
    if (document.activeElement === root) placeCaret(caret);
    else pendingCaret = caret;
  }

  /** Replace the selection (the end when the editor doesn't have it) with what `fill` puts in, given the text
   *  before it; the caret lands after it. */
  function insertAtCaret(fill: (frag: DocumentFragment, before: string) => void, replace = 0) {
    const sel = getSelection();
    let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !root.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
    }
    if (replace && range.collapsed && range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset >= replace) range.setStart(range.startContainer, range.startOffset - replace);
    range.deleteContents();
    const frag = document.createDocumentFragment();
    fill(frag, range.startContainer.nodeType === Node.TEXT_NODE ? (range.startContainer.nodeValue ?? "").slice(0, range.startOffset) : value());
    const end = frag.lastChild;
    if (!end) return;
    range.insertNode(frag);
    range.setStartAfter(end);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    syncEmpty();
    root.dispatchEvent(new Event("input"));
  }

  function insertChips(chips: HTMLElement[], replace = 0) {
    insertAtCaret((frag, before) => {
      // Right after a word, the chip gets a space before it.
      if (before && !/\s$/.test(before)) frag.append(document.createTextNode(" "));
      // The caret lands after the last chip's space, ready to type.
      for (const c of chips) frag.append(c, document.createTextNode(" "));
    }, replace);
  }

  // Clearing everything can leave Chromium's line-break placeholders behind, which would read as a second line.
  root.addEventListener("input", () => {
    if (!root.querySelector(".mention") && /^\n*$/.test(value())) root.replaceChildren();
    syncEmpty();
  });
  syncEmpty();
  return {
    root,
    value,
    set,
    insertChips,
    insert: (text, chip) => insertAtCaret((frag) => frag.append(...nodesOf(text, chip))),
    chips: () => [...root.querySelectorAll<HTMLElement>(".mention")],
    caret: () => (document.activeElement === root ? (selectionOffset() ?? lastCaret) : lastCaret),
    focus() {
      if (document.activeElement === root) return;
      root.focus();
    },
  };
}
