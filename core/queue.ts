// The pending-message queue (Zeron's `queue` on the session doc, crates/doc/src/queue.rs): what was typed while a
// turn ran, held per thread until there's somewhere to put it. The rows can be retyped, reordered and dropped, and
// only the core takes from it (main.ts's drain, at turn end, or an explicit Steer). Kept on disk so a restart doesn't
// lose what was typed; a recovered queue comes back paused, so nothing goes out on its own after one.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueuedMessage, QueuePause, ThreadQueue, TurnSettings } from "../shared/model";

/** A row as the core keeps it: the settings it was queued with (the next turn runs on them), and which window has
 *  it open for editing. */
export type Row = Omit<QueuedMessage, "gate"> & { settings: TurnSettings; gate: { kind: "editing"; owner: string } | { kind: "review" } | null };
type Stored = { items: Row[]; paused: QueuePause | null };

export class MessageQueue {
  private file: string;
  private queues = new Map<string, Stored>();
  /** A thread's queue changed: clients get the new one. `sent`: the row left because it's being sent. */
  onChanged = (_threadId: string, _sent?: Row) => {};

  constructor(stateDir: string) {
    this.file = join(stateDir, "queue.json");
    let saved: Record<string, Stored> = {};
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8")).threads ?? {};
    } catch {}
    for (const [id, q] of Object.entries(saved)) {
      const items = (q.items ?? []).filter((r) => r?.id && r.text?.trim() && r.settings);
      if (!items.length) continue;
      // Whatever ran when the core went down didn't finish the way the user saw it: hold the rest until they say.
      // An edit that was open can't be finished by the window that had it; it waits for review.
      this.queues.set(id, { paused: { reason: "restart", message: null }, items: items.map((r) => ({ ...r, gate: r.gate ? { kind: "review" } : null })) });
    }
  }

  /** A thread's queue as clients see it. */
  get(threadId: string): ThreadQueue {
    const q = this.queues.get(threadId);
    return {
      paused: q?.paused ?? null,
      items: (q?.items ?? []).map(({ settings: _settings, gate, ...r }) => ({ ...r, gate: gate?.kind ?? null })),
    };
  }

  all(): Record<string, ThreadQueue> {
    return Object.fromEntries([...this.queues.keys()].map((id) => [id, this.get(id)]));
  }

  rows(threadId: string): readonly Row[] {
    return this.queues.get(threadId)?.items ?? [];
  }

  /** Why the queue is held, or null when it goes out on its own. */
  pause(threadId: string): QueuePause | null {
    return this.queues.get(threadId)?.paused ?? null;
  }

  /** Append to the back. */
  add(threadId: string, text: string, settings: TurnSettings): Row {
    if (!text.trim()) throw new Error("Nothing to queue");
    const row: Row = { id: randomUUID(), text, queuedAt: Date.now(), editedAt: null, settings, gate: null };
    this.edit(threadId, (q) => q.items.push(row));
    return row;
  }

  /** Remove a row and hand it back, for sending. Null when it's gone, or held by an edit. */
  take(threadId: string, id: string): Row | null {
    const ix = this.index(threadId, id);
    if (ix < 0 || this.rows(threadId)[ix].gate) return null;
    const row = this.rows(threadId)[ix];
    this.edit(threadId, (q) => q.items.splice(ix, 1), row);
    return row;
  }

  /** Put a taken row back at `index` (a send that failed): where it was, not at the back. */
  insert(threadId: string, index: number, row: Row) {
    this.edit(threadId, (q) => q.items.splice(Math.max(0, Math.min(index, q.items.length)), 0, row));
  }

  move(threadId: string, id: string, index: number) {
    const from = this.index(threadId, id);
    if (from < 0) return;
    this.edit(threadId, (q) => {
      const to = Math.max(0, Math.min(index, q.items.length - 1));
      if (to !== from) q.items.splice(to, 0, ...q.items.splice(from, 1));
    });
  }

  /** False when it was already gone (sent, or removed elsewhere). */
  remove(threadId: string, id: string): boolean {
    const ix = this.index(threadId, id);
    if (ix < 0) return false;
    this.edit(threadId, (q) => q.items.splice(ix, 1));
    return true;
  }

  /** Hold the queue (with why), or let it go on (null). */
  setPause(threadId: string, pause: QueuePause | null) {
    const now = this.pause(threadId);
    if (now?.reason === pause?.reason && now?.message === pause?.message) return;
    this.edit(threadId, (q) => (q.paused = pause));
  }

  /** `owner` (a window) takes the row into its composer: it keeps its place but can't be sent meanwhile. A row
   *  another open window is editing is refused; one waiting for review can be taken by anyone. */
  beginEdit(threadId: string, id: string, owner: string): Row {
    const row = this.find(threadId, id);
    if (row.gate?.kind === "editing" && row.gate.owner !== owner) throw new Error("This message is being edited in another window");
    this.edit(threadId, () => (row.gate = { kind: "editing", owner }));
    return row;
  }

  /** Finish an edit: `text` replaces the row's (empty drops it), null keeps the old text. Either way it can go out
   *  again. Settings follow the edit, like a fresh queue would. */
  finishEdit(threadId: string, id: string, owner: string, text: string | null, settings: TurnSettings | null) {
    const row = this.find(threadId, id);
    if (row.gate?.kind === "editing" && row.gate.owner !== owner) throw new Error("This message is being edited in another window");
    if (text !== null && !text.trim()) return void this.remove(threadId, id);
    this.edit(threadId, () => {
      if (text !== null && text !== row.text) (row.text = text), (row.editedAt = Date.now());
      if (text !== null && settings) row.settings = settings;
      row.gate = null;
    });
  }

  /** A window went away: edits it had open wait for review instead of becoming sendable. */
  release(owner: string) {
    for (const [threadId, q] of this.queues) {
      const open = q.items.filter((r) => r.gate?.kind === "editing" && r.gate.owner === owner);
      if (open.length) this.edit(threadId, () => open.forEach((r) => (r.gate = { kind: "review" })));
    }
  }

  /** The thread is gone (archived). */
  drop(threadId: string) {
    if (this.queues.has(threadId)) this.edit(threadId, (q) => ((q.items = []), (q.paused = null)));
  }

  private index(threadId: string, id: string) {
    return this.rows(threadId).findIndex((r) => r.id === id);
  }

  private find(threadId: string, id: string): Row {
    const row = this.rows(threadId).find((r) => r.id === id);
    if (!row) throw new Error("That message was already sent or removed");
    return row;
  }

  private edit(threadId: string, fn: (q: Stored) => void, sent?: Row) {
    let q = this.queues.get(threadId);
    if (!q) this.queues.set(threadId, (q = { items: [], paused: null }));
    fn(q);
    // An emptied queue is forgotten, unless it's paused: what's queued next still waits for the user.
    if (!q.items.length && !q.paused) this.queues.delete(threadId);
    this.save();
    this.onChanged(threadId, sent);
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ threads: Object.fromEntries(this.queues) }, null, 2));
    renameSync(tmp, this.file);
  }
}
