// The context ring in the composer, right of the model picker (Zeron context_usage.rs), with used / full on hover.
// Plan limits show in Settings → Providers.
import { el } from "./dom";
import { store } from "./store";

const groupDigits = (n: number) => n.toLocaleString("en-US");

/** The 16px progress ring: a faint full track under an arc from twelve o'clock. */
export function ring(): { svg: SVGSVGElement; set: (f: number) => void } {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.classList.add("ring");
  const mk = (cls: string) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "8");
    c.setAttribute("cy", "8");
    c.setAttribute("r", "6");
    c.setAttribute("class", cls);
    svg.append(c);
    return c;
  };
  mk("track");
  const arc = mk("arc");
  const C = 2 * Math.PI * 6;
  return {
    svg,
    set(f: number) {
      const v = Math.min(1, Math.max(0, f));
      arc.setAttribute("stroke-dasharray", `${v * C} ${C}`);
      arc.style.opacity = v > 0 ? "1" : "0";
    },
  };
}

type Chip = { root: HTMLElement; update: (f: number, tone: string) => void };

/** Just the ring: the numbers show on hover. */
function ringChip(): Chip {
  const root = el("div", "ring-chip");
  const r = ring();
  root.append(r.svg);
  return {
    root,
    update(f, tone) {
      r.set(f);
      root.dataset.tone = tone;
    },
  };
}

// ---------------- reset times ----------------

/** How long until the window resets: "resets in 2d 4h", "3h 12m", "14m". */
export function resetText(at: number) {
  const mins = Math.max(0, Math.ceil((at - Date.now()) / 60_000));
  const [d, h, m] = [Math.floor(mins / 1440), Math.floor((mins % 1440) / 60), mins % 60];
  if (d) return `resets in ${d}d${h ? ` ${h}h` : ""}`;
  if (h) return `resets in ${h}h${m ? ` ${m}m` : ""}`;
  return mins ? `resets in ${m}m` : "resets now";
}

/** The ring's full mark: where the session auto-compacts, else the model's window. */
const fullAt = () => store.thread?.compactAt || store.thread?.contextWindow || 0;

// ---------------- context ring ----------------

let context: Chip;
let tip: HTMLElement;

/** The composer's context ring, beside the model picker; hovering it shows used / full. */
export function initContext(): HTMLElement {
  context = ringChip();
  context.root.classList.add("context");
  context.root.hidden = true;
  tip = el("div", "card ring-tip");
  context.root.append(tip);
  // Without a hover (a touch screen), a tap shows the numbers for a moment.
  let hide: ReturnType<typeof setTimeout> | undefined;
  context.root.onpointerup = (e) => {
    if (e.pointerType === "mouse") return;
    clearTimeout(hide);
    context.root.classList.add("tip-on");
    hide = setTimeout(() => context.root.classList.remove("tip-on"), 2500);
  };
  return context.root;
}

export function renderContext() {
  const t = store.thread;
  // Context occupancy toward auto-compaction, muted until it fills up; hidden until the harness reports a window.
  const full = fullAt();
  context.root.hidden = !full;
  if (!full) return;
  const tokens = t?.contextTokens ?? 0;
  const f = tokens / full;
  context.update(f, f >= 0.9 ? "danger" : f >= 0.75 ? "warning" : "muted");
  tip.textContent = `${groupDigits(tokens)} / ${groupDigits(full)}`;
}
