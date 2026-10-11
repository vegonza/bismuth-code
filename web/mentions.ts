// The composer's `@` (Zeron's file mentions, t3code's path trigger): typing `@` and a query lists the session's files
// matching it in a card just above the box, while the caret stays in the box. ↑↓ move, Enter or Tab mentions the
// file (its chip takes the `@query`'s place), Esc dismisses until another `@`. Go to file's search and rows.
import { el } from "./dom";
import type { Editor } from "./editor";
import { reducedMotion } from "./motion";
import { fileRow } from "./palette";
import { findFiles, loadSuggestions, suggestedFiles } from "./panels";
import { store } from "./store";

const MENU_OUT_MS = 100;
const ROWS_MAX = 50;

/** An `@` starting a word, and what's typed after it up to the caret. */
const TOKEN = /(?:^|[\s([{>])@([^\s@]*)$/;

export function initMentions(editor: Editor, host: HTMLElement, chip: (path: string) => HTMLElement) {
  let card: HTMLElement | null = null;
  let list: HTMLElement;
  /** The open token: where its `@` is, and its query. */
  let token: { at: number; query: string } | null = null;
  /** Esc'd: the `@` it was at, left alone until the caret leaves it. */
  let dismissed: number | null = null;
  let results: string[] = [];
  /** The query `results` answer (null: none yet), and the search answering the latest one. */
  let resultsFor: string | null = null;
  let seq = 0;
  let active = 0;

  function open() {
    card = el("div", "card mention-menu menu-in");
    list = el("div", "mention-list");
    card.append(list);
    // Picking with the mouse leaves the caret where it is.
    card.onmousedown = (e) => e.preventDefault();
    host.append(card);
  }

  function close() {
    token = null;
    seq++;
    if (!card) return;
    const closing = card;
    card = null;
    closing.classList.replace("menu-in", "menu-out");
    closing.style.pointerEvents = "none";
    setTimeout(() => closing.remove(), reducedMotion() ? 0 : MENU_OUT_MS + 20);
  }

  /** The token at the caret, followed: the list opened, searched again or closed. */
  function track() {
    const m = store.thread && document.activeElement === editor.root ? TOKEN.exec(editor.value().slice(0, editor.caret())) : null;
    if (!m) {
      dismissed = null;
      return close();
    }
    // Typed text, not a chip's label (an `@path` too) the caret is just after.
    const sel = getSelection();
    if (sel?.focusNode?.nodeType !== Node.TEXT_NODE || !(sel.focusNode.nodeValue ?? "").slice(0, sel.focusOffset).endsWith(`@${m[1]}`)) return close();
    const at = m.index + m[0].length - m[1].length - 1;
    if (at === dismissed) return close();
    dismissed = null;
    const query = m[1];
    if (token?.at === at && token.query === query) return;
    token = { at, query };
    if (!card) open();
    active = 0;
    search(query);
    render();
  }

  function search(query: string) {
    const mine = ++seq;
    if (!query) {
      results = suggestedFiles().map((s) => s.path);
      resultsFor = "";
      // The changes and the top folder's files join as they arrive.
      void loadSuggestions()
        .catch(() => {})
        .then(() => {
          if (mine !== seq) return;
          results = suggestedFiles().map((s) => s.path);
          render();
        });
      return;
    }
    void findFiles(query)
      .then((paths) => {
        if (mine !== seq) return;
        results = paths;
        resultsFor = query;
        active = 0;
        render();
      })
      .catch(() => {});
  }

  function render() {
    if (!card || !token) return;
    const shown = results.slice(0, ROWS_MAX);
    active = Math.min(active, Math.max(0, shown.length - 1));
    if (!shown.length) {
      const note = resultsFor !== token.query ? "Searching files…" : token.query ? "No matching files" : "No files here";
      list.replaceChildren(el("div", "mention-note", note));
      return;
    }
    list.replaceChildren(
      ...shown.map((path, i) => {
        const row = fileRow(path, token!.query);
        row.classList.toggle("active", i === active);
        row.onmousemove = () => i !== active && ((active = i), mark());
        row.onclick = () => pick(i);
        return row;
      }),
    );
    edgeFades();
  }

  /** The active row lit, and scrolled to. */
  function mark() {
    [...list.children].forEach((r, i) => r.classList.toggle("active", i === active));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function pick(i: number) {
    const path = results[i];
    if (!path || !token) return;
    const replace = token.query.length + 1;
    close();
    editor.insertChips([chip(path)], replace);
  }

  function edgeFades() {
    list.classList.toggle("fade-top", list.scrollTop > 0);
    list.classList.toggle("fade-bottom", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }

  editor.root.addEventListener("input", track);
  document.addEventListener("selectionchange", () => (card || document.activeElement === editor.root) && track());
  editor.root.addEventListener("blur", () => close());
  // Ahead of the composer's own keys (Enter sends).
  editor.root.addEventListener(
    "keydown",
    (e) => {
      if (!card || !token || e.isComposing) return;
      const n = Math.min(results.length, ROWS_MAX);
      let handled = true;
      if (e.key === "ArrowDown" && n) (active = (active + 1) % n), mark();
      else if (e.key === "ArrowUp" && n) (active = (active - 1 + n) % n), mark();
      else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && n) pick(active);
      else if (e.key === "Escape") (dismissed = token.at), close();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  host.addEventListener("scroll", () => card && edgeFades(), { capture: true, passive: true });
}
