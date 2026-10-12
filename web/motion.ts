// Zeron's motion catalog (crates/ui/src/motion.rs) for the DOM: exact cubic-bezier curves, wall-clock
// tweens that retarget from wherever they are, and Scritto's rolling label.

/** CSS `cubic-bezier(x1, y1, x2, y2)` as a function of progress. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const sample = (a: number, b: number, t: number) => ((1 - 3 * b + 3 * a) * t + (3 * b - 6 * a)) * t * t + 3 * a * t;
  const slope = (a: number, b: number, t: number) => 3 * (1 - 3 * b + 3 * a) * t * t + 2 * (3 * b - 6 * a) * t + 3 * a;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sample(x1, x2, t) - x;
      const d = slope(x1, x2, t);
      if (Math.abs(err) < 1e-6 || Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    t = Math.min(1, Math.max(0, t));
    return Math.min(1, Math.max(0, sample(y1, y2, t)));
  };
}

export const EASE_OUT = bezier(0, 0, 0.58, 1);
export const EASE_OUT_QUINT = bezier(0.22, 1, 0.36, 1);

/** Width/height/value transitions: Zeron's RESIZE, 200ms ease-out. */
export const RESIZE_MS = 200;

/** Settings → Reduce motion (or the system's, when it follows it): theme.ts keeps the class on <html> current. */
export const reducedMotion = () => document.documentElement.classList.contains("reduce-motion");

/** A scalar that glides to its target; retargeting mid-flight starts from the current value, never jumps. */
export class Tween {
  private from: number;
  private to: number;
  private started = 0;
  constructor(value: number, private ms = RESIZE_MS, private curve = EASE_OUT) {
    this.from = this.to = value;
  }
  get target() {
    return this.to;
  }
  value(now = performance.now()) {
    const raw = (now - this.started) / this.ms;
    return raw >= 1 ? this.to : this.from + (this.to - this.from) * this.curve(raw);
  }
  moving(now = performance.now()) {
    return now - this.started < this.ms && this.from !== this.to;
  }
  set(target: number, now = performance.now()) {
    if (target === this.to) return;
    this.from = reducedMotion() ? target : this.value(now);
    this.to = target;
    this.started = now;
  }
  /** Jump without animating (first placement, drags). */
  snap(value: number) {
    this.from = this.to = value;
    this.started = 0;
  }
}

/** Runs `frame` every animation frame while it returns true. Restarting while running is a no-op. */
export function animator(frame: (now: number) => boolean) {
  let raf = 0;
  const tick = (now: number) => {
    raf = frame(now) ? requestAnimationFrame(tick) : 0;
  };
  return () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
}

// ---------------- rolling labels ----------------

// Scritto's roll: {y: .35em, scale: .6, rotate: 2°, blur: .1em, stagger: .3} over 550ms ease-out-quint,
// while the label's width glides on the 200ms resize clock (narrowing, a beat behind the old glyphs leaving from the right).
const ROLL_MS = 550;
const STAGGER = 0.3;
const GLIDE = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Set `el`'s text, rolling the changed middle: characters shared at either end stay put (the trailing run
 * slides), old glyphs rise out and shrink away as new ones rise in from below. The first value never rolls,
 * nor do the values a reload settles through before its first screen is up.
 */
export function rollText(el: HTMLElement, text: string) {
  const prev = el.dataset.roll;
  if (prev === text) return;
  el.dataset.roll = text;
  if (prev === undefined || reducedMotion() || !el.isConnected || !window.__bismuthReady) {
    el.textContent = text;
    return;
  }
  const a = [...prev];
  const b = [...text];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldMid = a.slice(p, a.length - s);
  const newMid = b.slice(p, b.length - s);

  const glyphs = (chars: string[], cls: string) => {
    const layer = document.createElement("span");
    layer.className = cls;
    for (const ch of chars) {
      const g = document.createElement("span");
      g.className = "roll-glyph";
      g.textContent = ch;
      layer.append(g);
    }
    return layer;
  };
  const mid = document.createElement("span");
  mid.className = "roll-mid";
  const incoming = glyphs(newMid, "roll-in");
  const outgoing = glyphs(oldMid, "roll-out");
  mid.append(incoming, outgoing);
  el.replaceChildren(b.slice(0, p).join(""), mid, b.slice(b.length - s).join(""));

  // Separate glyphs set without kerning. Each one is spaced to where the plain text puts it, so the old glyphs start
  // where the label stood, the new ones land where the plain label takes over, and the width glides between the two.
  const setAsPlain = (layer: HTMLElement, chars: string[]) => {
    if (!chars.length) return 0;
    const probe = document.createElement("span");
    probe.className = "roll-out";
    probe.style.visibility = "hidden";
    probe.textContent = chars.join("");
    mid.append(probe);
    const text = probe.firstChild as Text;
    const range = document.createRange();
    const left = probe.getBoundingClientRect().left;
    let at = 0;
    const xs = chars.map((ch) => {
      range.setStart(text, at);
      range.setEnd(text, (at += ch.length));
      return range.getBoundingClientRect().left - left;
    });
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    [...layer.children].forEach((g, i) => {
      const advance = (i + 1 < xs.length ? xs[i + 1] : width) - xs[i];
      (g as HTMLElement).style.marginRight = `${advance - g.getBoundingClientRect().width}px`;
    });
    return width;
  };
  const oldW = setAsPlain(outgoing, oldMid);
  const newW = setAsPlain(incoming, newMid);
  // Narrowing, the old glyphs leave from the right and the trailing run follows them in, a beat behind: closing over
  // glyphs still rising out garbles the label.
  const narrowing = newW < oldW;
  mid.animate([{ width: `${oldW}px` }, { width: `${newW}px` }], { duration: RESIZE_MS, delay: narrowing ? ROLL_MS * 0.22 : 0, easing: "cubic-bezier(0, 0, 0.58, 1)", fill: "both" });
  const rest = "translateY(0) scale(1) rotate(0)";
  const away = (dir: number) => `translateY(${dir * 0.35}em) scale(0.6) rotate(2deg)`;
  const run = (layer: HTMLElement, enter: boolean, fromRight = false) => {
    const n = layer.children.length;
    [...layer.children].forEach((g, i) => {
      const delay = n > 1 ? ((fromRight ? n - 1 - i : i) / (n - 1)) * STAGGER * ROLL_MS : 0;
      const frames = [
        { transform: away(enter ? 1 : -1), opacity: 0, filter: "blur(0.1em)" },
        { transform: rest, opacity: 1, filter: "blur(0)" },
      ];
      g.animate(enter ? frames : frames.reverse(), { duration: ROLL_MS, delay, easing: GLIDE, fill: "both" });
    });
  };
  run(incoming, true);
  run(outgoing, false, narrowing);
  // Hand back to the plain label once everything has landed.
  setTimeout(() => {
    if (el.dataset.roll === text) el.textContent = text;
  }, ROLL_MS * (1 + STAGGER) + 20);
}
