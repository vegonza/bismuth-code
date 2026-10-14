// The composer's completions (Zeron's and t3code's): typing a trigger and a query lists what it completes to in a card
// just above the box, while the caret stays in the box. ↑↓ move, Enter or Tab picks, Esc dismisses until another one.
// - `@` mentions one of the session's files (Go to file's search and rows): its chip takes the `@query`'s place.
// - `$` or `/` starting a word lists the harness's skills. A pick is written the way that harness takes it
//   (`/simplify` for Claude Code, `$imagegen` for Codex), as text: it's what gets sent.
// - `/` opening the prompt lists the commands too: `/compact` and `/goal` where the harness has them (the harness runs
//   the prompt), and bismuth's own (APP), which the app runs instead of sending.
import type { HarnessId, Invocable, TurnSettings } from "../shared/model";
import { el } from "./dom";
import type { Editor } from "./editor";
import { HARNESS_NAMES, icon } from "./icons";
import { reducedMotion } from "./motion";
import { fileRow, highlight, openMcp } from "./palette";
import { findFiles, loadSuggestions, newSideChat, showCommit, suggestedFiles } from "./panels";
import { renameSession } from "./sidebar";
import { sideChat } from "./sidechat";
import { currentHarness, openPicker } from "./picker";
import { actions, call, net, projectOf, store, targetProject, workFolder } from "./store";

const MENU_OUT_MS = 100;
const ROWS_MAX = 50;

type Kind = "file" | "skill";

/** The token the caret is at the end of, in the text before it: an `@`, `$` or `/` starting a word. A `$` before a
 *  number is an amount. */
const TOKENS: [Kind, string, RegExp][] = [
  ["file", "@", /(?:^|[\s([{>])@([^\s@]*)$/],
  ["skill", "$", /(?:^|[\s([{>])\$((?![0-9])[\w:.-]*)$/],
  ["skill", "/", /(?:^|[\s([{>])\/([\w:.-]*)$/],
];

type AppCommand = { it: Invocable; shown: () => boolean; run: (arg: string, settings: TurnSettings) => void };
const command = (name: string, description: string, hint: string | null): Invocable => ({ name, kind: "command", text: `/${name}`, description, hint });

/** bismuth's own commands, in every harness: the app runs them, nothing is sent. One without arguments runs as it's
 *  picked. */
const APP: AppCommand[] = [
  { it: command("model", "Choose the model and reasoning", null), shown: () => true, run: () => openPicker() },
  {
    it: command("side", "Open a side chat on this session, asking it what follows", "[question]"),
    shown: () => !!store.thread && !sideChat,
    run: (arg, settings) => void newSideChat(arg ? { text: arg, settings } : undefined),
  },
  {
    it: command("new", "Start a new session in this project, with what follows as its prompt", "[prompt]"),
    shown: () => !sideChat,
    run: (arg, settings) => {
      const project = currentProject();
      if (arg && project) net.send({ type: "send", threadId: null, projectId: project.id, text: arg, settings });
      else actions.newThread(project?.id);
    },
  },
  {
    it: command("rename", "Rename this session (to what follows)", "[title]"),
    shown: () => !!store.thread && !sideChat,
    run: (arg) => store.thread && (arg ? actions.rename(store.thread.id, arg) : renameSession(store.thread.id)),
  },
  { it: command("changes", "Show the changes (source control)", null), shown: () => !sideChat, run: () => showCommit() },
  { it: command("mcp", "This project's MCP servers", null), shown: () => !sideChat, run: () => openMcp(currentProject()) },
];

/** The project the session on screen is in, or the one a new session starts in. */
const currentProject = () => (store.thread ? projectOf(store.thread.cwd) : null) ?? targetProject();

/** The app command a prompt runs, if it's one (`/side why…`), to run with the composer's settings. */
export function appCommand(text: string): ((settings: TurnSettings) => void) | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const app = m && APP.find((a) => a.it.name === m[1] && a.shown());
  return app ? (settings) => app.run(m![2]?.trim() ?? "", settings) : null;
}

/** What the open token lists, out of the harness's: skills, and the commands first when its `/` opens the prompt. */
function listFor(all: Invocable[], commands: boolean): Invocable[] {
  if (!commands) return all.filter((i) => i.kind === "skill");
  const app = APP.filter((a) => a.shown()).map((a) => a.it);
  return [...all.filter((i) => i.kind === "command"), ...app].sort((a, b) => a.name.localeCompare(b.name)).concat(all.filter((i) => i.kind === "skill"));
}

/** Where the skills come from: the session on screen, or the harness and project a new one starts with. */
function skillsOwner(): { key: string; harness: HarnessId; params: { threadId: string } | { harness: HarnessId; projectId: string } } | null {
  if (store.thread) return { key: store.thread.id, harness: store.thread.harness, params: { threadId: store.thread.id } };
  const project = targetProject();
  const harness = currentHarness();
  return project ? { key: `${harness}:${project.id}`, harness, params: { harness, projectId: project.id } } : null;
}

/** Each owner's list as last fetched (shown at once the next time, while it's asked for again). */
const listed = new Map<string, Invocable[]>();

/** The ones whose name has the query, a name starting with it first, then a word in it, then anywhere. */
function rank(list: Invocable[], query: string): Invocable[] {
  const q = query.toLowerCase();
  const score = (name: string) => (name.startsWith(q) ? 0 : new RegExp(`[-_:.]${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(name) ? 1 : name.includes(q) ? 2 : -1);
  return list
    .map((i, at) => ({ i, at, s: score(i.name.toLowerCase()) }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => a.s - b.s || a.at - b.at)
    .map((r) => r.i);
}

/** A skill's or command's row: how a prompt names it, then what it does in the quiet tone. */
function invocableRow(it: Invocable, query: string): HTMLElement {
  const item = el("button", "palette-command palette-skill");
  const label = el("span", "label");
  const name = el("span", "name");
  name.append(highlight(it.text, query ? [query.toLowerCase()] : []));
  label.append(name);
  if (it.description) label.append(el("span", "path", it.description));
  item.title = [it.hint && `${it.text} ${it.hint}`, it.description].filter(Boolean).join("\n");
  if (it.kind === "command") item.append(icon("squareSlash"));
  item.append(label);
  return item;
}

export function initMentions(editor: Editor, host: HTMLElement, chip: (path: string) => HTMLElement, settings: () => TurnSettings) {
  let card: HTMLElement | null = null;
  let list: HTMLElement;
  /** The open token: what it completes, where its trigger is, its query, and whether it lists commands (a `/`
   *  opening the prompt). */
  let token: { kind: Kind; at: number; query: string; commands: boolean } | null = null;
  /** Esc'd: the trigger it was at, left alone until the caret leaves it. */
  let dismissed: number | null = null;
  let results: string[] = [];
  /** The query `results` answer (null: none yet), and the search answering the latest one. */
  let resultsFor: string | null = null;
  let seq = 0;
  let active = 0;
  /** The skills and commands for the open `$` or `/` (null: still being asked for), and why they couldn't be. */
  let skills: Invocable[] | null = null;
  let skillsError: string | null = null;
  let skillsFor: string | null = null;
  let found: Invocable[] = [];

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
    hide();
  }

  function hide() {
    if (!card) return;
    const closing = card;
    card = null;
    closing.classList.replace("menu-in", "menu-out");
    closing.style.pointerEvents = "none";
    setTimeout(() => closing.remove(), reducedMotion() ? 0 : MENU_OUT_MS + 20);
  }

  /** What the token's query finds. */
  const find = (t: NonNullable<typeof token>) => rank(listFor(skills ?? [], t.commands), t.query);

  /** The card up while the token has something to show: a `$` or `/` naming no skill isn't asking for a list (`$HOME`,
   *  a path), so it stays out of the way. */
  function sync() {
    if (!token || (token.kind === "skill" && skills && token.query && !found.length && !skillsError)) return hide();
    if (!card) open();
    render();
  }

  /** The token at the caret, followed: the list opened, searched again or closed. */
  function track() {
    const before = document.activeElement === editor.root ? editor.value().slice(0, editor.caret()) : null;
    const hit = before === null ? null : TOKENS.map(([kind, trigger, re]) => [kind, trigger, re.exec(before)] as const).find(([kind, , m]) => m && (kind === "file" ? !!workFolder() : !!skillsOwner()));
    if (!hit) {
      dismissed = null;
      return close();
    }
    const [kind, trigger, m] = hit as [Kind, string, RegExpExecArray];
    // Typed text, not a chip's label (an `@path` too) the caret is just after.
    const sel = getSelection();
    if (sel?.focusNode?.nodeType !== Node.TEXT_NODE || !(sel.focusNode.nodeValue ?? "").slice(0, sel.focusOffset).endsWith(`${trigger}${m[1]}`)) return close();
    const at = m.index + m[0].length - m[1].length - 1;
    if (at === dismissed) return close();
    dismissed = null;
    const query = m[1];
    if (token?.kind === kind && token.at === at && token.query === query) return;
    const opening = token?.kind !== kind || token.at !== at;
    token = { kind, at, query, commands: trigger === "/" && !before!.slice(0, at).trim() };
    active = 0;
    if (kind === "file") search(query);
    else {
      if (opening) loadSkills();
      found = find(token);
    }
    sync();
  }

  /** The owner's skills: the last list at once, then the one asked for now. */
  function loadSkills() {
    const owner = skillsOwner();
    if (!owner) return;
    skillsFor = owner.key;
    skills = listed.get(owner.key) ?? null;
    skillsError = null;
    void call("invocables.list", owner.params)
      .then((list) => {
        listed.set(owner.key, list);
        if (skillsFor !== owner.key) return;
        skills = list;
      })
      .catch((err) => {
        if (skillsFor !== owner.key) return;
        skillsError = `Couldn't list ${HARNESS_NAMES[owner.harness]}'s skills: ${err?.message ?? err}`;
        skills ??= [];
      })
      .finally(() => {
        if (skillsFor !== owner.key || token?.kind !== "skill") return;
        found = find(token);
        sync();
      });
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

  /** How many rows the open list has. */
  const shownCount = () => Math.min(token?.kind === "file" ? results.length : found.length, ROWS_MAX);

  function render() {
    if (!card || !token) return;
    const n = shownCount();
    active = Math.min(active, Math.max(0, n - 1));
    if (!n) {
      list.replaceChildren(el("div", "mention-note", emptyNote(token)));
      return;
    }
    const rows = token.kind === "file" ? results.slice(0, n).map((path) => fileRow(path, token!.query)) : found.slice(0, n).map((it) => invocableRow(it, token!.query));
    rows.forEach((row, i) => {
      row.classList.toggle("active", i === active);
      row.onmousemove = () => i !== active && ((active = i), mark());
      row.onclick = () => pick(i);
    });
    // `/model` lists even when the harness's skills couldn't be: why they're missing goes under it.
    list.replaceChildren(...rows, ...(token.kind === "skill" && skillsError ? [el("div", "mention-note", skillsError)] : []));
    edgeFades();
  }

  function emptyNote(t: NonNullable<typeof token>): string {
    if (t.kind === "file") return resultsFor !== t.query ? "Searching files…" : t.query ? "No matching files" : "No files here";
    if (skillsError) return skillsError;
    if (!skills) return "Loading skills…";
    const harness = skillsOwner()?.harness;
    return `${harness ? HARNESS_NAMES[harness] : "This harness"} has no skills here`;
  }

  /** The active row lit, and scrolled to. */
  function mark() {
    [...list.children].forEach((r, i) => r.classList.toggle("active", i === active));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function pick(i: number) {
    if (!token) return;
    const replace = token.query.length + 1;
    if (token.kind === "file") {
      const path = results[i];
      if (!path) return;
      close();
      editor.insertChips([chip(path)], replace);
      return;
    }
    const it = found[i];
    if (!it) return;
    close();
    const app = APP.find((a) => a.it === it);
    if (app && !it.hint) {
      editor.insert("", () => null, replace);
      return app.run("", settings());
    }
    editor.insert(`${it.text} `, () => null, replace);
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
      const n = shownCount();
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
