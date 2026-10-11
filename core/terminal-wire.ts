// What the core and the terminal host (core/terminal-host.ts) say to each other over its socket: one JSON message
// per line.
import type { TerminalInfo } from "../shared/model";

export const HOST_VERSION = 1;

export type HostChunk = { seq: number; data: string } | { seq: number; exit: number };
/** Host → core. */
export type HostMessage =
  | { t: "hello"; version: number; terminals: TerminalInfo[] }
  | { t: "list"; terminals: TerminalInfo[] }
  | { t: "chunk"; id: string; chunk: HostChunk }
  | { t: "res"; req: number; info?: TerminalInfo; error?: string };
/** Core → host. */
export type CoreMessage =
  | { t: "open"; req: number; projectId: string; cwd: string; cols: number; rows: number }
  | { t: "write"; id: string; data: string }
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "close"; id: string }
  | { t: "move"; id: string; index: number }
  | { t: "keep" }
  | { t: "shutdown" };

export const clampSize = (cols: number, rows: number) => ({
  cols: Math.max(2, Math.min(500, Math.trunc(cols) || 80)),
  rows: Math.max(1, Math.min(300, Math.trunc(rows) || 24)),
});
