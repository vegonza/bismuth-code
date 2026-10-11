// The file viewer's Jupyter notebooks (.ipynb): their cells and the outputs saved with them, edited in place like
// VS Code's: code cells are editors, Markdown cells show rendered until double-clicked; cells are added, removed,
// moved and switched between code and Markdown. Nothing runs: outputs are what the file holds. Rich outputs are
// inert: HTML is sanitized (no scripts, no <style>), SVG shows as an image.
import DOMPurify from "dompurify";
import { cellEditor, type EditorView } from "./code";
import { el } from "./dom";
import { icon, type IconName } from "./icons";
import { renderMarkdown } from "./markdown";
import "./viewers.css";

type Multiline = string | string[];
type Output = {
  output_type: "stream" | "display_data" | "execute_result" | "error" | string;
  name?: string;
  text?: Multiline;
  data?: Record<string, Multiline | object>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
};
type Cell = {
  cell_type: "code" | "markdown" | "raw";
  id?: string;
  source: Multiline;
  metadata?: object;
  outputs?: Output[];
  execution_count?: number | null;
  attachments?: Record<string, Record<string, string>>;
};
type Notebook = { cells: Cell[]; metadata?: { language_info?: { name?: string }; kernelspec?: { language?: string } }; nbformat?: number; nbformat_minor?: number };

/** A cell's DOM, kept while the cell lives (its editor and undo history with it); moves just move it. */
type CellNode = { el: HTMLElement; up: HTMLButtonElement; down: HTMLButtonElement; editor: EditorView | null };

type View = {
  root: HTMLElement;
  nb: Notebook;
  /** The file's mtime the cells came from; a newer one replaces them unless there are unsaved edits. */
  mtime: number;
  dirty: boolean;
  onDirty: (dirty: boolean) => void;
  nodes: Map<Cell, CellNode>;
  foot: HTMLElement;
  /** The cell last clicked or typed in: outlined, its tools on its edge (VS Code's selected cell). */
  active: Cell | null;
};

const views = new Map<string, View>();

/** The notebook's view; the same one (edits and all) while the file's unchanged, or while it has unsaved edits.
 *  `onDirty` hears when it gains unsaved edits. Throws on text that isn't a notebook. */
export function notebookView(key: string, text: string, mtime: number, onDirty: (dirty: boolean) => void): HTMLElement {
  const had = views.get(key);
  if (had && (had.mtime === mtime || had.dirty)) return had.root;
  const nb = JSON.parse(text) as Notebook;
  if (!Array.isArray(nb?.cells)) throw new Error("Not a notebook: it has no cells");
  if (had) teardown(had);
  const v: View = { root: el("div", "nb"), nb, mtime, dirty: false, onDirty, nodes: new Map(), foot: adder("nb-foot", () => v.nb.cells.length), active: null };
  v.foot.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.onclick = () => insert(v, v.nb.cells.length, b.dataset.type as "code" | "markdown")));
  views.set(key, v);
  render(v);
  return v.root;
}

export const notebookDirty = (key: string) => !!views.get(key)?.dirty;

/** The notebook as it now stands, in Jupyter's own layout (one-space indent, a final newline), to save. */
export function notebookText(key: string): string | null {
  const v = views.get(key);
  return v ? JSON.stringify(v.nb, null, 1) + "\n" : null;
}

/** Saved as `mtime`: the edits are the file now. */
export function notebookSaved(key: string, mtime: number) {
  const v = views.get(key);
  if (v) (v.mtime = mtime), (v.dirty = false);
}

/** The tab closed (or its edits thrown away): the next view reads the file afresh. */
export function dropNotebook(key: string) {
  const v = views.get(key);
  if (v) teardown(v);
  views.delete(key);
}

function teardown(v: View) {
  for (const n of v.nodes.values()) n.editor?.destroy();
  v.nodes.clear();
}

// ---------------- cells ----------------

const joined = (s: Multiline | undefined) => (Array.isArray(s) ? s.join("") : (s ?? ""));
/** Text back into a cell's source: Jupyter's lines (each but the last keeping its newline), or one string if it was. */
const lines = (text: string, was: Multiline): Multiline => (typeof was === "string" ? text : text ? text.split(/(?<=\n)/) : []);
const language = (nb: Notebook) => nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? "python";

function changed(v: View) {
  if (v.dirty) return;
  v.dirty = true;
  v.onDirty(true);
}

/** Every cell in order (each made once), a gap to add one between each two (and above the first), then the
 *  footer; the move buttons know where their cell now stands. */
function render(v: View) {
  const cells = v.nb.cells;
  for (const [cell, node] of v.nodes) if (!cells.includes(cell)) node.editor?.destroy(), v.nodes.delete(cell);
  const parts: HTMLElement[] = [];
  cells.forEach((cell, i) => {
    let node = v.nodes.get(cell);
    if (!node) v.nodes.set(cell, (node = cellNode(v, cell)));
    node.up.disabled = i === 0;
    node.down.disabled = i === cells.length - 1;
    node.el.classList.toggle("active", cell === v.active);
    parts.push(gap(v, i), node.el);
  });
  v.root.replaceChildren(...parts, v.foot);
}

/** The cell marked as the one being worked on. */
function activate(v: View, cell: Cell) {
  if (v.active === cell) return;
  if (v.active) v.nodes.get(v.active)?.el.classList.remove("active");
  v.active = cell;
  v.nodes.get(cell)?.el.classList.add("active");
}

function newCell(nb: Notebook, type: "code" | "markdown"): Cell {
  // nbformat 4.5 and later give every cell an id.
  const id = (nb.nbformat ?? 4) > 4 || (nb.nbformat_minor ?? 0) >= 5 ? crypto.randomUUID().slice(0, 8) : undefined;
  const cell: Cell = type === "code" ? { cell_type: "code", execution_count: null, id, metadata: {}, outputs: [], source: [] } : { cell_type: "markdown", id, metadata: {}, source: [] };
  if (!id) delete cell.id;
  return cell;
}

/** A new cell at `at`, its editor open. */
function insert(v: View, at: number, type: "code" | "markdown") {
  const cell = newCell(v.nb, type);
  v.nb.cells.splice(at, 0, cell);
  changed(v);
  render(v);
  const node = v.nodes.get(cell)!;
  if (type === "markdown") editMarkdown(v, cell, node);
  activate(v, cell);
  requestAnimationFrame(() => {
    node.editor?.focus();
    node.el.scrollIntoView({ block: "nearest" });
  });
}

function cellNode(v: View, cell: Cell): CellNode {
  const box = el("div", `nb-cell nb-${cell.cell_type}`);
  const node: CellNode = { el: box, up: el("button"), down: el("button"), editor: null };
  box.addEventListener("pointerdown", () => activate(v, cell));
  box.addEventListener("focusin", () => activate(v, cell));
  if (cell.cell_type === "markdown") showMarkdown(v, cell, node);
  else {
    const frame = el("div", "nb-frame");
    const host = el("div", "nb-editor");
    frame.append(host);
    box.append(frame);
    node.editor = cellEditor(host, joined(cell.source), cell.cell_type === "code" ? language(v.nb) : "", {
      change: (text) => {
        cell.source = lines(text, cell.source);
        changed(v);
      },
      leave: () => node.editor?.contentDOM.blur(),
    });
    if (cell.cell_type === "code" && cell.outputs?.length) {
      const outs = el("div", "nb-outputs");
      for (const o of cell.outputs) {
        const out = output(o);
        if (out) outs.append(out);
      }
      if (outs.childElementCount) box.append(outs);
    }
  }
  box.append(tools(v, cell, node));
  return node;
}

/** A Markdown cell as it reads; a double-click opens its source. */
function showMarkdown(v: View, cell: Cell, node: CellNode) {
  node.editor?.destroy();
  node.editor = null;
  const text = joined(cell.source);
  const md = el("div", "nb-md md");
  if (text.trim()) renderMarkdown(withAttachments(text, cell), md);
  else md.append(el("span", "nb-empty", "Empty Markdown cell · double-click to write"));
  md.ondblclick = () => {
    editMarkdown(v, cell, node);
    node.editor?.focus();
  };
  node.el.classList.remove("editing");
  node.el.querySelector(":scope > .nb-md, :scope > .nb-frame")?.remove();
  node.el.prepend(md);
}

/** A Markdown cell's source in an editor, until it's left (Escape, Shift+Enter, or the focus going elsewhere). */
function editMarkdown(v: View, cell: Cell, node: CellNode) {
  if (node.editor) return;
  const frame = el("div", "nb-frame");
  const host = el("div", "nb-editor");
  frame.append(host);
  node.el.querySelector(":scope > .nb-md")?.remove();
  node.el.prepend(frame);
  node.el.classList.add("editing");
  const done = () => node.editor && showMarkdown(v, cell, node);
  node.editor = cellEditor(host, joined(cell.source), "markdown", {
    change: (text) => {
      cell.source = lines(text, cell.source);
      changed(v);
    },
    leave: done,
  });
  // Clicking elsewhere leaves it too (its own tools keep the focus: they don't take it).
  node.editor.contentDOM.addEventListener("blur", () => setTimeout(() => node.editor && !node.editor.hasFocus && done(), 0));
}

/** A cell's controls, over its top-right corner while the pointer's on it: its type, move up and down, add a cell
 *  of its type below, delete. */
function tools(v: View, cell: Cell, node: CellNode): HTMLElement {
  const bar = el("div", "nb-tools");
  const act = (b: HTMLButtonElement, run: () => void) => {
    b.onmousedown = (e) => e.preventDefault(); // an open editor keeps the focus
    b.onclick = (e) => {
      e.stopPropagation();
      run();
    };
    return b;
  };
  const button = (b: HTMLButtonElement, glyph: IconName, title: string, run: () => void) => {
    b.className = "nb-tool";
    b.title = title;
    b.append(icon(glyph));
    return act(b, run);
  };
  const at = () => v.nb.cells.indexOf(cell);
  const kind = act(el("button", "nb-tool nb-kind", cell.cell_type === "markdown" ? "Markdown" : cell.cell_type === "raw" ? "Raw" : "Code"), () => {
    const to = cell.cell_type === "code" ? "markdown" : "code";
    cell.cell_type = to;
    // Markdown cells have no outputs or count; code cells must have both.
    if (to === "markdown") delete cell.outputs, delete cell.execution_count;
    else (cell.outputs = []), (cell.execution_count = null), delete cell.attachments;
    node.editor?.destroy();
    v.nodes.delete(cell);
    changed(v);
    render(v);
  });
  kind.title = cell.cell_type === "code" ? "Make it a Markdown cell" : "Make it a code cell";
  const move = (by: number) => {
    const i = at();
    v.nb.cells.splice(i + by, 0, ...v.nb.cells.splice(i, 1));
    changed(v);
    render(v);
    node.el.scrollIntoView({ block: "nearest" });
  };
  bar.append(
    kind,
    button(node.up, "arrowUp", "Move up", () => move(-1)),
    button(node.down, "arrowDown", "Move down", () => move(1)),
    button(el("button"), "plus", cell.cell_type === "markdown" ? "Add a Markdown cell below" : "Add a code cell below", () => insert(v, at() + 1, cell.cell_type === "markdown" ? "markdown" : "code")),
    button(el("button"), "trash2", "Delete cell", () => {
      v.nb.cells.splice(at(), 1);
      changed(v);
      render(v);
    }),
  );
  return bar;
}

/** Code and Markdown buttons that add a cell at `at()`. */
function adder(cls: string, at: () => number, v?: View): HTMLElement {
  const box = el("div", cls);
  for (const [type, label] of [["code", "Code"], ["markdown", "Markdown"]] as const) {
    const b = el("button", "nb-add");
    b.dataset.type = type;
    b.title = type === "code" ? "Add a code cell here" : "Add a Markdown cell here";
    b.append(icon("plus"), el("span", "", label));
    if (v) b.onclick = () => insert(v, at(), type);
    box.append(b);
  }
  return box;
}

/** Above cell `i`: its buttons show while the pointer's in the gap. */
const gap = (v: View, i: number) => adder("nb-gap", () => i, v);

/** `attachment:name` images in a Markdown cell point at the data the cell carries. */
function withAttachments(text: string, cell: Cell): string {
  if (!cell.attachments) return text;
  return text.replace(/attachment:([^\s)"'>]+)/g, (whole, name: string) => {
    const bundle = cell.attachments![decodeURIComponent(name)];
    const mime = bundle && Object.keys(bundle).find((m) => m.startsWith("image/"));
    return mime ? `data:${mime};base64,${String(bundle[mime]).replace(/\s+/g, "")}` : whole;
  });
}

// ---------------- outputs ----------------

function output(o: Output): HTMLElement | null {
  if (o.output_type === "stream") return ansi(joined(o.text), `nb-stream${o.name === "stderr" ? " stderr" : ""}`);
  if (o.output_type === "error") return ansi(o.traceback?.length ? o.traceback.join("\n") : `${o.ename}: ${o.evalue}`, "nb-error");
  if ((o.output_type === "execute_result" || o.output_type === "display_data") && o.data) return rich(o.data);
  return null;
}

/** The richest form of a display the viewer can show inertly. */
function rich(data: Record<string, Multiline | object>): HTMLElement | null {
  const text = (mime: string) => (typeof data[mime] === "string" || Array.isArray(data[mime]) ? joined(data[mime] as Multiline) : JSON.stringify(data[mime], null, 2));
  if (data["text/html"]) {
    const box = el("div", "nb-html");
    box.innerHTML = DOMPurify.sanitize(text("text/html"), { FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"] });
    box.querySelectorAll("a").forEach((a) => ((a.target = "_blank"), (a.rel = "noreferrer")));
    // Script-built displays (plots, widgets) sanitize to nothing: their text form says what they were instead.
    const shows = box.textContent!.trim() || box.querySelector("img, svg, table, video, canvas");
    if (shows || !data["text/plain"]) return box;
  }
  if (data["image/svg+xml"]) return image(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text("image/svg+xml"))}`);
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"])
    if (data[mime]) return image(`data:${mime};base64,${text(mime).replace(/\s+/g, "")}`);
  if (data["text/markdown"]) {
    const md = el("div", "nb-md md");
    renderMarkdown(text("text/markdown"), md);
    return md;
  }
  if (data["text/latex"]) return el("pre", "nb-text", text("text/latex"));
  if (data["application/json"]) return el("pre", "nb-text", text("application/json"));
  if (data["text/plain"]) return ansi(text("text/plain"), "nb-text");
  return null;
}

function image(src: string): HTMLElement {
  const box = el("div", "nb-image");
  const img = el("img");
  img.src = src;
  img.alt = "";
  box.append(img);
  return box;
}

const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** Text with its terminal colours (SGR codes) as classes; other escapes dropped. */
function ansi(text: string, cls: string): HTMLElement {
  const pre = el("pre", cls);
  let fg: string | null = null;
  let bold = false;
  const re = /\x1b\[([\d;]*)m|\x1b\[[\d;?]*[A-Za-z]|\r(?!\n)/g;
  let at = 0;
  const push = (s: string) => {
    if (!s) return;
    if (!fg && !bold) return void pre.append(s);
    pre.append(el("span", [fg && `ansi-${fg}`, bold && "ansi-bold"].filter(Boolean).join(" "), s));
  };
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) (fg = null), (bold = false);
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30];
      else if (c >= 90 && c <= 97) fg = ANSI_COLORS[c - 90];
      else if (c === 39) fg = null;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4; // 256 and true colours: skipped
    }
  }
  push(text.slice(at));
  return pre;
}
