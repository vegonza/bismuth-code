// The message queue (Zeron's queue.rs), docked above the composer: what was typed while the agent worked, in the
// order it goes out. The core holds the rows (every window sees the same queue) and sends the head when the turn
// ends. Each row: a drag handle (the whole row drags, to reorder), the text, Edit (into the composer, where Enter
// saves and Escape cancels), Remove, and Steer — into the running turn without stopping it, or as the next turn
// when nothing runs. A held queue (Stop, a failed turn, a restart, a message the harness refused) says why above its
// rows, with Resume; the next prompt sent resumes it too.
import type { QueuedMessage, QueuePause, ThreadQueue } from "../shared/model";
import { attachmentName, attachmentUrl, openLightbox, parseUserMessage } from "./attachments";
import { el } from "./dom";
import { icon, type IconName } from "./icons";
import { displayCombo } from "./keymap";
import { workingCombo } from "./prefs";
import { call, store } from "./store";

export type QueueHooks = {
  /** The row this window has in its composer, if any. */
  editing: () => string | null;
  edit: (id: string) => void;
  save: () => void;
  cancel: () => void;
};

const DRAG_THRESHOLD = 4;

export const queueOf = (threadId: string | null | undefined): ThreadQueue | null => (threadId ? (store.queues.get(threadId) ?? null) : null);

let box: HTMLElement;
let hooks: QueueHooks;
let drag: { id: string; from: number; startY: number; over: number; moved: boolean; slot: number } | null = null;
/** Rows whose removal or steer is on its way to the core: shown dimmed and inert until the queue comes back. */
const pending = new Set<string>();
let error: string | null = null;
let errorTimer: ReturnType<typeof setTimeout> | undefined;
let shown = "";

/** Show why a queue action didn't go through, under the rows for a few seconds. */
export function failed(err: unknown) {
  error = String((err as Error)?.message ?? err);
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    error = null;
    renderQueue();
  }, 6000);
  renderQueue(true);
}

/** Run a row action against the core; the row stays inert until it answers. */
function act(id: string, p: Promise<unknown>) {
  pending.add(id);
  renderQueue(true);
  p.catch(failed).finally(() => {
    pending.delete(id);
    renderQueue(true);
  });
}

const running = () => !!store.thread?.activeTurnId;

/** Steer a row in now (or send it as the next turn when none runs). */
export function steer(id: string) {
  const threadId = store.thread?.id;
  if (!threadId || pending.has(id)) return;
  act(id, call("queue.steer", { threadId, id }));
}

/** The newest row that can go out, for the steer key on an empty composer. False when there's none. */
export function steerLatest(): boolean {
  const q = queueOf(store.thread?.id);
  const last = q?.items[q.items.length - 1];
  if (!last || last.gate || pending.has(last.id)) return false;
  steer(last.id);
  return true;
}

function action(name: IconName, title: string, onclick: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", "q-action");
  b.title = title;
  b.setAttribute("aria-label", title);
  b.disabled = disabled;
  b.append(icon(name));
  b.onpointerdown = (e) => e.stopPropagation(); // a click on an action never starts a drag
  b.onclick = (e) => {
    e.stopPropagation();
    onclick();
  };
  return b;
}

function rowText(item: QueuedMessage): HTMLElement {
  const { text, images } = parseUserMessage(item.text);
  const wrap = el("div", "q-content");
  const line = text.replace(/\s+/g, " ").trim();
  wrap.append(el("span", "q-text", line || (images.length ? `${images.length} image${images.length > 1 ? "s" : ""}` : "")));
  for (const img of images.slice(0, 3)) {
    const thumb = el("img", "q-thumb");
    thumb.src = attachmentUrl(img.path);
    thumb.alt = thumb.title = img.label ?? attachmentName(img.path);
    thumb.onpointerdown = (e) => e.stopPropagation();
    thumb.onclick = (e) => {
      e.stopPropagation();
      openLightbox(attachmentUrl(img.path), attachmentName(img.path));
    };
    wrap.append(thumb);
  }
  if (images.length > 3) wrap.append(el("span", "q-more", `+${images.length - 3}`));
  return wrap;
}

function row(threadId: string, item: QueuedMessage, ix: number, count: number): HTMLElement {
  const mine = hooks.editing() === item.id;
  const busy = pending.has(item.id);
  const r = el("div", `q-row${mine ? " editing" : ""}${busy ? " busy" : ""}`);
  r.dataset.id = item.id;
  const handle = el("span", "q-handle");
  handle.append(icon("gripVertical"));
  r.append(handle);

  if (mine) {
    r.append(el("div", "q-content muted", "Editing in the composer"), action("check", "Save to queue (Enter)", hooks.save), action("x", "Cancel (Escape)", hooks.cancel));
    return r;
  }
  if (item.gate === "editing") {
    r.append(el("div", "q-content muted", "Being edited in another window"));
  } else {
    r.append(rowText(item));
    if (item.gate === "review") {
      const badge = el("span", "q-badge", "Needs review");
      badge.title = "The window editing this went away before saving it. Edit it to send it on, or remove it.";
      r.append(badge);
    }
  }
  const latest = ix === count - 1 ? ` · ${displayCombo(workingCombo("steer"))}` : "";
  const steerTitle = running() ? `Steer (keep current work running)${latest}` : `Send now${latest}`;
  r.append(
    action("pencil", "Edit", () => hooks.edit(item.id), busy || item.gate === "editing" || !!hooks.editing()),
    action("trash2", "Remove", () => act(item.id, call("queue.remove", { threadId, id: item.id })), busy),
    action("arrowRight", steerTitle, () => steer(item.id), busy || !!item.gate),
  );

  // The whole row drags (Zeron's full-row hitbox); rows being edited or on their way out stay put.
  if (!busy && !mine) {
    r.onpointerdown = (e) => {
      if (e.button !== 0) return;
      drag = { id: item.id, from: ix, startY: e.clientY, over: ix, moved: false, slot: r.offsetHeight };
      r.setPointerCapture(e.pointerId);
    };
    r.onpointermove = (e) => drag?.id === item.id && dragMove(e.clientY);
    r.onpointerup = () => {
      if (drag?.id !== item.id) return;
      const d = drag;
      drag = null;
      if (d.moved && d.over !== d.from) {
        // Optimistic: the core's queue comes back in the same order.
        const q = store.queues.get(threadId);
        if (q) q.items.splice(d.over, 0, ...q.items.splice(d.from, 1));
        void call("queue.move", { threadId, id: item.id, index: d.over }).catch(failed);
      }
      renderQueue(true);
    };
    r.onpointercancel = () => {
      drag = null;
      renderQueue(true);
    };
  }
  return r;
}

function dragMove(y: number) {
  if (!drag) return;
  const dy = y - drag.startY;
  if (!drag.moved && Math.abs(dy) < DRAG_THRESHOLD) return;
  drag.moved = true;
  const rows = [...box.querySelectorAll<HTMLElement>(".q-row")];
  drag.over = Math.max(0, Math.min(rows.length - 1, drag.from + Math.round(dy / drag.slot)));
  rows.forEach((r, ix) => {
    if (ix === drag!.from) {
      r.classList.add("dragging");
      r.style.transform = `translateY(${dy}px)`;
      return;
    }
    const { from, over, slot } = drag!;
    const shift = from < over && ix > from && ix <= over ? -slot : from > over && ix < from && ix >= over ? slot : 0;
    r.style.transform = shift ? `translateY(${shift}px)` : "";
  });
}

export function initQueue(container: HTMLElement, h: QueueHooks) {
  box = container;
  hooks = h;
  box.hidden = true;
}

const pausedLabel = (p: QueuePause) =>
  ({
    stop: "Paused after Stop",
    failed: `Paused — the last turn failed${p.message ? `: ${p.message}` : ""}`,
    restart: "Paused — bismuth restarted",
    error: `Paused — couldn't send${p.message ? `: ${p.message}` : ""}`,
  })[p.reason];

/** Redraw when what it shows changed (`force`: local state did). The composer calls it on every render. */
export function renderQueue(force = false) {
  if (!box || drag) return; // a drag in progress keeps its rows; the drop redraws
  const threadId = store.thread?.id ?? null;
  const q = queueOf(threadId);
  const key = JSON.stringify([threadId, q, hooks.editing(), running(), error]);
  if (!force && key === shown) return;
  shown = key;
  if (!threadId || !q || (!q.items.length && !error)) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const children: HTMLElement[] = [];
  if (q.paused && q.items.length) {
    const head = el("div", "q-head");
    const why = el("span", "q-why", pausedLabel(q.paused));
    if (q.paused.message) why.title = q.paused.message;
    head.append(why);
    const resume = el("button", "q-resume", "Resume");
    resume.onclick = () => void call("queue.resume", { threadId }).catch(failed);
    head.append(resume);
    children.push(head);
  }
  children.push(...q.items.map((item, ix) => row(threadId, item, ix, q.items.length)));
  if (error) children.push(el("div", "q-error", error));
  box.replaceChildren(...children);
}
