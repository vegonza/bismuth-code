// Electron shell: runs the Bun server (core/main.ts) as a child on a localhost port and shows it in a window. The
// core can ask to be restarted (exit code 75); the shell starts it again on the same port without closing the window.
// bun run app [cwd]
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { devtoolsPort, guardWebviews, initBrowser, openDevtools } from "./browser.ts";

const root = resolve(import.meta.dirname, "..");
const MAC = process.platform === "darwin";
const icon = join(root, "assets", "icon.png");
// Electron's own argv: [electron, ".", ...args] in dev, [app, ...args] when packaged; skip Chromium switches.
const folderArg = (argv: string[], cwd: string) => {
  const a = argv.slice(app.isPackaged ? 1 : 2).filter((x) => !x.startsWith("-"))[0];
  return a ? resolve(cwd, a) : null;
};
// A folder to open as a project (`bun run app <dir>`); without one the app opens where it left off.
const dir = folderArg(process.argv, process.cwd());

app.setName("bismuth");

// One app for every project: launching again (with another folder) hands it to the running window.
if (!app.requestSingleInstanceLock({ dir })) app.exit(0);
openDevtools();

// Launched from the Dock or Finder, a Mac app gets launchd's bare PATH, not a terminal's (Homebrew's node, ~/.bun,
// ~/.local): the core and everything it runs (tsc for Restart bismuth, the agents' CLIs and their tools) take the
// login shell's, asked once. From a terminal (TERM set), the PATH is that already.
if (MAC && !process.env.TERM) {
  try {
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "\\n__bismuth_path=%s" "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const path = out.split("__bismuth_path=").pop()?.trim();
    if (path) process.env.PATH = path;
  } catch {
    // A shell that fails or hangs: the bare PATH, as before.
  }
}

// Launched from a .desktop entry, PATH often lacks ~/.bun/bin.
function bunPath() {
  if (process.env.BUN) return process.env.BUN;
  const local = join(homedir(), ".bun", "bin", "bun");
  return existsSync(local) ? local : "bun";
}

let server: ChildProcess | null = null;
/** Chromium's DevTools port, for the core's browser agents use (core/browser.ts). */
let cdpPort: number | null = null;
let quitting = false;
/** The port the running core serves on: a restart reuses it, so the window's origin (and its storage) stays. */
let port = 0;
/** The core exits with this to be started again (Restart bismuth in the command palette). */
const RESTART_CODE = 75;

// The UI's localStorage and IndexedDB (prefs, the background image) belong to its origin, port included, so the
// core keeps one port across launches: the first launch takes a free one and remembers it. If it's taken
// (another window is open), this launch falls back to a fresh port without forgetting the remembered one.
const portFile = join(app.getPath("userData"), "core-port");

async function startCore(): Promise<string> {
  const saved = existsSync(portFile) ? Number(readFileSync(portFile, "utf8").trim()) || 0 : 0;
  if (saved) {
    try {
      return await startServer(saved);
    } catch (err: any) {
      console.error(`bismuth: port ${saved} unavailable (${err?.message ?? err}); using a free one`);
    }
  }
  const url = await startServer(0);
  if (!saved) writeFileSync(portFile, new URL(url).port);
  return url;
}

/** Start the core again where it was. The window's sockets reconnect on their own and reload into the new build.
 *  If the new core won't start, say why and offer to try again (after fixing it elsewhere) instead of quitting. */
async function restartCore() {
  for (;;) {
    try {
      const url = await startServer(port);
      // Same port, so normally the window just reconnects; if it had to move, point the window at it.
      if (win && new URL(win.webContents.getURL()).origin !== new URL(url).origin) void win.loadURL(url);
      return;
    } catch (err: any) {
      if (quitting) return;
      const { response } = await dialog.showMessageBox({
        type: "error",
        message: "bismuth couldn't restart",
        detail: `${err?.message ?? err}. See the terminal for details.`,
        buttons: ["Try again", "Quit"],
        defaultId: 0,
      });
      if (response === 1) return app.quit();
    }
  }
}

function startServer(requested: number): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    // PORT=0 lets Bun pick a free port; we read the actual URL from its banner. Closing stdin tells it to exit.
    const child = spawn(bunPath(), [join(root, "core", "main.ts"), ...(dir ? [dir] : [])], {
      cwd: root,
      // The launch cwd only seeds the very first project list (see core/projects.ts).
      env: { ...process.env, PORT: String(requested), BISMUTH_DESKTOP: "1", BISMUTH_LAUNCH_CWD: process.cwd(), ...(cdpPort ? { BISMUTH_CDP_PORT: String(cdpPort) } : {}) },
      stdio: ["pipe", "pipe", "inherit"],
    });
    server = child;
    let banner = "";
    let started = false;
    child.stdout!.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      if (started) return;
      banner += chunk.toString();
      const url = banner.match(/open (http:\/\/\S+)/)?.[1];
      if (url) (started = true), (port = Number(new URL(url).port)), resolveUrl(url);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      server = null;
      const reason = `bismuth server exited (${signal ?? code})`;
      if (!started) return reject(new Error(reason));
      if (code === RESTART_CODE && !quitting) return void restartCore();
      if (!quitting) {
        dialog.showErrorBox("bismuth", `${reason}. See the terminal for details.`);
        app.quit();
      }
    });
  });
}

let win: BrowserWindow | null = null;

function createWindow(url: string) {
  const w = new BrowserWindow({
    width: 1300,
    height: 850,
    minWidth: 720,
    minHeight: 480,
    title: "bismuth",
    icon,
    backgroundColor: "#0e0f11",
    show: false,
    // On a Mac, no title bar over the UI's own: the traffic lights sit at the left of its titlebar strip, which leaves
    // them room and moves the window (web/style.css, `html.traffic-lights`).
    ...(MAC ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 12, y: 14 } } : {}),
    // webviewTag: the browser tabs' pages (desktop/browser.ts holds each one to a web page's rights).
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true, preload: join(root, "desktop", "preload.cjs") },
  });
  guardWebviews(w.webContents);
  // Hidden for good: with autoHideMenuBar, a lone Alt would pop Electron's default File/Edit/View bar over the UI.
  // The menu stays attached, so its accelerators (copy/paste, reload, devtools, zoom) keep working.
  w.setMenuBarVisibility(false);
  w.once("ready-to-show", () => w.show());
  // Full screen hides the traffic lights: the UI gives their room back.
  w.on("enter-full-screen", () => w.webContents.send("window-fullscreen", true));
  w.on("leave-full-screen", () => w.webContents.send("window-fullscreen", false));

  // Links in rendered markdown open in the system browser; the window never navigates off the local server.
  const origin = new URL(url).origin;
  w.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (ev, target) => {
    if (new URL(target).origin === origin) return;
    ev.preventDefault();
    if (/^https?:/.test(target)) void shell.openExternal(target);
  });

  void w.loadURL(url);
  w.on("closed", () => (win = null));
  win = w;
}

// How the window draws its frame, asked once by the preload as the page loads (a reload in full screen included).
ipcMain.on("window-frame", (e) => {
  e.returnValue = { trafficLights: MAC, fullscreen: !!BrowserWindow.fromWebContents(e.sender)?.isFullScreen() };
});

/** Where the last PDF was saved: the next one's dialog opens there (Downloads at first). */
let pdfDir: string | null = null;

// A preview saved as a PDF (web/printpdf.ts hands over the page to print), where the user picks in the save dialog.
// The page is written into a hidden window that shares the app's origin, so its stylesheets, fonts and figures load
// as they do in the app, then printed by Chromium: text stays text, the maths vector.
ipcMain.handle("save-pdf", async (e, html: string, name: string) => {
  if (!win || e.sender !== win.webContents) throw new Error("not the app's window");
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: join(pdfDir && existsSync(pdfDir) ? pdfDir : app.getPath("downloads"), basename(name)),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return null;
  pdfDir = dirname(filePath);
  const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  try {
    // An empty page on the app's origin, the document written into it: a data: URL of a whole page with its figures
    // inlined would pass Chromium's 2 MB URL limit.
    await page.loadURL("data:text/html;charset=utf-8,", { baseURLForDataURL: `${new URL(e.sender.getURL()).origin}/` });
    await page.webContents.executeJavaScript(`(async () => {
      document.open();
      document.write(${JSON.stringify(html)});
      document.close();
      if (document.readyState !== "complete") await new Promise((r) => addEventListener("load", r, { once: true }));
      await document.fonts.ready;
    })()`);
    await writeFile(filePath, await page.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true }));
    return filePath;
  } finally {
    page.destroy();
  }
});

app.on("before-quit", () => {
  quitting = true;
  server?.kill();
});
app.on("window-all-closed", () => app.quit());

app.whenReady().then(async () => {
  // Electron's default menu, less its Window menu: Ctrl+M (Minimize) on a compositor without minimizing (Hyprland)
  // left the window on screen with Chromium no longer drawing it, a frozen app; and Ctrl+W (Close) would close bismuth.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }]));
  initBrowser(() => win);
  cdpPort = await devtoolsPort();
  try {
    const url = await startCore();
    createWindow(url);
    // A second launch: focus this window, and open its folder as a project (the UI adds and selects it).
    app.on("second-instance", (_e, argv, cwd, data) => {
      const next = (data as { dir?: string | null } | undefined)?.dir ?? folderArg(argv, cwd);
      if (!win) return createWindow(url);
      if (win.isMinimized()) win.restore();
      win.focus();
      if (next) void win.webContents.executeJavaScript(`window.__bismuthOpenProject?.(${JSON.stringify(next)})`);
    });
    app.on("activate", () => BrowserWindow.getAllWindows().length || createWindow(url));
  } catch (err: any) {
    if (!quitting) dialog.showErrorBox("bismuth", `Could not start the server: ${err?.message ?? err}`);
    app.quit();
  }
});
