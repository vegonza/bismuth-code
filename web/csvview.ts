// The file viewer's CSV and TSV files: a table of them. A click on a column's head sorts by it (numbers as numbers),
// the search above finds rows by any cell, and each column's own filter narrows them further (text, or for numbers
// `>10`, `<=3`, `1..5`; `!` for "not", `=` for exact, `/…/` for a pattern). Columns are sized to what they hold and
// resizable; a cell is selected by a click (arrows move it, Mod+C copies it). Beside the search, how many rows and
// columns there are, or a summary of the column the pointer is on. Only the rows in view are drawn, so long files scroll as fast as short ones.
// Spreadsheets (Excel, OpenDocument) show in the same table, a tab per sheet under it, read by SheetJS (its own
// chunk, loaded the first time one opens).
import { el } from "./dom";
import { icon } from "./icons";
import { loadXlsx } from "./lazy";
import "./viewers.css";

/** A row's height (viewers.css .csv-row). */
const ROW_H = 26;
/** Rows drawn past the view's edges. */
const OVERSCAN = 12;
const MAX_COLS = 1000;
const COL_MIN = 48;
const COL_MAX = 420;

type Col = { name: string; numeric: boolean; width: number; nums: Float64Array | null; stats: string | null };
type View = {
  root: HTMLElement;
  text: string;
  path: string;
  /** A workbook's sheets (as their cells show), and the one shown. */
  sheets: { name: string; rows: string[][] }[] | null;
  sheet: number;
  tabs: HTMLElement;
  note: HTMLElement;
  delim: string;
  /** Every row as read, the header among them when there is one. */
  all: string[][];
  header: boolean;
  cols: Col[];
  sort: { col: number; dir: 1 | -1 } | null;
  query: string;
  filters: string[];
  /** The data rows shown, in order (indices into `data()`). */
  shown: Int32Array;
  sel: { row: number; col: number } | null;
  hovered: number | null;
  scroller: HTMLElement;
  table: HTMLTableElement;
  colgroup: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
  search: HTMLInputElement;
  filterBtn: HTMLButtonElement;
  /** The filters' row shows (asked for, or with a filter set). */
  filtering: boolean;
  drawn: string;
};

const views = new Map<string, View>();

/** The table of the file's text; the same one (sort, filters, scroll and all) while it's open, read again when the
 *  text changes. */
export function csvView(key: string, text: string, path: string): HTMLElement {
  let v = views.get(key);
  if (v && v.text === text) return v.root;
  if (!v) views.set(key, (v = build(path)));
  load(v, text);
  return v.root;
}

/** The table of the workbook at `url` (fetched, and fetched again when the file changes: `mtime`). */
export function sheetView(key: string, url: string, mtime: number, path: string): HTMLElement {
  let v = views.get(key);
  const stamp = `\u0000${mtime}`;
  if (v && v.text === stamp) return v.root;
  if (!v) views.set(key, (v = build(path)));
  const view = v;
  view.text = stamp;
  if (!view.sheets) note(view, "");
  void readWorkbook(url).then(
    (sheets) => {
      if (view.text !== stamp) return;
      const had = view.sheets?.[view.sheet]?.name;
      view.sheets = sheets;
      view.sheet = Math.max(0, sheets.findIndex((s) => s.name === had));
      note(view, null);
      showSheet(view, true);
    },
    (err) => {
      if (view.text === stamp) note(view, `Couldn't read this workbook · ${err?.message ?? err}`);
    },
  );
  return view.root;
}

/** In place of the rows while a workbook loads (`""`), or why it can't; `null` takes it away. */
function note(v: View, text: string | null) {
  v.note.hidden = text === null;
  v.note.textContent = text ?? "";
}

async function readWorkbook(url: string) {
  const [{ read, utils }, bytes] = await Promise.all([loadXlsx(), fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))]);
  const book = read(bytes, { dense: true, cellDates: true });
  return book.SheetNames.map((name) => ({ name, rows: utils.sheet_to_json<string[]>(book.Sheets[name], { header: 1, raw: false, defval: "", blankrows: true }) }));
}

/** The workbook's current sheet in the table, its tab marked. `keep`: the file changed, so its sort and filters stay. */
function showSheet(v: View, keep: boolean) {
  const sheets = v.sheets!;
  v.tabs.replaceChildren(
    ...sheets.map((s, i) => {
      const tab = el("button", i === v.sheet ? "csv-tab on" : "csv-tab", s.name);
      tab.onclick = () => {
        if (i === v.sheet) return;
        v.sheet = i;
        v.query = "";
        v.scroller.scrollTop = 0;
        v.scroller.scrollLeft = 0;
        showSheet(v, false);
      };
      return tab;
    }),
  );
  v.tabs.hidden = sheets.length < 2;
  if (!keep) v.all = [];
  loadRows(v, sheets[v.sheet]?.rows ?? [], "");
}

/** The file's tab closed. */
export function dropCsv(key: string) {
  views.delete(key);
}

// ---------------- reading ----------------

/** The delimiter: a TSV's tab, or whichever of , ; tab | splits the first lines most evenly. */
function sniff(text: string, path: string): string {
  if (/\.(tsv|tab)$/i.test(path)) return "\t";
  if (/\.psv$/i.test(path)) return "|";
  const lines = text.slice(0, 64 * 1024).split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ",";
  let score = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => splitLine(l, d));
    if (!counts.length || counts[0] < 1) continue;
    const same = counts.filter((c) => c === counts[0]).length / counts.length;
    const s = same * 1000 + counts[0];
    if (s > score) (score = s), (best = d);
  }
  return best;
}
/** How many delimiters a line holds outside quotes. */
function splitLine(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

/** RFC 4180: quoted fields hold delimiters, line breaks and doubled quotes. */
export function parseCsv(text: string, d: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i <= n) {
    if (i === n) {
      if (row.length) rows.push(row);
      break;
    }
    let field: string;
    if (text[i] === '"') {
      let s = "";
      let from = ++i;
      for (;;) {
        const q = text.indexOf('"', from);
        if (q < 0) {
          s += text.slice(from);
          i = n;
          break;
        }
        s += text.slice(from, q);
        if (text[q + 1] === '"') {
          s += '"';
          from = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      // Anything between the closing quote and the delimiter is kept, as spreadsheets do.
      let end = i;
      while (end < n && text[end] !== d && text[end] !== "\n" && text[end] !== "\r") end++;
      field = s + text.slice(i, end);
      i = end;
    } else {
      let end = i;
      while (end < n && text[end] !== d && text[end] !== "\n" && text[end] !== "\r") end++;
      field = text.slice(i, end);
      i = end;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    if (text[i] === d) i++;
    else {
      i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
      rows.push(row);
      row = [];
    }
  }
  // A last empty line isn't a row.
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

/** A cell as a number, or NaN: thousands separators, a percent sign and (with `;` files) a decimal comma allowed. */
function toNumber(s: string, comma: boolean): number {
  let t = s.trim();
  if (!t) return NaN;
  if (t.endsWith("%")) t = t.slice(0, -1);
  if (comma && /^[-+]?\d{1,3}(\.\d{3})*(,\d+)?$|^[-+]?\d+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

const data = (v: View) => (v.header ? v.all.slice(1) : v.all);

function load(v: View, text: string) {
  v.text = text;
  const delim = sniff(text, v.path);
  loadRows(v, parseCsv(text, delim), delim);
}

/** `rows` in the table; a reload of what it showed keeps its sort, filters and selection when the columns stayed. */
function loadRows(v: View, rows: string[][], delim: string) {
  const same = v.all.length > 0;
  v.delim = delim;
  v.all = rows;
  const width = Math.min(MAX_COLS, Math.max(0, ...v.all.slice(0, 5000).map((r) => r.length)));
  const keep = same && v.cols.length === width;
  if (!same) v.header = guessHeader(v.all, v.delim);
  columnsOf(v, width, keep ? v.cols : null);
  if (!keep) (v.sort = null), (v.filters = Array(width).fill("")), (v.sel = null);
  v.search.value = v.query;
  drawHead(v);
  apply(v);
}

/** Whether the first row names the columns: it does unless it's a row like the rest (numbers where they have them). */
function guessHeader(rows: string[][], d: string): boolean {
  if (rows.length < 2) return true;
  const comma = d === ";";
  const first = rows[0];
  const sample = rows.slice(1, 50);
  for (let c = 0; c < first.length; c++) {
    const numericBelow = sample.filter((r) => !Number.isNaN(toNumber(r[c] ?? "", comma))).length > sample.length * 0.8;
    if (numericBelow && !Number.isNaN(toNumber(first[c], comma))) return false;
  }
  return new Set(first).size === first.length || first.some((f) => /[a-z]/i.test(f));
}

function columnsOf(v: View, width: number, had: Col[] | null) {
  const rows = data(v);
  const comma = v.delim === ";";
  const css = getComputedStyle(document.documentElement);
  const px = 12 * (parseFloat(css.getPropertyValue("--fs")) || 1);
  const family = css.getPropertyValue("--sans") || "sans-serif";
  const ctx = document.createElement("canvas").getContext("2d")!;
  const sample = rows.length > 400 ? rows.filter((_, i) => i % Math.ceil(rows.length / 400) === 0) : rows;
  v.cols = Array.from({ length: width }, (_, c) => {
    const name = v.header ? (v.all[0]?.[c] ?? "") : "";
    const nums = new Float64Array(rows.length);
    let numbers = 0;
    let filled = 0;
    for (let r = 0; r < rows.length; r++) {
      const cell = rows[r][c] ?? "";
      const x = toNumber(cell, comma);
      nums[r] = x;
      if (cell.trim()) filled++;
      if (!Number.isNaN(x)) numbers++;
    }
    const numeric = filled > 0 && numbers >= filled * 0.95;
    // The name in the head's weight, beside its type mark and sort arrow; the cells with their padding.
    ctx.font = `600 ${px}px ${family}`;
    let w = ctx.measureText(name || columnName(c)).width + 64;
    ctx.font = `${px}px ${family}`;
    for (const row of sample) w = Math.max(w, ctx.measureText((row[c] ?? "").slice(0, 80)).width + 24);
    return { name, numeric, width: had?.[c]?.width ?? Math.round(Math.min(COL_MAX, Math.max(COL_MIN, w))), nums: numeric ? nums : null, stats: null };
  });
}

/** A spreadsheet's column letters, for files without a header: A … Z, AA … */
function columnName(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// ---------------- filtering and sorting ----------------

type Test = (cell: string, num: number) => boolean;

/** A column's filter as a test: comparisons and ranges for numbers, `!` not, `=` exact, `/…/` a pattern, else text. */
function test(raw: string, numeric: boolean): Test | null {
  let f = raw.trim();
  if (!f) return null;
  let not = false;
  if (f.startsWith("!") && !f.startsWith("!=")) (not = true), (f = f.slice(1).trim());
  const wrap = (t: Test): Test => (not ? (c, n) => !t(c, n) : t);
  const re = /^\/(.+)\/([imsu]*)$/.exec(f);
  if (re)
    try {
      const rx = new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i");
      return wrap((c) => rx.test(c));
    } catch {
      return () => false;
    }
  if (numeric) {
    const range = /^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)$/.exec(f);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      return wrap((_, n) => n >= a && n <= b);
    }
    const cmp = /^(>=|<=|!=|>|<|=)\s*(-?[\d.]+(?:e[-+]?\d+)?)$/i.exec(f);
    if (cmp) {
      const x = Number(cmp[2]);
      const ops: Record<string, (n: number) => boolean> = { ">": (n) => n > x, "<": (n) => n < x, ">=": (n) => n >= x, "<=": (n) => n <= x, "=": (n) => n === x, "!=": (n) => n !== x };
      return wrap((_, n) => ops[cmp[1]](n));
    }
  }
  if (f.startsWith("=")) {
    const exact = f.slice(1).trim().toLowerCase();
    return wrap((c) => c.trim().toLowerCase() === exact);
  }
  const needle = f.toLowerCase();
  return wrap((c) => c.toLowerCase().includes(needle));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The rows shown: those every filter and the search let through, in the column's order. */
function apply(v: View) {
  const rows = data(v);
  const tests = v.cols.map((c, i) => test(v.filters[i] ?? "", c.numeric));
  const q = v.query.trim().toLowerCase();
  const out: number[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    let ok = true;
    for (let c = 0; c < tests.length && ok; c++) {
      const t = tests[c];
      if (t && !t(row[c] ?? "", v.cols[c].nums ? v.cols[c].nums![r] : NaN)) ok = false;
    }
    if (ok && q) ok = row.some((cell) => cell.toLowerCase().includes(q));
    if (ok) out.push(r);
  }
  if (v.sort) {
    const { col, dir } = v.sort;
    const nums = v.cols[col]?.nums;
    // Empty (and, by numbers, not-a-number) cells last either way.
    if (nums)
      out.sort((a, b) => {
        const x = nums[a];
        const y = nums[b];
        if (Number.isNaN(x)) return Number.isNaN(y) ? a - b : 1;
        if (Number.isNaN(y)) return -1;
        return (x - y) * dir || a - b;
      });
    else
      out.sort((a, b) => {
        const x = rows[a][col] ?? "";
        const y = rows[b][col] ?? "";
        if (!x) return y ? 1 : a - b;
        if (!y) return -1;
        return collator.compare(x, y) * dir || a - b;
      });
  }
  v.shown = Int32Array.from(out);
  v.sel = null;
  v.drawn = "";
  draw(v);
  status(v);
}

// ---------------- drawing ----------------

function build(path: string): View {
  const root = el("div", "csv");
  root.tabIndex = -1;
  const bar = el("div", "csv-bar");
  const field = el("label", "csv-search");
  const search = el("input");
  search.placeholder = "Search rows";
  search.spellcheck = false;
  field.append(icon("search"), search);
  const filterBtn = el("button", "csv-btn csv-filterbtn");
  filterBtn.title = "Filter by column";
  filterBtn.append(icon("listFilter"));
  const clear = el("button", "csv-btn csv-clear");
  clear.title = "Clear the filters";
  clear.append(icon("x"), el("span", "", "Clear"));
  const meta = el("div", "csv-meta");
  bar.append(field, filterBtn, clear, meta);
  const scroller = el("div", "csv-scroll");
  const table = el("table", "csv-table");
  const colgroup = el("colgroup");
  const head = el("thead");
  const body = el("tbody");
  table.append(colgroup, head, body);
  const note = el("div", "fv-note");
  note.hidden = true;
  scroller.append(table, note);
  const tabs = el("div", "csv-tabs");
  tabs.hidden = true;
  root.append(bar, scroller, tabs);
  const v: View = { root, text: "", path, sheets: null, sheet: 0, tabs, note, delim: ",", all: [], header: true, cols: [], sort: null, query: "", filters: [], shown: new Int32Array(), sel: null, hovered: null, scroller, table, colgroup, head, body, meta, search, filterBtn, filtering: false, drawn: "" };
  clear.onclick = () => clearFilters(v);
  filterBtn.onclick = () => {
    v.filtering = !v.filtering || v.filters.some((f) => f.trim());
    headState(v);
    v.drawn = "";
    draw(v);
    if (v.filtering) v.head.querySelector<HTMLInputElement>(".csv-filters input")?.focus();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = (run: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 90);
  };
  search.oninput = () => later(() => ((v.query = search.value), apply(v)));
  search.onkeydown = (e) => {
    if (e.key === "Escape" && search.value) {
      e.stopPropagation();
      search.value = "";
      v.query = "";
      apply(v);
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      if (v.shown.length) select(v, 0, v.sel?.col ?? 0);
    }
  };
  scroller.addEventListener("scroll", () => draw(v), { passive: true });
  new ResizeObserver(() => draw(v)).observe(scroller);

  // The filters: typing narrows the rows (after a pause), Escape clears the one typed in.
  head.addEventListener("input", (e) => {
    const input = e.target as HTMLInputElement;
    const c = Number(input.dataset.col);
    later(() => ((v.filters[c] = input.value), input.classList.toggle("on", !!input.value.trim()), apply(v), headState(v)));
  });
  head.addEventListener("keydown", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.tagName !== "INPUT") return;
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      v.filters[Number(input.dataset.col)] = "";
      input.classList.remove("on");
      apply(v);
      headState(v);
    } else if (e.key === "Enter") input.blur();
  });
  head.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, .csv-resize")) return;
    const th = t.closest<HTMLElement>("th[data-col]");
    if (!th) return;
    const c = Number(th.dataset.col);
    // Ascending, descending, then as the file has them.
    v.sort = v.sort?.col !== c ? { col: c, dir: 1 } : v.sort.dir === 1 ? { col: c, dir: -1 } : null;
    apply(v);
    headState(v);
  });
  head.addEventListener("pointerover", (e) => {
    const th = (e.target as HTMLElement).closest<HTMLElement>("th[data-col]");
    const c = th ? Number(th.dataset.col) : null;
    if (c !== v.hovered) (v.hovered = c), status(v);
  });
  head.addEventListener("pointerleave", () => ((v.hovered = null), status(v)));
  head.addEventListener("pointerdown", (e) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>(".csv-resize");
    if (grip) resizeColumn(v, Number(grip.dataset.col), e);
  });

  body.addEventListener("mousedown", (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-col]");
    const tr = td?.parentElement as HTMLElement | undefined;
    if (!td || !tr?.dataset.i) return;
    select(v, Number(tr.dataset.i), Number(td.dataset.col), false);
    root.focus({ preventScroll: true });
  });
  root.addEventListener("keydown", (e) => keys(v, e));
  return v;
}

/** The head: each column's name, type and sort; a filter under it (when filtering). A last column takes the room
 *  left, so the rows reach across the view. */
function drawHead(v: View) {
  v.colgroup.replaceChildren(el("col", "csv-numcol"), ...v.cols.map((c) => Object.assign(el("col"), { style: `width: ${c.width}px` })), el("col"));
  const names = el("tr", "csv-names");
  names.append(el("th", "csv-corner"));
  const filters = el("tr", "csv-filters");
  filters.append(el("th", "csv-corner"));
  v.cols.forEach((c, i) => {
    const th = el("th");
    th.dataset.col = String(i);
    if (c.numeric) th.classList.add("num");
    const label = el("span", "csv-name", c.name || columnName(i));
    if (!v.header || !c.name) label.classList.add("letter");
    th.title = c.name || columnName(i);
    th.append(el("span", "csv-type", c.numeric ? "#" : "Aa"), label, el("span", "csv-sort"));
    const grip = el("span", "csv-resize");
    grip.dataset.col = String(i);
    th.append(grip);
    names.append(th);
    const f = el("th");
    const input = el("input");
    input.dataset.col = String(i);
    input.placeholder = "Filter…";
    input.title = c.numeric ? "Text, or a comparison: >10, <=3, !=0, 1..5 (! for not, = for exact, /…/ for a pattern)" : "Text (! for not, = for exact, /…/ for a pattern)";
    input.spellcheck = false;
    input.value = v.filters[i] ?? "";
    input.classList.toggle("on", !!input.value.trim());
    f.append(input);
    filters.append(f);
  });
  names.append(el("th", "csv-fill"));
  filters.append(el("th", "csv-fill"));
  v.head.replaceChildren(names, filters);
  v.table.style.width = `max(${tableWidth(v)}px, 100%)`;
  headState(v);
}

const NUM_W = 56;
const tableWidth = (v: View) => NUM_W + v.cols.reduce((s, c) => s + c.width, 0);

/** The sorted column's arrow, and whether there are filters to clear. */
function headState(v: View) {
  v.head.querySelectorAll<HTMLElement>(".csv-names th[data-col]").forEach((th) => {
    const c = Number(th.dataset.col);
    const on = v.sort?.col === c;
    th.classList.toggle("sorted", on);
    th.querySelector(".csv-sort")!.textContent = on ? (v.sort!.dir === 1 ? "↑" : "↓") : "";
  });
  const filtered = v.filters.some((f) => f.trim());
  v.root.classList.toggle("filtered", filtered);
  v.root.classList.toggle("filtering", v.filtering || filtered);
  v.filterBtn.classList.toggle("on", v.filtering || filtered);
}

function clearFilters(v: View) {
  v.filters = v.filters.map(() => "");
  v.filtering = false;
  v.head.querySelectorAll<HTMLInputElement>(".csv-filters input").forEach((i) => ((i.value = ""), i.classList.remove("on")));
  apply(v);
  headState(v);
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A cell's text, the search's matches marked. */
function cellHtml(text: string, q: string): string {
  const shown = text.length > 400 ? text.slice(0, 400) + "…" : text;
  if (!q) return escHtml(shown);
  const lower = shown.toLowerCase();
  let out = "";
  let at = 0;
  for (let k = lower.indexOf(q); k >= 0; k = lower.indexOf(q, k + q.length)) {
    out += escHtml(shown.slice(at, k)) + `<mark>${escHtml(shown.slice(k, k + q.length))}</mark>`;
    at = k + q.length;
  }
  return out + escHtml(shown.slice(at));
}

/** The rows in and near the view; above and below them, room for the rest. */
function draw(v: View) {
  const headH = v.head.offsetHeight;
  const top = Math.max(0, v.scroller.scrollTop - headH);
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const last = Math.min(v.shown.length, Math.ceil((top + v.scroller.clientHeight) / ROW_H) + OVERSCAN);
  const sig = `${first}:${last}:${v.sel?.row}:${v.sel?.col}`;
  if (sig === v.drawn) return;
  v.drawn = sig;
  const rows = data(v);
  const q = v.query.trim().toLowerCase();
  let html = `<tr class="csv-pad" style="height: ${first * ROW_H}px"></tr>`;
  for (let k = first; k < last; k++) {
    const r = v.shown[k];
    const row = rows[r];
    html += `<tr class="csv-row" data-i="${k}"><th>${r + 1}</th>`;
    for (let c = 0; c < v.cols.length; c++) {
      const text = row[c] ?? "";
      const sel = v.sel?.row === k && v.sel.col === c ? " sel" : "";
      html += `<td data-col="${c}" class="${v.cols[c].numeric ? "num" : ""}${sel}"${text.length > 24 ? ` title="${escHtml(text.slice(0, 2000))}"` : ""}>${cellHtml(text, q)}</td>`;
    }
    html += `<td class="csv-fill"></td></tr>`;
  }
  html += `<tr class="csv-pad" style="height: ${(v.shown.length - last) * ROW_H}px"></tr>`;
  v.body.innerHTML = html;
  if (!v.shown.length) v.body.innerHTML = `<tr><td class="csv-none" colspan="${v.cols.length + 2}">${rows.length ? "No rows match" : "No rows"}</td></tr>`;
}

/** Beside the search: how many rows show (of how many) and columns, or a summary of the column the pointer's on;
 *  whether the first row is the header. */
function status(v: View) {
  const total = data(v).length;
  const c = v.hovered;
  const delim = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" }[v.delim] ?? v.delim;
  const rows = v.shown.length === total ? `${total.toLocaleString()} rows` : `${v.shown.length.toLocaleString()} of ${total.toLocaleString()} rows`;
  const text = el("span", "csv-metatext");
  if (c !== null && v.cols[c]) text.append(el("strong", "", v.cols[c].name || columnName(c)), ` · ${stats(v, c)}`);
  else text.append(rows, el("span", "csv-dim", ` · ${v.cols.length} columns`));
  text.title = c !== null ? (text.textContent ?? "") : `${rows} · ${v.cols.length} columns${v.sheets ? ` · ${v.sheets[v.sheet]?.name}` : ` · ${delim}-separated`}`;
  const toggle = el("button", "csv-btn csv-headtoggle", v.header ? "Header row" : "No header");
  toggle.title = v.header ? "Read the first row as data" : "Read the first row as the columns' names";
  toggle.onclick = () => {
    v.header = !v.header;
    columnsOf(v, v.cols.length, null);
    v.sort = null;
    drawHead(v);
    apply(v);
  };
  toggle.classList.toggle("on", v.header);
  v.meta.replaceChildren(text, toggle);
}

/** A column's summary, over the rows shown: numbers' range, mean and sum; text's distinct values; empty cells. */
function stats(v: View, c: number): string {
  const rows = data(v);
  const col = v.cols[c];
  let empty = 0;
  if (col.nums) {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    for (const r of v.shown) {
      const x = col.nums[r];
      if (Number.isNaN(x)) {
        empty++;
        continue;
      }
      n++;
      sum += x;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    if (!n) return `${empty.toLocaleString()} empty`;
    const f = (x: number) => (Number.isInteger(x) ? x.toLocaleString() : x.toLocaleString(undefined, { maximumFractionDigits: 4 }));
    return [`min ${f(min)}`, `max ${f(max)}`, `mean ${f(sum / n)}`, `sum ${f(sum)}`, empty ? `${empty.toLocaleString()} empty` : ""].filter(Boolean).join(" · ");
  }
  const seen = new Set<string>();
  for (const r of v.shown) {
    const t = rows[r][c] ?? "";
    if (!t.trim()) empty++;
    else if (seen.size < 100_000) seen.add(t);
  }
  return [`${seen.size.toLocaleString()}${seen.size >= 100_000 ? "+" : ""} distinct`, empty ? `${empty.toLocaleString()} empty` : ""].filter(Boolean).join(" · ");
}

// ---------------- selection, keys, sizes ----------------

/** The cell at shown row `k`, column `c`, selected (and scrolled to). */
function select(v: View, k: number, c: number, reveal = true) {
  k = Math.max(0, Math.min(v.shown.length - 1, k));
  c = Math.max(0, Math.min(v.cols.length - 1, c));
  v.sel = { row: k, col: c };
  if (reveal) {
    const headH = v.head.offsetHeight;
    const y = headH + k * ROW_H;
    const s = v.scroller;
    if (y < s.scrollTop + headH) s.scrollTop = y - headH;
    else if (y + ROW_H > s.scrollTop + s.clientHeight) s.scrollTop = y + ROW_H - s.clientHeight;
    const x = NUM_W + v.cols.slice(0, c).reduce((a, col) => a + col.width, 0);
    const w = v.cols[c].width;
    if (x < s.scrollLeft + NUM_W) s.scrollLeft = x - NUM_W;
    else if (x + w > s.scrollLeft + s.clientWidth) s.scrollLeft = x + w - s.clientWidth;
    v.root.focus({ preventScroll: true });
  }
  v.drawn = "";
  draw(v);
  status(v);
}

function keys(v: View, e: KeyboardEvent) {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === "f") {
    e.preventDefault();
    e.stopPropagation();
    v.search.focus();
    v.search.select();
    return;
  }
  if (!v.sel) return;
  const { row, col } = v.sel;
  const page = Math.max(1, Math.floor(v.scroller.clientHeight / ROW_H) - 2);
  const moves: Record<string, [number, number]> = {
    ArrowUp: [row - 1, col], ArrowDown: [row + 1, col], ArrowLeft: [row, col - 1], ArrowRight: [row, col + 1],
    PageUp: [row - page, col], PageDown: [row + page, col], Home: [mod ? 0 : row, mod ? col : 0], End: [mod ? v.shown.length - 1 : row, mod ? col : v.cols.length - 1],
    Tab: [row, col + (e.shiftKey ? -1 : 1)],
  };
  if (moves[e.key]) {
    e.preventDefault();
    e.stopPropagation();
    return select(v, ...moves[e.key]);
  }
  if (mod && e.key === "c" && !getSelection()?.toString()) {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(data(v)[v.shown[row]]?.[col] ?? "");
  } else if (e.key === "Escape") {
    e.stopPropagation();
    v.sel = null;
    v.drawn = "";
    draw(v);
    status(v);
  }
}

function resizeColumn(v: View, c: number, e: PointerEvent) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const w0 = v.cols[c].width;
  const col = v.colgroup.children[c + 1] as HTMLElement;
  const move = (m: PointerEvent) => {
    v.cols[c].width = Math.max(COL_MIN, Math.round(w0 + m.clientX - x0));
    col.style.width = `${v.cols[c].width}px`;
    v.table.style.width = `max(${tableWidth(v)}px, 100%)`;
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    document.body.classList.remove("csv-resizing");
  };
  document.body.classList.add("csv-resizing");
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}
