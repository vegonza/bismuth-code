// The browser tabs' side of the shell (web/browser.ts draws them, each page a <webview>):
// - one persistent session for every page (`persist:bismuth-browser`), its cookies kept across launches;
// - Zen's (or Firefox's) sign-ins synced into it: its profile's cookies (session ones too, from its saved session)
//   copied in as they change, and each site's localStorage as its pages load (page-preload.cjs), one way, never over
//   what a site has changed here since (two browsers trading one sign-in's tokens is what gets sites to end it);
// - every page held to what a web page may do: no Node, sandboxed, web addresses only, permissions asked for denied
//   but a few harmless ones; its only preload is ours, in a world the page can't reach;
// - a page drawn as a desktop's window or a phone, as Chrome's DevTools draws its devices (the viewport's size, drawn
//   at the scale the window shows it, sharp; as a phone, its user agent, platform and client hints, a touch screen,
//   overlay scrollbars);
// - a page's own new windows open as tabs (a popup that signs in stays a window, so it can talk to its opener);
// - the app's shortcuts reach the app while a page has focus (the page never hears them);
// - Chromium's DevTools port open on localhost for agents (core/browser.ts filters it down to the pages), each page's
//   target named to the window so the core can tell which tab an agent means.
import { app, BrowserWindow, ipcMain, session, shell, webContents, type Session, type WebContents } from "electron";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PARTITION = "persist:bismuth-browser";
/** Each page's preload: Zen's localStorage for its site, put in before the page's scripts run. */
const PAGE_PRELOAD = join(import.meta.dirname, "page-preload.cjs");
const MAC = process.platform === "darwin";

/** Web pages, and what pages make for themselves (a frame's own documents). */
const WEB = /^(https?:|about:blank|data:|blob:)/i;
/** Asked for by a page, granted without a prompt; the rest are refused (camera, location, notifications…). */
const ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

let win: () => BrowserWindow | null = () => null;

/** Before the app is ready: Chromium's DevTools port, on a free localhost port it writes to DevToolsActivePort. */
export function openDevtools() {
  rmSync(join(app.getPath("userData"), "DevToolsActivePort"), { force: true });
  app.commandLine.appendSwitch("remote-debugging-port", "0");
}

/** The DevTools port, once Chromium has written it (null if it never does). */
export async function devtoolsPort(): Promise<number | null> {
  const file = join(app.getPath("userData"), "DevToolsActivePort");
  for (let i = 0; i < 50; i++) {
    const port = Number(existsSync(file) ? readFileSync(file, "utf8").split("\n")[0] : NaN);
    if (port > 0) return port;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
let pages: Session;

export function initBrowser(window: () => BrowserWindow | null) {
  win = window;
  settingsFile = join(app.getPath("userData"), "browser.json");
  syncedFile = join(app.getPath("userData"), "browser-synced.json");
  storageFile = join(app.getPath("userData"), "browser-synced-storage.json");
  settings = { ...settings, ...readJson(settingsFile) };
  pages = session.fromPartition(PARTITION);
  // Sites that turn away embedded browsers look for Electron (and the app) in the user agent: a plain Chrome's.
  pages.setUserAgent(pages.getUserAgent().replace(/\s(Electron|bismuth)\/\S+/g, ""));
  pages.setPermissionRequestHandler((_wc, permission, done) => done(ALLOWED.has(permission)));
  pages.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
  app.on("web-contents-created", (_e, contents) => {
    if (contents.getType() === "webview") guest(contents, true);
    // A page's popup (a sign-in window): held to the same rules, without the app's keys.
    else if (contents.session === pages) guest(contents, false);
  });
  ipcMain.on("browser-keys", (e, combos: string[]) => {
    if (e.sender === win()?.webContents) keys = new Set(combos);
  });
  ipcMain.handle("browser-sync", (e, change: { enabled?: boolean }) => {
    if (e.sender !== win()?.webContents) throw new Error("not the app's window");
    if (typeof change?.enabled === "boolean" && change.enabled !== settings.zenSync) {
      settings.zenSync = change.enabled;
      writeFileSync(settingsFile, JSON.stringify(settings));
      if (settings.zenSync) startSync();
      else stopSync();
    }
    return status();
  });
  // A page's DevTools target: what the core's filter calls it.
  ipcMain.handle("browser-target", async (e, id: number) => {
    if (e.sender !== win()?.webContents) throw new Error("not the app's window");
    const contents = webContents.fromId(id);
    if (!contents || contents.getType() !== "webview" || contents.hostWebContents !== e.sender) return null;
    holdDebugger(contents);
    try {
      return ((await contents.debugger.sendCommand("Target.getTargetInfo")) as { targetInfo: { targetId: string } }).targetInfo.targetId;
    } finally {
      releaseDebugger(contents);
    }
  });
  // A page's localStorage from Zen's for its site (page-preload.cjs asks, synchronously, before the page's scripts).
  ipcMain.on("browser-storage", (e, origin: string) => {
    e.returnValue = e.sender.session === pages && typeof origin === "string" ? storageFor(origin) : [];
  });
  // A page drawn as a viewport (web/browser.ts), or as its frame is again (null). Resolves to whether what it tells
  // sites it is changed, so the window loads it again as that.
  ipcMain.handle("browser-viewport", async (e, id: number, viewport: unknown) => {
    if (e.sender !== win()?.webContents) throw new Error("not the app's window");
    const contents = webContents.fromId(id);
    if (!contents || contents.getType() !== "webview" || contents.hostWebContents !== e.sender) return false;
    if (viewport !== null && !isViewport(viewport)) throw new Error("not a viewport");
    return setViewport(contents, viewport);
  });
  // A page an agent holds kept running though its tab isn't shown (the window lays it out, out of sight): its timers
  // and frames not throttled as a hidden page's are.
  ipcMain.on("browser-awake", (e, id: number, on: boolean) => {
    if (e.sender !== win()?.webContents) return;
    const contents = webContents.fromId(id);
    if (contents?.getType() === "webview" && contents.hostWebContents === e.sender) contents.setBackgroundThrottling(!on);
  });
  if (settings.zenSync) startSync();
}

/** The app's window attaching a page: only into the browser's session, and never with more than a web page has. */
export function guardWebviews(contents: WebContents) {
  contents.on("will-attach-webview", (e, prefs, params) => {
    if (params.partition !== PARTITION || (params.src && !WEB.test(params.src))) return e.preventDefault();
    prefs.preload = PAGE_PRELOAD;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
  });
}

function guest(contents: WebContents, tab: boolean) {
  // Links that leave the web (mailto:, an app's own scheme) go to the system; file: and the like nowhere.
  contents.on("will-navigate", (e, url) => {
    if (WEB.test(url)) return;
    e.preventDefault();
    if (/^(mailto|tel):/i.test(url)) void shell.openExternal(url);
  });
  contents.on("will-frame-navigate", (e) => !e.isMainFrame && !WEB.test(e.url) && e.preventDefault());
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!/^https?:/i.test(url)) return { action: "deny" };
    // window.open with a size (a sign-in popup) stays a window, so it can reach its opener and close itself.
    if (disposition === "new-window")
      return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PAGE_PRELOAD } } };
    // A link to a new tab (or window.open without a size): the app opens it as a tab beside this page's.
    win()?.webContents.send("browser-open", url, tab ? contents.id : null, disposition === "background-tab");
    return { action: "deny" };
  });
  if (!tab) return;
  contents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const combo = comboOf(input);
    if (!combo || !keys.has(combo)) return;
    e.preventDefault();
    win()?.webContents.send("browser-key", { key: input.key, code: input.code, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt, metaKey: input.meta });
  });
}

// ---------------- the debugger ----------------

/** Who needs each page's debugger (by webContents id): a target asked for, a viewport's emulation. Attached while anyone
 *  does: one attach for all of them, never one detaching it from under another. */
const debuggerHolds = new Map<number, number>();

function holdDebugger(contents: WebContents) {
  const held = debuggerHolds.get(contents.id) ?? 0;
  if (!held) {
    contents.debugger.attach("1.3");
    // Let go of from outside (the page gone, DevTools taking it): nothing is held, and the emulation went with it.
    contents.debugger.once("detach", () => {
      debuggerHolds.delete(contents.id);
      viewports.delete(contents.id);
    });
  }
  debuggerHolds.set(contents.id, held + 1);
}

function releaseDebugger(contents: WebContents) {
  const held = (debuggerHolds.get(contents.id) ?? 0) - 1;
  if (held > 0) return void debuggerHolds.set(contents.id, held);
  debuggerHolds.delete(contents.id);
  if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
}

// ---------------- viewports ----------------

/** A page drawn as a `width`×`height` viewport at `scale`, and as a phone, telling sites it's one. */
type Viewport = { width: number; height: number; scale: number; phone: Phone | null };
/** Its user agent, the platform scripts read, and its client hints (Chromium's UserAgentMetadata, checked by it). */
type Phone = { ua: string; platform: string; metadata?: object };
const isPhone = (p: any): p is Phone =>
  typeof p?.ua === "string" &&
  p.ua.length <= 512 &&
  typeof p.platform === "string" &&
  p.platform.length <= 64 &&
  (p.metadata === undefined || (typeof p.metadata === "object" && p.metadata !== null && JSON.stringify(p.metadata).length <= 4096));
const isViewport = (v: any): v is Viewport =>
  !!v &&
  [v.width, v.height].every((n) => Number.isInteger(n) && n > 0 && n <= 10_000) &&
  typeof v.scale === "number" &&
  v.scale >= 0.05 &&
  v.scale <= 4 &&
  (v.phone === null || isPhone(v.phone));

/** The pages drawn as viewports: their debugger held, as the emulation lasts only while it's attached. */
const viewports = new Map<number, Viewport>();
/** Each page's asks, one at a time (a panel gliding open asks every frame). */
const viewportQueue = new Map<number, Promise<unknown>>();

/** Whether what it tells sites it is changed. */
function setViewport(contents: WebContents, viewport: Viewport | null): Promise<boolean> {
  const id = contents.id;
  const next = (viewportQueue.get(id) ?? Promise.resolve()).catch(() => {}).then(() => applyViewport(contents, viewport));
  viewportQueue.set(id, next);
  void next.finally(() => viewportQueue.get(id) === next && viewportQueue.delete(id)).catch(() => {});
  return next;
}

async function applyViewport(contents: WebContents, viewport: Viewport | null): Promise<boolean> {
  if (contents.isDestroyed()) return false;
  const id = contents.id;
  const was = viewports.get(id) ?? null;
  const send = (method: string, params?: object) => contents.debugger.sendCommand(method, params);
  const phoneChanged = JSON.stringify(was?.phone ?? null) !== JSON.stringify(viewport?.phone ?? null);
  if (!viewport) {
    if (!was) return false;
    viewports.delete(id);
    if (debuggerHolds.has(id)) {
      // Undone one by one (something else may hold the debugger on, so detaching might not undo them).
      await send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
      await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      // Chromium refuses maxTouchPoints out of 1..16 even when turning it off.
      await send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 }).catch(() => {});
      releaseDebugger(contents);
    }
    return phoneChanged;
  }
  if (!was) holdDebugger(contents);
  viewports.set(id, viewport);
  try {
    if (phoneChanged) {
      // What the page is told it runs on, consistently: the user agent, the platform scripts read (not Linux's) and
      // the client hints (a phone's, not this browser's); and a touch screen as far as it can tell. The mouse stays a mouse: turned into touches
      // (Emulation.setEmitTouchEventsForMouse), a <webview>'s press is never let go of, and holds the window's input.
      const phone = viewport.phone;
      await send("Emulation.setUserAgentOverride", phone ? { userAgent: phone.ua, platform: phone.platform, ...(phone.metadata && { userAgentMetadata: phone.metadata }) } : { userAgent: "" });
      await send("Emulation.setTouchEmulationEnabled", phone ? { enabled: true, maxTouchPoints: 5 } : { enabled: false, maxTouchPoints: 1 });
    }
    // The viewport's size, drawn at the scale the window shows it at (the page drawn smaller, not a picture of it
    // shrunk); as a phone, a phone's viewport rules and scrollbars over the page. The screen's density stays the
    // window's, so the page is drawn at the pixels it shows on.
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 0, mobile: !!viewport.phone, scale: viewport.scale });
  } catch (err) {
    if (!was) {
      viewports.delete(id);
      releaseDebugger(contents);
    } else viewports.set(id, was);
    throw err;
  }
  return phoneChanged;
}

// ---------------- the app's keys ----------------

/** The combos the app acts on (its keymap, sent by the window): taken from a focused page before it sees them. */
let keys = new Set<string>();
const NAMED: Record<string, string> = { " ": "space", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Escape: "escape", Enter: "enter", Tab: "tab", Backspace: "backspace", Delete: "delete" };
const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph", "CapsLock", "Fn"]);

/** As web/keymap.ts comboFromEvent spells it; only with Ctrl, Cmd or Alt held, or a function key, so typing into a
 *  page (Shift+Backspace too) is never taken. */
function comboOf(input: Electron.Input): string | null {
  if (MODIFIERS.has(input.key)) return null;
  if (!input.control && !input.meta && !input.alt && !/^F\d+$/.test(input.key)) return null;
  const key = /^Key[A-Z]$/.test(input.code) ? input.code.slice(3).toLowerCase() : /^Digit\d$/.test(input.code) ? input.code.slice(5) : (NAMED[input.key] ?? input.key.toLowerCase());
  const parts: string[] = [];
  if (input.meta || (input.control && !MAC)) parts.push("mod");
  if (input.control && MAC) parts.push("ctrl");
  if (input.alt) parts.push("alt");
  if (input.shift) parts.push("shift");
  parts.push(key);
  return parts.join("-");
}

// ---------------- Zen's sign-ins ----------------

let settingsFile = "";
let settings = { zenSync: true };
/** What was copied in last time, by cookie: a hash of Zen's (its value and attributes), so only what Zen changed since
 *  is written, and a hash of the value written, so a cookie the site has renewed here since is left as it is (and
 *  what Zen dropped is dropped only if it hasn't been). */
let syncedFile = "";

export type SyncStatus = { enabled: boolean; source: string | null; profile: string | null; cookies: number; at: number | null; error: string | null };
let last: Omit<SyncStatus, "enabled"> = { source: null, profile: null, cookies: 0, at: null, error: null };
const status = (): SyncStatus => ({ enabled: settings.zenSync, ...last });

function readJson(file: string) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

type Profile = { source: string; name: string; dir: string };

/** Where Firefox-family browsers keep their profiles, Zen first. */
function profileRoots(): { source: string; dir: string }[] {
  const home = homedir();
  if (MAC)
    return [
      { source: "Zen", dir: join(home, "Library/Application Support/zen") },
      { source: "Firefox", dir: join(home, "Library/Application Support/Firefox") },
    ];
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA ?? join(home, "AppData/Roaming");
    return [
      { source: "Zen", dir: join(roaming, "zen") },
      { source: "Firefox", dir: join(roaming, "Mozilla/Firefox") },
    ];
  }
  return [
    { source: "Zen", dir: join(home, ".zen") },
    { source: "Zen", dir: join(home, ".var/app/app.zen_browser.zen/.zen") },
    { source: "Firefox", dir: join(home, ".mozilla/firefox") },
    { source: "Firefox", dir: join(home, ".var/app/org.mozilla.firefox/.mozilla/firefox") },
  ];
}

/** The profile the browser opens with: installs.ini's default for the install, else profiles.ini's Default=1. */
function findProfile(): Profile | null {
  for (const { source, dir } of profileRoots()) {
    const pick = (file: string, isDefault: (section: Record<string, string>) => boolean) => {
      if (!existsSync(join(dir, file))) return null;
      for (const s of iniSections(readFileSync(join(dir, file), "utf8"))) {
        const path = s.Default && file === "installs.ini" ? s.Default : s.Path;
        if (!path || !isDefault(s)) continue;
        const full = file === "installs.ini" || s.IsRelative !== "0" ? join(dir, path) : path;
        if (existsSync(join(full, "cookies.sqlite"))) return { source, name: s.Name ?? path.replace(/^[^.]+\./, ""), dir: full };
      }
      return null;
    };
    const found = pick("installs.ini", (s) => !!s.Default) ?? pick("profiles.ini", (s) => s.Default === "1");
    if (found) return found;
  }
  return null;
}

function iniSections(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) out.push({});
    else {
      const m = line.match(/^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/);
      if (m && out.length) out[out.length - 1][m[1]] = m[2];
    }
  }
  return out;
}

/** `expiry` null: a session cookie, one that lasts while the browser is open. */
type ZenCookie = { name: string; value: string; host: string; path: string; expiry: number | null; isSecure: number; isHttpOnly: number; sameSite: number };

/** All the profile's cookies: its database's, and the session cookies it never writes there (many sign-ins are one). */
function zenCookies(dir: string): ZenCookie[] {
  const all = new Map<string, ZenCookie>();
  for (const c of [...readSessionCookies(dir), ...readCookies(dir)]) all.set(keyOf(c), c);
  return [...all.values()];
}

/** The profile's cookies, from a copy: the browser keeps its database locked while it runs, and its newest writes are
 *  in the write-ahead log beside it. Container and partitioned cookies stay out (they belong to one tab's context). */
function readCookies(dir: string): ZenCookie[] {
  const tmp = mkdtempSync(join(tmpdir(), "bismuth-cookies-"));
  try {
    copyFileSync(join(dir, "cookies.sqlite"), join(tmp, "cookies.sqlite"));
    if (existsSync(join(dir, "cookies.sqlite-wal"))) copyFileSync(join(dir, "cookies.sqlite-wal"), join(tmp, "cookies.sqlite-wal"));
    const db = new DatabaseSync(join(tmp, "cookies.sqlite"));
    try {
      return db.prepare("SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = ''").all() as ZenCookie[];
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

type SessionCookie = { name: string; value?: string; host: string; path?: string; secure?: boolean; httponly?: boolean; sameSite?: number; originAttributes?: Record<string, unknown> };

/** The profile's session cookies, from what it saves to restore its session: while it runs, its recovery file (written
 *  every few seconds as they change); closed, what it saved on the way out. Container and partitioned ones stay out. A
 *  file that can't be read throws, so its cookies aren't taken for signed out of. */
function readSessionCookies(dir: string): ZenCookie[] {
  const file = [join(dir, "sessionstore-backups", "recovery.jsonlz4"), join(dir, "sessionstore.jsonlz4")].find((f) => existsSync(f));
  if (!file) return [];
  const { cookies = [] } = JSON.parse(new TextDecoder().decode(unmozlz4(readFileSync(file)))) as { cookies?: SessionCookie[] };
  return cookies
    .filter((c) => !c.originAttributes?.partitionKey && !c.originAttributes?.userContextId && !c.originAttributes?.privateBrowsingId && !c.originAttributes?.firstPartyDomain)
    .map((c) => ({ name: c.name, value: c.value ?? "", host: c.host, path: c.path || "/", expiry: null, isSecure: c.secure ? 1 : 0, isHttpOnly: c.httponly ? 1 : 0, sameSite: c.sameSite ?? 0 }));
}

/** Mozilla's mozLz4 files: a magic, the decompressed size, then one LZ4 block (literals and back-references). */
function unmozlz4(src: Buffer): Uint8Array {
  if (src.toString("latin1", 0, 8) !== "mozLz40\0") throw new Error("not mozLz4");
  const out = new Uint8Array(src.readUInt32LE(8));
  let pos = 12;
  let o = 0;
  while (pos < src.length) {
    const token = src[pos++];
    let n = token >> 4;
    if (n === 15) for (let b = 255; b === 255; n += b) b = src[pos++];
    out.set(src.subarray(pos, pos + n), o);
    pos += n;
    o += n;
    // The last sequence is literals alone.
    if (pos >= src.length) break;
    const off = src[pos] | (src[pos + 1] << 8);
    pos += 2;
    let m = token & 15;
    if (m === 15) for (let b = 255; b === 255; m += b) b = src[pos++];
    m += 4;
    for (let i = 0; i < m; i++, o++) out[o] = out[o - off];
  }
  if (o !== out.length) throw new Error("not mozLz4");
  return out;
}

const keyOf = (c: { host: string; path: string; name: string }) => `${c.host}\t${c.path}\t${c.name}`;
/** A value's fingerprint, kept instead of it. */
const hash = (value: string) => createHash("sha1").update(value).digest("base64").slice(0, 16);
const urlOf = (host: string, path: string, secure: boolean) => `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${path || "/"}`;

/** Firefox's expiry is in milliseconds now, seconds before. */
const seconds = (expiry: number) => (expiry > 1e11 ? expiry / 1000 : expiry);

/** The cookies copied in since the app started: a session cookie among them that's gone was ended by its site here. */
const copiedThisRun = new Set<string>();

let syncing = false;
let again = false;
async function sync() {
  if (syncing) return void (again = true);
  syncing = true;
  try {
    const profile = findProfile();
    if (!profile) {
      last = { ...last, source: null, profile: null, error: null };
      return;
    }
    const now = Date.now() / 1000;
    const cookies = zenCookies(profile.dir).filter((c) => c.name && (c.expiry === null || seconds(c.expiry) > now));
    // Each entry: Zen's cookie's hash, then the written value's (one hash alone: from before they were told apart).
    const before: Record<string, string> = readJson(syncedFile);
    const after: Record<string, string> = {};
    // The cookies here now, by the same key (Chromium spells a domain cookie's host with its dot, as Firefox does).
    const here = new Map((await pages.cookies.get({})).map((c) => [keyOf({ host: c.domain ?? "", path: c.path ?? "/", name: c.name }), c.value]));
    /** Whether the cookie here is still what was written (or is gone): Zen's newer one may take its place. */
    const untouched = (key: string) => {
      const written = before[key]?.split(" ")[1];
      return !here.has(key) || written === undefined || hash(here.get(key)!) === written;
    };
    // Zen's, including any that couldn't be copied (not taken for dropped in Zen).
    const zen = new Set(cookies.map(keyOf));
    let failed = 0;
    for (const c of cookies) {
      const key = keyOf(c);
      const sig = createHash("sha1").update(`${c.value}\0${c.expiry}\0${c.isSecure}${c.isHttpOnly}${c.sameSite}`).digest("base64");
      after[key] = `${sig} ${hash(c.value)}`;
      // A session cookie ends with the app: one copied in before it last started, and gone, is copied in again.
      const lapsed = c.expiry === null && !here.has(key) && !copiedThisRun.has(key);
      if (before[key]?.split(" ")[0] === sig && !lapsed) {
        if (before[key].includes(" ")) after[key] = before[key];
        continue;
      }
      // Renewed here by its site since it was copied: two browsers trading one sign-in's tokens is what ends it.
      if (before[key] && !untouched(key)) {
        after[key] = `${sig} ${before[key].split(" ")[1]}`;
        continue;
      }
      const secure = !!c.isSecure;
      // Firefox's 0 is SameSite=None, which Chromium only takes on a secure cookie.
      const sameSite = c.sameSite === 1 ? "lax" : c.sameSite === 2 ? "strict" : secure ? "no_restriction" : "unspecified";
      try {
        await pages.cookies.set({
          url: urlOf(c.host, c.path, secure),
          name: c.name,
          value: c.value,
          path: c.path || "/",
          // A leading dot is a domain cookie; without one it's the host's alone (and __Host- cookies must have none).
          ...(c.host.startsWith(".") ? { domain: c.host } : {}),
          secure,
          httpOnly: !!c.isHttpOnly,
          // No expiry: a session cookie here too.
          ...(c.expiry === null ? {} : { expirationDate: seconds(c.expiry) }),
          sameSite,
        });
        copiedThisRun.add(key);
      } catch (err: any) {
        // An insecure twin of a secure cookie (Firefox keeps both, Chromium only the secure one): nothing's missing.
        if (String(err?.message).includes("OVERWRITE_SECURE")) continue;
        failed++;
        delete after[key];
      }
    }
    // Signed out in Zen: signed out here too (unless the site has signed in again here since).
    for (const key of Object.keys(before)) {
      if (key in after || zen.has(key) || !untouched(key)) continue;
      const [host, path, name] = key.split("\t");
      await pages.cookies.remove(urlOf(host, path, true), name).catch(() => {});
      await pages.cookies.remove(urlOf(host, path, false), name).catch(() => {});
    }
    writeFileSync(syncedFile, JSON.stringify(after));
    last = { source: profile.source, profile: profile.name, cookies: Object.keys(after).length, at: Date.now(), error: failed ? `${failed} cookies couldn't be copied` : null };
    watchProfile(profile.dir);
  } catch (err: any) {
    last = { ...last, at: Date.now(), error: String(err?.message ?? err) };
  } finally {
    syncing = false;
    win()?.webContents.send("browser-sync-status", status());
    if (again) (again = false), void sync();
  }
}

// ---------------- localStorage ----------------

/** What was put into each site's localStorage last time, by key: a hash of the value, so only what Zen changed since is
 *  written, and only where the page still holds what was put in (page-preload.cjs compares): a value the site has
 *  changed here since stays, and what Zen dropped is dropped only if it hasn't. */
let storageFile = "";
let stored: Record<string, Record<string, string>> | null = null;
/** Each site's storage as last read from Zen's, and when its files were last written. */
const storageCache = new Map<string, { stamp: string; items: Map<string, string> }>();

/** Firefox's folder for a site's storage: "https://example.com:8080" is "https+++example.com+8080". */
const storageDir = (origin: string) => origin.replace("://", "+++").replace(/:(\d+)$/, "+$1");

/** What a page's localStorage should take from Zen's now: [key, value, what was put in last time (null: never)] to set,
 *  [key, null, …] to remove. */
function storageFor(origin: string): [string, string | null, string | null][] {
  if (!settings.zenSync) return [];
  try {
    const profile = findProfile();
    if (!profile || !/^https?:\/\/[^/+^]+$/.test(origin)) return [];
    const items = readStorage(join(profile.dir, "storage", "default", storageDir(origin), "ls"));
    stored ??= readJson(storageFile);
    const before = stored![origin] ?? {};
    const after: Record<string, string> = {};
    const ops: [string, string | null, string | null][] = [];
    for (const [key, value] of items ?? []) {
      const sig = storageHash(value);
      after[key] = sig;
      if (before[key] !== sig) ops.push([key, value, before[key] ?? null]);
    }
    for (const key of Object.keys(before)) if (!(key in after)) ops.push([key, null, before[key]]);
    if (!ops.length) return [];
    if (Object.keys(after).length) stored![origin] = after;
    else delete stored![origin];
    writeFileSync(storageFile, JSON.stringify(stored));
    return ops;
  } catch {
    return [];
  }
}

/** A value's fingerprint: page-preload.cjs's storageHash, the same function (it compares the page's values with these). */
function storageHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A site's localStorage in a Firefox profile (its `ls` folder): read from a copy, as the cookies are; null if it has
 *  none. Values are UTF-8, some compressed with Snappy. */
function readStorage(dir: string): Map<string, string> | null {
  const file = join(dir, "data.sqlite");
  if (!existsSync(file)) return null;
  const wal = `${file}-wal`;
  const stamp = `${statSync(file).mtimeMs}:${existsSync(wal) ? statSync(wal).mtimeMs : 0}`;
  const cached = storageCache.get(dir);
  if (cached?.stamp === stamp) return cached.items;
  const tmp = mkdtempSync(join(tmpdir(), "bismuth-storage-"));
  const items = new Map<string, string>();
  try {
    copyFileSync(file, join(tmp, "data.sqlite"));
    if (existsSync(wal)) copyFileSync(wal, join(tmp, "data.sqlite-wal"));
    const db = new DatabaseSync(join(tmp, "data.sqlite"));
    try {
      const rows = db.prepare("SELECT key, conversion_type, compression_type, value FROM data").all() as { key: string; conversion_type: number; compression_type: number; value: Uint8Array | string }[];
      for (const r of rows) {
        try {
          if (typeof r.value === "string") items.set(r.key, r.value);
          else {
            const raw = r.compression_type === 1 ? unsnappy(r.value) : r.value;
            items.set(r.key, new TextDecoder(r.conversion_type === 1 ? "utf-8" : "utf-16le", { fatal: true }).decode(raw));
          }
        } catch {
          // A value that can't be read is left out.
        }
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  storageCache.set(dir, { stamp, items });
  return items;
}

/** Snappy's raw format (what Firefox compresses localStorage with): a length, then literals and back-references. */
function unsnappy(src: Uint8Array): Uint8Array {
  let pos = 0;
  let len = 0;
  for (let shift = 0; ; shift += 7) {
    const b = src[pos++];
    len |= (b & 0x7f) << shift;
    if (b < 0x80) break;
  }
  const out = new Uint8Array(len);
  let o = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    if ((tag & 3) === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n |= src[pos++] << (8 * i);
      }
      n += 1;
      out.set(src.subarray(pos, pos + n), o);
      pos += n;
      o += n;
      continue;
    }
    let n: number;
    let off: number;
    if ((tag & 3) === 1) {
      n = ((tag >> 2) & 7) + 4;
      off = ((tag >> 5) << 8) | src[pos++];
    } else if ((tag & 3) === 2) {
      n = (tag >> 2) + 1;
      off = src[pos] | (src[pos + 1] << 8);
      pos += 2;
    } else {
      n = (tag >> 2) + 1;
      off = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
      pos += 4;
    }
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off];
  }
  if (o !== len) throw new Error("not Snappy");
  return out;
}

let watchers: FSWatcher[] = [];
let watching = "";
let timer: ReturnType<typeof setTimeout> | null = null;

/** Zen writes its cookies as they change, and its session cookies with the rest of its session every few seconds: a
 *  sync a moment after it's done writing. */
function watchProfile(dir: string) {
  if (watching === dir) return;
  stopWatching();
  watching = dir;
  const on = (folder: string, files: RegExp) => {
    if (!existsSync(folder)) return;
    const w = watch(folder, (_event, file) => {
      if (!files.test(String(file ?? ""))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void sync(), 2000);
    });
    w.on("error", () => stopWatching());
    watchers.push(w);
  };
  on(dir, /^(cookies\.sqlite|sessionstore\.jsonlz4)/);
  on(join(dir, "sessionstore-backups"), /^recovery\.jsonlz4/);
}

function stopWatching() {
  for (const w of watchers) w.close();
  watchers = [];
  watching = "";
  if (timer) clearTimeout(timer), (timer = null);
}

function startSync() {
  void sync();
}

/** Syncing off: what was copied in stays (the pages stay signed in), and Zen's changes no longer follow. */
function stopSync() {
  stopWatching();
  rmSync(syncedFile, { force: true });
  rmSync(storageFile, { force: true });
  stored = null;
  win()?.webContents.send("browser-sync-status", status());
}
