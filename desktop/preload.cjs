// What the shell offers the UI beyond a browser's: window.bismuthDesktop. The page runs sandboxed, so it's plain
// CommonJS asking the shell (desktop/main.ts) over IPC.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bismuthDesktop", {
  /** A whole HTML document printed to a PDF where the user picks (`name` offered); resolves to where, or null. */
  savePdf: (html, name) => ipcRenderer.invoke("save-pdf", html, name),
});
