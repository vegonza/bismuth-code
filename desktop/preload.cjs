// What the shell offers the UI beyond a browser's: window.bismuthDesktop. The page runs sandboxed, so it's plain
// CommonJS asking the shell (desktop/main.ts) over IPC.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bismuthDesktop", {
  /** A whole HTML document printed to a PDF where the user picks (`name` offered); resolves to where, or null. */
  savePdf: (html, name) => ipcRenderer.invoke("save-pdf", html, name),
  /** The browser tabs (desktop/browser.ts): their pages' session, and what the shell tells about them. */
  browser: {
    partition: "persist:bismuth-browser",
    /** A page asked for a new tab: its address, the page it came from (its webContents id), and whether in the background. */
    onOpen: (fn) => ipcRenderer.on("browser-open", (_e, url, from, background) => fn(url, from, background)),
    /** The combos the app acts on: taken from a focused page and handed to `onKey` instead. */
    setKeys: (combos) => ipcRenderer.send("browser-keys", combos),
    onKey: (fn) => ipcRenderer.on("browser-key", (_e, key) => fn(key)),
    /** Zen's sign-ins synced in: turned on or off (`{ enabled }`), or just asked about; resolves to how it stands. */
    sync: (change) => ipcRenderer.invoke("browser-sync", change ?? {}),
    onSync: (fn) => ipcRenderer.on("browser-sync-status", (_e, status) => fn(status)),
    /** A page's DevTools target id (by its webContents id), as agents driving the browser name it. */
    target: (id) => ipcRenderer.invoke("browser-target", id),
    /** A page an agent holds kept rendering though it isn't shown (by its webContents id), or let sleep again. */
    awake: (id, on) => ipcRenderer.send("browser-awake", id, on),
    /** A page (by its webContents id) drawn as a viewport (its size and scale, and as a phone what it tells sites it
     *  is), or as its frame is (null); resolves to whether what it tells sites changed (it's loaded again as that). */
    viewport: (id, viewport) => ipcRenderer.invoke("browser-viewport", id, viewport),
  },
});
