// The browser agents use: bismuth's own browser tabs (web/browser.ts, each page an Electron <webview>), driven by
// Chrome DevTools MCP (`bismuth-browser`, a built-in server: see mcp.ts). The desktop shell opens Chromium's DevTools
// port (BISMUTH_CDP_PORT); the MCP server never talks to it directly but to this filter, which passes on only the
// browser's pages: bismuth's own window (and anything else of the app's) is never listed, attached to or reachable.
// A page the agent opens or closes is a tab opened or closed in the window, not a window of its own; the browser
// itself can't be closed.
//
// Each session's agent has a browser of its own: its session's tabs. Every run's server names its session (its
// address carries it, signed), a page an agent opens is a tab in its session's panel (shown there or not), and the
// window tells which session holds each page (`owners`), so an agent sees, and can reach, only its session's pages. A
// new Codex session is started before it has an id: its key is linked to the id once it has one (`alias`).
//
// Which targets are the browser's: the <webview>s (the only ones the app makes, all in the browser's partition), and
// what's in their browser context (a page's frames and workers). Pages are shown to the MCP server as Chrome's tabs
// are; the rest only inside a page it holds.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpDef } from "./mcp";

export const BROWSER_SERVER = "bismuth-browser";
const MCP_BIN = join(import.meta.dir, "..", "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js");

/** What the window does for a session's agent: a tab opened in the session (resolving to its page's target), one of
 *  its pages' tabs closed or shown. */
export type BrowserWindowOps = {
  open(session: string, url: string): Promise<string>;
  close(session: string, targetId: string): Promise<void>;
  show(session: string, targetId: string): Promise<void>;
  /** The pages agents hold now: kept awake (rendering, laid out) wherever their tabs are, so they can be driven. */
  awake(targets: string[]): void;
};

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };
type TargetInfo = { targetId: string; type: string; browserContextId?: string; [k: string]: unknown };

/** Methods never passed on: the browser and its contexts are the app's. */
const REFUSED = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Target.createBrowserContext", "Target.disposeBrowserContext", "Target.exposeDevToolsProtocol"]);
/** Ids of the filter's own requests upstream, out of the client's range; their answers aren't passed on. */
const OWN_IDS = 2_000_000_000;

/** The MCP server's socket into the filter. */
export type CdpSocket = { send(data: string): unknown; close(code?: number, reason?: string): unknown };

/** A page, as against what's inside one (a <webview> is first listed as a page, before it knows it's one). */
const isPage = (t: TargetInfo) => t.type === "webview" || t.type === "page";

class Link {
  private up: WebSocket | null = null;
  private waiting: string[] = [];
  /** The browser's contexts, learnt from its <webview>s. */
  private contexts = new Set<string>();
  /** Targets the client has been told of, and sessions it holds (to which target). */
  private known = new Set<string>();
  private sessions = new Map<string, string>();
  /** The pages it holds (sessions at the top, not a frame's or a worker's inside one). */
  readonly held = new Map<string, string>();
  /** Requests whose answers are rewritten: by session and id. */
  private asked = new Map<string, string>();
  private ownId = OWN_IDS;
  private closed = false;
  /** The client asked to be attached to new pages as they come: Chromium does it (through their tabs), Electron not
   *  for <webview>s, so the filter does, as the client registers only pages it was attached to that way. */
  private autoAttach = false;
  private attaching = new Set<string>();
  /** Every page of the browser as last listed, the session's or not (another session's may become its). */
  private pages = new Map<string, TargetInfo>();

  constructor(
    private ws: CdpSocket,
    private browser: Browser,
    private key: string,
  ) {}

  /** The session this agent works in. */
  private get session() {
    return this.browser.sessionOf(this.key);
  }

  private mine = (t: TargetInfo) => isPage(t) && this.browser.ownerOf(t.targetId) === this.session;

  async connect(port: number) {
    try {
      const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) })).json()) as { webSocketDebuggerUrl: string };
      if (this.closed) return;
      const up = new WebSocket(version.webSocketDebuggerUrl);
      this.up = up;
      up.onopen = () => {
        for (const m of this.waiting.splice(0)) up.send(m);
      };
      up.onmessage = (e) => this.fromBrowser(JSON.parse(String(e.data)));
      up.onclose = () => this.ws.close();
      up.onerror = () => this.ws.close();
    } catch {
      this.ws.close(1011, "bismuth's browser isn't reachable");
    }
  }

  close() {
    this.closed = true;
    this.up?.close();
    if (this.held.size) this.held.clear(), this.browser.heldChanged();
  }

  private upstream(msg: Msg) {
    const raw = JSON.stringify(msg);
    if (this.up?.readyState === WebSocket.OPEN) this.up.send(raw);
    else this.waiting.push(raw);
  }

  private toClient(msg: Msg) {
    this.ws.send(JSON.stringify(msg));
  }

  private answer(req: Msg, result: object) {
    this.toClient({ id: req.id, ...(req.sessionId ? { sessionId: req.sessionId } : {}), result });
  }

  private refuse(req: Msg, message: string) {
    this.toClient({ id: req.id, ...(req.sessionId ? { sessionId: req.sessionId } : {}), error: { code: -32000, message } });
  }

  // ---------------- client → browser ----------------

  async fromClient(msg: Msg) {
    const { method, params, sessionId } = msg;
    if (!method) return;
    if (sessionId) {
      if (!this.sessions.has(sessionId)) return this.refuse(msg, "Session with given id not found.");
      // A page brought to the front: its tab shown.
      if (method === "Page.bringToFront") {
        await this.browser.ops.show(this.session, this.sessions.get(sessionId)!).catch(() => {});
        return this.answer(msg, {});
      }
      return this.upstream(msg);
    }
    if (REFUSED.has(method)) return this.refuse(msg, `${method} isn't available in bismuth's browser`);
    if (method === "Target.setAutoAttach") this.autoAttach = !!params?.autoAttach;
    try {
      switch (method) {
        // Electron doesn't have it (Puppeteer asks every page whether it's DevTools): none is.
        case "Target.getDevToolsTarget":
          return this.answer(msg, {});
        case "Target.createTarget": {
          const session = this.session;
          const targetId = await this.browser.ops.open(session, String(params?.url || "about:blank"));
          // Its page is the session's from now (the window says so too, but maybe after the page is listed).
          this.browser.setOwners([[targetId, session]]);
          return this.answer(msg, { targetId });
        }
        case "Target.closeTarget":
          if (!this.known.has(params?.targetId)) return this.refuse(msg, "No target with given id found");
          await this.browser.ops.close(this.session, params.targetId);
          return this.answer(msg, { success: true });
        case "Target.activateTarget":
          if (!this.known.has(params?.targetId)) return this.refuse(msg, "No target with given id found");
          await this.browser.ops.show(this.session, params.targetId);
          return this.answer(msg, {});
        case "Target.attachToTarget":
        case "Target.getTargetInfo":
          if (params?.targetId && !this.known.has(params.targetId)) return this.refuse(msg, "No target with given id found");
          break;
      }
    } catch (err: any) {
      return this.refuse(msg, String(err?.message ?? err));
    }
    if (method === "Target.getTargets" || method === "Target.getTargetInfo") this.asked.set(`:${msg.id}`, method);
    this.upstream(msg);
  }

  // ---------------- browser → client ----------------

  /** The browser's, as against the app's: a <webview>, or something in a <webview>'s context. */
  private allowed(t: TargetInfo): boolean {
    if (t.type === "webview" && t.browserContextId) this.contexts.add(t.browserContextId);
    return t.type === "webview" || (!!t.browserContextId && this.contexts.has(t.browserContextId) && t.type !== "browser");
  }

  /** As the client sees it: a <webview> is a page. */
  private shown = (t: TargetInfo): TargetInfo => (t.type === "webview" ? { ...t, type: "page" } : t);

  /** A page of the session's told of, as new, and attached to as a new tab would be (a page an agent opened waits for
   *  this). */
  private announce(t: TargetInfo) {
    this.known.add(t.targetId);
    this.toClient({ method: "Target.targetCreated", params: { targetInfo: this.shown(t) } });
    if (this.autoAttach && !this.attaching.has(t.targetId) && ![...this.held.values()].includes(t.targetId)) {
      this.attaching.add(t.targetId);
      this.upstream({ id: this.ownId++, method: "Target.attachToTarget", params: { targetId: t.targetId, flatten: true } });
    }
  }

  /** A page no longer the session's (its tab went to another session): gone, as far as the client knows. */
  private retract(targetId: string) {
    for (const [sessionId, t] of this.sessions) if (t === targetId) this.upstream({ id: this.ownId++, method: "Target.detachFromTarget", params: { sessionId } });
    this.known.delete(targetId);
    this.toClient({ method: "Target.targetDestroyed", params: { targetId } });
  }

  /** Which session holds which page changed. */
  ownersChanged() {
    for (const t of this.pages.values()) {
      if (this.mine(t) && !this.known.has(t.targetId)) this.announce(t);
      else if (!this.mine(t) && this.known.has(t.targetId)) this.retract(t.targetId);
    }
  }

  private fromBrowser(msg: Msg) {
    if (msg.id !== undefined && msg.id >= OWN_IDS) return;
    if (msg.id !== undefined) return this.response(msg);
    // Events inside a session held: passed on, but a session attached under one (a frame, a worker) is the browser's.
    if (msg.sessionId && !this.sessions.has(msg.sessionId)) return;
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const t = msg.params.targetInfo as TargetInfo;
        // Only pages are listed: frames and workers come attached inside the page they're in.
        if (!this.allowed(t) || !isPage(t)) return;
        this.pages.set(t.targetId, t);
        if (!this.mine(t)) return void (this.known.has(t.targetId) && this.retract(t.targetId));
        // A <webview> is made as a page with no address, then becomes one: the first the client hears of it may be
        // a change, which is its creation as far as it knows.
        if (!this.known.has(t.targetId)) return this.announce(t);
        return this.toClient({ ...msg, params: { targetInfo: this.shown(t) } });
      }
      case "Target.targetDestroyed":
      case "Target.targetCrashed":
        if (msg.method === "Target.targetDestroyed") this.pages.delete(msg.params.targetId), this.attaching.delete(msg.params.targetId);
        if (!this.known.has(msg.params.targetId)) return;
        if (msg.method === "Target.targetDestroyed") this.known.delete(msg.params.targetId);
        return this.toClient(msg);
      case "Target.attachedToTarget": {
        const t = msg.params.targetInfo as TargetInfo;
        // At the top, a page of the session's; inside one, what's in it.
        if (!this.allowed(t) || (!msg.sessionId && !this.mine(t))) {
          // Attached to something not the agent's: let it run on, and let go of it.
          const sessionId = msg.params.sessionId;
          if (msg.params.waitingForDebugger) this.upstream({ id: this.ownId++, method: "Runtime.runIfWaitingForDebugger", sessionId });
          this.upstream({ id: this.ownId++, method: "Target.detachFromTarget", params: { sessionId }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
          return;
        }
        if (!msg.sessionId) this.known.add(t.targetId), this.attaching.delete(t.targetId), this.held.set(msg.params.sessionId, t.targetId), this.browser.heldChanged();
        this.sessions.set(msg.params.sessionId, t.targetId);
        return this.toClient({ ...msg, params: { ...msg.params, targetInfo: this.shown(t) } });
      }
      case "Target.detachedFromTarget":
        if (!this.sessions.delete(msg.params.sessionId)) return;
        if (this.held.delete(msg.params.sessionId)) this.browser.heldChanged();
        return this.toClient(msg);
    }
    this.toClient(msg);
  }

  private response(msg: Msg) {
    if (msg.sessionId && !this.sessions.has(msg.sessionId)) return;
    const key = `${msg.sessionId ?? ""}:${msg.id}`;
    const method = this.asked.get(key);
    if (!method) return this.toClient(msg);
    this.asked.delete(key);
    if (msg.result && method === "Target.getTargets") {
      const infos = msg.result.targetInfos as TargetInfo[];
      // The <webview>s first, so their contexts count for whatever is listed before them.
      for (const t of infos) if (t.type === "webview") this.allowed(t);
      for (const t of infos) if (this.allowed(t) && isPage(t)) this.pages.set(t.targetId, t);
      const mine = infos.filter((t) => this.allowed(t) && this.mine(t));
      for (const t of mine) this.known.add(t.targetId);
      return this.toClient({ ...msg, result: { ...msg.result, targetInfos: mine.map(this.shown) } });
    }
    if (msg.result?.targetInfo) return this.toClient({ ...msg, result: { ...msg.result, targetInfo: this.shown(msg.result.targetInfo) } });
    this.toClient(msg);
  }
}

export class Browser {
  private key: Buffer;
  private links = new Map<CdpSocket, Link>();
  /** The session holding each page (by its target), as the window tells; and new sessions' keys, to their ids. */
  private owners = new Map<string, string>();
  private aliases = new Map<string, string>();

  constructor(
    stateDir: string,
    private port: () => number,
    /** Chromium's DevTools port in the desktop app; null without one (the core on its own). */
    private cdpPort: number | null,
    readonly ops: BrowserWindowOps,
  ) {
    const file = join(stateDir, "browser-key");
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    this.key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  }

  private sign = (key: string) => createHmac("sha256", this.key).update(key).digest("hex").slice(0, 32);

  get available() {
    return this.cdpPort !== null;
  }

  /** The server a session's runs get (`key`: its id, or the key it was started with): Chrome DevTools MCP, pointed at
   *  the filter. Files it writes (screenshots, traces) may go in the project or the temp folder. */
  server(cwd: string, key: string): McpDef {
    return {
      transport: "stdio",
      command: node(),
      args: [
        MCP_BIN,
        `--wsEndpoint=ws://127.0.0.1:${this.port()}/cdp/${this.sign(key)}/${encodeURIComponent(key)}`,
        "--no-usage-statistics",
        "--no-performance-crux",
        "--screenshotFormat=jpeg",
        "--screenshotMaxWidth=1600",
        `--workspace=${cwd}`,
        "--workspace=/tmp",
      ],
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
      cwd: null,
    };
  }

  /** The session a request for the filter's socket is for, if it may have one: its path names it, signed, and no web
   *  page sent it. */
  admits(req: Request, path: string): string | null {
    const m = path.match(/^\/cdp\/([0-9a-f]{32})\/([^/]+)$/);
    if (this.cdpPort === null || !m || req.headers.get("origin")) return null;
    const key = decodeURIComponent(m[2]);
    return m[1] === this.sign(key) ? key : null;
  }

  /** A new session's key, once it has its id. */
  alias(key: string, id: string) {
    this.aliases.set(key, id);
    for (const l of this.links.values()) l.ownersChanged();
  }

  sessionOf = (key: string) => this.aliases.get(key) ?? key;
  ownerOf = (targetId: string) => this.owners.get(targetId);

  /** Which session holds which pages (null: none, its tab is gone); `all`: every page there is, the rest forgotten. */
  setOwners(owners: [string, string | null][], all = false) {
    if (all) this.owners.clear();
    for (const [targetId, session] of owners) session ? this.owners.set(targetId, session) : this.owners.delete(targetId);
    for (const l of this.links.values()) l.ownersChanged();
  }

  open(ws: CdpSocket, key: string) {
    const link = new Link(ws, this, key);
    this.links.set(ws, link);
    void link.connect(this.cdpPort!);
  }

  message(ws: CdpSocket, raw: string | Buffer) {
    let msg: Msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    void this.links.get(ws)?.fromClient(msg);
  }

  close(ws: CdpSocket) {
    const link = this.links.get(ws);
    this.links.delete(ws);
    link?.close();
  }

  /** The pages agents hold, now. */
  awake = () => [...new Set([...this.links.values()].flatMap((l) => [...l.held.values()]))];
  private lastAwake = "[]";

  heldChanged() {
    const now = this.awake().sort();
    if (JSON.stringify(now) === this.lastAwake) return;
    this.lastAwake = JSON.stringify(now);
    this.ops.awake(now);
  }
}

/** Node for the MCP server (Puppeteer is at home there); Bun if there's none. */
let nodePath: string | undefined;
function node(): string {
  return (nodePath ??= Bun.which("node") ?? process.execPath);
}
