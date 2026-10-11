// Terminals (Zeron's engine/terminals.rs over Bun's PTY): login shells grouped by project instead of by session.
// - The shells live in the terminal host (core/terminal-host.ts), a process of their own, so they keep running
//   through Restart bismuth: the next core connects to the same host and picks them up where they were.
// - Output is batched over 12ms windows, numbered, and kept in a bounded ~1 MB replay (mirrored here from the host),
//   so a viewer attaching (a reloaded UI, a second window) gets the screen back from `afterSeq` and then follows live.
// - A shell outlives its viewers: detaching never closes it, only closing its tab or quitting the app does.
//   Exited shells keep their tab, dimmed, and expire after 30 minutes; at most 32 terminals exist at once.
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { TerminalInfo } from "../shared/model";
import { HOST_VERSION, type CoreMessage, type HostChunk, type HostMessage } from "./terminal-wire";

const MAX_REPLAY_CHARS = 1024 * 1024;
const HOST = join(import.meta.dirname, "terminal-host.ts");
/** How long a host just spawned gets to start listening. */
const SPAWN_WAIT_MS = 5000;

type Mirror<S> = { info: TerminalInfo; replay: HostChunk[]; replayChars: number; viewers: Set<S> };
type Delivery = { type: "terminal.output"; id: string; seq: number; data: string } | { type: "terminal.exit"; id: string; seq: number; code: number };

export class Terminals<S> {
  private live = new Map<string, Mirror<S>>();
  private order: string[] = [];
  private host: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private req = 0;
  private waiting = new Map<number, { resolve: (info: TerminalInfo) => void; reject: (err: Error) => void }>();
  /** The list changed (opened, exited, closed, moved, expired, or picked up from the host). */
  onChanged = () => {};

  /** `socket`: the host's address, one per app (it's how the next core finds the shells). `log`: its stderr. */
  constructor(
    private socket: string,
    private log: string,
    private deliver: (viewer: S, msg: Delivery) => void,
  ) {}

  /** Connect to the host, starting one if none is running. Resolves once its list is in (replays may follow). */
  connect(): Promise<void> {
    return (this.connecting ??= this.reach().finally(() => (this.connecting = null)));
  }

  list(): TerminalInfo[] {
    return this.order.map((id) => this.live.get(id)!.info);
  }

  async open(projectId: string, cwd: string, cols: number, rows: number): Promise<TerminalInfo> {
    if (!this.host) await this.connect();
    const req = ++this.req;
    const answer = new Promise<TerminalInfo>((resolve, reject) => this.waiting.set(req, { resolve, reject }));
    this.tell({ t: "open", req, projectId, cwd, cols, rows });
    return answer;
  }

  /** Stream a terminal to `viewer`: what it hasn't seen of the replay, then live output (until it exits). */
  attach(id: string, viewer: S, afterSeq: number) {
    const t = this.live.get(id);
    if (!t) return;
    for (const c of t.replay) if (c.seq > afterSeq) this.deliver(viewer, message(id, c));
    if (t.info.exitCode === null) t.viewers.add(viewer);
  }

  detach(id: string, viewer: S) {
    this.live.get(id)?.viewers.delete(viewer);
  }

  /** A viewer went away (its socket closed): its shells keep running. */
  detachAll(viewer: S) {
    for (const t of this.live.values()) t.viewers.delete(viewer);
  }

  write(id: string, data: string) {
    this.tell({ t: "write", id, data });
  }

  resize(id: string, cols: number, rows: number) {
    this.tell({ t: "resize", id, cols, rows });
  }

  close(id: string) {
    this.tell({ t: "close", id });
  }

  /** A project removed: its terminals go with it. */
  closeProject(projectId: string) {
    for (const t of this.live.values()) if (t.info.projectId === projectId) this.close(t.info.id);
  }

  /** Move a tab to `index` among its project's tabs. */
  move(id: string, index: number) {
    this.tell({ t: "move", id, index });
  }

  /** The core is exiting to be started again: the shells wait for the next one. */
  keep() {
    this.tell({ t: "keep" });
  }

  /** The core is exiting for good. Dropping the connection without `keep` is what ends the shells (the host sees
   *  it however the core goes), so this needs nothing sent. */
  shutdown() {
    this.host?.destroy();
  }

  private tell(msg: CoreMessage) {
    this.host?.write(JSON.stringify(msg) + "\n");
  }

  private async reach() {
    if (await this.attachHost()) return;
    // None running (or it just went): start one, detached so it outlives this core, and wait for it to listen.
    const log = openSync(this.log, "a");
    spawn(process.execPath, [HOST, this.socket], { detached: true, stdio: ["ignore", log, log] }).unref();
    closeSync(log);
    const until = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < until) {
      await Bun.sleep(40);
      if (await this.attachHost()) return;
    }
    throw new Error("The terminal host didn't start (see .bismuth/terminal-host.log)");
  }

  /** Connect to a running host and take in its hello; false if none listens (or it's another version, now gone). */
  private attachHost(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect(this.socket);
      sock.setEncoding("utf8");
      let hello = false;
      let stale = false;
      let buf = "";
      sock.on("error", () => {
        if (!hello) resolve(false);
      });
      sock.on("data", (data: string) => {
        buf += data;
        for (let i = buf.indexOf("\n"); i >= 0 && !stale; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg: HostMessage;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.t === "hello") {
            if (msg.version !== HOST_VERSION) {
              // Left by an older core: its shells can't be read by this one, so it goes and a new one starts.
              stale = true;
              sock.write(JSON.stringify({ t: "shutdown" } satisfies CoreMessage) + "\n");
              sock.once("close", () => resolve(false));
              return;
            }
            hello = true;
            this.host = sock;
            this.adopt(msg.terminals);
            resolve(true);
          } else this.receive(msg);
        }
      });
      sock.on("close", () => {
        if (this.host !== sock) return;
        // The host died (its shells with it): the tabs go, and the next terminal opened starts a new host.
        this.host = null;
        this.adopt([]);
        for (const w of this.waiting.values()) w.reject(new Error("The terminal host went away"));
        this.waiting.clear();
      });
    });
  }

  private receive(msg: HostMessage) {
    switch (msg.t) {
      case "list":
        return this.adopt(msg.terminals);
      case "chunk":
        return this.chunk(msg.id, msg.chunk);
      case "res": {
        const w = this.waiting.get(msg.req);
        this.waiting.delete(msg.req);
        if (msg.info) w?.resolve(msg.info);
        else w?.reject(new Error(msg.error ?? "Couldn't open a terminal"));
        return;
      }
    }
  }

  /** The host's list: tabs it has that are new here, gone, or changed (exited, renumbered, reordered). */
  private adopt(list: TerminalInfo[]) {
    const ids = new Set(list.map((t) => t.id));
    for (const [id, t] of this.live) if (!ids.has(id)) t.viewers.clear(), this.live.delete(id);
    for (const info of list) {
      const t = this.live.get(info.id);
      if (t) t.info = info;
      else this.live.set(info.id, { info, replay: [], replayChars: 0, viewers: new Set() });
    }
    this.order = list.map((t) => t.id);
    this.onChanged();
  }

  private chunk(id: string, chunk: HostChunk) {
    const t = this.live.get(id);
    if (!t) return;
    t.replay.push(chunk);
    t.replayChars += "data" in chunk ? chunk.data.length : 16;
    while (t.replayChars > MAX_REPLAY_CHARS && t.replay.length > 1) {
      const dropped = t.replay.shift()!;
      t.replayChars -= "data" in dropped ? dropped.data.length : 16;
    }
    const msg = message(id, chunk);
    for (const v of t.viewers) this.deliver(v, msg);
    if ("exit" in chunk) t.viewers.clear();
  }
}

const message = (id: string, c: HostChunk): Delivery =>
  "data" in c ? { type: "terminal.output", id, seq: c.seq, data: c.data } : { type: "terminal.exit", id, seq: c.seq, code: c.exit };
