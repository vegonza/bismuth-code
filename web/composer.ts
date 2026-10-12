// The dock under the transcript: plan tray, agent questions, the composer (text over a row of controls)
// with the model picker (picker.ts) and the context ring (usage.ts).
import type { TurnSettings } from "../shared/model";
import { ACCEPT, clipboardImages, forgetStaged, onStaged, openLightbox, parseUserMessage, QUEUE_EDIT, restoreStaged, setStagedKey, staged, stagedImages, stagedKey, stageFiles, stageUploaded, takeStaged, uploading, unstage, withAttachments, type Staged } from "./attachments";
import { $, el, miniSpinner } from "./dom";
import { createEditor, fileChip, labelFile, mentionChip, type Editor } from "./editor";
import { questionPanel, type QuestionPanel } from "./questions";
import { icon } from "./icons";
import { animator, EASE_OUT, reducedMotion } from "./motion";
import { closePicker, currentEffort, currentHarness, currentModel, fastOn, initPicker, refreshPicker } from "./picker";
import { getDraft, getDraftCaret, leaveDraft, openNewDraft, setDraft, setDraftCaret, setNewDraftProject } from "./drafts";
import { displayCombo } from "./keymap";
import { openPalette } from "./palette";
import { appCommand, initMentions } from "./mentions";
import { openCitedPath } from "./refs";
import { draftChanged, projectArt } from "./sidebar";
import { prefs, workingCombo, type WorkingSend } from "./prefs";
import { offScreen } from "./phone";
import { failed as queueFailed, initQueue, queueOf, renderQueue, steerLatest } from "./queue";
import { call, net, on, store, targetProject, tildePath } from "./store";
import { sideChat } from "./sidechat";
import { initContext, renderContext } from "./usage";
import { keepHold } from "./transcript";

export { closePicker };

/** A session's box starts at one line (its line box plus the 14px and 4px around it); a new session's at 76px. */
const textFloor = () => (store.thread ? Math.round(parseFloat(getComputedStyle(editor.root).lineHeight) + 18) : 76);

let editor: Editor;
let composer: HTMLElement;
let send: HTMLButtonElement;
let pickerSlot: HTMLElement;
let contextRing: HTMLElement;
let stack: HTMLElement;
let strip: HTMLElement;
/** Whose draft the box holds: the session being opened or shown, or the new session on screen (drafts.ts). */
let draftOwner: string | undefined;
const ownerKey = () => draftOwner ?? openNewDraft().id;
/** A queued message taken into the box (Zeron's queue edit): the session's own draft waits, unsaved over, until
 *  Enter saves it back to the queue or Escape cancels. */
let editing: { threadId: string; id: string } | null = null;
/** An edit being taken or saved: the core hasn't answered yet, so a second click or Enter waits. */
let editBusy = false;

// ---------------- motion ----------------
// Zeron animates the pill's committed height: the layout switches at once while the box glides from the
// height it last painted to the live target, bottom edge pinned, so the controls stay put and only the text
// sweeps with the top edge. Typing flips and auto-grow use the 180ms collapse curve; the new-session ⇄ thread route uses a
// critically damped glide (420ms docking, 470ms returning) that also carries the dock between positions.

const COLLAPSE_MS = 180;
const ROUTE_SNAP_MS = 250; // after switching threads, layout changes snap instead of morphing
/** Critically damped settle, normalised to [0, 1] over the route's duration (twelve time constants). */
const spring = (t: number) => (t >= 1 ? 1 : 1 - (1 + 12 * t) * Math.exp(-12 * t));
const smoothstep = (t: number, a: number, b: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

type Morph = { from: number; start: number; ms: number; curve: (t: number) => number };
let morph: Morph | null = null;
/** How far the text and the thumbnails sat below where the new layout puts them when it changed: the morph eases
 *  them in, so each glides from where it was painted instead of jumping to the new layout's spot. */
let textLag = 0;
let stripLag = 0;
let target = 0; // natural height of the current layout
let shown = 0; // height painted last frame
let snapUntil = 0;
type Route = { start: number; ms: number; dy: number; docking: boolean; chips: HTMLElement[] };
let route: Route | null = null;

const progress = (m: { start: number; ms: number }, now: number) => Math.min(1, (now - m.start) / m.ms);

const tick = animator((now) => {
  let moving = false;
  if (morph) {
    const p = progress(morph, now);
    shown = morph.from + (target - morph.from) * morph.curve(p);
    if (p >= 1) morph = null;
    else moving = true;
  } else shown = target;
  paintHeight();

  if (route) {
    const p = progress(route, now);
    stack.style.transform = p < 1 ? `translateY(${route.dy * (1 - spring(p))}px)` : "";
    // Departing selectors leave early in the trip; arriving ones come in near its end.
    const chipsIn = route.docking ? 1 - smoothstep(p, 0, 0.25) : smoothstep(p, 0.5, 0.95);
    for (const c of route.chips) c.style.opacity = String(chipsIn);
    $("scroller").style.opacity = route.docking ? String(smoothstep(p, 0.2, 0.65)) : "";
    if (p >= 1) {
      for (const c of route.chips) {
        c.style.opacity = "";
        c.classList.remove("leaving");
        if (route.docking) c.hidden = true;
      }
      $("scroller").style.opacity = "";
      route = null;
    } else moving = true;
  }
  return moving;
});

/** The box at the height painted this frame, and what it carries back to where it was. */
function paintHeight() {
  if (morph) composer.style.height = `${shown}px`;
  else composer.style.height = "";
  composer.classList.toggle("morphing", !!morph);
  // The layout is already the target's, pinned to the bottom edge, and the text and thumbnails are carried back to
  // where they were painted, easing in with the height. Text that grew rides the moving top edge (Zeron's
  // anchoring), its lower part, pushed over the controls, clipped; what sits below a change stays put, and a strip
  // appearing or leaving is uncovered or covered by the edge instead of sliding over the text.
  const r = remaining();
  const textD = textLag * r;
  const stripD = stripLag * r;
  strip.style.transform = stripD ? `translateY(${stripD}px)` : "";
  editor.root.style.transform = textD ? `translateY(${textD}px)` : "";
  editor.root.style.clipPath = textD > 0 ? `inset(0 0 ${textD}px 0)` : "";
  if (morph) painted = paintedNow();
  else for (const g of composer.querySelectorAll(".attach-ghost")) g.remove();
}

type Painted = { text: number; strip: number | null };
/** Where the text and thumbnails were last painted, while the box glides: by the time an input event reaches the
 *  composer the layout has already changed under them. */
let painted: Painted = { text: 0, strip: null };
const paintedNow = (): Painted => ({ text: textTop(), strip: strip.hidden ? null : stripTop() });
/** What's on screen now: at rest, the layout (a typed key doesn't move the text within the box); mid-glide, the
 *  last frame. */
const onScreen = () => (morph ? painted : paintedNow());

/** Ease the text and thumbnails from where they were painted (`was`) into the layout the box is gliding to. */
function settleLags(was: Painted) {
  textLag = stripLag = 0;
  paintHeight();
  const r = remaining();
  if (r > 0.01) {
    textLag = (was.text - textTop()) / r;
    stripLag = was.strip == null || strip.hidden ? 0 : (was.strip - stripTop()) / r;
    paintHeight();
  }
}

/** The share of the morph's distance still to go: 1 as it starts, 0 at rest. */
function remaining() {
  if (!morph || Math.abs(target - morph.from) < 0.5) return 0;
  return Math.min(1, Math.max(0, (target - shown) / (target - morph.from)));
}

/** The first line's top within the box, as painted. */
const textTop = () =>
  editor.root.getBoundingClientRect().top + parseFloat(getComputedStyle(editor.root).paddingTop) - editor.root.scrollTop - composer.getBoundingClientRect().top;
/** The thumbnails' top within the box, as painted. */
const stripTop = () => strip.getBoundingClientRect().top + parseFloat(getComputedStyle(strip).paddingTop) - composer.getBoundingClientRect().top;

/** The box's natural height for the current layout (measured without the animated override). */
function naturalHeight() {
  const prev = composer.style.height;
  // Measured at rest: mid-glide the box drops its min-height (.morphing), and the expanded box's content alone is
  // 2px short of it, so typing during a glide would retarget between the two heights on every key.
  const morphing = composer.classList.contains("morphing");
  composer.classList.remove("morphing");
  composer.style.height = "";
  const h = composer.offsetHeight;
  composer.style.height = prev;
  if (morphing) composer.classList.add("morphing");
  return h;
}

/** Retarget the height: morph from what's on screen unless this change should snap. */
function retarget(kind: "morph" | "route") {
  const next = naturalHeight();
  if (Math.abs(next - target) < 0.5 && kind === "morph") return;
  const now = performance.now();
  const snap = reducedMotion() || !shown || (kind === "morph" && now < snapUntil);
  target = next;
  if (snap) {
    morph = null;
    shown = next;
  } else if (kind === "route") {
    morph = { from: shown, start: now, ms: route?.ms ?? 420, curve: spring };
  } else if (!(morph?.curve === spring && progress(morph, now) < 1)) {
    // Each change starts one collapse morph from what's painted, so reversals hand off without a jump;
    // a route glide in flight owns the height and simply tracks the new target.
    morph = { from: shown, start: now, ms: COLLAPSE_MS, curve: EASE_OUT };
  }
  // Paint the starting frame now: waiting for the next tick would flash the new layout's height.
  if (morph) paintHeight();
  tick();
}

// ---------------- composer ----------------

const running = () => !!store.thread?.activeTurnId;
/** What a prompt does while a turn runs: Enter (`mod` false) does what Settings → General says, Ctrl/Cmd+Enter
 *  the other. Null when nothing runs (both just send). A core without queues can only steer. */
function workingSend(mod: boolean): WorkingSend | null {
  if (!running()) return null;
  if (!store.queueSupported) return "steer";
  const enter = prefs.enterWhileWorking;
  return mod ? (enter === "queue" ? "steer" : "queue") : enter;
}

function renderSend() {
  const hasText = !!editor.value().trim() || staged().length > 0;
  composer.classList.toggle("editing-queued", !!editing);
  if (editing) {
    send.replaceChildren(icon("check"));
    send.title = uploading() ? "Attaching…" : hasText ? "Save to queue" : "Remove from queue";
    send.disabled = uploading();
    return;
  }
  const stop = running() && !hasText;
  send.replaceChildren(stop ? el("span", "stop-square") : icon("arrowUp"));
  const how = workingSend(false);
  const other = how && store.queueSupported ? ` · ${displayCombo(workingCombo(how === "queue" ? "steer" : "queue"))} to ${how === "queue" ? "steer" : "queue"}` : "";
  send.title = stop ? `Stop (${displayCombo(prefs.keymap.stopTurn)})` : uploading() ? "Attaching…" : how === "queue" ? `Queue message (sends when this turn ends)${other}` : how === "steer" ? `Steer (send into the running turn now)${other}` : "Send";
  send.disabled = (!stop && !hasText) || (hasText && uploading());
}

// ---------------- attachments ----------------
// Like Zeron, an added image is mentioned where the caret is, as an "Image N" chip, and every attached image shows
// in the AttachmentStrip: 56px rounded thumbnails over the text, a remove button on hover. Deleting a chip only
// drops the mention (the image stays attached); removing a thumbnail drops the image and its chips. A click on
// either opens the full-size view. A refusal (wrong type, too large) shows under the strip for a few seconds.

let attachError: string | null = null;
let errorTimer: ReturnType<typeof setTimeout> | undefined;

function chipFor(s: Staged): HTMLElement {
  const chip = mentionChip(s.label);
  chip.contentEditable = "false";
  chip.dataset.id = s.id;
  chip.classList.toggle("uploading", !s.path);
  chip.onclick = () => openLightbox(s.url, s.name);
  return chip;
}

function fileMention(path: string): HTMLElement {
  const chip = fileChip(path);
  chip.onclick = () => openCitedPath({ path });
  return chip;
}

/** A label in the text as its chip: an attached image's, or a mentioned file's. */
function chipOf(label: string): HTMLElement | null {
  const file = label.startsWith("@") ? labelFile(label) : null;
  if (file) return fileMention(file);
  const s = staged().find((x) => x.label === label);
  return s ? chipFor(s) : null;
}

/** The draft's text with its labels as chips again (a draft coming back, a session switched to), the caret
 *  where it was left (the end by default). */
const loadDraft = (text: string, caret?: number) => editor.set(text, chipOf, caret);

/** Stage files and mention each image taken at the caret. */
function attachFiles(files: Iterable<File>) {
  const added = stageFiles(files);
  if (added.length) editor.insertChips(added.map(chipFor));
}

function renderStrip() {
  // Chips follow their image: uploading dims them, a removed image (or a failed upload) takes its chips away, and
  // the images after it renumbered relabel theirs.
  const list = staged();
  let relabelled = false;
  for (const chip of editor.chips()) {
    if (chip.dataset.file) continue;
    const s = list.find((x) => x.id === chip.dataset.id);
    if (!s) {
      chip.remove();
      relabelled = true;
      continue;
    }
    chip.classList.toggle("uploading", !s.path);
    if (chip.dataset.label !== s.label) {
      chip.dataset.label = s.label;
      chip.lastElementChild!.textContent = s.label;
      relabelled = true;
    }
  }
  if (relabelled && !editing) setDraft(ownerKey(), editor.value());

  // Within one draft, an added thumbnail grows in, a removed one fades where it was, and the rest slide to their
  // new places; another draft's (a session switched to) just appear.
  const animate = stripKey === stagedKey() && !reducedMotion();
  stripKey = stagedKey();
  const ids = new Set(list.map((s) => s.id));
  const base = strip.getBoundingClientRect();
  const before = new Map<HTMLElement, DOMRect>();
  if (animate && !strip.hidden) for (const t of tiles.values()) before.set(t, t.getBoundingClientRect());
  const empties = !list.length && !attachError;
  // The last one gone: the strip stays where it was, out of the layout, while the box's top edge comes down over it.
  if (animate && empties && !strip.hidden) {
    const ghost = el("div", "attach-strip attach-ghost");
    const box = composer.getBoundingClientRect();
    const style = getComputedStyle(strip);
    ghost.style.cssText = `left:${base.left - box.left - composer.clientLeft}px;width:${base.width}px;bottom:${box.bottom - base.bottom - composer.clientTop}px;padding:${style.padding}`;
    ghost.append(...strip.querySelectorAll(":scope > :not(.leaving)"));
    composer.append(ghost);
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: COLLAPSE_MS, easing: "ease-out", fill: "forwards" }).onfinish = () => ghost.remove();
  }
  const leaving: HTMLElement[] = [...strip.querySelectorAll<HTMLElement>(":scope > .leaving")];
  for (const [id, t] of tiles) {
    if (ids.has(id)) continue;
    tiles.delete(id);
    const was = before.get(t);
    if (!was || empties) continue;
    t.classList.add("leaving");
    t.style.left = `${was.left - base.left}px`;
    t.style.top = `${was.top - base.top}px`;
    leaving.push(t);
    t.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.8)" }], { duration: 150, easing: "ease-out", fill: "forwards" }).onfinish = () => t.remove();
  }
  const kept = list.map(tileFor);
  strip.replaceChildren(...kept, ...(attachError ? [el("div", "attach-error", attachError)] : []), ...(empties ? [] : leaving));
  strip.hidden = empties;
  composer.classList.toggle("has-strip", !strip.hidden);
  if (!animate || strip.hidden) return;
  const now = strip.getBoundingClientRect();
  for (const t of kept) {
    const was = before.get(t);
    if (!was) {
      t.animate([{ opacity: 0, transform: "scale(0.8)" }, { opacity: 1, transform: "none" }], { duration: COLLAPSE_MS, easing: "ease-out" });
      continue;
    }
    const at = t.getBoundingClientRect();
    const dx = was.left - base.left - (at.left - now.left);
    const dy = was.top - base.top - (at.top - now.top);
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) t.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: COLLAPSE_MS, easing: "ease-out" });
  }
}

/** The thumbnails on screen, by image, kept across redraws (a finished upload) so they never reload or restart a
 *  motion. */
const tiles = new Map<string, HTMLElement>();
/** Whose images the strip shows. */
let stripKey: string | null = null;

function tileFor(s: Staged): HTMLElement {
  let tile = tiles.get(s.id);
  if (!tile) {
    tile = el("div", "attach-tile");
    const img = el("img");
    img.src = s.url;
    img.alt = s.name;
    tile.append(img);
    tile.onclick = () => openLightbox(s.url, s.name);
    const remove = el("button", "attach-remove");
    remove.title = `Remove ${s.name}`;
    remove.append(icon("x"));
    remove.onclick = (e) => {
      e.stopPropagation();
      unstage(s.id);
      editor.focus();
    };
    tile.append(remove);
    tiles.set(s.id, tile);
  }
  tile.title = s.name;
  tile.classList.toggle("uploading", !s.path);
  const spinner = tile.querySelector(".mspin");
  if (s.path) spinner?.remove();
  else if (!spinner) tile.append(miniSpinner());
  return tile;
}

function stagedChanged() {
  const was = onScreen();
  renderStrip();
  if (!editing) draftChanged(ownerKey());
  measure("morph", was);
  renderSend();
}

function attachFailed(message: string) {
  attachError = message;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    attachError = null;
    stagedChanged();
  }, 6000);
  stagedChanged();
}

/** The whole conversation takes dropped images (Zeron's chat dropzone), with a "Drop to attach" veil. */
function dropZone(main: HTMLElement) {
  const veil = el("div", "drop-veil", "Drop to attach");
  veil.hidden = true;
  main.append(veil);
  let depth = 0;
  const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  main.addEventListener("dragenter", (e) => {
    if (!files(e)) return;
    e.preventDefault();
    depth++;
    veil.hidden = false;
  });
  main.addEventListener("dragover", (e) => {
    if (!files(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  });
  main.addEventListener("dragleave", (e) => {
    if (!files(e)) return;
    if (--depth <= 0) (depth = 0), (veil.hidden = true);
  });
  main.addEventListener("drop", (e) => {
    if (!files(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    editor.focus();
    attachFiles(e.dataTransfer!.files);
  });
}

/** The picker's width with its model and effort labels showing, kept from the last time they were. */
let fullPickerW = 0;
/** When the controls' row can't fit a labelled picker, the picker shows only the harness icon (its tooltip still
 *  names the model). Judged on the labelled width, so hiding doesn't undo it. */
function fitPicker() {
  const narrow = composer.classList.contains("narrow");
  if (!narrow) fullPickerW = pickerSlot.offsetWidth;
  const room = composer.clientWidth - 24 - 28 - (fullPickerW + 8) - contextRing.offsetWidth - 28;
  composer.classList.toggle("narrow", room < (narrow ? 16 : 0));
}

/** `was`: where the text and thumbnails were on screen before the change, when the caller changed the layout
 *  before calling (the strip). */
function measure(kind: "morph" | "route" = "morph", was: Painted = onScreen()) {
  fitPicker();
  // Grow with content up to the cap, from one line in a session (a new session's box starts taller).
  composer.classList.toggle("roomy", !store.thread);
  const box = editor.root;
  box.style.height = "auto";
  box.style.height = `${Math.min(260, Math.max(textFloor(), box.scrollHeight))}px`;
  retarget(kind);
  // The strip moves the text down: everything starts where it was and eases into the new layout over the morph.
  if (morph) settleLags(was);
}

const turnSettings = (): TurnSettings => {
  const m = currentModel();
  return { harness: m?.harness ?? currentHarness(), model: m?.id ?? null, effort: currentEffort(m), serviceTier: fastOn(m) ? m!.fastTier : null };
};

/** `key`: Enter, which never stops a run (Zeron #406: a stray Enter right after sending stopped the turn it had just
 *  queued behind); the Stop button and the Stop generation shortcut do. */
function submit(key = false, mod = false) {
  // Another session is loading: the one still on screen isn't where the user means to send (the draft waits).
  if (store.opening && store.opening !== store.thread?.id) return;
  if (editing) return void finishEdit(true);
  const typed = editor.value().trim();
  if (!typed && !staged().length) {
    if (running() && !key) net.send({ type: "interrupt", threadId: store.thread!.id });
    return;
  }
  // Images still uploading hold the send (the button shows it); they take a moment at most.
  if (uploading()) return;
  const app = staged().length ? null : appCommand(typed);
  if (app) {
    loadDraft("");
    setDraft(ownerKey(), "");
    draftChanged(ownerKey());
    renderSend();
    return app(turnSettings());
  }
  // A new session needs somewhere to run: with no project yet, adding one comes first (the draft waits).
  const project = store.thread ? null : targetProject();
  if (!store.thread && !project) return openPalette("folders");
  const text = withAttachments(typed, takeStaged());
  // A command waits for the running turn to end rather than cut into it.
  const how = workingSend(mod);
  if (store.thread && (how === "queue" || (how && store.queueSupported && /^\/(compact|goal)(\s|$)/.test(typed)))) net.send({ type: "queue.add", threadId: store.thread.id, text, settings: turnSettings() });
  else net.send({ type: "send", threadId: store.thread?.id ?? null, projectId: project?.id ?? null, text, settings: turnSettings() });
  loadDraft("");
  setDraft(ownerKey(), "");
  draftChanged(ownerKey());
  measure();
  renderSend();
}

// ---------------- editing a queued message ----------------

async function beginEdit(id: string) {
  const threadId = store.thread?.id;
  if (!threadId || editing || editBusy || draftOwner !== threadId) return;
  let text: string;
  editBusy = true;
  try {
    ({ text } = await call("queue.edit.begin", { threadId, id }));
  } catch (err) {
    return queueFailed(err);
  } finally {
    editBusy = false;
  }
  // Moved on (or started another edit) while the core answered: give the row back.
  if (editing || draftOwner !== threadId) return void call("queue.edit.finish", { threadId, id, text: null, settings: null }).catch(() => {});
  setDraftCaret(threadId, editor.caret());
  editing = { threadId, id };
  const parsed = parseUserMessage(text);
  setStagedKey(QUEUE_EDIT + id);
  restoreStaged(QUEUE_EDIT + id, parsed.images);
  loadDraft(parsed.text);
  stagedChanged();
  renderQueue(true);
  editor.focus();
}

/** Save the box back to its row (empty removes it), or cancel and keep the row as it was. */
async function finishEdit(save: boolean) {
  if (!editing || editBusy) return;
  const { threadId, id } = editing;
  if (save) {
    if (uploading()) return;
    const text = withAttachments(editor.value().trim(), stagedImages());
    const settings = turnSettings();
    editBusy = true;
    try {
      // Removed meanwhile (another window): what was typed still goes in the queue, as a new row.
      if (!queueOf(threadId)?.items.some((r) => r.id === id)) {
        if (text) net.send({ type: "queue.add", threadId, text, settings });
      } else await call("queue.edit.finish", { threadId, id, text, settings });
    } catch (err) {
      return queueFailed(err); // the edit stays open: nothing typed is lost
    } finally {
      editBusy = false;
    }
  } else void call("queue.edit.finish", { threadId, id, text: null, settings: null }).catch(() => {});
  if (editing?.id === id) endEdit();
}

/** Back to the session's own draft. */
function endEdit() {
  if (!editing) return;
  const key = QUEUE_EDIT + editing.id;
  editing = null;
  setStagedKey(ownerKey());
  forgetStaged(key);
  loadDraft(getDraft(ownerKey()), getDraftCaret(ownerKey()));
  stagedChanged();
  renderQueue(true);
}

/** Shift+Backspace's image: the newest one attached. Only from the box, or with nothing else focused that edits
 *  text (anywhere else the key keeps its usual meaning). */
export function canRemoveImage() {
  const at = document.activeElement;
  const typing = at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || (at instanceof HTMLElement && at.isContentEditable);
  return staged().length > 0 && (!typing || editor.root.contains(at));
}
export function removeLastImage() {
  const list = staged();
  if (list.length) unstage(list[list.length - 1].id);
}

export const canStopTurn = running;
export function stopTurn() {
  net.send({ type: "interrupt", threadId: store.thread!.id });
}

export const draft = {
  get: () => editor.value(),
  set(text: string) {
    loadDraft(text);
    setDraft(ownerKey(), text);
    draftChanged(ownerKey());
    measure();
    renderSend();
  },
  // While the agent asks something, its panel is where typing goes.
  focus: () => (panel ? panel.focus() : editor.focus()),
};

/** The open question (Zeron's wizard), standing in for the composer until it's answered. */
let panel: QuestionPanel | null = null;

// ---------------- tray + questions ----------------

function renderTray(box: HTMLElement) {
  const plan = store.thread?.plan;
  box.hidden = !plan?.length;
  if (!plan?.length) return;
  const done = plan.filter((s) => s.status === "completed").length;
  box.replaceChildren(
    el("div", "tray-title", `Plan · ${done}/${plan.length}`),
    ...plan.map((s) => {
      const step = el("div", `step ${s.status}`);
      const mark = el("span", "mark");
      if (s.status === "completed") mark.append(icon("check"));
      else if (s.status === "inProgress") mark.append(icon("chevronRight"));
      else mark.append(el("span", "ring"));
      step.append(mark, el("span", "", s.step));
      return step;
    }),
  );
}

// ---------------- mount ----------------

function chip(name: "folder" | "monitor" | "gitBranch", text: string): HTMLElement {
  const c = el("span", "chip");
  c.append(icon(name), el("span", "", text));
  return c;
}

/** The project a new session starts in; picking another opens the New session palette (Ctrl+O). */
function projectChip(): HTMLElement {
  const p = targetProject();
  const c = el("button", "chip pick");
  c.title = p ? `${tildePath(p.path)} · change with ${displayCombo(prefs.keymap.newSessionIn)}` : "Add a project";
  c.append(p ? projectArt(p) : icon("folderPlus"), el("span", "", p?.name ?? "Add project"), icon("chevronDown", undefined, "caret"));
  c.onclick = () => openPalette(p ? "projects" : "folders");
  return c;
}

export function initComposer() {
  const dock = $("dock");
  stack = el("div", "stack");
  const questions = el("div");
  const tray = el("div", "tray");
  const top = el("div", "selector-row top");
  const bottom = el("div", "selector-row bottom");

  composer = el("div", "composer");
  const attach = el("button", "attach");
  attach.title = "Attach images";
  attach.append(icon("plus"));
  const picker = el("input");
  picker.type = "file";
  picker.accept = ACCEPT;
  picker.multiple = true;
  picker.hidden = true;
  picker.onchange = () => {
    editor.focus();
    if (picker.files) attachFiles(picker.files);
    picker.value = "";
  };
  attach.onclick = () => picker.click();
  strip = el("div", "attach-strip");
  strip.hidden = true;
  editor = createEditor("Do anything…");
  pickerSlot = el("div", "picker-slot");
  initPicker(pickerSlot, () => editor.focus());
  initMentions(editor, composer, fileMention, turnSettings);
  contextRing = initContext();
  send = el("button", "send");
  send.onclick = () => submit();
  composer.append(strip, attach, picker, editor.root, pickerSlot, contextRing, send);
  onStaged(stagedChanged, attachFailed);
  dropZone($("main"));
  composer.onclick = (e) => {
    if (e.target === composer) editor.focus();
  };

  const queueBox = el("div", "tray queue");
  initQueue(queueBox, {
    editing: () => editing?.id ?? null,
    edit: (id) => void beginEdit(id),
    save: () => void finishEdit(true),
    cancel: () => void finishEdit(false),
  });

  stack.append(questions, tray, top, queueBox, composer, bottom);
  dock.replaceChildren(stack);

  // The caret of the draft on screen survives reloads and restarts too.
  addEventListener("pagehide", () => draftOwner !== undefined && !editing && setDraftCaret(draftOwner, editor.caret()));
  editor.root.addEventListener("input", () => {
    if (!editing) setDraft(ownerKey(), editor.value()), draftChanged(ownerKey());
    measure();
    renderSend();
  });
  // A pasted image (a screenshot) attaches at the caret; pasted text still goes in as text. A copied message
  // brings its images back: they're staged again and its "Image N"s are their chips (numbered after the draft's own).
  editor.root.addEventListener("paste", (e) => {
    const copied = clipboardImages(e.clipboardData!);
    if (copied?.length) {
      e.preventDefault();
      const taken = stageUploaded(copied);
      const byLabel = new Map(copied.map((img, i) => [img.label, taken[i]]));
      editor.insert(e.clipboardData!.getData("text/plain"), (label) => {
        const s = byLabel.get(label);
        return s ? chipFor(s) : label.startsWith("@") ? chipOf(label) : null;
      });
      return;
    }
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    if (!e.clipboardData!.getData("text/plain")) e.preventDefault();
    attachFiles(images);
  });
  // A touch keyboard's Enter is its only way to a new line (there's no Shift): there the send button sends.
  const touchKeys = matchMedia("(hover: none) and (pointer: coarse)");
  editor.root.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !(touchKeys.matches && !e.ctrlKey && !e.metaKey)) {
      e.preventDefault();
      const mod = e.ctrlKey || e.metaKey;
      // The steer key on an empty box steers the newest queued message in (Zeron's modified submit).
      if (workingCombo("steer") === (mod ? "mod-enter" : "enter") && !editing && !editor.value().trim() && !staged().length) steerLatest();
      else submit(true, mod);
    } else if (e.key === "Escape" && editing) {
      e.preventDefault();
      e.stopPropagation();
      void finishEdit(false);
    }
  });

  // The pill's room for text changes with the box and with what sits beside it (a model label rolling to
  // another name, the context ring appearing), so a draft near the edge re-checks whether it still fits.
  let lastWidths = "";
  const room = new ResizeObserver(() => {
    const widths = `${composer.clientWidth}:${pickerSlot.offsetWidth}:${contextRing.offsetWidth}`;
    if (widths !== lastWidths) (lastWidths = widths), measure();
  });
  for (const e of [composer, pickerSlot, contextRing]) room.observe(e);
  // Keep the transcript's tail clear of the floating dock (Zeron: the stack's height plus the 24px fade band
  // and 8px). The transcript's scroll keeper sees it resize: pinned to the bottom, its last message rides above the
  // box; scrolled up, it keeps its position.
  let clearance = 0;
  new ResizeObserver(() => {
    const next = dock.offsetHeight + 32;
    if (Math.abs(next - clearance) < 0.5) return;
    clearance = next;
    $("main").style.setProperty("--bottom-clearance", `${next}px`);
    // In this frame, not the observer's next one.
    keepHold();
  }).observe(dock);

  let wasNew: boolean | null = null;
  let threadId: string | null = null;
  on("composer", () => {
    // A side chat's frame has no new-session page: until its session is asked for, the composer holds no draft (the
    // window's own new-session one would be taken as left behind).
    if (sideChat && !store.opening && !store.thread) return;
    // Each session keeps its own draft: moving to another (from the moment it's asked for) swaps in that one's,
    // and what was typed here stays here.
    const owner = store.opening ?? store.thread?.id ?? openNewDraft().id;
    if (owner !== draftOwner) {
      // Leaving the session gives an open edit back to its queue unchanged.
      if (editing) {
        const { threadId, id } = editing;
        void call("queue.edit.finish", { threadId, id, text: null, settings: null }).catch(() => {});
        forgetStaged(QUEUE_EDIT + id);
        editing = null;
      } else if (draftOwner !== undefined) setDraftCaret(draftOwner, editor.caret());
      if (draftOwner !== undefined) leaveDraft(draftOwner);
      draftOwner = owner;
      setStagedKey(owner ?? "");
      loadDraft(getDraft(owner), getDraftCaret(owner));
      renderStrip();
    }
    const newThread = !store.thread;
    // Until the first screen is up (window.__bismuthReady), the layout is still settling from boot or a
    // reload restoring its thread: snap rather than glide. So does a phone's screen out of sight (phone.ts offScreen),
    // which comes over the list already settled.
    const routeChange = !!window.__bismuthReady && wasNew !== null && wasNew !== newThread && !offScreen();
    if ((store.thread?.id ?? null) !== threadId) {
      threadId = store.thread?.id ?? null;
      if (!routeChange) snapUntil = performance.now() + ROUTE_SNAP_MS;
    }
    // Where the dock sits now, before the layout changes underneath it.
    const before = routeChange ? stack.getBoundingClientRect().bottom : 0;
    if (routeChange) {
      closePicker();
      composer.style.height = `${shown}px`;
    }
    wasNew = newThread;
    $("main").classList.toggle("new-thread", newThread);
    if (newThread) {
      // The draft starts its session where the chip says (a first draft may predate any project being picked).
      setNewDraftProject(openNewDraft().id, targetProject()?.id ?? null);
      const branch = targetProject()?.branch;
      top.replaceChildren(projectChip(), chip("monitor", store.device || "This device"));
      bottom.replaceChildren(...(branch ? [chip("gitBranch", branch)] : []));
    }
    const chips = [top, bottom];
    if (routeChange && !reducedMotion()) {
      // Departing selectors float out of the layout and fade while the dock travels.
      for (const c of chips) {
        c.hidden = false;
        c.classList.toggle("leaving", !newThread);
        c.style.opacity = newThread ? "0" : "1";
      }
      route = { start: performance.now(), ms: newThread ? 470 : 420, dy: before - stack.getBoundingClientRect().bottom, docking: !newThread, chips };
      stack.style.transform = `translateY(${route.dy}px)`;
      if (route.docking) $("scroller").style.opacity = "0";
    } else if (!route) for (const c of chips) c.hidden = !newThread;
    renderTray(tray);
    // The first open request gets the panel (others wait their turn); it's rebuilt only for a new request, so
    // picks and typed answers survive re-renders. While it shows, the composer steps aside.
    const req = store.thread?.requests[0] ?? null;
    if ((req?.id ?? null) !== (panel?.requestId ?? null)) {
      const hadFocus = !!panel?.root.contains(document.activeElement) || document.activeElement === editor.root;
      const threadId = store.thread?.id;
      panel = req && threadId ? questionPanel(req, (response) => net.send({ type: "respond", threadId, requestId: req.id, response })) : null;
      questions.replaceChildren(...(panel ? [panel.root] : []));
      stack.classList.toggle("asking", !!panel);
      if (hadFocus || panel) requestAnimationFrame(() => draft.focus());
    }
    refreshPicker();
    renderQueue();
    renderSend();
    renderContext();
    measure(routeChange ? "route" : "morph");
  });
}
