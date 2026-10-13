// The files panel's Agents view (Zeron's Subagents section): the open session's subagents and side chats, each opening
// its transcript in a tab (panels.ts), so one whose tab was closed opens again from here. Two lists, each under a
// header that folds it (open to start), the glyph telling each one's state: the ones at work lead, longest at it
// first, then the rest, the latest first. Subagents come from
// the session's Agent rows (the tool items that spawned them) and the core's word on each one's thread
// (ThreadSummary.subagent), which also holds the ones a subagent spawned itself.
import type { Item, ThreadSummary } from "../shared/model";
import { el, miniSpinner, timeAgo } from "./dom";
import { icon } from "./icons";
import { slideFold } from "./motion";
import { store } from "./store";

type SpawnItem = Extract<Item, { kind: "tool" }>;

/** A subagent at work: as its transcript says (a spawn can return while it works on), else as its call does. */
export function agentWorking(item: SpawnItem): boolean {
  const sub = item.agent ? store.summaries.get(item.agent) : undefined;
  return sub ? sub.status === "running" || sub.status === "waiting" : item.status === "inProgress";
}

/** A side chat's state is "chat" once it has stopped: it hasn't completed or failed, it waits for its next message. */
type State = "running" | "completed" | "failed" | "chat";
type AgentRow = { id: string; title: string; side: boolean; state: State; /** Started (running), else last active; null: not known. */ at: number | null };

const ended = (item: SpawnItem | null, sub: ThreadSummary | undefined): State =>
  sub?.status === "error" || item?.status === "failed" || item?.status === "interrupted" ? "failed" : "completed";
const busy = (t: ThreadSummary) => t.status === "running" || t.status === "waiting";

/** The open session's subagents, in the order they started, then its side chats. */
function agentRows(sideChats: { id: string; title: string }[]): AgentRow[] {
  const t = store.thread;
  if (!t) return [];
  const rows = new Map<string, AgentRow>();
  for (const turn of t.turns)
    for (const item of turn.items) {
      if (item.kind !== "tool" || !item.agent || rows.has(item.agent)) continue;
      const sub = store.summaries.get(item.agent);
      const running = agentWorking(item);
      rows.set(item.agent, {
        id: item.agent,
        side: false,
        title: sub?.title ?? (item.name.replace(/^subagent · /, "") || "Agent"),
        state: running ? "running" : ended(item, sub),
        at: running ? (sub?.createdAt ?? turn.startedAt) : (sub?.updatedAt ?? turn.completedAt),
      });
    }
  // Ones the core knows that no row here spawned: a subagent's own.
  for (const sub of store.summaries.values())
    if (sub.subagent && sub.parent === t.id && !rows.has(sub.id)) {
      const running = busy(sub);
      rows.set(sub.id, { id: sub.id, title: sub.title, side: false, state: running ? "running" : ended(null, sub), at: running ? sub.createdAt : sub.updatedAt });
    }
  for (const c of sideChats) {
    const sum = store.summaries.get(c.id);
    const running = !!sum && busy(sum);
    rows.set(c.id, { id: c.id, title: c.title, side: true, state: running ? "running" : "chat", at: (running ? sum?.createdAt : sum?.updatedAt) ?? null });
  }
  return [...rows.values()];
}

type Section = "subagents" | "sidechats";
const LABEL: Record<Section, string> = { subagents: "Subagents", sidechats: "Side chats" };

const GLYPH = { completed: "check", failed: "x", chat: "messageCircle" } as const;

/** The view, under the files panel's head. `open`: a transcript shown; `shown`: the one its tab shows now;
 *  `sideChats`: the session's side chats, labelled as their tabs are. */
export function agentsView(hooks: { open: (id: string) => void; shown: () => string | null; sideChats: () => { id: string; title: string }[] }) {
  const root = el("div", "av fp-page");
  const list = el("div", "av-list");
  root.append(list);
  /** Sections folded shut by a click. */
  const shut = new Set<Section>();
  let query = "";
  let drawn = "";

  const since = (ms: number | null) => {
    const ago = ms == null ? "" : timeAgo(ms);
    return ago === "now" ? "" : ago;
  };

  function row(a: AgentRow): HTMLElement {
    const r = el("div", `ft-row av-row ${a.state}${hooks.shown() === a.id ? " current" : ""}`);
    const glyph = el("span", "ft-icon av-glyph");
    glyph.append(a.state === "running" ? miniSpinner() : icon(GLYPH[a.state]));
    const time = since(a.at);
    r.append(glyph, el("span", "ft-name", a.title), el("span", "av-time", time));
    const what = a.state === "running" ? `working${time ? ` for ${time}` : ""}` : a.state === "chat" ? `side chat${time ? `, active ${time} ago` : ""}` : `${a.state}${time ? ` ${time} ago` : ""}`;
    r.title = `${a.title} · ${what}`;
    r.onclick = () => hooks.open(a.id);
    return r;
  }

  /** A section's header, its chevron turning as its rows slide open or shut. */
  function section(sec: Section, rows: AgentRow[]): HTMLElement[] {
    const head = el("div", `ft-row av-group${shut.has(sec) ? "" : " open"}`);
    const chev = el("span", "ft-chev");
    chev.append(icon("chevronRight"));
    head.append(chev, el("span", "ft-name", LABEL[sec]), el("span", "av-time", String(rows.length)));
    const box = el("div", "av-kids");
    const kids = rows.map(row);
    if (!shut.has(sec)) box.append(...kids);
    head.onclick = async () => {
      const open = shut.has(sec);
      open ? shut.delete(sec) : shut.add(sec);
      head.classList.toggle("open", open);
      if (open) box.replaceChildren(...kids), await slideFold(box, true);
      else await slideFold(box, false), box.replaceChildren();
      drawn = "";
      render();
    };
    return [head, box];
  }

  const matches = (title: string) => {
    const p = title.toLowerCase();
    let at = -1;
    for (const ch of query) if ((at = p.indexOf(ch, at + 1)) < 0) return false;
    return true;
  };

  function render() {
    const all = agentRows(hooks.sideChats());
    const rows = query ? all.filter((a) => matches(a.title)) : all;
    const sig = `${store.thread?.id}|${hooks.shown()}|${[...shut].join()}|${query}|${Math.floor(Date.now() / 30_000)}|${rows.map((a) => `${a.id}:${a.state}:${a.title}:${a.at}`).join()}`;
    if (sig === drawn) return;
    drawn = sig;
    const top = list.scrollTop;
    if (!store.thread) return list.replaceChildren(el("div", "cv-note", "Open a session to see its subagents and side chats."));
    if (!all.length) return list.replaceChildren(el("div", "cv-note", "Subagents and side chats show here when the session starts one."));
    if (!rows.length) return list.replaceChildren(el("div", "cv-note", "No matching agents."));
    // At work, the one at it longest first, so new ones join the end of them and the list holds still; then the
    // rest, the latest first. Subagents go by when they started (the order rows come in): when one ended is only
    // known once its transcript is read, so by that the list would shift as they're opened.
    const working = (a: AgentRow) => a.state === "running";
    const subs = rows.filter((a) => !a.side);
    const chats = rows.filter((a) => a.side);
    const byTime = (a: AgentRow, b: AgentRow) => (a.at ?? 0) - (b.at ?? 0);
    const sections = [
      ...(subs.length ? section("subagents", [...subs.filter(working), ...subs.filter((a) => !working(a)).reverse()]) : []),
      ...(chats.length ? section("sidechats", [...chats.filter(working).sort(byTime), ...chats.filter((a) => !working(a)).sort(byTime).reverse()]) : []),
    ];
    list.replaceChildren(...sections);
    list.scrollTop = top;
  }

  /** The panel's search, applied to the list: a subsequence of the title, as the files are searched. */
  function filter(q: string) {
    query = q.trim().toLowerCase().replace(/\s+/g, "");
    render();
  }

  return { el: root, render, filter };
}
