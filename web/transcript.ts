// The conversation: rows derived from the thread's turns (user bubbles, markdown replies, collapsible
// activity groups), the working trailer and hover timestamps. Rows are keyed and only rebuilt when their
// content signature changes, so streaming and open folds survive updates.
import { attachmentName, attachmentUrl, clipboardHtml, openLightbox, parseUserMessage, type SentImage } from "./attachments";
import { fileChip, labelFile, mentionChip } from "./editor";
import type { FileChange, Item, Thread, Turn } from "../shared/model";
import { $, basename, el, elapsed, firstLine, gradientSpinner, timestamp } from "./dom";
import { fileGlyph } from "./fileicons";
import { icon, type IconName } from "./icons";
import { copyText, renderMarkdown } from "./markdown";
import { openCitedPath } from "./refs";
import { on, promptCount, promptsLike, store } from "./store";
import { isViewTool, viewFrame, viewOf } from "./views";

type ToolItem = Exclude<Item, { kind: "user" | "assistant" | "plan" | "notice" | "question" }>;
type QuestionItem = Extract<Item, { kind: "question" }>;
type Row =
  | { kind: "user"; key: string; item: Extract<Item, { kind: "user" }>; ts: number | null; gap: number }
  | { kind: "md"; key: string; text: string; done: boolean; ts: number | null; copy: string | null; gap: number }
  | { kind: "group"; key: string; items: ToolItem[]; live: boolean; gap: number }
  | { kind: "notice"; key: string; text: string; gap: number }
  | { kind: "question"; key: string; item: QuestionItem; waiting: boolean; gap: number }
  | { kind: "view"; key: string; id: string; title: string; viewport: number | null; gap: number }
  | { kind: "error"; key: string; label: string; text: string; warning: boolean; gap: number };

const OUTPUT_LINES = 24;
const USER_COLLAPSE_CHARS = 400;
const USER_COLLAPSED_LINES = 5;
const STICK_PX = 70;

// Fold state outlives re-renders: user overrides for groups, per-item detail toggles, expanded bubbles.
const groupFolds = new Map<string, boolean>();
const itemFolds = new Map<string, boolean>();
const fullOutput = new Set<string>();
const bubbleOpen = new Set<string>();

const rowsEl = () => $("transcript-rows");
const hoverGroup = new Map<string, string>(); // row key -> the message it belongs to
let hot: string | null = null;
const scroller = () => $("scroller");
let renderedThread: string | null = null;
let stuckEcho = 0;
/** The rendered rows of recently left threads, by row key: going back reuses every row that didn't change instead of
 *  rendering all its markdown again. */
const parked = new Map<string, Map<string, HTMLElement>>();
const PARKED = 12;

function park(threadId: string, container: HTMLElement) {
  const rows = new Map<string, HTMLElement>();
  for (const node of container.children as HTMLCollectionOf<HTMLElement>) rows.set(node.dataset.key!, node);
  parked.delete(threadId);
  parked.set(threadId, rows);
  while (parked.size > PARKED) parked.delete(parked.keys().next().value!);
}

// ---------------- rows ----------------

const isTool = (i: Item): i is ToolItem => i.kind !== "user" && i.kind !== "assistant" && i.kind !== "plan" && i.kind !== "notice" && i.kind !== "question";

function buildRows(thread: Thread): Row[] {
  const rows: Row[] = [];
  type Draft = Row extends infer R ? (R extends Row ? Omit<R, "gap"> : never) : never;
  const gapFor = (row: Draft, prev: Row | undefined, turnStart: boolean) =>
    turnStart ? 16 : row.kind === "md" && prev?.kind === "md" ? 12 : [row.kind, prev?.kind].some((k) => k === "group" || k === "view") ? 12 : 8;
  const push = (row: Draft, turnStart = false) => rows.push({ ...row, gap: gapFor(row, rows.at(-1), turnStart) } as Row);
  const pendingRow = (key: string, text: string, at: number) => {
    push({ kind: "user", key, item: { id: key, kind: "user", text, images: 0 }, ts: at }, true);
    hoverGroup.set(key, `u:${key}`);
  };

  // Queued prompts the core just sent show at once, until the harness records them (by text; or, should it word
  // them differently, once the thread has had more prompts for a while). One that started a turn heads it even
  // when the turn's first output beats the harness's record of the prompt; a steer waits at the end.
  // Another thread's are only checked when it's open again; ones left behind for long are let go.
  store.sent = store.sent.filter((s) =>
    s.threadId !== thread.id
      ? Date.now() - s.at < 60_000
      : promptsLike(thread, s.text) <= s.seen && !(Date.now() - s.at > 30_000 && promptCount(thread) > s.prompts),
  );
  const sent = store.sent.filter((s) => s.threadId === thread.id);
  const heads = new Map<string, (typeof sent)[number]>();
  for (const s of sent) {
    const turn = thread.turns.find((t) => (t.startedAt ?? 0) >= s.at - 1000 && !t.items.some((i) => i.kind === "user") && ![...heads.keys()].includes(t.id));
    if (turn) heads.set(turn.id, s);
  }

  thread.turns.forEach((turn) => {
    const head = heads.get(turn.id);
    if (head) pendingRow(`sent:${head.id}`, head.text, head.at);
    const live = turn.status === "inProgress";
    let replyStart = true;
    let group: Extract<Row, { kind: "group" }> | null = null;
    const firstRowIx = rows.length;
    for (const item of turn.items) {
      if (item.kind === "user") {
        group = null;
        push({ kind: "user", key: item.id, item, ts: turn.startedAt }, true);
        replyStart = true;
      } else if (item.kind === "tool" && viewOf(item)) {
        // A view the agent rendered: its own row, out of the activity around it, like a question.
        group = null;
        push({ kind: "view", key: item.id, ...viewOf(item)! }, replyStart);
        replyStart = false;
      } else if (isTool(item)) {
        if (!group) {
          push({ kind: "group", key: `g:${item.id}`, items: [] as ToolItem[], live: false }, replyStart);
          group = rows.at(-1) as Extract<Row, { kind: "group" }>;
          replyStart = false;
        }
        group.items.push(item);
      } else if (item.kind === "notice") {
        group = null;
        push({ kind: "notice", key: item.id, text: item.text }, replyStart);
        replyStart = false;
      } else if (item.kind === "question") {
        // Its own row between the activity around it (Zeron's InputChip), not folded into a group.
        group = null;
        push({ kind: "question", key: item.id, item, waiting: !item.answers && live }, replyStart);
        replyStart = false;
      } else {
        group = null;
        if (!item.text.trim()) continue;
        push({ kind: "md", key: item.id, text: item.text, done: item.kind === "plan" || item.done, ts: null as number | null, copy: null as string | null }, replyStart);
        replyStart = false;
      }
    }
    if (turn.status === "failed" && turn.error)
      push({ kind: "error", key: `err:${turn.id}`, label: "Error", text: turn.error, warning: false }, replyStart);
    // The trailing group of a running turn auto-opens and shimmers while work streams into it.
    const last = rows.at(-1);
    if (live && last?.kind === "group" && rows.length > firstRowIx) last.live = true;
    // Hover reveals a message's timestamp strip anywhere over it: a prompt is its bubble, a reply is
    // every row the turn produced.
    for (const row of rows.slice(firstRowIx)) hoverGroup.set(row.key, row.kind === "user" ? `u:${row.key}` : `t:${turn.id}`);
    // A settled reply carries its completion time (and the final text to copy) on its last row.
    if (!live && last && rows.length > firstRowIx && last.kind !== "user") {
      const finalText = [...turn.items].reverse().find((i) => i.kind === "assistant") as Extract<Item, { kind: "assistant" }> | undefined;
      if (last.kind === "md") {
        last.ts = turn.completedAt;
        last.copy = finalText?.text ?? null;
      }
    }
  });
  // The prompt just sent shows at once, ahead of the harness's echo (Codex takes a second or more on a new
  // session's first turn).
  const echo = store.echo;
  if (echo && promptCount(thread) > echo.seen) store.echo = null;
  else if (echo?.threadId === thread.id) {
    push({ kind: "user", key: `echo:${echo.at}`, item: { id: `echo:${echo.at}`, kind: "user", text: echo.text, images: 0 }, ts: echo.at }, true);
    hoverGroup.set(`echo:${echo.at}`, `u:echo:${echo.at}`);
  }
  for (const s of sent) if (![...heads.values()].includes(s)) pendingRow(`sent:${s.id}`, s.text, s.at);
  if (thread.notice)
    push({ kind: "error", key: `notice:${thread.id}`, label: /retrying/i.test(thread.notice) ? "Retrying" : "Error", text: thread.notice, warning: /retrying/i.test(thread.notice) });
  return rows;
}

function signature(row: Row): string {
  switch (row.kind) {
    case "user":
      return `u${row.item.text.length}:${row.item.images}:${row.ts}:${bubbleOpen.has(row.key)}:${row.gap}`;
    case "md":
      return `m${row.text.length}:${row.done}:${row.ts}:${row.gap}`;
    case "group":
      return `g${row.live}:${groupFolds.get(row.key)}:${row.gap}:` +
        row.items
          .map((i) => {
            const fold = `${itemFolds.get(i.id) ?? ""}${fullOutput.has(i.id) ? "F" : ""}`;
            switch (i.kind) {
              case "command":
                return `${i.id}${i.status}${i.exitCode}${i.output.length}${fold}`;
              case "reasoning":
                return `${i.id}${i.done}${i.summary.join("").length}${fold}`;
              case "fileChange":
                return `${i.id}${i.status}${i.changes.length}${fold}`;
              case "tool":
                return `${i.id}${i.status}${i.output.length}${fold}`;
              default:
                return i.id;
            }
          })
          .join("|");
    case "notice":
      return `n${row.text}${row.gap}`;
    case "question":
      return `q${JSON.stringify(row.item.answers)}:${row.waiting}:${row.gap}`;
    case "view":
      return `v${row.id}:${row.gap}`;
    case "error":
      return `e${row.text}${row.gap}`;
  }
}

// ---------------- questions ----------------

/** Where the agent asked (Zeron's InputChip, kept open): a quiet card, "Question" and the first header on top, then
 *  each question with what was answered under it ("Awaiting your answer…" while the panel over the composer waits). */
function questionChip(row: Extract<Row, { kind: "question" }>): HTMLElement {
  const { item } = row;
  const card = el("div", "q-card");
  const head = el("div", "q-card-head");
  const tile = el("span", "q-card-tile");
  tile.append(icon("messageCircle"));
  const header = item.questions[0]?.header || "Question";
  head.append(tile, el("span", "q-card-label", "Question"), el("span", "q-card-value", item.questions.length > 1 ? `${item.questions.length} questions` : header));
  card.append(head);
  const list = el("div", "q-card-list");
  item.questions.forEach((q, i) => {
    const a = item.answers?.[i] ?? [];
    const pending = !item.answers && row.waiting;
    const entry = el("div", "q-card-entry");
    entry.append(
      el("div", "q-card-q", q.question),
      el("div", `q-card-a${a.length ? "" : " none"}`, a.length ? a.join(", ") : pending ? "Awaiting your answer…" : "No answer"),
    );
    list.append(entry);
  });
  card.append(list);
  return card;
}

// ---------------- tool groups ----------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const commandFailed = (i: Extract<Item, { kind: "command" }>) =>
  i.status === "failed" || i.status === "declined" || (i.status === "completed" && i.exitCode != null && i.exitCode !== 0);
const itemFailed = (i: ToolItem) =>
  i.kind === "command" ? commandFailed(i) : (i.kind === "fileChange" || i.kind === "tool") && (i.status === "failed" || i.status === "declined");

/** "Thought 2 times · Ran 3 commands · edited 2 files · 1 failed" */
export function groupSummary(items: ToolItem[]): string {
  const thoughts = items.filter((i) => i.kind === "reasoning").length;
  const calls = items.filter((i) => i.kind !== "reasoning");
  const commands = calls.filter((i) => i.kind === "command").length;
  const edited = new Set(calls.flatMap((i) => (i.kind === "fileChange" ? i.changes.map((c) => c.path) : [])));
  const searches = calls.filter((i) => i.kind === "webSearch").length;
  const other = calls.filter((i) => i.kind === "tool").length;
  const failed = calls.filter(itemFailed).length;
  const base: string[] = [];
  if (commands) base.push(`ran ${plural(commands, "command", "commands")}`);
  if (edited.size) base.push(`edited ${plural(edited.size, "file", "files")}`);
  if (searches) base.push(`searched ${plural(searches, "time", "times")}`);
  if (other) base.push(`called ${plural(other, "tool", "tools")}`);
  if (!base.length && calls.length) base.push(plural(calls.length, "tool", "tools"));
  if (failed) base.push(`${failed} failed`);
  let baseText = base.join(" · ");
  if (baseText) baseText = baseText[0].toUpperCase() + baseText.slice(1);
  const segments: string[] = [];
  if (thoughts === 1) segments.push("thought process");
  else if (thoughts > 1) segments.push(`thought ${thoughts} times`);
  if (baseText) segments.push(baseText);
  const text = segments.join(" · ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

type ToolView = { label: string; detail: string | HTMLElement; icon: IconName; failed: boolean; body: (() => HTMLElement[]) | null; defaultOpen: boolean };

function outputBody(id: string, text: string): HTMLElement[] {
  const lines = text.replace(/\n$/, "").split("\n");
  const full = fullOutput.has(id);
  const shown = full ? lines : lines.slice(-OUTPUT_LINES);
  const pre = el("div", "tdetail-body term");
  pre.textContent = shown.join("\n");
  const out: HTMLElement[] = [pre];
  if (!full && lines.length > OUTPUT_LINES) {
    const more = el("div", "blob-more", `Show full output (${lines.length} lines)`);
    more.onclick = (e) => {
      e.stopPropagation();
      fullOutput.add(id);
      update();
    };
    out.push(more);
  }
  return out;
}

function diffBody(changes: FileChange[]): HTMLElement[] {
  const pre = el("div", "tdetail-body");
  for (const c of changes) {
    if (changes.length > 1) pre.append(el("div", "line d-file", `${c.path}${c.movePath ? ` → ${c.movePath}` : ""}`));
    const lines = c.diff.replace(/\n$/, "").split("\n");
    for (const line of lines.slice(0, 600)) {
      const cls = c.kind === "add" ? "d-add" : line.startsWith("@@") ? "d-hunk" : line.startsWith("+") ? "d-add" : line.startsWith("-") ? "d-del" : "";
      pre.append(el("div", `line ${cls}`, line || " "));
    }
  }
  return [pre];
}

function fileBadge(paths: string[]): HTMLElement {
  const badge = el("span", "file-badge");
  const well = el("span", "well");
  well.append(fileGlyph(paths[0]));
  badge.append(well, el("span", "name", basename(paths[0])));
  if (paths.length > 1) badge.append(el("span", "more", `+${paths.length - 1}`));
  badge.title = paths.join("\n");
  // The file opens in the panel (the first, of several).
  badge.classList.add("file-link");
  badge.onclick = (e) => {
    e.stopPropagation();
    openCitedPath({ path: paths[0] });
  };
  badge.ondblclick = (e) => {
    e.stopPropagation();
    openCitedPath({ path: paths[0] }, true);
  };
  return badge;
}

function toolView(item: ToolItem): ToolView {
  switch (item.kind) {
    case "reasoning": {
      const text = item.summary.join("\n\n").replace(/\*\*/g, "").trim();
      return {
        label: "Thought process",
        detail: "",
        icon: "brain",
        failed: false,
        body: text ? () => [Object.assign(el("div", "tdetail-body prose"), { textContent: text })] : null,
        defaultOpen: !item.done,
      };
    }
    case "command": {
      const multi = item.command.includes("\n") || item.command.length > 100;
      return {
        label: "Run",
        detail: firstLine(item.command),
        icon: "squareTerminal",
        failed: commandFailed(item),
        body:
          item.output || multi
            ? () => [...(multi ? [Object.assign(el("div", "tdetail-body call"), { textContent: item.command })] : []), ...(item.output ? outputBody(item.id, item.output) : [])]
            : null,
        defaultOpen: false,
      };
    }
    case "fileChange": {
      const kinds = new Set(item.changes.map((c) => c.kind));
      const label = kinds.size === 1 && kinds.has("add") ? "Write" : kinds.size === 1 && kinds.has("delete") ? "Delete" : "Edit";
      const paths = item.changes.map((c) => c.path);
      return {
        label,
        detail: paths.length ? fileBadge(paths) : "",
        icon: label === "Write" ? "filePlus" : "pencil",
        failed: itemFailed(item),
        body: item.changes.some((c) => c.diff) ? () => diffBody(item.changes) : null,
        defaultOpen: false,
      };
    }
    case "tool": {
      const agent = item.name.startsWith("subagent ·");
      const view = isViewTool(item.name);
      const mcp = !agent && !view && item.name.includes(" · ");
      let detail = agent ? item.name.replace(/^subagent · /, "") : item.name;
      if (view) {
        try {
          detail = String(JSON.parse(item.input).title || "");
        } catch {
          detail = "";
        }
      }
      return {
        label: view ? "View" : agent ? "Agent" : mcp ? "MCP" : "Tool",
        detail,
        icon: view ? "blocks" : agent ? "bot" : mcp ? "plug" : "wrench",
        failed: itemFailed(item),
        body:
          item.input || item.output
            ? () => [
                ...(item.input ? [Object.assign(el("div", "tdetail-body call"), { textContent: item.input })] : []),
                ...(item.output ? outputBody(item.id, item.output) : []),
              ]
            : null,
        defaultOpen: false,
      };
    }
    case "webSearch":
      return { label: "Web", detail: item.query, icon: "globe", failed: false, body: null, defaultOpen: false };
  }
}

function toolRow(item: ToolItem, continues: boolean): HTMLElement {
  const view = toolView(item);
  const row = el("div", `titem${view.failed ? " failed" : ""}${view.body ? " expandable" : ""}`);
  const rail = el("div", "rail");
  rail.append(el("span", "branch"));
  if (continues) rail.append(el("span", "cont"));
  rail.append(icon(view.icon, undefined, "ticon"));

  const card = el("div", "tcard");
  const head = el("div", "thead");
  head.append(el("span", "tlabel", view.label));
  if (view.detail instanceof HTMLElement || view.detail) {
    const detail = el("span", "tdetail");
    detail.append(view.detail);
    if (typeof view.detail === "string") detail.title = view.detail;
    head.append(detail);
  }
  const open = view.body ? (itemFolds.get(item.id) ?? view.defaultOpen) : false;
  if (view.body) {
    const trail = el("span", "trail");
    trail.append(icon(open ? "chevronDown" : "chevronRight"));
    head.append(trail);
    head.onclick = (e) => {
      e.stopPropagation();
      itemFolds.set(item.id, !open);
      update();
    };
  }
  card.append(head);
  if (open && view.body) card.append(...view.body());
  row.append(rail, card);
  return row;
}

function groupRow(row: Extract<Row, { kind: "group" }>): HTMLElement {
  const open = groupFolds.get(row.key) ?? row.live;
  const box = el("div", `tgroup${open ? " open" : ""}${row.live ? " active" : ""}`);
  const head = el("div", "tgroup-head");
  const slot = el("span", "chev-slot");
  slot.append(icon("chevronDown", undefined, "chev"));
  head.append(slot, el("span", "summary", groupSummary(row.items) || "Working"));
  head.onclick = () => {
    groupFolds.set(row.key, !open);
    update();
  };
  const body = el("div", "tgroup-body");
  const list = el("div", "tlist");
  // Only build the tree while open; collapsing animates the grid row, then the content is dropped next render.
  if (open) row.items.forEach((item, i) => list.append(toolRow(item, i < row.items.length - 1)));
  body.append(list);
  box.append(head, body);
  return box;
}

// ---------------- other rows ----------------

/** `images`: a user message's, copied with it (attachments.ts). */
function metaStrip(ts: number, user: boolean, copy: string | null, images: SentImage[] = []): HTMLElement {
  const strip = el("div", `meta-strip${user ? " user" : ""}`);
  strip.append(el("span", "ts", timestamp(ts)));
  if (copy) {
    const btn = el("button", "copy-btn");
    btn.title = "Copy message";
    btn.append(icon("copy"));
    btn.onclick = () => copyText(copy, btn, images.length ? clipboardHtml(copy, images) : undefined);
    strip.append(btn);
  }
  return strip;
}

/** Zeron's user-bubble thumbnails: 112×80 tiles over the bubble, a click opens the full-size view. */
function userImages(paths: string[]): HTMLElement {
  const box = el("div", "user-images");
  for (const path of paths) {
    const name = attachmentName(path);
    const tile = el("button", "user-image");
    tile.title = name;
    const img = el("img");
    img.src = attachmentUrl(path);
    img.alt = name;
    img.loading = "lazy";
    // Gone from disk (or never on this device): the tile keeps its place and names the file.
    img.onerror = () => tile.replaceChildren(icon("image"), el("span", "", name));
    tile.append(img);
    tile.onclick = () => openLightbox(img.src, name);
    box.append(tile);
  }
  return box;
}

/** The bubble's text with each "Image N" that names an attached image as its chip (a click opens the image), and
 *  each mentioned file (`@web/app.ts`) as its own (a click opens the file). */
function bubbleText(bubble: HTMLElement, text: string, images: Map<string, string>) {
  let last = 0;
  for (const m of text.matchAll(/Image \d+|(?<=^|\s)@(?:"[^"\n]+"|[^\s"]+)/g)) {
    const file = m[0].startsWith("@") ? labelFile(m[0]) : null;
    const path = file ?? images.get(m[0]);
    if (!path) continue;
    bubble.append(text.slice(last, m.index));
    const chip = file ? fileChip(file) : mentionChip(m[0]);
    chip.onclick = file ? (e) => (e.stopPropagation(), openCitedPath({ path: file })) : () => openLightbox(attachmentUrl(path), attachmentName(path));
    bubble.append(chip);
    last = m.index + m[0].length;
  }
  bubble.append(text.slice(last));
}

function userRow(row: Extract<Row, { kind: "user" }>): HTMLElement[] {
  const out: HTMLElement[] = [];
  // Images ride the prompt as a list of paths under the text (attachments.ts); split them back out. Every image
  // gets a thumbnail, and an "Image N" in the text that names one shows as its chip.
  const { text, images } = parseUserMessage(row.item.text);
  // Older sends named the file after its label instead ("…-Image 2.png").
  const labels = new Map(images.map((i) => [i.label ?? attachmentName(i.path).replace(/\.[^.]*$/, ""), i.path]));
  if (images.length) out.push(userImages(images.map((i) => i.path)));
  else if (row.item.images) out.push(el("div", "attach-badge", `${row.item.images} image${row.item.images > 1 ? "s" : ""} attached`));
  if (text) {
    const wrap = el("div", "bubble-wrap");
    const bubble = el("div", "bubble");
    bubbleText(bubble, text, labels);
    // Selected text copies the images it mentions too, when it's all inside the bubble.
    if (images.length)
      bubble.addEventListener("copy", (e) => {
        const sel = getSelection();
        if (!sel?.rangeCount || !bubble.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
        const picked = sel.toString();
        const mentioned = [...labels].flatMap(([label, path]) => (new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(picked) ? [{ label, path }] : []));
        if (!mentioned.length) return;
        e.preventDefault();
        e.clipboardData!.setData("text/plain", picked);
        e.clipboardData!.setData("text/html", clipboardHtml(picked, mentioned));
      });
    const long = text.length > USER_COLLAPSE_CHARS || text.split("\n").length > USER_COLLAPSED_LINES;
    const open = bubbleOpen.has(row.key);
    if (long && !open) bubble.classList.add("collapsed");
    wrap.append(bubble);
    out.push(wrap);
    if (long) {
      const toggle = el("div", "bubble-toggle", open ? "Show less" : "Show more");
      toggle.onclick = () => {
        if (open) bubbleOpen.delete(row.key);
        else bubbleOpen.add(row.key);
        update();
      };
      out.push(toggle);
    }
  }
  if (row.ts) out.push(metaStrip(row.ts, true, text || null, [...labels].map(([label, path]) => ({ label, path }))));
  return out;
}

function noticeChip(label: string, text: string, warning: boolean): HTMLElement {
  const chip = el("div", `notice-chip${warning ? " warning" : ""}`);
  const head = el("div", "head");
  const tile = el("span", "tile");
  tile.append(icon("triangleAlert"));
  head.append(tile, el("span", "label", label));
  chip.append(head, el("div", "msg", text));
  return chip;
}

function buildRow(row: Row): HTMLElement {
  const outer = el("div", "trow");
  outer.dataset.key = row.key;
  outer.dataset.group = hoverGroup.get(row.key) ?? row.key;
  outer.dataset.sig = signature(row);
  // A view spans the conversation's width, past the text column.
  if (row.kind === "view") outer.classList.add("wide");
  outer.style.paddingTop = `${row.gap}px`;
  const inner = el("div", "inner");
  switch (row.kind) {
    case "user":
      inner.append(...userRow(row));
      break;
    case "md": {
      const md = el("div", "md");
      renderMarkdown(row.text, md, "", true);
      inner.append(md);
      if (row.ts) inner.append(metaStrip(row.ts, false, row.copy));
      break;
    }
    case "group":
      inner.append(groupRow(row));
      break;
    case "notice":
      inner.append(el("div", "fork-marker", row.text));
      break;
    case "question":
      inner.append(questionChip(row));
      break;
    case "view":
      inner.append(viewFrame(row.id, row.title, row.viewport));
      break;
    case "error":
      inner.append(noticeChip(row.label, row.text, row.warning));
      break;
  }
  outer.append(inner);
  return outer;
}

// ---------------- working trailer ----------------

const FLAVOUR = ["Zeroning", "Thinking", "Pondering", "Scheming", "Brewing", "Weaving", "Tinkering", "Musing", "Composing", "Sifting", "Untangling", "Distilling", "Sketching", "Plotting", "Riffing", "Combobulating", "Percolating", "Marinating", "Noodling", "Puzzling", "Conjuring"];
const seen = new Map<string, number>(); // turn id -> first time we saw it running, when the core has no start time

function activeTurn(): Turn | null {
  const t = store.thread;
  return t?.activeTurnId ? (t.turns.find((x) => x.id === t.activeTurnId) ?? null) : null;
}

function renderTrailer() {
  const box = $("working");
  const turn = activeTurn();
  const thread = store.thread;
  if (!thread || !turn) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  if (!seen.has(turn.id)) seen.set(turn.id, turn.startedAt ?? Date.now());
  const started = turn.startedAt ?? seen.get(turn.id)!;
  const secs = Math.max(0, (Date.now() - started) / 1000);
  let seed = 0;
  for (const ch of thread.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const word = FLAVOUR[(seed + Math.floor(secs / 7)) % FLAVOUR.length];
  box.hidden = false;
  if (!box.firstChild) box.append(gradientSpinner(), el("span", "word"), el("span", "elapsed"));
  box.querySelector(".word")!.textContent = `${word}…`;
  box.querySelector(".elapsed")!.textContent = elapsed(secs);
}

// ---------------- rendering ----------------

const nearBottom = () => {
  const s = scroller();
  return s.scrollHeight - s.scrollTop - s.clientHeight < STICK_PX;
};
// What the view holds on to while things change size around it (text rewrapping as columns open, the terminal
// drawer gliding, the dock growing, rows folding or streaming in): the conversation's end when it's scrolled there,
// else the row at the top of the view (by key, so a row rebuilt by an update is still found), kept at the same height
// on screen. Noted on every scroll; restored after every resize (before it paints) and every reconcile.
type Hold = { end: true } | { end: false; key: string; offset: number };
let held: Hold = { end: true };
/** Where our own last scroll put the view. Its scroll event arrives a frame later, when the rows may have moved again
 *  (mid-glide): that echo isn't the user scrolling, so it doesn't change what's held. */
let ownTop: number | null = null;
let lastTop = 0;
function setTop(top: number) {
  const s = scroller();
  s.scrollTop = top;
  ownTop = lastTop = s.scrollTop;
}
function onScroll() {
  const s = scroller();
  if (s.scrollTop === ownTop) return;
  ownTop = null;
  // Scrolling up lets go of the end at once (else the next streamed line would pull the view back down); scrolling
  // down to near it takes it up again.
  const up = s.scrollTop < lastTop;
  lastTop = s.scrollTop;
  noteHold(up);
}
const atEnd = () => {
  const s = scroller();
  return s.scrollHeight - s.scrollTop - s.clientHeight < 1;
};
function noteHold(up = false) {
  const s = scroller();
  if (up ? atEnd() : nearBottom()) return void (held = { end: true });
  const top = s.getBoundingClientRect().top;
  // Rows stack top to bottom: the first one reaching into the view, by halves.
  const rows = rowsEl().children;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  const row = rows[lo] as HTMLElement | undefined;
  held = row ? { end: false, key: row.dataset.key!, offset: row.getBoundingClientRect().top - top } : { end: true };
}
/** Puts the view back where it's held, now (for size changes made outside the transcript's own observers). */
export function keepHold() {
  const s = scroller();
  if (held.end) {
    if (!atEnd()) setTop(s.scrollHeight);
    return;
  }
  const key = held.key;
  const row = [...rowsEl().children].find((r) => (r as HTMLElement).dataset.key === key);
  // Gone (a pending prompt the harness echoed under another key): hold whatever is there now.
  if (!row) return noteHold();
  const drift = row.getBoundingClientRect().top - s.getBoundingClientRect().top - held.offset;
  if (Math.abs(drift) >= 0.5) setTop(s.scrollTop + drift);
}
export const scrollToBottom = () => {
  setTop(scroller().scrollHeight);
  held = { end: true };
};

let frame = 0;
/** Coalesce streaming updates to one reconcile per animation frame. */
export function update() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    reconcile();
  });
}

function reconcile() {
  const thread = store.thread;
  const container = rowsEl();
  if (!thread) {
    if (renderedThread) park(renderedThread, container);
    container.replaceChildren();
    renderedThread = null;
    renderTrailer();
    return;
  }
  const switched = renderedThread !== thread.id;
  // Sending a prompt brings the conversation to its end, wherever it was scrolled.
  const echo = store.echo;
  const ownSend = echo?.threadId === thread.id && echo.at !== stuckEcho;
  if (ownSend) stuckEcho = echo!.at;
  const stick = switched || ownSend;
  let existing = new Map<string, HTMLElement>();
  if (!switched) for (const node of container.children as HTMLCollectionOf<HTMLElement>) existing.set(node.dataset.key!, node);
  else {
    if (renderedThread) park(renderedThread, container);
    existing = parked.get(thread.id) ?? existing;
    parked.delete(thread.id);
  }
  const rows = buildRows(thread);
  const nodes = rows.map((row) => {
    const prev = existing.get(row.key);
    return prev && prev.dataset.sig === signature(row) ? prev : buildRow(row);
  });
  // Only touch the DOM where it changed, so open folds, selections and scroll positions stay put.
  nodes.forEach((node, i) => {
    if (container.children[i] !== node) container.insertBefore(node, container.children[i] ?? null);
  });
  while (container.children.length > nodes.length) container.lastElementChild!.remove();
  renderedThread = thread.id;
  markHot();
  renderTrailer();
  if (stick) scrollToBottom();
  // Rows rebuilt at the same height move nothing the resize observer would see; anything else is put back here too.
  else keepHold();
}

function markHot() {
  for (const node of rowsEl().children as HTMLCollectionOf<HTMLElement>) node.classList.toggle("hot", !!hot && node.dataset.group === hot);
}

// While a column glides, the conversation's width changes every frame. Rows away from the view are held at the height
// they had and skipped (content-visibility: hidden at a fixed height, so nothing moves), and only the ones on screen
// rewrap; once the glide is over they're let go, and the keeper puts back whatever their new heights shifted.
const GLIDES = new Set(["--sb", "--rp", "--fp"]);
let gliding = 0;
let frozen: HTMLElement[] = [];
function freeze() {
  const s = scroller().getBoundingClientRect();
  const margin = s.height;
  // Every size read before any is written: one layout, not one per row.
  const rows = [...(rowsEl().children as HTMLCollectionOf<HTMLElement>)];
  const rects = rows.map((row) => row.getBoundingClientRect());
  rows.forEach((row, i) => {
    const r = rects[i];
    if (r.bottom > s.top - margin && r.top < s.bottom + margin) return;
    row.style.height = `${r.height}px`;
    row.style.contentVisibility = "hidden";
    frozen.push(row);
  });
}
function thaw() {
  for (const row of frozen) {
    row.style.height = "";
    row.style.contentVisibility = "";
  }
  frozen = [];
  keepHold();
}

export function initTranscript() {
  const app = $("app");
  let safety = 0;
  app.addEventListener("transitionrun", (e) => {
    if (e.target !== app || !GLIDES.has(e.propertyName)) return;
    if (!gliding++) freeze();
    // Should an end never come, the rows aren't left frozen.
    clearTimeout(safety);
    safety = window.setTimeout(() => gliding && ((gliding = 0), thaw()), 1000);
  });
  const ended = (e: TransitionEvent) => {
    if (e.target !== app || !GLIDES.has(e.propertyName) || !gliding) return;
    if (!--gliding) thaw();
  };
  app.addEventListener("transitionend", ended);
  app.addEventListener("transitioncancel", ended);
  rowsEl().addEventListener("mouseover", (e) => {
    const group = (e.target as Element).closest<HTMLElement>(".trow")?.dataset.group ?? null;
    if (group !== hot) (hot = group), markHot();
  });
  rowsEl().addEventListener("mouseleave", () => {
    hot = null;
    markHot();
  });
  const s = scroller();
  s.addEventListener("scroll", onScroll, { passive: true });
  const keep = new ResizeObserver(keepHold);
  keep.observe($("transcript"));
  keep.observe(s);
  on("transcript", () => {
    // A session asked of the core but not loaded yet: the old one dims (after a beat, so quick opens don't
    // flash) until it arrives.
    s.classList.toggle("opening", !!store.opening && store.opening !== store.thread?.id);
    update();
  });
  setInterval(renderTrailer, 1000);
}
