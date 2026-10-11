// What the core needs from a harness adapter (Codex, Claude Code), plus the item bookkeeping they share.
// Adapters own their processes and thread state and report every change through `onEvent`.
import type {
  HarnessId,
  Item,
  ItemStatus,
  ModelOption,
  RequestResponse,
  Thread,
  ThreadEvent,
  ThreadSummary,
  Turn,
  TurnSettings,
  TurnStatus,
  UsageWindow,
} from "../shared/model";

export interface Harness {
  readonly id: HarnessId;
  readonly name: string;
  /** Called for every normalized change; the server fans these out to clients. */
  onEvent: (threadId: string, event: ThreadEvent) => void;
  /** The harness died; its threads can't run until the core restarts. */
  onExit: (err: Error) => void;
  /** The live account's rate-limit windows, as a running turn reported them (folded into Accounts). */
  onUsage: (windows: UsageWindow[]) => void;

  start(): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  /** Sessions in these project folders (newest first, up to 50 per folder). */
  listThreads(cwds: string[]): Promise<ThreadSummary[]>;
  openThread(threadId: string): Promise<Thread>;
  /** A new session in the project folder `cwd`. */
  newThread(settings: TurnSettings, cwd: string): Promise<Thread>;
  /** Starts a turn, or steers the running one. */
  send(threadId: string, text: string, settings: TurnSettings): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  archive(threadId: string): Promise<void>;
  respond(requestId: string, response: RequestResponse): void;
}

export const UNTITLED = "New thread";

/** A title from a prompt's first non-empty line. */
export const titleFrom = (text: string) => text.trim().split("\n")[0].slice(0, 80);

export function summary(t: Thread): ThreadSummary {
  return { id: t.id, harness: t.harness, title: t.title, updatedAt: t.updatedAt, createdAt: t.createdAt, status: t.status, branch: t.branch, cwd: t.cwd };
}

/** Items a turn left running when it ended: tools cut off by an interrupt or failure, text that stopped streaming. */
export function finalizeItem(item: Item, turnStatus: TurnStatus): Item {
  const status: ItemStatus = turnStatus === "failed" ? "failed" : "interrupted";
  // A completed turn can legitimately leave a command running as a background terminal.
  if (turnStatus !== "completed" && (item.kind === "command" || item.kind === "fileChange" || item.kind === "tool") && item.status === "inProgress") return { ...item, status };
  if ((item.kind === "assistant" || item.kind === "reasoning") && !item.done) return { ...item, done: true };
  return item;
}

/** Insert or replace by id; a completed snapshot wins, a late "started" never regresses one. */
export function mergeItem(turn: Turn, item: Item): Item {
  const idx = turn.items.findIndex((i) => i.id === item.id);
  if (idx < 0) {
    turn.items.push(item);
    return item;
  }
  const prev = turn.items[idx];
  if ("done" in prev && prev.done && "done" in item && !item.done) return prev;
  turn.items[idx] = item;
  return item;
}
