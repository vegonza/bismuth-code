// The browser tabs' side of the shell (web/browser.ts draws them, each page a <webview>):
// - one persistent session for every page (`persist:bismuth-browser`), its cookies kept across launches;
// - Zen's (or Firefox's) sign-ins synced into it: its profile's cookies copied in as they change, one way;
// - every page held to what a web page may do: no Node, no preload, sandboxed, web addresses only, permissions asked
//   for denied but a few harmless ones;
// - a page's own new windows open as tabs (a popup that signs in stays a window, so it can talk to its opener);
// - the app's shortcuts reach the app while a page has focus (the page never hears them);
// - Chromium's DevTools port open on localhost for agents (core/browser.ts filters it down to the pages), each page's
//   target named to the window so the core can tell which tab an agent means.
import { app, BrowserWindow, ipcMain, session, shell, webContents, type Session, type WebContents } from "electron";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PARTITION = "persist:bismuth-browser";
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
    const dbg = contents.debugger;
    const mine = !dbg.isAttached();
    if (mine) dbg.attach("1.3");
    try {
      return ((await dbg.sendCommand("Target.getTargetInfo")) as { targetInfo: { targetId: string } }).targetInfo.targetId;
    } finally {
      if (mine) dbg.detach();
    }
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
    delete prefs.preload;
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
      return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
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
/** What was copied in last time, by cookie: a hash of its value and attributes, so only what Zen changed since is
 *  written (a cookie a site renewed here isn't put back to Zen's older copy), and what Zen dropped is dropped. */
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

type ZenCookie = { name: string; value: string; host: string; path: string; expiry: number; isSecure: number; isHttpOnly: number; sameSite: number };

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

const keyOf = (c: { host: string; path: string; name: string }) => `${c.host}\t${c.path}\t${c.name}`;
const urlOf = (host: string, path: string, secure: boolean) => `${secure ? "https" : "http"}://${host.replace(/^\./, "")}${path || "/"}`;

/** Firefox's expiry is in milliseconds now, seconds before. */
const seconds = (expiry: number) => (expiry > 1e11 ? expiry / 1000 : expiry);

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
    const cookies = readCookies(profile.dir).filter((c) => c.name && seconds(c.expiry) > now);
    const before: Record<string, string> = readJson(syncedFile);
    const after: Record<string, string> = {};
    let failed = 0;
    for (const c of cookies) {
      const key = keyOf(c);
      const sig = createHash("sha1").update(`${c.value}\0${c.expiry}\0${c.isSecure}${c.isHttpOnly}${c.sameSite}`).digest("base64");
      after[key] = sig;
      if (before[key] === sig) continue;
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
          expirationDate: seconds(c.expiry),
          sameSite,
        });
      } catch (err: any) {
        // An insecure twin of a secure cookie (Firefox keeps both, Chromium only the secure one): nothing's missing.
        if (String(err?.message).includes("OVERWRITE_SECURE")) continue;
        failed++;
        delete after[key];
      }
    }
    // Signed out in Zen: signed out here too.
    for (const key of Object.keys(before)) {
      if (key in after) continue;
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

let watcher: FSWatcher | null = null;
let watching = "";
let timer: ReturnType<typeof setTimeout> | null = null;

/** Zen writes its cookies as they change: a sync a moment after it's done writing. */
function watchProfile(dir: string) {
  if (watching === dir) return;
  watcher?.close();
  watching = dir;
  watcher = watch(dir, (_event, file) => {
    if (!String(file ?? "").startsWith("cookies.sqlite")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void sync(), 2000);
  });
  watcher.on("error", () => stopWatching());
}

function stopWatching() {
  watcher?.close();
  watcher = null;
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
  win()?.webContents.send("browser-sync-status", status());
}
