// Floating cards shared by menus: Zeron's menu-in/menu-out motion (travelling from the trigger's side),
// dismissal on outside presses, Escape, leaving the window or the trigger going, and the small parts menus are built from.
import { el } from "./dom";
import { icon, type IconName } from "./icons";
import { reducedMotion } from "./motion";

const MENU_OUT_MS = 100;

export type Popover = { card: HTMLElement; close: () => void };

/**
 * Mount `card` into `host` with the entrance motion; it closes on an outside press (ignoring `keep`, usually
 * the trigger, which toggles it itself) or Escape. `from` is the trigger's side: the card travels away from
 * it — up from a trigger below (default), down from one above, rightward from one on its left.
 */
export function openPopover(host: HTMLElement, card: HTMLElement, opts: { from?: "below" | "above" | "left"; keep?: HTMLElement[]; onClose?: () => void } = {}): Popover {
  const motion = { below: ["menu-in", "menu-out"], above: ["menu-in-down", "menu-out-down"], left: ["menu-in-side", "menu-out-side"] }[opts.from ?? "below"];
  card.classList.add(motion[0]);
  card.tabIndex = -1;
  host.append(card);
  let closed = false;
  const outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!card.contains(t) && !opts.keep?.some((k) => k.contains(t))) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  // Leaving the window (another app, or a press in a preview's frame, which the document never hears) closes it,
  // as a native menu; so does its trigger going (its panel closed or hidden, the screen changed under it).
  const left = () => close();
  const anchor = opts.keep?.[0];
  const watch = anchor && new IntersectionObserver(() => (!anchor.isConnected || !anchor.getClientRects().length) && close());
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
    removeEventListener("blur", left);
    watch?.disconnect();
    card.classList.remove(motion[0]);
    card.classList.add(motion[1]);
    card.style.pointerEvents = "none";
    setTimeout(() => card.remove(), reducedMotion() ? 0 : MENU_OUT_MS + 20);
    opts.onClose?.();
  }
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  addEventListener("blur", left);
  if (anchor) watch!.observe(anchor);
  card.focus({ preventScroll: true });
  return { card, close };
}

// ---------------- context menus ----------------
// Every action menu (a right click, or a ··· pressed with the mouse) is this one: a card at the pointer, as VS Code's.

export type MenuItem = { icon?: IconName; label: string; run: () => void; hint?: string; danger?: boolean; disabled?: boolean };
/** A menu's entries: items, "-" for a separator, or a row built by the caller (one with a switch, say). */
export type MenuEntry = MenuItem | "-" | HTMLElement;

let openMenu: Popover | null = null;

/** A menu row that closes the menu, then runs. */
export function menuItem(it: MenuItem): HTMLElement {
  const row = el("div", `menu-row${it.disabled ? " disabled" : ""}${it.danger ? " danger" : ""}`);
  if (it.icon) row.append(icon(it.icon, undefined, "lead"));
  row.append(el("span", "grow", it.label));
  if (it.hint) row.append(el("span", "value", it.hint));
  row.onclick = (e) => {
    e.stopPropagation();
    if (it.disabled) return;
    openMenu?.close();
    it.run();
  };
  return row;
}

/**
 * A menu at a point (the pointer, or a caret), kept inside the window; one open at a time. `trigger`: the button
 * that opened it, lit while it's open (and left to toggle it). `beside`: what it's for, marked while it's open.
 */
export function contextMenu(at: { x: number; y: number }, entries: MenuEntry[], opts: { trigger?: HTMLElement; beside?: HTMLElement | null; className?: string; onClose?: () => void } = {}): Popover {
  openMenu?.close();
  const card = el("div", `card ctx-menu${opts.className ? ` ${opts.className}` : ""}`);
  for (const it of entries) card.append(it === "-" ? menuSeparator() : it instanceof HTMLElement ? it : menuItem(it));
  card.oncontextmenu = (e) => e.preventDefault();
  card.onclick = (e) => e.stopPropagation();
  opts.trigger?.classList.add("on");
  opts.beside?.classList.add("menu-for");
  const pop = openPopover(document.body, card, {
    keep: opts.trigger ? [opts.trigger] : [],
    onClose: () => {
      if (openMenu === pop) openMenu = null;
      opts.trigger?.classList.remove("on");
      opts.beside?.classList.remove("menu-for");
      opts.onClose?.();
    },
  });
  openMenu = pop;
  placeMenu(card, at);
  return pop;
}

/** Where a ··· button's menu goes: at the pointer that pressed it, or (from the keyboard) under the button. */
export function menuPoint(e: MouseEvent | undefined, trigger: HTMLElement): { x: number; y: number } {
  if (e?.detail) return { x: e.clientX, y: e.clientY };
  const r = trigger.getBoundingClientRect();
  return { x: r.right, y: r.bottom + 4 };
}

/** A menu with a corner at the point: its top left there, flipped to the left or upwards where it wouldn't fit. */
function placeMenu(card: HTMLElement, at: { x: number; y: number }) {
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const x = at.x + w <= innerWidth - 8 ? at.x : at.x - w;
  const y = at.y + h <= innerHeight - 8 ? at.y : at.y - h;
  card.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  card.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
}

/** Small uppercase section heading inside a menu. */
export const menuHeading = (label: string) => el("div", "menu-heading", label);
export const menuSeparator = () => el("div", "menu-separator");

/** Zeron's settings switch: an accent track with on/off marks under a white thumb that travels 180ms. */
export function toggleSwitch(on: boolean): HTMLElement {
  const sw = el("span", `switch${on ? " on" : ""}`);
  const track = el("span", "track");
  track.append(el("span", "mark-on"), el("span", "mark-off"));
  sw.append(track, el("span", "thumb"));
  return sw;
}
