// Side chats (Zeron's): a session branched off the open one with the very same context (core: threads.fork, each
// harness's own fork, so the prompt cache carries over), held as a tab in the open session's right pane until it's
// moved to the sidebar. Its tab is this same UI in a frame, in side mode (?side=<id>): the chat column alone, on the
// sidebar's tone to tell it from the session beside it. A frame that leaves the document starts over, so like browser
// pages (browser.ts) the frames live in one layer over the panel's body, the shown one visible. What a frame can't do
// itself (files, web links, the app's shortcuts) it hands to the window around it. Booting a frame is booting the app,
// so one waits booted (a spare) for the next side chat to open in at once, and each shows once its session is on it.
import type { FileRef } from "../shared/model";
import { el } from "./dom";
import { comboFromEvent } from "./keymap";
import { prefs, SHORTCUTS } from "./prefs";
import type { Cited } from "./refs";

/** A side chat's tab among the panel's tabs: this, then its session's id. */
export const SIDE_TAB = "bismuth:side:";
export const isSideTab = (path: string) => path.startsWith(SIDE_TAB);
export const sideOf = (tab: string) => tab.slice(SIDE_TAB.length);

/** In a side chat's frame: the session it shows (null in the app's own window), or SPARE in one booted ahead. */
export const sideChat = new URLSearchParams(location.search).get("side");
const SPARE = "-";
let session = sideChat === SPARE ? null : sideChat;
/** The session a side chat's frame shows (null: a spare, not given one yet). */
export const sideSession = () => session;
/** A spare given its session: it shows that one from now on, and again if it reloads. */
export function adoptSession(id: string) {
  session = id;
  history.replaceState(history.state, "", `${location.pathname}?side=${encodeURIComponent(id)}`);
}

type KeyInit = { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean };
/** What the window around a side chat does for it. */
export type Host = {
  openCited(ref: FileRef | null, cited: Cited, keep: boolean): void;
  openWebLink(url: string, background: boolean): void;
  /** One of the app's shortcuts pressed in the frame, as if pressed in the window. */
  key(k: KeyInit): void;
  /** The frame has its session on screen. */
  shown(id: string): void;
  /** The spare has booted, ready for a session. */
  warm(): void;
};

declare global {
  interface Window {
    __bismuthHost?: Host;
    /** A side chat's frame, for the window around it: `show` gives a spare its session. */
    __bismuthSide?: { focus(): void; show(id: string): void };
  }
}

// ---------------- the window around ----------------

let layer: HTMLElement;
/** Each side chat's frame, by session, the most recently shown last. */
const frames = new Map<string, HTMLIFrameElement>();
/** Frames kept up behind the shown one (each is a whole app): an older one starts over when its tab shows again. */
const KEEP = 6;
/** A frame booted with no session, for the next one, and whether it's up. */
let spare: HTMLIFrameElement | null = null;
let spareUp = false;
/** Side chats waiting for their frame to show them. */
const waiting = new Map<string, () => void>();

export function mountSideChats(body: HTMLElement, host: Omit<Host, "shown" | "warm">) {
  window.__bismuthHost = {
    ...host,
    warm: () => (spareUp = true),
    shown: (id) => {
      frames.get(id)?.classList.add("ready");
      waiting.get(id)?.();
      waiting.delete(id);
    },
  };
  layer = el("div", "sc");
  body.append(layer);
  warmSpare();
}

const frameSrc = (id: string) => `${location.pathname}?side=${encodeURIComponent(id)}`;

/** A spare booted in a moment, once the window has settled (and again after one is used). */
function warmSpare() {
  setTimeout(() => {
    if (spare) return;
    spareUp = false;
    spare = el("iframe", "sc-frame") as HTMLIFrameElement;
    spare.src = frameSrc(SPARE);
    layer.append(spare);
  }, 2000);
}

/** `id`'s frame: kept, the spare given it (when it has booted), or a new one. */
function frameFor(id: string): HTMLIFrameElement {
  let frame = frames.get(id);
  frames.delete(id);
  const side = spareUp ? spare?.contentWindow?.__bismuthSide : undefined;
  if (!frame && spare && side) {
    frame = spare;
    spare = null;
    side.show(id);
    warmSpare();
  }
  if (!frame) {
    frame = el("iframe", "sc-frame") as HTMLIFrameElement;
    frame.src = frameSrc(id);
    layer.append(frame);
  }
  frames.set(id, frame);
  return frame;
}

/** `tab`'s side chat on its way into a frame: settles when the frame shows it, or after `ms` regardless. */
export function prepareSideChat(tab: string, ms: number): Promise<void> {
  const id = sideOf(tab);
  if (frameFor(id).classList.contains("ready")) return Promise.resolve();
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    setTimeout(resolve, ms);
  });
}

/** The layer showing `tab`'s side chat (its frame made now, the first time), or hidden (null: the panel shows
 *  something else). Its frame comes into view once it has the session on screen. */
export function showSideChat(tab: string | null) {
  if (!tab) return void layer.classList.remove("shown");
  const id = sideOf(tab);
  frameFor(id);
  for (const [k, f] of frames) f.classList.toggle("shown", k === id);
  while (frames.size > KEEP + 1) dropSideChat(SIDE_TAB + frames.keys().next().value!);
  layer.classList.add("shown");
}

/** A tab closed (or its session gone): its frame let go of. */
export function dropSideChat(tab: string) {
  const id = sideOf(tab);
  frames.get(id)?.remove();
  frames.delete(id);
}

/** Typing goes to a side chat's composer. */
export function focusSideChat(tab: string) {
  const frame = frames.get(sideOf(tab));
  frame?.contentWindow?.focus();
  frame?.contentWindow?.__bismuthSide?.focus();
}

// ---------------- in the frame ----------------

/** The window around this side chat's frame. */
export const host = () => (sideChat ? window.parent.__bismuthHost : undefined);

/** A key pressed in a side chat's frame: the app's shortcuts go to the window around it (its composer's own stay). True
 *  when it went. */
export function forwardKey(e: KeyboardEvent): boolean {
  const combo = comboFromEvent(e);
  if (!combo || [prefs.keymap.stopTurn, prefs.keymap.removeImage, prefs.keymap.openModelPicker].includes(combo)) return false;
  if (!["mod-k", "mod-,", "mod-w"].includes(combo) && !SHORTCUTS.some((s) => prefs.keymap[s] === combo)) return false;
  const h = host();
  if (!h) return false;
  e.preventDefault();
  e.stopPropagation();
  h.key({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
  return true;
}
