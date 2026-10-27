// Entry point: the socket to the core, server messages → store, navigation, shortcuts, and the
// reload contract with `bun run apply` (window.__bismuthReady, draft/scroll carried across reloads).
import { initUiSync, uiSyncHello, uiSyncRemote } from "./uisync"; // first: it sees every write to shared settings
import type { ServerMessage, Thread, ThreadEvent, ThreadSummary, Turn } from "../shared/model";
import { subagentOf } from "../shared/model";
import { forgetStaged } from "./attachments";
import { initBackground } from "./background";
import { canRemoveImage, canStopTurn, canToggleWorktree, closePicker, draft, initComposer, removeLastImage, stopTurn, toggleWorktreeMode } from "./composer";
import { discardNewDraft, draftHasContent, isNewDraft, newDraft, openNewDraft, setDraft, setNewDraftProject, switchNewDraft } from "./drafts";
import { $, el, firstLine } from "./dom";
import { harnessIcon, icon } from "./icons";
import { bindShortcut, comboFromEvent, dispatchShortcut, keyContext, recentWalk, shellKeeps, shortcutFor, usedNow } from "./keymap";
import { closePalette, initPalette, openPalette, paletteOpen, togglePalette } from "./palette";
import { prefs, SHORTCUTS, TERMINAL_SCOPED } from "./prefs";
import { connectionChanged, threadChanged } from "./notify";
import { pickerOpen, togglePicker } from "./picker";
import { closeSettings, focusSettingsSearch, initSettings, selectSettingsTab, settingsOpen, toggleSettings } from "./settings";
import { usageArrived } from "./usagepage";
import { isRestarting, restartMessage, restartNeeded } from "./restart";
import { initPhone, initPhoneFrame, isPhone, onPhoneChange, sessionReady, showSession } from "./phone";
import { initSidebar, jumpOrder, projectArt, renameSession, renaming, sessionOrder, toggleSidebar } from "./sidebar";
import { actions, branchOf, call, failCalls, nav, net, on, persist, projectName, projectOf, promptCount, promptsLike, render, setCurrentProject, settleCall, store, targetProject, worktreeOf } from "./store";
import { initTheme } from "./theme";
import { previewSession } from "./worktrees";
import { closeTerminal, cycleTerminal, hideTerminal, initTerminal, newTerminal, terminalExit, terminalOutput, terminalsArrived, toggleMaximize, toggleTerminal } from "./terminal";
import { initTranscript, setAgentOpener } from "./transcript";
import { focusAddress, reloadPage, setAwake, wireLinks } from "./browser";
import { setOpener } from "./refs";
import { adoptSession, forwardKey, forwardKeyUp, host, sideChat, sideSession } from "./sidechat";
import { newSideChat, sideChatsToOpen, revealSideChat, sideChatChanged, sideChatGone, agentBrowser, reportOwners, browsing, openBrowser, closeActiveFile, reopenClosedFile, collapseFolders, showSidebarView, cycleTabs, expandFolders, filesChanged, goBack, goForward, openReview, initPanels, jumpTab, renameHovered, resyncWatch, showCommit, revealActiveFile, saveActiveFile, toggleExpand, toggleFiles, toggleHiddenFiles, togglePane, togglePreview, turnSnapshot } from "./panels";

declare global {
  interface Window {
    __bismuthReady?: boolean;
    /** The desktop shell, on a second launch with a folder: add it as a project and start a session there. */
    __bismuthOpenProject?: (path: string) => void;
  }
}
// Contract with `bun run apply`: set once the first screen has rendered from core data. The smoke test waits for it.
// Until then the main pane stays hidden (index.html's .booting), so a reload doesn't flash the empty new-session
// screen before its thread arrives; a core that's slow to answer gets the screen after 2s anyway.
const markReady = () => {
  window.__bismuthReady = true;
  $("app").classList.remove("booting");
};
setTimeout(() => $("app").classList.remove("booting"), 2000);

// The UI reloads whenever a new build is applied (and on Ctrl+R): carry the scroll position across (drafts and their
// images are kept per session in localStorage, drafts.ts and attachments.ts).
// The open thread survives via the URL hash; everything else comes back from the core.
// (A side chat's frame shares the window's sessionStorage: it leaves the window's to it.)
const restore = sideChat ? null : (JSON.parse(sessionStorage.getItem("bismuth.restore") ?? "null") as { scroll: number | null } | null);
if (!sideChat) sessionStorage.removeItem("bismuth.restore");
let pendingScroll = restore?.scroll ?? null;
addEventListener("pagehide", () => {
  if (sideChat) return;
  const s = $("scroller");
  const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 70;
  sessionStorage.setItem("bismuth.restore", JSON.stringify({ scroll: atBottom ? null : s.scrollTop }));
});

// ---------------- socket ----------------

let ws: WebSocket;
// A thread we just created reports the harness's config defaults, not the settings its first turn was sent with.
let creating = false;
net.send = (msg) => {
  if (msg.type === "send") {
    if (!msg.threadId) creating = true;
    // One still on its way when another follows (steers sent in a row) keeps its bubble, as a sent one does, until
    // the thread has it (by text: buildRows).
    const prev = store.echo;
    if (prev?.threadId && prev.threadId === msg.threadId)
      store.sent.push({ threadId: prev.threadId, id: `echo:${prev.at}`, text: prev.text, at: prev.at, seen: prev.like, prompts: prev.seen });
    const t = msg.threadId ? store.thread : null;
    store.echo = { threadId: msg.threadId, text: msg.text, at: Date.now(), seen: promptCount(t), like: t ? promptsLike(t, msg.text) : 0 };
    render("transcript");
  }
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};
net.open = () => ws?.readyState === WebSocket.OPEN;
initUiSync(net.send, net.open);

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    banner(null);
    if (!sideChat) connectionChanged(false);
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data) as ServerMessage);
  ws.onclose = () => {
    failCalls();
    // A restart takes the core down on purpose (no banner, chime or notification); the live client reloads the
    // window once it's back.
    // (A side chat's frame leaves saying so to the window around it.)
    if (!isRestarting() && !sideChat) {
      banner("Disconnected from the core — reconnecting…");
      connectionChanged(true);
    }
    setTimeout(connect, 1000);
  };
}

function summarize(t: Omit<Thread, "turns" | "requests">): ThreadSummary {
  return { id: t.id, harness: t.harness, title: t.title, updatedAt: t.updatedAt, createdAt: t.createdAt, status: t.status, branch: t.branch, cwd: t.cwd, settledAt: t.settledAt ?? null, runningSince: t.runningSince ?? null, parent: t.parent ?? null, subagent: t.subagent };
}

/** What a side chat's frame leaves to the window around it: the panels, the terminal, restarts. */
const WINDOW_ONLY = new Set<ServerMessage["type"]>(["restart", "restartNeeded", "terminals", "terminal.output", "terminal.exit", "files.changed", "turnSnapshot"]);

function onMessage(msg: ServerMessage) {
  if (sideChat && WINDOW_ONLY.has(msg.type)) return;
  switch (msg.type) {
    case "hello": {
      store.device = msg.device;
      store.home = msg.home;
      store.projects = msg.projects;
      // Opened on a folder (`bun run app <dir>`): new sessions start there, once per launch (a reload keeps the
      // window's sessionStorage, so it doesn't undo a later pick).
      if (!sideChat && msg.launch && sessionStorage.getItem("bismuth.launch") !== msg.launch) {
        sessionStorage.setItem("bismuth.launch", msg.launch);
        setCurrentProject(msg.launch);
      }
      store.harnesses = msg.harnesses;
      store.models = msg.models;
      store.summaries = new Map(msg.threads.map((t) => [t.id, titled(t)]));
      store.queueSupported = !!msg.queues;
      store.queues = new Map(Object.entries(msg.queues ?? {}));
      uiSyncHello(msg.uiState);
      banner(msg.error);
      const target = sideChat ? sideSession() : decodeURIComponent(location.hash.slice(1)) || store.thread?.id;
      if (target) (wanted = target), net.send({ type: "open", threadId: target });
      render("sidebar", "header", "composer", "transcript", "providers");
      // A new connection (a restarted core) watches nothing for this window yet, nor knows its pages' sessions.
      if (!sideChat) resyncWatch(), reportOwners();
      $("app").classList.remove("connecting"); // the sidebar has its sessions now, not the empty "Add a project"
      // A spare side chat frame isn't up until its session is: that one comes on screen settled, not gliding into place.
      if (!target && sideChat) host()?.warm();
      else if (!target) markReady();
      break;
    }
    case "restart":
      restartMessage(msg);
      break;
    case "restartNeeded":
      restartNeeded(msg.files);
      break;
    case "browser":
      void agentBrowser(msg);
      break;
    case "browserAwake":
      setAwake(msg.targets);
      break;
    case "uiState":
      uiSyncRemote(msg.key, msg.value);
      break;
    case "usageReport":
      usageArrived(msg.days, msg.report);
      break;
    case "usageReportFailed":
      usageArrived(msg.days, null, msg.message);
      break;
    case "harnesses":
      store.harnesses = msg.harnesses;
      store.models = msg.models;
      render("composer", "providers");
      break;
    case "terminals":
      terminalsArrived(msg.terminals);
      break;
    case "files.changed":
      filesChanged(msg.root, msg.dirs);
      break;
    case "turnSnapshot":
      turnSnapshot(msg.threadId);
      break;
    case "terminal.output":
      terminalOutput(msg.id, msg.seq, msg.data);
      break;
    case "terminal.exit":
      terminalExit(msg.id, msg.seq, msg.code);
      break;
    case "queue":
      if (msg.queue.items.length || msg.queue.paused) store.queues.set(msg.threadId, msg.queue);
      else store.queues.delete(msg.threadId);
      if (store.thread?.id === msg.threadId) {
        // A send that failed puts its row back: it isn't on its way after all.
        const back = new Set(msg.queue.items.map((r) => r.id));
        store.sent = store.sent.filter((s) => !back.has(s.id));
        if (msg.sent) {
          const t = store.thread;
          store.sent.push({ threadId: t.id, ...msg.sent, seen: promptsLike(t, msg.sent.text), prompts: promptCount(t) });
        }
        render("composer", "transcript");
      }
      break;
    case "rpcResult":
      settleCall(msg.id, msg.result, msg.error);
      break;
    case "threads":
      store.summaries = new Map(msg.threads.map((t) => [t.id, titled(t)]));
      render("sidebar");
      break;
    case "settlement": {
      const t = store.summaries.get(msg.threadId);
      if (t) store.summaries.set(msg.threadId, { ...t, settledAt: msg.settledAt });
      if (store.thread?.id === msg.threadId) store.thread.settledAt = msg.settledAt;
      render("sidebar");
      break;
    }
    case "projects":
      store.projects = msg.projects;
      render("sidebar", "header", "composer");
      break;
    case "thread": {
      const t = msg.thread;
      // An answer to an open the user has since moved on from (to another session or a new one) isn't shown.
      if (!creating && t.id !== wanted) break;
      // Already showing a kept copy: the composer's settings only follow if the thread's own changed meanwhile.
      const prev = store.thread?.id === t.id ? store.thread : null;
      const adopt = !prev || t.model !== prev.model || t.effort !== prev.effort || t.serviceTier !== prev.serviceTier || t.account !== prev.account;
      store.thread = t;
      t.title = titled(t).title;
      store.summaries.set(t.id, summarize(t));
      show(t, adopt);
      if (pendingScroll !== null) {
        const top = pendingScroll;
        pendingScroll = null;
        requestAnimationFrame(() => ($("scroller").scrollTop = top));
      }
      markReady();
      break;
    }
    case "event":
      applyEvent(msg.threadId, msg.event);
      break;
    case "error":
      store.echo = null; // the send may not have gone through
      if (store.opening) {
        store.opening = null;
        render("sidebar", "transcript", "composer");
      }
      banner(msg.message);
      markReady();
      break;
  }
}

/** Until Codex names a new session (after its first prompt is recorded), it's titled by that prompt. */
const UNTITLED = "New thread";
/** Each session's title as the harness names it, for when a rename is cleared. */
const harnessTitles = new Map<string, string>();
function titled<T extends { id: string; title: string }>(t: T): T {
  t = harnessTitled(t);
  harnessTitles.set(t.id, t.title);
  const name = store.titles.get(t.id);
  return name ? { ...t, title: name } : t;
}
function harnessTitled<T extends { id: string; title: string }>(t: T): T {
  if (t.title !== UNTITLED) return t;
  const open = store.thread?.id === t.id ? store.thread : null;
  const prompt = open?.turns.flatMap((turn) => turn.items).find((i) => i.kind === "user")?.text ?? (store.echo?.threadId === t.id ? store.echo.text : "");
  const title = firstLine(prompt).slice(0, 80);
  return title ? { ...t, title } : t;
}

/** The session on screen (or on its way), or the new-session screen's draft. */
const shownSession = () => store.opening ?? store.thread?.id ?? openNewDraft().id;
const RECENT_SESSIONS = "bismuth.recentSessions";
/** Sessions and drafts as last opened, newest first: the order Mod+Tab goes through them. */
let recentSessions: string[] = JSON.parse(localStorage.getItem(RECENT_SESSIONS) ?? "[]");
const sessionWalk = recentWalk(() => usedSession());
/** The shown session the newest of the recently opened (not while Mod+Tab passes through it). */
function usedSession() {
  const id = shownSession();
  if (sessionWalk.walking() || recentSessions[0] === id) return;
  recentSessions = usedNow(recentSessions, id).slice(0, 100);
  localStorage.setItem(RECENT_SESSIONS, JSON.stringify(recentSessions));
}

/** The address names the session shown (none: the new-session page), so a reload comes back to it. */
function nameAddress() {
  const id = store.opening ?? store.thread?.id;
  if (location.hash.slice(1) !== (id ?? "")) history.replaceState(history.state, "", id ? `#${id}` : location.pathname + location.search);
}
// The phone's screens step back through history (phone.ts), to an entry that may name the session shown before the
// one on screen now (it changed while a panel was over it: a side chat moved to the sidebar).
addEventListener("popstate", nameAddress);

/** Put a thread on screen: the core's snapshot, or one kept from an earlier visit while that snapshot is on its way.
 *  `adopt`: the composer takes the thread's model and effort (not when only a fresher copy of what's shown came). */
function show(t: Thread, adopt: boolean) {
  store.thread = t;
  store.opening = null;
  wanted = t.id;
  keep(t);
  if (creating && store.echo && !store.echo.threadId) store.echo.threadId = t.id;
  seen(t.id);
  // Like Zeron's selection: the project follows the open session, so the next new one starts beside it.
  const p = projectOf(t.cwd);
  if (p && !sideChat) setCurrentProject(p.id);
  // The entry keeps its state: the phone layout counts its screens there (phone.ts).
  nameAddress();
  nav.push(t.id);
  // The next turn continues with the thread's own model and effort.
  if (adopt && !creating) adoptSettings(t);
  creating = false;
  if (!sideChat) usedSession();
  render("sidebar", "header", "composer", "transcript");
  sessionReady();
  // A side chat's frame comes into view once this is painted.
  if (sideChat) requestAnimationFrame(() => requestAnimationFrame(() => host()?.shown(t.id)));
}

// Sessions opened lately, as last seen (the open one is kept current by its events). Going back to one shows it at
// once, with the transcript's parked rows; the core's snapshot follows and only what changed meanwhile is redrawn.
const visited = new Map<string, Thread>();
function keep(t: Thread) {
  visited.delete(t.id);
  visited.set(t.id, t);
  while (visited.size > 12) visited.delete(visited.keys().next().value!);
}
/** The session the user last asked for, whose snapshot is the one to show. */
let wanted: string | null = null;

/** Ask the core for a session (which also subscribes this window to it), showing a kept copy meanwhile. */
function open(id: string) {
  wanted = id;
  const kept = visited.get(id);
  if (kept && store.summaries.has(id)) show(kept, true), showSession();
  else {
    // The sidebar selects the row right away; the thread itself follows once the core has loaded it.
    store.opening = id;
    render("sidebar", "transcript", "composer");
    showSession(true);
  }
  net.send({ type: "open", threadId: id });
}

function adoptSettings(t: Thread) {
  // The account its last turn ran on, when the core knows it; else the one picked stays, if it's this harness's.
  const account = t.account ?? (t.harness === store.settings.harness ? store.settings.account : null);
  if (t.model && store.models.some((m) => m.id === t.model))
    store.settings = { harness: t.harness, model: t.model, effort: t.effort ?? store.settings.effort, serviceTier: t.serviceTier, account };
  else if (store.settings.harness !== t.harness) store.settings = { ...store.settings, harness: t.harness, model: null, account };
  else store.settings = { ...store.settings, account };
}

/** Threads that settle while not open read "Done" in the sidebar until visited. */
function seen(id: string) {
  if (store.done.delete(id)) persist();
}

function applyEvent(threadId: string, ev: ThreadEvent) {
  if (ev.type === "thread.upsert") {
    ev.thread = titled(ev.thread);
    const prev = store.summaries.get(threadId);
    store.summaries.set(threadId, summarize(ev.thread));
    // (A subagent's ending is its session's business: the session says when it's done.)
    if (!sideChat && !ev.thread.subagent) threadChanged(threadId, ev.thread.title, prev?.status, ev.thread.status);
    // (A side chat isn't in the sidebar to say so: its tab shows it working.)
    if (!sideChat && !ev.thread.parent && prev?.status === "running" && ev.thread.status !== "running" && store.thread?.id !== threadId) {
      store.done.add(threadId);
      persist();
    }
    render("sidebar");
    if (!sideChat && (ev.thread.parent || prev?.parent)) sideChatChanged(threadId);
    // Its Agent row shows whether it's at work.
    if (ev.thread.subagent && prev?.status !== ev.thread.status) render("transcript");
  }
  if (ev.type === "thread.archived") {
    store.summaries.delete(threadId);
    visited.delete(threadId);
    store.done.delete(threadId);
    setDraft(threadId, "");
    forgetStaged(threadId);
    // (A side chat's frame goes with its tab.)
    if (store.thread?.id === threadId && !sideChat) actions.newThread();
    if (!sideChat) sideChatGone(threadId);
    render("sidebar");
    return;
  }
  const t = store.thread;
  if (!t || t.id !== threadId) return;
  switch (ev.type) {
    case "thread.upsert": {
      const wasRunning = !!t.activeTurnId;
      const changed = t.model !== ev.thread.model || t.effort !== ev.thread.effort || t.serviceTier !== ev.thread.serviceTier || t.account !== ev.thread.account;
      Object.assign(t, ev.thread);
      if (changed) adoptSettings(t);
      render("header", "composer", "transcript");
      if (wasRunning !== !!t.activeTurnId) render("sidebar");
      return;
    }
    case "turn.upsert":
      Object.assign(ensureTurn(t, ev.turn.id), ev.turn);
      break;
    case "item.upsert": {
      const turn = ensureTurn(t, ev.turnId);
      const ix = turn.items.findIndex((i) => i.id === ev.item.id);
      if (ix >= 0) turn.items[ix] = ev.item;
      else turn.items.push(ev.item);
      break;
    }
    case "item.delta": {
      const item = t.turns.find((x) => x.id === ev.turnId)?.items.find((i) => i.id === ev.itemId);
      if (!item) return;
      if (ev.field === "text" && (item.kind === "assistant" || item.kind === "plan")) item.text += ev.delta;
      else if (ev.field === "output" && (item.kind === "command" || item.kind === "tool")) item.output += ev.delta;
      else if (ev.field === "summary" && item.kind === "reasoning" && ev.index !== undefined) {
        while (item.summary.length <= ev.index) item.summary.push("");
        item.summary[ev.index] += ev.delta;
      }
      break;
    }
    case "request.upsert":
      t.requests = [...t.requests.filter((r) => r.id !== ev.request.id), ev.request];
      render("composer");
      return;
    case "request.remove":
      t.requests = t.requests.filter((r) => r.id !== ev.requestId);
      render("composer");
      return;
  }
  render("transcript");
}

function ensureTurn(t: Thread, id: string): Turn {
  let turn = t.turns.find((x) => x.id === id);
  if (!turn) {
    turn = { id, status: "inProgress", error: null, durationMs: null, startedAt: Date.now(), completedAt: null, items: [] };
    t.turns.push(turn);
  }
  return turn;
}

// ---------------- actions ----------------

actions.open = (id) => {
  if (isNewDraft(id)) return newScreen(id, true), showSession();
  // A side chat shows as a tab of its session's panel.
  const parent = !sideChat && store.summaries.get(id)?.parent;
  if (parent) return revealSideChat(parent, id);
  closeSettings();
  // Already the open one: on a phone it's still there under the list (back only uncovered the list), so it comes back.
  if ((store.opening ?? store.thread?.id) === id) return showSession();
  closePicker();
  open(id);
};

/** The new-session screen with one of its drafts (drafts.ts), which brings back the project it was started in. */
function newScreen(id: string, push: boolean) {
  closeSettings();
  closePicker();
  const d = switchNewDraft(id);
  if (store.projects.some((p) => p.id === d.projectId)) setCurrentProject(d.projectId);
  store.thread = null;
  store.opening = null;
  wanted = null;
  nameAddress();
  if (push) nav.push(d.id);
  usedSession();
  render("sidebar", "header", "composer", "transcript");
  draft.focus();
}

actions.newThread = (projectId) => {
  const open = openNewDraft();
  // On the new-session screen, picking a project moves the draft there; a draft with something in it stays in the
  // sidebar for later while a fresh one opens.
  const onScreen = !store.thread && !store.opening;
  if (projectId) setCurrentProject(projectId);
  if (onScreen && (projectId || !draftHasContent(open.id))) {
    setNewDraftProject(open.id, targetProject()?.id ?? null);
    return newScreen(open.id, false), showSession();
  }
  const id = draftHasContent(open.id) ? switchNewDraft(null).id : open.id;
  setNewDraftProject(id, targetProject()?.id ?? null);
  newScreen(id, true);
  showSession();
};

// Sessions renamed in another window (store.ts has taken the names): the sidebar and header show them.
addEventListener("storage", (e: StorageEvent) => {
  if (e.key !== "bismuth.titles") return;
  for (const [id, t] of store.summaries) {
    const title = store.titles.get(id) ?? harnessTitles.get(id);
    if (title && title !== t.title) store.summaries.set(id, { ...t, title });
  }
  const open = store.thread && (store.titles.get(store.thread.id) ?? harnessTitles.get(store.thread.id));
  if (store.thread && open) store.thread.title = open;
  render("sidebar", "header");
});

actions.rename = (id, name) => {
  if (name) store.titles.set(id, name);
  else store.titles.delete(id);
  persist();
  const title = name || harnessTitles.get(id);
  const t = store.summaries.get(id);
  if (t && title) store.summaries.set(id, { ...t, title });
  if (store.thread?.id === id && title) store.thread.title = title;
  render("sidebar", "header");
};

actions.settle = (id, settled) => void call("threads.settle", { id, settled }).catch((err) => banner(String(err?.message ?? err)));

window.__bismuthOpenProject = (path) =>
  void call("projects.add", { path })
    .then((p) => actions.newThread(p.id))
    .catch((err) => banner(String(err?.message ?? err)));

function go(index: number) {
  if (index < 0 || index >= nav.stack.length) return;
  nav.index = index;
  const id = nav.stack[index];
  if (id && store.summaries.has(id)) open(id);
  // A draft sent or discarded since: the new-session screen as it is now.
  else newScreen(id && newDraft(id) ? id : openNewDraft().id, false);
  render("header");
}
actions.back = () => go(nav.index - 1);
actions.forward = () => go(nav.index + 1);

// ---------------- chat titlebar + banner ----------------

function renderHeader() {
  const bar = $("chat-titlebar");
  const t = store.thread;
  if (!t) {
    bar.replaceChildren();
    return;
  }
  // Mid-rename the field stays; finishing renders the header again.
  if (renaming()) return;
  const title = el("span", "title", t.title);
  // (On a phone the session's ··· renames it.)
  if (!isPhone()) title.ondblclick = () => renameSession(t.id);
  // The project, and the branch its folder is on unless that's the default one (the folder's current branch: where
  // the agent works now; the one the session started on if the project was removed).
  const target = el("span", "target", projectName(t.cwd));
  // A worktree's session names the branch it came off and the worktree (its two-word name).
  const tree = worktreeOf(t.cwd);
  const branch = branchOf(t);
  if (tree) {
    if (tree.from) target.append(icon("gitBranch"), el("span", "branch", tree.from));
    target.append(icon("folderGit2"), el("span", "branch", tree.name));
  } else if (branch && branch !== "main" && branch !== "master") target.append(icon("gitBranch"), el("span", "branch", branch));
  // A phone's header is narrow: the project's icon leads it (as on the session list), not the harness's.
  bar.replaceChildren(isPhone() ? projectArt(projectOf(t.cwd) ?? null, t.cwd) : harnessIcon(t.harness), title, target);
  bar.title = t.title;
}

function banner(text: string | null) {
  const b = $("banner");
  b.hidden = !text;
  if (!text) return;
  const chip = el("div", "notice-chip");
  const head = el("div", "head");
  const tile = el("span", "tile");
  tile.append(icon("triangleAlert"));
  head.append(tile, el("span", "label", "Error"));
  chip.append(head, el("div", "msg", text));
  b.replaceChildren(chip);
}

// ---------------- boot ----------------

/** The desktop app on a Mac draws no title bar: its traffic lights sit in the titlebar strip, which leaves them room
 *  unless the window is full screen (desktop/main.ts). A shell from before (or another platform) says nothing. */
function initFrame() {
  type Frame = { frame?: { trafficLights: boolean; fullscreen: boolean }; onFullscreen?(fn: (on: boolean) => void): void };
  const desktop = (window as { bismuthDesktop?: Frame }).bismuthDesktop;
  if (!desktop?.frame?.trafficLights) return;
  const fullscreen = (on: boolean) => document.documentElement.classList.toggle("traffic-lights", !on);
  fullscreen(desktop.frame.fullscreen);
  desktop.onFullscreen?.(fullscreen);
}

initTheme();
initFrame();
/** The files panel shown on one of its views (the phone's ··· menu). */
const explorerOn = (view: "files" | "changes" | "agents") => (document.getElementById("app")!.classList.contains("files-open") || toggleFiles(), showSidebarView(view));
// A side chat's frame (sidechat.ts) is the chat column alone: the window around it has the rest.
if (!sideChat) initPhone({
  search: () => openPalette("commands"),
  newSession: () => actions.newThread(),
  settings: () => toggleSettings(),
  files: () => explorerOn("files"),
  explorer: () => document.getElementById("app")!.classList.contains("files-open") || toggleFiles(false),
  changes: () => explorerOn("changes"),
  agents: () => explorerOn("agents"),
  terminal: () => toggleTerminal(),
  session: () => {
    const t = store.thread && store.summaries.get(store.thread.id);
    return t ? { rename: () => renameSession(t.id), settle: () => actions.settle(t.id, t.settledAt == null), settled: t.settledAt != null } : null;
  },
  sideChat: () => void newSideChat(),
  sideChats: sideChatsToOpen,
  closeSettings,
  closeFile: () => togglePane(),
  closeFiles: () => toggleFiles(false),
  closeTerminal: hideTerminal,
});
if (!sideChat) initSidebar(() => draft.focus());
initTranscript();
if (!sideChat) initTerminal();
initComposer();
if (sideChat) initSide();
else {
  initBackground();
  initSettings();
  initPalette();
  initPanels(() => draft.focus(), () => togglePalette("files"));
}
on("header", renderHeader);
onPhoneChange(() => render("header"));

/** A side chat's frame: files and web links open beside it, in the window around it. */
function initSide() {
  setOpener((ref, cited, keep) => host()?.openCited(ref, cited, keep));
  setAgentOpener((id) => host()?.openAgent(id));
  wireLinks((url, background) => host()?.openWebLink(url, background));
  // A subagent's transcript is read-only: its harness runs it, so there's no composer to write to it with.
  const readOnly = (id: string | null) => document.documentElement.classList.toggle("agent-view", !!id && !!subagentOf(id));
  readOnly(sideSession());
  window.__bismuthSide = { focus: () => draft.focus(), show: (id) => (readOnly(id), adoptSession(id), actions.open(id)) };
  // Never the new-session page: laid out as a session from the start, a spare takes its session without the
  // composer gliding down from the page's middle.
  $("main").classList.remove("new-thread");
  initPhoneFrame();
  // The window's edge peek follows the pointer, which a frame keeps to itself: passed on, as an HTML preview's page does.
  addEventListener("pointermove", (e: PointerEvent) => e.pointerType === "mouse" && parent.postMessage({ bismuthPointer: [e.clientX, e.buttons] }, location.origin), { capture: true, passive: true });
  addEventListener("keyup", forwardKeyUp, true);
}

// ---------------- shortcuts ----------------

/** Step through the sessions and drafts, most recently opened first; ones never opened come last, in the sidebar's order. */
function cycle(step: 1 | -1) {
  if (pickerOpen()) return;
  const at = shownSession();
  const id = sessionWalk.next(at, () => [...recentSessions, ...sessionOrder()], step, (id) => store.summaries.has(id) || !!newDraft(id));
  if (id && id !== at) actions.open(id);
}

bindShortcut("toggleSidebar", () => !settingsOpen() && toggleSidebar());
bindShortcut("toggleRightPane", () => !settingsOpen() && togglePane());
bindShortcut("expandRightPane", () => !settingsOpen() && toggleExpand());
bindShortcut("toggleFiles", () => !settingsOpen() && toggleFiles());
bindShortcut("showChanges", () => !settingsOpen() && showCommit());
bindShortcut("showReview", () => !settingsOpen() && openReview());
bindShortcut("toggleTerminal", () => !settingsOpen() && toggleTerminal());
bindShortcut("newTerminal", () => !settingsOpen() && newTerminal());
bindShortcut("closeTerminal", () => !settingsOpen() && closeTerminal());
bindShortcut("nextTerminal", () => !settingsOpen() && cycleTerminal(1));
bindShortcut("prevTerminal", () => !settingsOpen() && cycleTerminal(-1));
bindShortcut("maximizeTerminal", () => !settingsOpen() && toggleMaximize());
bindShortcut("closeFile", () => !settingsOpen() && closeActiveFile());
bindShortcut("reopenFile", () => !settingsOpen() && reopenClosedFile());
bindShortcut("saveFile", () => !settingsOpen() && saveActiveFile());
bindShortcut("togglePreview", () => !settingsOpen() && togglePreview());
bindShortcut("goBack", () => !settingsOpen() && goBack());
bindShortcut("goForward", () => !settingsOpen() && goForward());
bindShortcut("toggleHiddenFiles", () => !settingsOpen() && toggleHiddenFiles());
bindShortcut("expandFolders", () => !settingsOpen() && void expandFolders());
bindShortcut("collapseFolders", () => !settingsOpen() && collapseFolders());
bindShortcut("revealFile", () => !settingsOpen() && revealActiveFile());
for (let n = 1; n <= 9; n++) bindShortcut(`tab${n}` as `tab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`, () => !settingsOpen() && jumpTab(n));
bindShortcut("removeImage", removeLastImage, () => !settingsOpen() && canRemoveImage());
bindShortcut("stopTurn", stopTurn, () => !settingsOpen() && canStopTurn());
bindShortcut("newBrowserTab", () => !settingsOpen() && openBrowser());
bindShortcut("sideChat", () => !settingsOpen() && void newSideChat());
bindShortcut("previewSession", () => !settingsOpen() && void previewSession());
bindShortcut("toggleWorktree", toggleWorktreeMode, () => !settingsOpen() && canToggleWorktree());
bindShortcut("focusAddress", focusAddress, () => !settingsOpen() && browsing());
bindShortcut("reloadPage", reloadPage, () => !settingsOpen() && browsing());
bindShortcut("newSession", () => actions.newThread());
bindShortcut("newSessionIn", () => togglePalette("projects"));
bindShortcut("quickOpen", () => togglePalette("files"));
bindShortcut("openModelPicker", () => {
  closeSettings();
  togglePicker();
});
// Inside the right panel the same keys step through its tabs (Zeron's cycle_navigation). Both go most recently used first.
bindShortcut("nextSession", () => cycleTabs(1) || cycle(1));
bindShortcut("prevSession", () => cycleTabs(-1) || cycle(-1));
bindShortcut("settleSession", () => {
  if (settingsOpen()) return;
  // On a new session's draft, settling throws the draft away (a fresh one takes its place).
  if (!store.thread && !store.opening) {
    const id = openNewDraft().id;
    if (draftHasContent(id)) discardNewDraft(id), render("sidebar", "header", "composer");
    return;
  }
  const t = store.thread && store.summaries.get(store.thread.id);
  if (t) actions.settle(t.id, t.settledAt == null);
});
// F2 over a file in the tree renames the file.
bindShortcut("renameSession", () => renameHovered() || (store.thread && !settingsOpen() && renameSession(store.thread.id)));
for (let n = 1; n <= 9; n++)
  bindShortcut(`jump${n}` as `jump${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`, () => {
    // Inside Settings the jumps pick its tabs (a number past the last tab does nothing).
    if (settingsOpen()) return void selectSettingsTab(n - 1);
    // Like Zeron, not under an open picker: it would be left over a session the user never chose.
    const id = pickerOpen() ? null : jumpOrder()[n - 1];
    if (id) actions.open(id);
  });

addEventListener("keydown", (e: KeyboardEvent) => {
  // In a side chat's frame, the app's shortcuts act in the window around it.
  if (sideChat && forwardKey(e)) return;
  const combo = comboFromEvent(e);
  // Mod+W never reaches the window's menu, where it would close bismuth (and the sessions with it).
  if (combo === "mod-w") e.preventDefault();
  // A shell's own keys (Ctrl+W, Ctrl+H, Ctrl+R) stay the shell's while a terminal has focus.
  if (combo && shellKeeps(combo) && keyContext.terminal()) return;
  // In a focused terminal its own shortcuts come first, even over the fixed Mod+K and Mod+, below.
  const scoped = combo && keyContext.terminal() ? shortcutFor(combo) : undefined;
  if (scoped && TERMINAL_SCOPED.has(scoped) && dispatchShortcut(e)) return;
  // Fixed, like Zeron: Mod+K opens the command palette (and closes it again).
  if (combo === "mod-k") {
    e.preventDefault();
    togglePalette("commands");
    return;
  }
  // Any other shortcut acts on the app behind the palette, so the palette steps aside first (New session in… and
  // Go to file are the palette's own).
  if (paletteOpen() && combo && combo !== prefs.keymap.newSessionIn && combo !== prefs.keymap.quickOpen && (combo === "mod-," || SHORTCUTS.some((s) => prefs.keymap[s] === combo))) closePalette();
  if (dispatchShortcut(e)) return;
  // Fixed, like Zeron's app menu: Mod+, opens Settings (and closes it again).
  if (combo === "mod-,") {
    e.preventDefault();
    toggleSettings();
    return;
  }
  // Fixed, like Mod+,: Mod+F searches Settings while it's open (a terminal keeps it: it's readline's forward-char).
  if (combo === "mod-f" && settingsOpen() && !keyContext.terminal()) {
    e.preventDefault();
    focusSettingsSearch();
    return;
  }
  // In a terminal Alt+arrows move by word: they stay the shell's.
  if ((e.target as Element).closest?.(".terminal-drawer")) return;
  if (e.altKey && e.key === "ArrowLeft") actions.back();
  else if (e.altKey && e.key === "ArrowRight") actions.forward();
  else typeIntoComposer(e);
});

/** Something open that takes the keys (or text the user selected) while focus is on the page itself. */
const composerBlocked = () =>
  getSelection()?.isCollapsed === false || paletteOpen() || pickerOpen() || settingsOpen() || renaming() || !!document.querySelector(".card:not(.question):not(.picker):not(.ring-tip), .s-scrim, .lightbox");
const focusNowhere = () => !document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement;

/** The composer keeps focus, like a terminal's prompt: a mouse click that leaves focus nowhere useful (the page, a
 *  button, the transcript without selecting anything) hands it straight back, caret and all. Fields, the terminal,
 *  menus, dialogs and selected text keep theirs; keyboard activation (Tab, Enter on a button) is left alone. */
addEventListener("click", (e: MouseEvent) => {
  if (e.detail === 0) return;
  // After the click's own handlers: one that opens a menu or a field has already moved focus there.
  requestAnimationFrame(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && (active.isContentEditable || active.closest("input, textarea, select, .card, [role=dialog], .terminal-drawer, .rp, .fp"))) return;
    if (composerBlocked()) return;
    if ((e.target as Element).closest?.(".terminal-drawer, .rp, .fp")) return;
    draft.focus();
  });
});

/** Nor is focus ever left on nothing: whatever drops it there (a field or menu closing, the focused element taken
 *  out of the page, the window coming back) hands it to the composer at once, so Mod+V and Mod+A work without a
 *  key typed first. A press in progress is left to finish (it may be selecting text); its click decides above. */
let pressing = false;
addEventListener("pointerdown", () => (pressing = true), true);
addEventListener("pointerup", () => (pressing = false), true);
addEventListener("pointercancel", () => (pressing = false), true);
let reclaiming = false;
function reclaimFocus() {
  if (reclaiming) return;
  reclaiming = true;
  requestAnimationFrame(() => {
    reclaiming = false;
    if (!pressing && document.hasFocus() && focusNowhere() && !composerBlocked()) draft.focus();
  });
}
addEventListener("focusout", reclaimFocus);
addEventListener("focus", reclaimFocus);
// A focused element taken out of the page leaves focus nowhere without a focusout.
new MutationObserver(() => focusNowhere() && reclaimFocus()).observe(document.body, { childList: true, subtree: true });

/** Typing that would land nowhere (focus on the page, the transcript, a button) goes to the composer instead of
 *  being lost: focusing it during keydown makes the character insert there, and Mod+V or Mod+A act on it. Shortcuts,
 *  fields (rename, search, answers), menus, dialogs and the panels keep their keys, and Mod+C copies the selection. */
function typeIntoComposer(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (e.defaultPrevented || e.isComposing || e.altKey || [...e.key].length !== 1) return;
  const target = e.target as HTMLElement;
  if (target.isContentEditable || target.closest("input, textarea, select, .card, [role=menu], [role=listbox], [role=dialog]")) return;
  if (mod && (target.closest(".rp, .fp") || getSelection()?.isCollapsed === false)) return;
  if (e.key === " " && !mod && target !== document.body) return; // Space presses the focused button
  if (paletteOpen() || pickerOpen() || settingsOpen() || document.querySelector(".s-scrim, .lightbox")) return;
  draft.focus();
}

render("sidebar", "header", "composer", "transcript");
connect();
// A side chat's frame takes the focus only when given it (its tab opened or clicked).
if (!sideChat || document.hasFocus()) draft.focus();
