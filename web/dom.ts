// Small DOM + formatting helpers shared by the UI modules.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Label whose last glyphs fade out instead of an ellipsis (Zeron's sidebar labels). */
export const faded = (cls: string, text: string) => el("span", `${cls} fade`, text);

/** Arm the fade only on labels that actually overflow, so short ones stay crisp. */
export function fitFades(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".fade").forEach((f) => f.classList.toggle("clip", f.scrollWidth > f.clientWidth + 0.5));
}

/** Pictures under `root` still on their way: images loading, LaTeX figures not yet filled (latex.ts's placeholders). */
export const picturesPending = (root: HTMLElement) =>
  [...root.querySelectorAll("img")].some((i) => !i.complete) || !!root.querySelector("[data-tex-src]:not(:has(> img, > canvas, > .tex-note))");

/** Resolves once the pictures under `root` are in, or `ms` on regardless. */
export async function picturesIn(root: HTMLElement, ms: number) {
  for (const until = Date.now() + ms; picturesPending(root) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
}

/** A middle click on `host` (a three-finger tap on a touchpad) presses its copy `button`: the innermost block's when
 *  they nest, and not over a link, which a middle click opens. */
export function middleCopy(host: HTMLElement, button: HTMLElement) {
  host.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault()); // no autoscroll
  // Nor Linux's paste of the primary selection on release, which lands in whatever input has focus (the composer).
  host.addEventListener("mouseup", (e) => e.button === 1 && e.preventDefault());
  host.addEventListener("auxclick", (e) => {
    if (e.button !== 1 || e.defaultPrevented || (e.target as Element).closest("a")) return;
    e.preventDefault();
    button.click();
  });
}

export const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
export const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

// "now", "14m", "3h", "2d", "1w", "4mo"
export function timeAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo` : `${Math.floor(d / 365)}y`;
}

// "59s", "4m 12s", "1h 3m"
export function elapsed(secs: number) {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

// "Oct 8, 12:44 PM"; older than this year adds the year.
export function timestamp(ms: number) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  return `${date}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

const EFFORTS: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "X-High", "extra-high": "X-High", max: "Max", ultra: "Ultra" };
export const effortLabel = (e: string) => EFFORTS[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

/** The 2×3 accent activity glyph: a clockwise ring chase. Sidebar rows wear it while Working, browser tabs while
 *  loading, and the transcript's working trailer beside its word. */
export function miniSpinner(): HTMLElement {
  const box = el("span", "mspin");
  const ring = [[0, 1], [5, 2], [4, 3]];
  const tints = ["var(--glyph-light)", "var(--accent)", "var(--glyph-deep)"];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 2; col++) {
      const cell = el("i");
      cell.style.background = tints[row];
      cell.style.animationDelay = `${(-ring[row][col] / 6) * 0.75}s`;
      box.append(cell);
    }
  return box;
}

