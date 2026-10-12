// Side chats: sessions branched off another one's context (each harness's own fork) that live as a tab in that
// session's right pane until moved to the sidebar. Kept here: each one's parent, its harness (an unsent Codex fork
// isn't listed, nor is a Claude one after a restart), and the title it goes by, from its own first prompt (a fork
// starts with its parent's prompts, which its harness would title it from).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Forked, HarnessId } from "../shared/model";

type Entry = { parent: string | null; harness: HarnessId; title: string | null; forked?: Forked };

export class SideChats {
  private file: string;
  private entries: Record<string, Entry>;

  constructor(stateDir: string) {
    this.file = join(stateDir, "side-chats.json");
    try {
      this.entries = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.entries = {};
    }
  }

  parent = (id: string) => this.entries[id]?.parent ?? null;
  harness = (id: string) => this.entries[id]?.harness ?? null;
  /** The title a side chat (or one moved to the sidebar) goes by; null for any other session. */
  title = (id: string) => (this.entries[id] ? this.entries[id].title : undefined);
  forked = (id: string) => this.entries[id]?.forked ?? null;
  /** The side chats still in a session's pane. */
  children = (parent: string) => Object.keys(this.entries).filter((id) => this.entries[id].parent === parent);

  add(id: string, parent: string, harness: HarnessId, forked: Forked) {
    this.entries[id] = { parent, harness, title: null, forked };
    this.save();
  }

  /** Its first prompt names it. True when that changed it. */
  named(id: string, title: string): boolean {
    const e = this.entries[id];
    if (!e || e.title || !title) return false;
    e.title = title;
    this.save();
    return true;
  }

  /** Moved to the sidebar: a session of its own, keeping its title. */
  promote(id: string) {
    const e = this.entries[id];
    if (!e?.parent) throw new Error("That isn't a side chat");
    e.parent = null;
    this.save();
  }

  drop(id: string) {
    if (!(id in this.entries)) return;
    delete this.entries[id];
    this.save();
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.entries));
  }
}
