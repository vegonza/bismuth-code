// Settlement (t3code's ThreadSettlementService, lean): a session is active until it settles — explicitly (Settle)
// or on its own after AUTO_SETTLE_MS without activity. Settled sessions leave the active list for the Settled
// shelf; nothing is deleted. Un-settle pins a session active until its next turn; a new turn wakes a settled one.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadStatus } from "../shared/model";

/** t3code's default `sidebarAutoSettleAfterDays`. */
const AUTO_SETTLE_MS = 3 * 24 * 60 * 60_000;

type Entry = { override: "settled" | "active" | null; settledAt: number | null; unsettledAt: number | null };

export class Settlement {
  private file: string;
  private entries: Record<string, Entry>;

  constructor(stateDir: string) {
    this.file = join(stateDir, "settled.json");
    try {
      this.entries = JSON.parse(readFileSync(this.file, "utf8")).threads ?? {};
    } catch {
      this.entries = {};
    }
  }

  /** When a session settled, or null while it's active. Idle sessions settle at the time their work ended;
   *  `settleBefore` (its project's) settles everything last active before it. */
  settledAt(t: { id: string; status: ThreadStatus; updatedAt: number }, settleBefore: number | null = null): number | null {
    const e = this.entries[t.id];
    if (e?.override === "settled") return e.settledAt ?? t.updatedAt;
    if (e?.override === "active") return null;
    // Live work, or a question waiting on you, never settles on its own.
    if (t.status === "running" || t.status === "waiting") return null;
    return t.updatedAt < Math.max(Date.now() - AUTO_SETTLE_MS, settleBefore ?? 0) ? t.updatedAt : null;
  }

  /** Settle all: explicit "keep active" choices in these sessions give way too. */
  clearActive(ids: string[]) {
    let changed = false;
    for (const id of ids)
      if (this.entries[id]?.override === "active") {
        this.entries[id] = { ...this.entries[id], override: null };
        changed = true;
      }
    if (changed) this.save();
  }

  /** Settle, or un-settle (which holds it active until its next turn). Returns the new settledAt. */
  set(id: string, settled: boolean): number | null {
    const now = Date.now();
    this.entries[id] = settled ? { override: "settled", settledAt: now, unsettledAt: null } : { override: "active", settledAt: null, unsettledAt: now };
    this.save();
    return settled ? now : null;
  }

  /** A new turn: an explicit choice gives way to activity (a settled session wakes). True when that changed it. */
  activity(id: string): boolean {
    const e = this.entries[id];
    if (!e || e.override === null) return false;
    this.entries[id] = { override: null, settledAt: null, unsettledAt: e.override === "settled" ? Date.now() : e.unsettledAt };
    this.save();
    return true;
  }

  private save() {
    writeFileSync(this.file, JSON.stringify({ threads: this.entries }, null, 2));
  }
}
