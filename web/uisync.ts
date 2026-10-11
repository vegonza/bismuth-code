// Settings every window shares, wherever it's opened from (the app's window, a phone over remote access): the core
// keeps them (core/uistate.ts) and writes them into this page's localStorage before it loads. Here, a change this
// window makes to one goes to the core, and one another window made comes in as if from a same-address window
// (a `storage` event, which prefs.ts and store.ts already follow). Imported first, so every write passes through.
import type { ClientMessage } from "../shared/model";

/** Everything else stays this window's own: the sidebar shut or open, panel widths, drafts, the open project, the
 *  composer's model (it follows the session this window opens), the theme's cached colours (each screen's own light or
 *  dark, worked out from the shared Settings)… */
const SHARED = new Set([
  "bismuth.prefs", // Settings
  "bismuth.view", // the sidebar's view options
  "bismuth.titles", // session names
  "bismuth.favorites",
  "bismuth.done", // finished sessions not yet looked at
  "bismuth.closedProjects",
  "bismuth.sessionsOpen",
  "bismuth.settledOpen",
]);

/** The ones this window held before any of its scripts ran (written in by the core, or kept from an earlier visit):
 *  only those can fill in one the core has never had. One a window made up since is its defaults (a browser that's
 *  never been here), which mustn't stand in for what the other windows are about to bring. */
const held = new Set([...SHARED].filter((key) => localStorage.getItem(key) !== null));
/** A build being tried out (`bun run apply` boots one in a browser of its own, without the core's values): it reads
 *  the shared settings and changes none of them. */
const trial = location.pathname.startsWith("/_bismuth/preview/");

const setItem = Storage.prototype.setItem;
const removeItem = Storage.prototype.removeItem;
/** The core's values as last heard (null until the first hello). */
let known: Record<string, string> | null = null;
/** Changed here and not yet with the core (it was out of reach, or hadn't said hello). */
const dirty = new Set<string>();
/** Ones the core has never held: this window's values may fill them in (core/main.ts decides). */
const seeds = new Set<string>();
let send: (msg: ClientMessage) => void = () => {};
let open = () => false;

Storage.prototype.setItem = function (key: string, value: string) {
  setItem.call(this, key, value);
  if (this === localStorage && SHARED.has(key)) changed(key);
};
Storage.prototype.removeItem = function (key: string) {
  removeItem.call(this, key);
  if (this === localStorage && SHARED.has(key)) changed(key);
};

function changed(key: string) {
  if (trial) return;
  if (known && (known[key] ?? null) === localStorage.getItem(key)) return;
  // One the core has never had and this window didn't bring: its defaults, kept to itself.
  if (known && !(key in known) && !held.has(key)) return;
  dirty.add(key);
  flush();
}

function flush() {
  if (!known || !open()) return;
  for (const key of dirty) {
    const value = localStorage.getItem(key);
    if (value === null) delete known[key];
    else known[key] = value;
    send({ type: "uiState.set", key, value, ...(seeds.has(key) ? { seed: true } : {}) });
  }
  dirty.clear();
  seeds.clear();
}

/** Take another window's value, telling this one's listeners as a same-address window's write would. */
function adopt(key: string, value: string | null) {
  const old = localStorage.getItem(key);
  if (old === value) return;
  if (value === null) removeItem.call(localStorage, key);
  else setItem.call(localStorage, key, value);
  dispatchEvent(new StorageEvent("storage", { key, oldValue: old, newValue: value, storageArea: localStorage }));
}

export function initUiSync(sender: (msg: ClientMessage) => void, isOpen: () => boolean) {
  send = sender;
  open = isOpen;
}

/** Connected. The first time, the core's values stand: what this window wrote before then (its start-up saves every
 *  setting at once) was made from what it loaded, not changed by anyone, and one the core has never had (the first
 *  window after an update) is offered as a seed, if this window brought it. Again after a drop, what changed here while
 *  out of reach goes to the core and what changed elsewhere comes in. */
export function uiSyncHello(values: Record<string, string> | undefined) {
  if (!values) return; // a core from before shared settings
  const first = !known;
  known = { ...values };
  if (first) dirty.clear();
  for (const key of SHARED) {
    if (!(key in values)) {
      if (held.has(key) && localStorage.getItem(key) !== null && !trial) dirty.add(key), seeds.add(key);
    } else if (!dirty.has(key)) adopt(key, values[key]);
  }
  flush();
}

export function uiSyncRemote(key: string, value: string | null) {
  if (!SHARED.has(key) || !known) return;
  if (value === null) delete known[key];
  else known[key] = value;
  dirty.delete(key);
  adopt(key, value);
}
