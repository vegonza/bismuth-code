// Motion for a list rebuilt from scratch (t3code's Sidebar.motion.ts): pieces that stay glide from where they were to
// where they land (a settled session slides down onto its shelf, a busy one up to the top), new ones fade in and gone
// ones fade out, each riding the travel of the piece above it so a shelf opening arrives as one block. Pieces are
// matched across the rebuild by key, since the rebuild makes every element anew.
import { reducedMotion } from "./motion";

const TIMING: KeyframeAnimationOptions = { duration: 150, easing: "ease-out" };
/** A piece with no moving neighbour travels on its own, clamped so a tall card doesn't slide its whole height. */
const travelOf = (height: number) => Math.min(height, 40);
/** A big swap (regrouping, a long shelf opening) just changes: fading that many pieces costs more than it shows. */
const MAX_FADES = 40;

type Box = { el: HTMLElement; top: number; left: number; width: number; height: number };

/** Fading copies of removed pieces, carried across the next rebuild so it doesn't cut them off. */
const exiting = new WeakMap<HTMLElement, Set<HTMLElement>>();

/** Where each piece shows, relative to the list's content (mid-glide pieces where they are on screen). */
function measure(root: HTMLElement, pieces: Map<string, HTMLElement>): Map<string, Box> {
  const origin = root.getBoundingClientRect();
  const out = new Map<string, Box>();
  for (const [key, el] of pieces) {
    const r = el.getBoundingClientRect();
    out.set(key, { el, top: r.top - origin.top + root.scrollTop, left: r.left - origin.left + root.scrollLeft, width: r.width, height: r.height });
  }
  return out;
}

/** Run `rebuild` (which replaces the list's contents) with the change animated. `pieces` keys what's in the list. */
export function withListMotion(root: HTMLElement, pieces: (root: HTMLElement) => Map<string, HTMLElement>, rebuild: () => void) {
  const before = measure(root, pieces(root));
  rebuild();
  const leaving = exiting.get(root) ?? new Set<HTMLElement>();
  exiting.set(root, leaving);
  root.append(...leaving);
  const after = measure(root, pieces(root));

  const gone = [...before.keys()].filter((k) => !after.has(k) && before.get(k)!.height > 0);
  const added = [...after.keys()].filter((k) => !before.has(k) && after.get(k)!.height > 0);
  // Nothing on screen before (the first list from the core) or hidden now: no motion.
  if (reducedMotion() || !before.size || !root.clientHeight || gone.length + added.length > MAX_FADES) return;

  const moved = new Map<string, number>();
  for (const [key, box] of after) {
    const was = before.get(key);
    if (was && Math.abs(was.top - box.top) > 0.5) moved.set(key, was.top - box.top);
  }
  /** The travel of the nearest piece above that's in both lists (0 if it held still), or undefined. */
  const riding = (order: string[], at: number, kept: Map<string, Box>) => {
    for (let i = at - 1; i >= 0; i--) {
      if (moved.has(order[i])) return moved.get(order[i])!;
      if (kept.has(order[i])) return 0;
    }
    return undefined;
  };

  for (const [key, delta] of moved) after.get(key)!.el.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], TIMING);
  const newOrder = [...after.keys()];
  for (const key of added) {
    const box = after.get(key)!;
    const travel = riding(newOrder, newOrder.indexOf(key), before) ?? -travelOf(box.height);
    box.el.animate([{ opacity: 0, transform: `translateY(${travel}px)` }, { opacity: 1, transform: "translateY(0)" }], TIMING);
  }
  const oldOrder = [...before.keys()];
  for (const key of gone) {
    const box = before.get(key)!;
    const delta = riding(oldOrder, oldOrder.indexOf(key), after);
    // A copy stays for the fade (the real one is gone with the rebuild), under the pieces closing over it.
    const ghost = box.el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-id");
    ghost.inert = true;
    Object.assign(ghost.style, { position: "absolute", top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px`, margin: "0", boxSizing: "border-box", pointerEvents: "none", transform: "none", zIndex: "-1" });
    root.append(ghost);
    leaving.add(ghost);
    const fade = ghost.animate([{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: `translateY(${delta === undefined ? travelOf(box.height) : -delta}px)` }], TIMING);
    fade.onfinish = () => (ghost.remove(), leaving.delete(ghost));
  }
}
