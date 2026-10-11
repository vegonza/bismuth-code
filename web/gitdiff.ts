// Git's changes in the editor, as VS Code's quick diff shows them: beside the line numbers, a bar by each line that
// differs from the file as staged (git's index): green where lines were added, yellow where they changed, a red mark
// where some went. A click on one (or "Open changes") shows every change in place, the lines replaced in red over
// what's there now in green (@codemirror/merge's unified view), each with a revert; another hides them. Both follow
// typing.
import { Change, Chunk, diff, getChunks, rejectChunk, unifiedMergeView, updateOriginalDoc, type DiffConfig } from "@codemirror/merge";
import { ChangeSet, Compartment, EditorState, Prec, StateEffect, StateField, Text, type Extension, type Range, type TransactionSpec } from "@codemirror/state";
import { BlockType, Decoration, EditorView, gutter, GutterMarker, keymap, ViewPlugin, type BlockInfo, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { icon } from "./icons";
import { prefs } from "./prefs";

/** The diff gives up on precision past these (a file rewritten wholesale): its chunks are then coarser, never slow. */
const PLAIN = { scanLimit: 500, timeout: 80 };
const DIFF: DiffConfig = { ...PLAIN, override: (a, b) => slid(a, b, diff(a, b, PLAIN)) };

/** Each insertion and deletion slid to where it reads best, as git's and VS Code's diffs do. Text added next to text
 *  like its own ends could be placed a few ways (a function added after another: from the "}" above it, or from its
 *  own first line); it's moved (google's diff-match-patch's semantic cleanup) to the place that best splits on
 *  blank lines, then line breaks, then words; the furthest down of equals. */
function slid(a: string, b: string, changes: readonly Change[]): readonly Change[] {
  const out = changes.slice();
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const ins = c.fromA === c.toA;
    if (ins === (c.fromB === c.toB)) continue;
    // In the side the text is in, between the changes beside it.
    const t = ins ? b : a;
    const [from, to] = ins ? [c.fromB, c.toB] : [c.fromA, c.toA];
    const floor = i ? (ins ? out[i - 1].toB : out[i - 1].toA) : 0;
    const ceil = i < out.length - 1 ? (ins ? out[i + 1].fromB : out[i + 1].fromA) : t.length;
    let lo = 0;
    while (from - lo - 1 >= floor && t[from - lo - 1] === t[to - lo - 1]) lo++;
    let hi = 0;
    while (to + hi < ceil && t[from + hi] === t[to + hi]) hi++;
    if (!lo && !hi) continue;
    let best = 0;
    let bestScore = -1;
    for (let k = -lo; k <= hi; k++) {
      const score = boundary(t, from + k) + boundary(t, to + k);
      if (score >= bestScore) (best = k), (bestScore = score);
    }
    if (best) out[i] = new Change(c.fromA + best, c.toA + best, c.fromB + best, c.toB + best);
  }
  return out;
}

/** How well a change's edge at `p` splits the text: 6 at its ends, 5 at a blank line, 4 a line break, 3 a sentence's
 *  end, 2 a space, 1 punctuation (diff-match-patch's scores). */
function boundary(t: string, p: number): number {
  if (p <= 0 || p >= t.length) return 6;
  const x = t[p - 1];
  const y = t[p];
  const word = /[\p{L}\p{N}]/u;
  const punct1 = !word.test(x);
  const punct2 = !word.test(y);
  const space1 = punct1 && /\s/.test(x);
  const space2 = punct2 && /\s/.test(y);
  const break1 = space1 && (x === "\n" || x === "\r");
  const break2 = space2 && (y === "\n" || y === "\r");
  if ((break1 && /\n\r?\n$/.test(t.slice(Math.max(0, p - 3), p))) || (break2 && /^\r?\n\r?\n/.test(t.slice(p, p + 3)))) return 5;
  if (break1 || break2) return 4;
  if (punct1 && !space1 && space2) return 3;
  if (space1 || space2) return 2;
  return punct1 || punct2 ? 1 : 0;
}

type Diff = { raw: string | null; base: Text | null; chunks: readonly Chunk[] };
const setBase = StateEffect.define<string | null>();
const diffField = StateField.define<Diff>({
  create: () => ({ raw: null, base: null, chunks: [] }),
  update(v, tr) {
    for (const e of tr.effects)
      if (e.is(setBase)) {
        const base = e.value === null ? null : Text.of(e.value.split(/\r\n?|\n/));
        return { raw: e.value, base, chunks: base ? Chunk.build(base, tr.state.doc, DIFF) : [] };
      }
    return tr.docChanged && v.base ? { ...v, chunks: Chunk.updateB(v.chunks, v.base, tr.state.doc, tr.changes, DIFF) } : v;
  },
});

type Kind = "added" | "modified" | "deleted";
/** How a change shows: what it replaced (`fromA` to `endA` of git's copy) and the lines it covers now (from `fromB` up
 *  to `toB`; lines removed, where they were: a line's start, or past the end for below the last line). As its chunk,
 *  but at the end of a file without a final line break: there the diff counts the last line as changed when lines
 *  are added or removed after it, and they show as VS Code shows them, that line as it was, the lines below added or
 *  removed. */
type Shape = { kind: Kind; fromA: number; endA: number; fromB: number; toB: number };
const shapes = new WeakMap<Chunk, { doc: Text; shape: Shape }>();
function shapeOf(c: Chunk, base: Text, doc: Text): Shape {
  const known = shapes.get(c);
  if (known?.doc === doc) return known.shape;
  let shape: Shape = { kind: c.fromA === c.toA || base.length === 0 ? "added" : c.fromB === c.toB ? "deleted" : "modified", fromA: c.fromA, endA: c.endA, fromB: c.fromB, toB: c.toB };
  if (shape.kind === "modified" && (c.toA > base.length || c.toB > doc.length)) {
    const a = base.lineAt(c.fromA).number;
    const aEnd = base.lineAt(c.endA).number;
    const b = doc.lineAt(c.fromB).number;
    const bEnd = doc.lineAt(c.endB).number;
    let k = 0;
    while (a + k <= aEnd && b + k <= bEnd && base.line(a + k).text === doc.line(b + k).text) k++;
    if (b + k > bEnd && a + k <= aEnd) shape = { kind: "deleted", fromA: base.line(a + k).from, endA: c.endA, fromB: doc.length + 1, toB: doc.length + 1 };
    else if (a + k > aEnd && b + k <= bEnd) shape = { kind: "added", fromA: c.endA, endA: c.endA, fromB: doc.line(b + k).from, toB: c.toB };
  }
  shapes.set(c, { doc, shape });
  return shape;
}

/** Where a change starts in the file: lines removed from the end of one without a final line break start past it. */
const startOf = (c: Chunk, doc: Text) => Math.min(c.fromB, doc.length);
const chunkAt = (chunks: readonly Chunk[], doc: Text, pos: number) => chunks.findIndex((c) => startOf(c, doc) <= pos && pos <= Math.min(c.endB, doc.length));
/** The change a line is part of (or that removed lines just above it, or below the last line). */
function chunkOfLine(state: EditorState, line: { from: number; to: number }): Chunk | null {
  const { chunks } = state.field(diffField);
  const last = chunks[chunks.length - 1];
  if (last && line.to === state.doc.length && last.fromB > line.to) return last;
  let lo = 0;
  let hi = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = chunks[mid];
    if (c.toB <= line.from && !(c.fromB === c.toB && c.fromB === line.from)) lo = mid + 1;
    else if (c.fromB > line.to) hi = mid - 1;
    else return c;
  }
  return null;
}

// ---------------- the bars ----------------

class Bar extends GutterMarker {
  constructor(readonly kind: string) {
    super();
    this.elementClass = `cm-git-${kind}`;
  }
  eq(other: Bar) {
    return other.kind === this.kind;
  }
}
const BARS = { added: new Bar("added"), modified: new Bar("modified"), deleted: new Bar("deleted"), deletedBelow: new Bar("deleted-below") };

function barOf(state: EditorState, line: BlockInfo): Bar | null {
  const { base } = state.field(diffField);
  const c = chunkOfLine(state, line);
  if (!c || !base) return null;
  const s = shapeOf(c, base, state.doc);
  if (s.kind !== "deleted") return line.from >= s.fromB && line.from < s.toB ? BARS[s.kind] : null;
  // Lines removed: marked where they were, on the line that now follows them, or under the last one.
  if (line.from === s.fromB) return BARS.deleted;
  return s.fromB > line.to && line.to === state.doc.length ? BARS.deletedBelow : null;
}

/** Lines only added, marked while the whole file's changes show, to go without the marks of characters added. */
function addedLines(state: EditorState): DecorationSet {
  const { base, chunks } = state.field(diffField);
  if (!base || !state.field(diffOn)) return Decoration.none;
  const out: Range<Decoration>[] = [];
  const { doc } = state;
  for (const c of chunks) {
    const s = shapeOf(c, base, doc);
    if (s.kind === "added") for (let n = doc.lineAt(s.fromB).number, last = doc.lineAt(Math.min(s.toB - 1, doc.length)).number; n <= last; n++) out.push(addedLine.range(doc.line(n).from));
  }
  return Decoration.set(out);
}
const addedLine = Decoration.line({ class: "cm-git-addedLine" });
const addedDecos = StateField.define<DecorationSet>({
  create: addedLines,
  update: (deco, tr) => (tr.state.field(diffField) === tr.startState.field(diffField) && tr.state.field(diffOn) === tr.startState.field(diffOn) ? deco.map(tr.changes) : addedLines(tr.state)),
  provide: (f) => EditorView.decorations.from(f),
});

/** The change after (or before) `from` (the caret by default), wrapping around: its index, or -1. */
function stepFrom(state: EditorState, dir: 1 | -1, from = state.selection.main.head): number {
  const { chunks } = state.field(diffField);
  if (!chunks.length) return -1;
  const here = chunkAt(chunks, state.doc, from);
  if (dir > 0) {
    const next = chunks.findIndex((c, i) => i !== here && startOf(c, state.doc) > from);
    return next >= 0 ? next : 0;
  }
  for (let i = chunks.length - 1; i >= 0; i--) if (i !== here && startOf(chunks[i], state.doc) < from) return i;
  return chunks.length - 1;
}

/** Alt+F5 / Shift+Alt+F5: the caret to the next (previous) change. */
function goStep(view: EditorView, dir: 1 | -1): boolean {
  const i = stepFrom(view.state, dir);
  if (i < 0) return false;
  const pos = startOf(view.state.field(diffField).chunks[i], view.state.doc);
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  return true;
}

/** The text's visible part (beside the gutters, as long lines scroll sideways), for the revert buttons to keep to. */
const visibleWidth = ViewPlugin.define((view) => {
  const measure = {
    read: () => ({ width: view.scrollDOM.clientWidth, gutters: view.dom.querySelector<HTMLElement>(".cm-gutters")?.offsetWidth ?? 0 }),
    write: ({ width, gutters }: { width: number; gutters: number }) => {
      view.dom.style.setProperty("--git-visible-left", `${gutters}px`);
      view.dom.style.setProperty("--git-visible-width", `${width - gutters}px`);
    },
  };
  view.requestMeasure(measure);
  return { update: (u) => u.geometryChanged && view.requestMeasure(measure) };
});

// ---------------- the whole file's changes ----------------

const setDiffOn = StateEffect.define<boolean>();
/** Whether the whole file's changes are to show (as the user last chose, in any file): they do once there's git's
 *  copy to show them against. */
const diffOn = StateField.define<boolean>({
  create: () => prefs.showChanges,
  update: (on, tr) => tr.effects.reduce((v, e) => (e.is(setDiffOn) ? e.value : v), on),
});
const unified = new Compartment();
/** Git's copy the unified view shows changes against, while it does. */
const shownBase = (state: EditorState) => (state.field(diffOn) ? state.field(diffField).base : null);

/** The unified view kept to `diffOn` and git's copy: on, off, or told of a new copy (taken in again, its fields would
 *  keep the old one). */
const followBase = EditorState.transactionExtender.of((tr) => {
  if (!tr.effects.some((e) => e.is(setBase) || e.is(setDiffOn))) return null;
  const was = shownBase(tr.startState);
  const now = shownBase(tr.state);
  if (was === now) return null;
  if (!was || !now) return { effects: unified.reconfigure(now ? unifiedFor(now) : []) };
  return { effects: updateOriginalDoc.of({ doc: now, changes: ChangeSet.of({ from: 0, to: was.length, insert: now }, was.length) }) };
});

/** Each change's revert shows while the pointer is over it: its lines, or the ones it removed. (Listened for on the
 *  text's element itself: the editor passes plugins no events from inside widgets, the removed lines'.) */
const revertOnHover = ViewPlugin.fromClass(
  class {
    hovered: HTMLElement | null = null;
    move = (e: MouseEvent) => this.set(this.under(e.target));
    leave = () => this.set(null);
    constructor(readonly view: EditorView) {
      view.contentDOM.addEventListener("mousemove", this.move);
      view.contentDOM.addEventListener("mouseleave", this.leave);
    }
    set(el: HTMLElement | null) {
      if (el === this.hovered) return;
      this.hovered?.classList.remove("cm-git-hover");
      this.hovered = el;
      el?.classList.add("cm-git-hover");
    }
    /** The removed lines' block (which holds the revert) of the change under `target`. */
    under(target: EventTarget | null): HTMLElement | null {
      if (!(target instanceof Element) || !shownBase(this.view.state)) return null;
      const removed = target.closest<HTMLElement>(".cm-deletedChunk");
      if (removed) return removed;
      const line = target.closest<HTMLElement>(".cm-changedLine");
      if (!line) return null;
      const pos = this.view.posAtDOM(line);
      const c = getChunks(this.view.state)?.chunks.find((c) => c.fromB <= pos && pos <= c.endB);
      if (!c) return null;
      for (const el of this.view.contentDOM.querySelectorAll<HTMLElement>(".cm-deletedChunk")) if (this.view.posAtDOM(el) === c.fromB) return el;
      return null;
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.transactions.some((tr) => tr.reconfigured)) this.set(null);
    }
    destroy() {
      this.view.contentDOM.removeEventListener("mousemove", this.move);
      this.view.contentDOM.removeEventListener("mouseleave", this.leave);
      this.set(null);
    }
  },
);

/** Where a line's text is on screen (below the lines shown removed above it, which are part of its block). */
function textTop(view: EditorView, pos: number): number {
  const block = view.lineBlockAt(pos);
  const text = Array.isArray(block.type) ? block.type.find((b) => b.type === BlockType.Text) : null;
  return (text ?? block).top + view.documentTop;
}

/** A bar's click: the whole file's changes shown, or hidden, the line clicked held where it is on screen (the lines
 *  shown above it would push it down). */
function toggleAt(view: EditorView, pos: number) {
  const top = textTop(view, pos);
  view.dispatch(showChangesSpec(!view.state.field(diffOn)));
  view.requestMeasure({
    read: () => textTop(view, pos) - top,
    write: (moved) => moved && (view.scrollDOM.scrollTop += moved),
  });
}

/** A revert button on each change of the unified view (accepting one would mean staging it: not here). Its editor is
 *  found at the click: the view draws each change's buttons once and keeps them, and a file's editor is made anew
 *  each time it shows again, so the editor they came with may be gone. */
function mergeControls(type: "reject" | "accept"): HTMLElement {
  const b = document.createElement("button");
  b.className = type === "reject" ? "cm-git-revert" : "cm-git-accept";
  if (type === "reject") {
    b.title = "Revert change";
    b.append(icon("undo2"));
    b.onmousedown = (e) => {
      e.preventDefault();
      const root = b.closest<HTMLElement>(".cm-editor");
      const view = root && EditorView.findFromDOM(root);
      if (view) rejectChunk(view, view.posAtDOM(b));
    };
  }
  return b;
}
const unifiedFor = (base: Text) =>
  unifiedMergeView({ original: base, gutter: false, highlightChanges: true, syntaxHighlightDeletions: true, mergeControls, diffConfig: DIFF });

// ---------------- the extension ----------------

/** The bars' colours: VS Code's for added and removed lines (its Modern themes', light and dark alike), and a yellow
 *  for changed ones (VS Code's are blue). Fixed, not the theme's: those darken in light themes so text stays readable
 *  (the tree's "M" goes brown), and a bar has no text to read. */
const BAR = { added: "#2ea043", modified: "#eab308", deleted: "#f85149" };

const theme = EditorView.theme({
  ".cm-lineNumbers .cm-gutterElement": { paddingRight: "4px" },
  ".cm-gitGutter .cm-gutterElement": { position: "relative", width: "8px", cursor: "pointer" },
  ".cm-gitGutter .cm-gutterElement::before": { content: '""', position: "absolute", pointerEvents: "none" },
  ".cm-gitGutter .cm-git-added::before, .cm-gitGutter .cm-git-modified::before": { left: "2px", top: "0", bottom: "0", width: "3px" },
  ".cm-gitGutter .cm-git-added::before": { background: BAR.added },
  ".cm-gitGutter .cm-git-modified::before": { background: BAR.modified },
  // A triangle pointing in, on the line between where lines went.
  ".cm-gitGutter .cm-git-deleted::before, .cm-gitGutter .cm-git-deleted-below::before": { left: "2px", width: "0", height: "0", border: "4px solid transparent", borderLeftColor: BAR.deleted },
  ".cm-gitGutter .cm-git-deleted::before": { top: "-4px" },
  ".cm-gitGutter .cm-git-deleted-below::before": { bottom: "-4px" },
  ".cm-deletedChunk .cm-deletedLine": { padding: "0 24px 0 4px", background: "rgba(var(--danger-rgb), 0.1)", whiteSpace: "pre" },
  ".cm-deletedChunk .cm-deletedText": { background: "rgba(var(--danger-rgb), 0.24)", borderRadius: "2px" },
  ".cm-changedLine": { background: "rgba(var(--success-rgb), 0.1) !important" },
  ".cm-changedText": { background: "rgba(var(--success-rgb), 0.24) !important", borderRadius: "2px" },
  // Lines only added, or only deleted, are wholly new or gone: the line's wash says so, without marking each character.
  ".cm-git-addedLine .cm-changedText": { background: "none !important" },
  ".cm-deletedChunk:not(:has(+ .cm-changedLine)) .cm-deletedText": { background: "none" },
  ".cm-deletedChunk": { position: "relative", paddingLeft: "0", background: "none" },
  ".cm-deletedChunk .cm-deletedLine del": { textDecoration: "none" },
  // A file that's new since: its copy is empty, and the empty line the diff takes out of it (one without a final
  // line break) isn't anything removed.
  "&.cm-git-new .cm-deletedChunk .cm-deletedLine": { display: "none" },
  ".cm-insertedLine": { textDecoration: "none" },
  // Over the change's first line, at the right of what shows of it.
  ".cm-deletedChunk .cm-chunkButtons": { position: "sticky", insetInlineEnd: "auto", left: "var(--git-visible-left, 0)", width: "var(--git-visible-width, 100%)", height: "0", boxSizing: "border-box", padding: "0 8px", display: "flex", justifyContent: "flex-end", zIndex: "1", pointerEvents: "none" },
  ".cm-git-accept": { display: "none" },
  ".cm-deletedChunk .cm-git-revert": { opacity: "0", transition: "opacity 0.12s", pointerEvents: "auto", margin: "1px 0 0", width: "18px", height: "18px", padding: "0", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "5px", border: "1px solid var(--border)", background: "var(--main)", color: "var(--muted)", cursor: "pointer" },
  ".cm-deletedChunk .cm-git-revert:hover": { color: "var(--text)", background: "linear-gradient(rgba(var(--wash-rgb), 0.09), rgba(var(--wash-rgb), 0.09)) var(--main)" },
  ".cm-deletedChunk.cm-git-hover .cm-git-revert, .cm-deletedChunk .cm-git-revert:focus-visible": { opacity: "1" },
  ".cm-git-revert .icon": { width: "13px", height: "13px" },
});

/** The bars and "Open changes", for a file's editor. `changed`: whether the file differs from git's copy, or its
 *  changes show, went one way or the other (what the bar's Open changes button follows). */
export function gitChanges(changed: () => void): Extension {
  return [
    diffField,
    diffOn,
    addedDecos,
    EditorView.editorAttributes.compute([diffField], (st): Record<string, string> => (st.field(diffField).base?.length === 0 ? { class: "cm-git-new" } : {})),
    visibleWidth,
    unified.of([]),
    followBase,
    revertOnHover,
    gutter({
      class: "cm-gitGutter",
      lineMarker: (view, line) => barOf(view.state, line),
      lineMarkerChange: (u) => u.startState.field(diffField) !== u.state.field(diffField),
      domEventHandlers: {
        mousedown(view, line) {
          if (!chunkOfLine(view.state, line)) return false;
          toggleAt(view, line.from);
          return true;
        },
      },
    }),
    Prec.high(
      keymap.of([
        { key: "Alt-F5", run: (v) => goStep(v, 1), preventDefault: true },
        { key: "Shift-Alt-F5", run: (v) => goStep(v, -1), preventDefault: true },
      ]),
    ),
    EditorView.updateListener.of((u) => {
      if (u.startState.field(diffField).chunks.length > 0 !== u.state.field(diffField).chunks.length > 0 || u.startState.field(diffOn) !== u.state.field(diffOn)) changed();
    }),
    theme,
  ];
}

/** Git's copy of the file (null: git has none) for its editor's changes to compare with: the update, or null when
 *  that's the copy it has already. */
export function baseSpec(state: EditorState, text: string | null): TransactionSpec | null {
  return state.field(diffField, false)?.raw === text ? null : { effects: setBase.of(text) };
}

/** How many places the file differs from git's copy. */
export const changeCount = (state: EditorState) => state.field(diffField, false)?.chunks.length ?? 0;
/** Whether there is a copy to compare with (the file is in a repository, and for "Last turn" the turn was kept). */
export const hasBase = (state: EditorState) => !!state.field(diffField, false)?.base;
export const showsChanges = (state: EditorState) => !!state.field(diffOn, false);

/** Open changes: every change shown in place (or not), now and once there's git's copy. */
export const showChangesSpec = (on: boolean): TransactionSpec => ({ effects: setDiffOn.of(on) });

/** A read-only review of a file's changes (the Changes tab): all of them shown against `base`, the unchanged lines
 *  between them folded away (a click opens them). */
export function reviewDiff(base: string): Extension {
  const original = Text.of(base.split(/\r\n?|\n/));
  return [
    diffField.init((st) => ({ raw: base, base: original, chunks: Chunk.build(original, st.doc, DIFF) })),
    diffOn.init(() => true),
    addedDecos,
    unifiedMergeView({ original, gutter: false, highlightChanges: true, syntaxHighlightDeletions: true, mergeControls: false, diffConfig: DIFF, collapseUnchanged: { margin: 3, minSize: 4 } }),
    EditorView.editorAttributes.of(original.length === 0 ? { class: "cm-git-new" } : {}),
    theme,
    reviewTheme,
  ];
}

const reviewTheme = EditorView.theme({
  ".cm-collapsedLines": { padding: "3px 12px", background: "rgba(var(--wash-rgb), 0.04)", color: "var(--faint)", fontFamily: "var(--sans)", fontSize: "11px", cursor: "pointer" },
  ".cm-collapsedLines:hover": { background: "rgba(var(--wash-rgb), 0.08)", color: "var(--muted)" },
  ".cm-collapsedLines::before, .cm-collapsedLines::after": { display: "none" },
});
