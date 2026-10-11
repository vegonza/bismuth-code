// The terminal host: the process that owns the project terminals' shells, apart from the core so they outlive a
// core restart. The core (core/terminals.ts) spawns it detached and talks to it over a unix socket, one JSON
// message per line. It holds each shell's PTY and replay; the core mirrors the replay and serves the windows.
// - A core connecting gets the list, then every terminal's replay, then live output.
// - The core telling it `keep` before it exits (Restart bismuth) leaves the shells running for the next core, for
//   up to KEEP_MS; any other disconnect (a quit, a crash) ends them, so no shell outlives the app.
// - Kept small and stable: a host left running by an older core is reused while HOST_VERSION matches.
// bun core/terminal-host.ts <socket>
import { existsSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type { TerminalInfo } from "../shared/model";
import { clampSize, HOST_VERSION, type CoreMessage, type HostChunk, type HostMessage } from "./terminal-wire";

const MAX_TERMINALS = 32;
const MAX_REPLAY_CHARS = 1024 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const BATCH_MS = 12;
const EXITED_TTL_MS = 30 * 60_000;
const REAPER_MS = 60_000;
/** How long kept shells wait for the next core. */
const KEEP_MS = 60_000;

type Live = {
  info: TerminalInfo;
  proc: Subprocess;
  decoder: TextDecoder;
  replay: HostChunk[];
  replayChars: number;
  seq: number;
  pending: string;
  flush: Timer | null;
  exitedAt: number | null;
};

/** A login shell for the user: $SHELL, else bash (zsh on macOS). */
const userShell = () => process.env.SHELL?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");

/** The environment without what only makes sense to bismuth itself. */
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("BISMUTH_")) env[k] = v;
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "bismuth" };
}

const live = new Map<string, Live>();
/** Every terminal id in tab order (each project's tabs are its ids in this order). */
let order: string[] = [];
/** The connected core (a new one replaces an old one still hanging on). */
let core: Socket | null = null;
let kept: Timer | null = null;

const list = (): TerminalInfo[] => order.map((id) => live.get(id)!.info);
const send = (msg: HostMessage) => core?.write(JSON.stringify(msg) + "\n");
const changed = () => send({ t: "list", terminals: list() });

function open(projectId: string, cwd: string, cols: number, rows: number): TerminalInfo {
  if (live.size >= MAX_TERMINALS) throw new Error(`Too many open terminals (at most ${MAX_TERMINALS})`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`The project's folder is unavailable: ${cwd}`);
  const shell = userShell();
  const id = randomUUID();
  // Numbered on from the project's highest, like VS Code (back to 1 once it has none).
  const n = Math.max(0, ...list().filter((t) => t.projectId === projectId).map((t) => t.n)) + 1;
  const info: TerminalInfo = { id, projectId, n, shell: basename(shell), cwd, exitCode: null, createdAt: Date.now() };
  const t: Live = { info, proc: null!, decoder: new TextDecoder(), replay: [], replayChars: 0, seq: 0, pending: "", flush: null, exitedAt: null };
  t.proc = Bun.spawn([shell, "-l"], {
    cwd,
    env: shellEnv(),
    terminal: {
      ...clampSize(cols, rows),
      name: "xterm-256color",
      data: (_term, bytes) => {
        t.pending += t.decoder.decode(bytes, { stream: true });
        t.flush ??= setTimeout(() => flush(t), BATCH_MS);
      },
    },
  });
  void t.proc.exited.then((code) => {
    flush(t);
    t.info = { ...t.info, exitCode: code ?? 0 };
    t.exitedAt = Date.now();
    emit(t, { seq: ++t.seq, exit: t.info.exitCode! });
    t.proc.terminal?.close();
    if (live.has(id)) changed();
  });
  live.set(id, t);
  order.push(id);
  changed();
  return info;
}

function close(id: string) {
  const t = live.get(id);
  if (!t) return;
  live.delete(id);
  order = order.filter((x) => x !== id);
  dispose(t);
  changed();
}

/** Move a tab to `index` among its project's tabs. */
function move(id: string, index: number) {
  const t = live.get(id);
  if (!t) return;
  const siblings = order.filter((x) => live.get(x)!.info.projectId === t.info.projectId);
  const from = siblings.indexOf(id);
  const to = Math.max(0, Math.min(siblings.length - 1, Math.trunc(index)));
  if (from === to) return;
  siblings.splice(from, 1);
  siblings.splice(to, 0, id);
  // The project's slots in the global order keep their places; its ids fill them in the new order.
  let k = 0;
  order = order.map((x) => (live.get(x)!.info.projectId === t.info.projectId ? siblings[k++] : x));
  changed();
}

function flush(t: Live) {
  if (t.flush) clearTimeout(t.flush);
  t.flush = null;
  if (!t.pending) return;
  const data = t.pending;
  t.pending = "";
  emit(t, { seq: ++t.seq, data });
}

function emit(t: Live, chunk: HostChunk) {
  t.replay.push(chunk);
  t.replayChars += "data" in chunk ? chunk.data.length : 16;
  while (t.replayChars > MAX_REPLAY_CHARS && t.replay.length > 1) {
    const dropped = t.replay.shift()!;
    t.replayChars -= "data" in dropped ? dropped.data.length : 16;
  }
  send({ t: "chunk", id: t.info.id, chunk });
}

function dispose(t: Live) {
  if (t.flush) clearTimeout(t.flush);
  // An interactive shell ignores SIGTERM; a hangup ends it and its foreground jobs, like closing a window.
  if (t.exitedAt === null) t.proc.kill("SIGHUP");
  t.proc.terminal?.close();
}

function shutdown(): never {
  for (const t of live.values()) dispose(t);
  rmSync(socketPath, { force: true });
  process.exit(0);
}

function handle(msg: CoreMessage) {
  switch (msg.t) {
    case "open":
      try {
        send({ t: "res", req: msg.req, info: open(msg.projectId, msg.cwd, msg.cols, msg.rows) });
      } catch (err: any) {
        send({ t: "res", req: msg.req, error: String(err?.message ?? err) });
      }
      return;
    case "write": {
      const t = live.get(msg.id);
      if (t && t.exitedAt === null) t.proc.terminal?.write(String(msg.data).slice(0, MAX_INPUT_CHARS));
      return;
    }
    case "resize": {
      const t = live.get(msg.id);
      if (!t || t.exitedAt !== null) return;
      const size = clampSize(msg.cols, msg.rows);
      t.proc.terminal?.resize(size.cols, size.rows);
      return;
    }
    case "close":
      return close(msg.id);
    case "move":
      return move(msg.id, msg.index);
    case "keep":
      keep = true;
      return;
    case "shutdown":
      return shutdown();
  }
}

/** Whether the current core asked for its shells to be kept when it goes. */
let keep = false;

const socketPath = process.argv[2];
if (!socketPath) throw new Error("usage: bun core/terminal-host.ts <socket>");
// A socket file left by a host that died: nothing listens on it any more (the core only spawns a host when
// connecting failed).
rmSync(socketPath, { force: true });

const server = createServer((sock) => {
  core?.destroy();
  core = sock;
  keep = false;
  if (kept) clearTimeout(kept), (kept = null);
  sock.setEncoding("utf8");
  sock.write(JSON.stringify({ t: "hello", version: HOST_VERSION, terminals: list() } satisfies HostMessage) + "\n");
  for (const t of live.values()) for (const chunk of t.replay) sock.write(JSON.stringify({ t: "chunk", id: t.info.id, chunk } satisfies HostMessage) + "\n");
  let buf = "";
  sock.on("data", (data: string) => {
    buf += data;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        handle(JSON.parse(line));
      } catch (err) {
        console.error("[terminal-host]", err);
      }
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (core !== sock) return; // replaced by a newer core
    core = null;
    // Nothing to keep, or the core went without asking (quit, crash): the shells go with it.
    if (!keep || !live.size) shutdown();
    kept = setTimeout(shutdown, KEEP_MS);
  });
});
server.listen(socketPath);

setInterval(() => {
  const now = Date.now();
  for (const t of [...live.values()]) if (t.exitedAt !== null && now - t.exitedAt > EXITED_TTL_MS) close(t.info.id);
}, REAPER_MS);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, shutdown);
