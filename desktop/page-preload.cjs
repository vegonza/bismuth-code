// Run in every browser tab's page (desktop/browser.ts) before its own scripts, in a world of its own the page can't
// reach. Nothing is offered to the page.
const { ipcRenderer } = require("electron");

/** A value's fingerprint: desktop/browser.ts's storageHash, the same function (theirs and these are compared). */
function storageHash(s) {
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

// What Zen keeps in the site's localStorage (its settings, a signed-in app's state) put in first, as its cookies are:
// what Zen changed since the last time, unless the site has changed it here since (`written`: what was put in then).
try {
  if (/^https?:$/.test(location.protocol)) {
    for (const [key, value, written] of ipcRenderer.sendSync("browser-storage", location.origin) ?? []) {
      const now = localStorage.getItem(key);
      if (written !== null && now !== null && storageHash(now) !== written) continue;
      if (value !== null) localStorage.setItem(key, value);
      else if (now !== null) localStorage.removeItem(key);
    }
  }
} catch {
  // Storage refused (a sandboxed frame, the quota): the page goes on without.
}
