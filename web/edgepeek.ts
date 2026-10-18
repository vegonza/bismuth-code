// The edge peek: a column put away (the files panel: panels.ts; the sessions sidebar: sidebar.ts) slides in over
// everything when the pointer touches its side of the window, and slides away once the pointer has left it for a
// moment. Followed by where the pointer is, not by enter/leave on a panel that moves under it.
import { $ } from "./dom";
import { RESIZE_MS } from "./motion";

/** How close to the window's edge counts as touching it: past the scrollbars, which stay usable. */
const EDGE_PX = 3;
const PEEK_LINGER = 100;
/** A menu beside the peek just closed (or a name typed in it was entered) with the pointer out past the panel: it
 *  stays while the pointer heads back to it, and goes once it strays GRACE_SLACK past the nearest it came, or rests
 *  (GRACE_MS) without coming nearer. */
const GRACE_MS = 1200;
const GRACE_SLACK = 16;

export type EdgePeek = {
  readonly peeking: boolean;
  start(): void;
  /** `refocus`: the composer takes the focus whether or not the panel had it. */
  end(refocus?: boolean): void;
  /** Docked while it peeks: it stays where it shows, the column making room under it, and settles into it after. */
  dock(): void;
  /** Something that held it open let go of it: with the pointer out past the panel, the grace begins. */
  released(): void;
  /** It goes after a moment, unless the pointer comes back or something holds it. */
  scheduleClose(): void;
  /** How far the pointer is out past the panel: 0 or less over it (or within a few pixels of its edge). */
  gap(): number;
};

type Options = {
  side: "left" | "right";
  panel: HTMLElement;
  /** On #app while it peeks; with `-shown` after it while it's out rather than sliding away (style.css). */
  cls: string;
  /** Whether it can come out now (put away, and nothing in the way of it). */
  peekable(): boolean;
  /** It stays while this holds (one of its menus open, a name being typed in it). */
  holding(): boolean;
  /** It's coming out: what it shows is drawn. */
  opening?(): void;
  /** The focus went with it: back to the composer. */
  refocus(): void;
};

const peeks: (EdgePeek & { pointer(x: number, buttons: number): void })[] = [];
/** Where the pointer last was, across the window. */
let pointerX = 0;

/** The pointer is at `x` across the window without moving it (dragged over something, which the page hears as drag
 *  events instead). */
export const notePointer = (x: number) => (pointerX = x);

function onPointer(x: number, buttons: number) {
  pointerX = x;
  for (const p of peeks) p.pointer(x, buttons);
}

/** The pointer at `x` across a frame's page `width` wide (a view's frame is scaled to its row, a browser tab's page drawn
 *  at its viewport's scale): at its place across the window. */
export function framePointer(frame: HTMLElement, x: number, buttons: number, width: number) {
  const box = frame.getBoundingClientRect();
  onPointer(box.left + (width > 0 ? (x * box.width) / width : x), buttons);
}

function listen() {
  addEventListener("pointermove", (e: PointerEvent) => e.pointerType === "mouse" && onPointer(e.clientX, e.buttons), { passive: true });
  // Every frame keeps the pointer's moves to itself: its page passes them on (an HTML preview's: previewDoc; a side
  // chat's: app.ts's initSide; a view's: view-bridge.js; a browser tab's: desktop/page-preload.cjs, by way of browser.ts).
  addEventListener("message", (e) => {
    const at = e.data?.bismuthPointer;
    if (!Array.isArray(at) || typeof at[0] !== "number" || typeof at[1] !== "number") return;
    const frame = [...document.querySelectorAll<HTMLIFrameElement>("iframe.fv-html, iframe.sc-frame, iframe.uiview")].find((f) => f.contentWindow === e.source);
    if (frame) framePointer(frame, at[0], at[1], frame.offsetWidth);
  });
  // The pointer gone from the window: it goes.
  document.documentElement.addEventListener("pointerleave", () => peeks.forEach((p) => p.peeking && p.scheduleClose()));
}

export function edgePeek(o: Options): EdgePeek {
  if (!peeks.length) listen();
  const app = $("app");
  const shown = `${o.cls}-shown`;
  const right = o.side === "right";
  let peeking = false;
  let closeTimer: Timer | null = null;
  let grace: { gap: number; timer: Timer } | null = null;

  const gap = () => (right ? innerWidth - o.panel.offsetWidth - 8 - pointerX : pointerX - o.panel.offsetWidth - 8);
  const cancelClose = () => closeTimer && (clearTimeout(closeTimer), (closeTimer = null));
  const endGrace = () => grace && (clearTimeout(grace.timer), (grace = null));
  const graceTimer = () =>
    setTimeout(() => {
      grace = null;
      if (peeking && !o.holding()) end();
    }, GRACE_MS);
  const restGrace = () => grace && (clearTimeout(grace.timer), (grace.timer = graceTimer()));

  function scheduleClose() {
    if (closeTimer || o.holding()) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (peeking && !o.holding()) end();
    }, PEEK_LINGER);
  }

  function start() {
    if (!o.peekable() || peeking) return;
    peeking = true;
    o.opening?.();
    // Placed off the edge first (at once: placing it isn't a slide), then slid in, from wherever it is should it still be
    // sliding out.
    if (!app.classList.contains(o.cls)) {
      o.panel.style.transition = "none";
      app.classList.add(o.cls);
      void o.panel.offsetWidth;
      o.panel.style.transition = "";
    }
    app.classList.add(shown);
  }

  function end(refocus = false) {
    cancelClose();
    endGrace();
    if (!peeking) return;
    peeking = false;
    const hadFocus = o.panel.contains(document.activeElement);
    app.classList.remove(shown);
    setTimeout(() => !peeking && app.classList.remove(o.cls), RESIZE_MS + 20);
    if (hadFocus || refocus) o.refocus();
  }

  const peek = {
    get peeking() {
      return peeking;
    },
    start,
    end,
    dock() {
      if (!peeking) return;
      peeking = false;
      cancelClose();
      endGrace();
      setTimeout(() => !peeking && app.classList.remove(o.cls, shown), RESIZE_MS + 20);
    },
    released() {
      const g = gap();
      if (!peeking || o.holding() || g <= 0) return;
      cancelClose();
      endGrace();
      grace = { gap: g, timer: graceTimer() };
    },
    scheduleClose,
    gap,
    pointer(x: number, buttons: number) {
      if (!peeking) {
        // Back over it while it's still sliding away: it comes back.
        const box = o.panel.getBoundingClientRect();
        if (app.classList.contains(o.cls) && !buttons && (right ? x >= box.left : x <= box.right)) return start();
        if ((right ? x >= innerWidth - EDGE_PX : x < EDGE_PX) && !buttons) start();
        return;
      }
      // Over the panel: it stays. Anywhere else: it goes, after a moment.
      const g = gap();
      if (g <= 0) return endGrace(), cancelClose();
      if (!grace) return scheduleClose();
      if (g > grace.gap + GRACE_SLACK) return end();
      if (g < grace.gap) (grace.gap = g), restGrace();
    },
  };
  peeks.push(peek);
  return peek;
}
