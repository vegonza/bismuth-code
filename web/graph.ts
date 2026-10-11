// The Changes view's Graph (VS Code's source control graph): the branch checked out and its upstream, newest first,
// each commit on its lane with the lines to its parents, and the branches and tags it carries. A commit picked opens
// its changes in a review tab (review.ts). Read a page at a time, the next as the list's end comes near; read again
// when HEAD or the upstream moves.
import type { GitChanges, GitCommit, GitRef } from "../shared/model";
import { el, timeAgo } from "./dom";
import { icon, type IconName } from "./icons";
import { RESIZE_MS, reducedMotion } from "./motion";
import { call } from "./store";

export type GraphHooks = {
  root: () => string | null;
  /** A commit picked: its changes reviewed (`keep`: a double click, the tab kept rather than a preview). */
  open: (hash: string, keep: boolean) => void;
  flash: (text: string) => void;
};

/** Commits read at a time. */
const PAGE = 100;
/** A row's height and a lane's width (px), as the SVG draws them. */
const ROW_H = 26;
const LANE_W = 12;
/** The most lanes drawn side by side; more are cut off at the edge. */
const MAX_LANES = 8;
/** The lanes' colours, in turn (VS Code's graph's, which read on dark and light alike). */
const COLORS = ["#4daafc", "#e5a03a", "#b180d7", "#3fb68b", "#e06c75", "#d4b44a", "#4fc1c9", "#f07ab0"];
const OPEN_KEY = "bismuth.graphOpen";
const SVG = "http://www.w3.org/2000/svg";

/** A row of the graph: its commit, its lane, and the lanes above and below it (the commit each waits for, and its
 *  colour). */
type Row = { c: GitCommit; lane: number; top: (string | null)[]; topColor: number[]; bottom: (string | null)[]; bottomColor: number[] };

/** Each commit's lane, the lanes running past it, and where its parents' lines go: a lane waits for a commit; a commit
 *  takes the lane waiting for it (a new one when none is: a branch's tip), hands it on to its first parent, and opens
 *  one for each other parent (a merge's) not waited for already. Lanes that waited for it too end at it. */
function layout(commits: GitCommit[]): Row[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let next = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };
  return commits.map((c) => {
    const top = lanes.slice();
    const topColor = colors.slice();
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) (lane = free()), (lanes[lane] = c.hash), (colors[lane] = next++);
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.hash) lanes[i] = null;
    lanes[lane] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      if (lanes.includes(p)) continue;
      const j = free();
      lanes[j] = p;
      colors[j] = next++;
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop(), colors.pop();
    return { c, lane, top, topColor, bottom: lanes.slice(), bottomColor: colors.slice() };
  });
}

const x = (i: number) => LANE_W / 2 + 2 + Math.min(i, MAX_LANES) * LANE_W;
const color = (n: number) => COLORS[n % COLORS.length];

function path(d: string, stroke: string): SVGPathElement {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  p.setAttribute("stroke", stroke);
  return p;
}

/** From (x1, y1) to (x2, y2): straight down, or a curve across lanes. */
const link = (x1: number, y1: number, x2: number, y2: number) => (x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);

/** The lanes a row draws. */
const lanesOf = (row: Row) => Math.min(Math.max(row.top.length, row.bottom.length, row.lane + 1), MAX_LANES + 1);

/** How wide `lanes` lanes are drawn (px). */
const lanesWidth = (lanes: number) => x(lanes - 1) + LANE_W / 2 + 2;

/** A row's lanes, as wide as the widest row's (the list's --gr-w, so the subjects line up), drawn from the left. */
function rowSvg(row: Row, head: string | null): SVGSVGElement {
  const width = lanesWidth(lanesOf(row));
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "gr-svg");
  svg.setAttribute("height", String(ROW_H));
  svg.setAttribute("viewBox", `0 0 ${width} ${ROW_H}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMid meet");
  const mid = ROW_H / 2;
  const at = x(row.lane);
  // From above: the lanes waiting for this commit come into it; the rest run past.
  row.top.forEach((h, i) => {
    if (h === null) return;
    if (h === row.c.hash) svg.append(path(link(x(i), 0, at, mid), color(row.topColor[i])));
    else svg.append(path(`M${x(i)} 0V${ROW_H}`, color(row.topColor[i])));
  });
  // Down to its parents' lanes.
  for (const p of row.c.parents) {
    const j = row.bottom.indexOf(p);
    if (j >= 0) svg.append(path(link(at, mid, x(j), ROW_H), color(row.bottomColor[j])));
  }
  const dot = document.createElementNS(SVG, "circle");
  dot.setAttribute("cx", String(at));
  dot.setAttribute("cy", String(mid));
  dot.setAttribute("r", row.c.hash === head ? "4" : "3.5");
  const own = color(row.bottomColor[row.lane] ?? row.topColor[row.lane] ?? 0);
  dot.setAttribute("class", row.c.hash === head ? "gr-dot head" : "gr-dot");
  dot.setAttribute("stroke", own);
  dot.setAttribute("fill", row.c.hash === head ? "var(--main)" : own);
  svg.append(dot);
  return svg;
}

const REF_ICON: Record<GitRef["kind"], IconName> = { head: "gitBranch", branch: "gitBranch", remote: "cloud", tag: "tag" };

function refBadge(r: GitRef): HTMLElement {
  const b = el("span", `gr-ref ${r.kind}`);
  b.append(icon(REF_ICON[r.kind]), el("span", "gr-ref-name", r.name));
  b.title = r.kind === "head" ? `${r.name} (checked out)` : r.kind === "remote" ? `${r.name} (remote)` : r.kind === "tag" ? `Tag ${r.name}` : r.name;
  return b;
}

export function graphView(hooks: GraphHooks) {
  const root = el("section", "gr");
  let open = localStorage.getItem(OPEN_KEY) !== "0";
  const head = el("div", "disclosure gr-head");
  head.append(el("span", "label", "Graph"), el("span", "grow"), icon("chevronRight", 12, "chev"));
  const list = el("div", "gr-list");
  root.append(head, list);
  let commits: GitCommit[] = [];
  let headHash: string | null = null;
  let more = false;
  let reading = false;
  /** What the commits are for (the folder, HEAD, the upstream): another reads them again. */
  let readFor = "";
  let selected: string | null = null;
  let seq = 0;
  const end = el("div", "gr-end");
  const near = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && more && !reading && void page(false), { root: list, rootMargin: "300px 0px" });
  near.observe(end);

  head.onclick = () => {
    open = !open;
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    slide();
    if (open && !commits.length) void page(true);
  };
  const syncOpen = () => {
    head.classList.toggle("open", open);
    root.classList.toggle("closed", !open);
    list.hidden = !open;
  };
  syncOpen();

  /** Opened or put away by its height (Zeron's RESIZE: the changes above give way as it goes), its commits fading in
   *  or out with it; from wherever it is when turned back mid-way, at once with reduced motion. */
  let sliding: Animation | null = null;
  function slide() {
    const from = root.getBoundingClientRect().height;
    sliding?.cancel();
    sliding = null;
    root.style.flex = root.style.overflow = "";
    root.classList.remove("sliding");
    head.classList.toggle("open", open);
    root.classList.toggle("closed", !open);
    // Where it ends: shut, its head alone; open, its share beside the changes.
    list.hidden = !open;
    const to = root.getBoundingClientRect().height;
    if (reducedMotion() || from === to) return syncOpen();
    // Its commits stay drawn while it shuts, gone once it has; the changes fill what it doesn't take meanwhile.
    list.hidden = false;
    root.classList.add("sliding");
    root.style.flex = "none";
    root.style.overflow = "hidden";
    list.animate({ opacity: open ? [0.4, 1] : [1, 0.4] }, { duration: RESIZE_MS, easing: "cubic-bezier(0, 0, 0.58, 1)" });
    const anim = (sliding = root.animate({ height: [`${from}px`, `${to}px`] }, { duration: RESIZE_MS, easing: "cubic-bezier(0, 0, 0.58, 1)" }));
    anim.onfinish = () => {
      if (sliding !== anim) return;
      sliding = null;
      root.style.flex = root.style.overflow = "";
      root.classList.remove("sliding");
      syncOpen();
    };
  }

  async function page(first: boolean) {
    const r = hooks.root();
    if (!r) return;
    const mine = ++seq;
    reading = true;
    try {
      const got = await call("git.log", { root: r, skip: first ? 0 : commits.length, limit: PAGE });
      if (mine !== seq) return;
      const had = first ? 0 : commits.length;
      commits = first ? got.commits : [...commits, ...got.commits];
      headHash = got.head;
      more = got.more;
      reading = false;
      render(had);
    } catch (err: any) {
      if (mine === seq) hooks.flash(String(err?.message ?? err));
    } finally {
      if (mine === seq) reading = false;
    }
  }

  /** The commits drawn: from the `from`th on, the ones before left as they are (a page read further down). */
  function render(from = 0) {
    if (!commits.length) return void list.replaceChildren(el("div", "cv-note", headHash === null && !reading ? "No commits yet." : ""));
    const rows = layout(commits);
    const lanes = rows.reduce((n, row) => Math.max(n, lanesOf(row)), 1);
    list.style.setProperty("--gr-w", `${lanesWidth(lanes)}px`);
    const drawn = rows.slice(from).map((row) => {
      const c = row.c;
      const it = el("div", `gr-row${c.hash === selected ? " selected" : ""}`);
      it.dataset.hash = c.hash;
      const subject = el("span", "gr-subject", c.subject);
      const refs = el("span", "gr-refs");
      refs.append(...c.refs.map(refBadge));
      it.append(rowSvg(row, headHash), subject, refs, el("span", "gr-time", timeAgo(c.date)));
      it.title = `${c.subject}\n${c.hash.slice(0, 10)} · ${c.author} · ${new Date(c.date).toLocaleString()}`;
      it.onclick = () => (select(c.hash), hooks.open(c.hash, false));
      it.ondblclick = () => hooks.open(c.hash, true);
      return it;
    });
    if (from && end.isConnected) end.before(...drawn);
    else list.replaceChildren(...drawn, end);
  }

  /** The commit whose changes show, marked (null: none). */
  function select(hash: string | null) {
    selected = hash;
    for (const row of list.querySelectorAll<HTMLElement>(".gr-row")) row.classList.toggle("selected", row.dataset.hash === hash);
  }

  /** The changes read again: the commits too when HEAD or the upstream moved (a commit, a pull), or the folder did. */
  function sync(c: GitChanges | null) {
    root.hidden = !c?.repo;
    if (!c?.repo) return;
    const key = `${hooks.root()}\0${c.head ?? ""}\0${c.branch ?? ""}\0${c.upstream ?? ""}\0${c.ahead}\0${c.behind}`;
    if (key === readFor) return;
    readFor = key;
    if (open) void page(true);
    else commits = [];
  }

  return { el: root, sync, select };
}
