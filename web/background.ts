// The new-thread background (Zeron's new_thread_background_{image,effects,mask}.rs): an image across the top
// of the new-session screen, fading out downward and opening a soft cutout around the composer, optionally
// rebuilt by an effect (dither, ASCII, halftone, scanlines). The file lives in IndexedDB; its name and
// framing (focal point + zoom) in prefs, which remember the last few images used, each as it was left. Also the
// Adjust dialog that sets the framing. Or, instead of an image,
// an animation (web/lazy/), played through the same fade and cutout while the screen is up.
import { upload } from "./attachments";
import { $, el } from "./dom";
import { isPhone } from "./phone";
import { icon, type IconName } from "./icons";
import { loadSharks } from "./lazy";
import type { Scene } from "./lazy/sharks";
import { animator, reducedMotion } from "./motion";
import { prefs, setPrefs, onPrefs, type BackgroundAnimation, type BackgroundEffect, type BackgroundImage, type Framing } from "./prefs";
import { activeTheme, onTheme } from "./theme";
import { action } from "./widgets";

export const EFFECTS: { id: BackgroundEffect; label: string; description: string }[] = [
  { id: "none", label: "None", description: "Shows the original artwork." },
  { id: "dither", label: "Dither", description: "Rebuilds the artwork with a dithered color palette." },
  { id: "ascii", label: "ASCII", description: "Recreates the artwork with colored characters on black." },
  { id: "halftone", label: "Halftone", description: "Recreates the artwork with colored print dots on black." },
  { id: "scanlines", label: "Scanlines", description: "Adds a pronounced horizontal display-line texture." },
];

export const ANIMATIONS: { id: BackgroundAnimation; label: string; description: string; icon: IconName; load: () => Promise<{ createScene: (font: string) => Scene }> }[] = [
  { id: "sharks", label: "Sharks", description: "ASCII sharks hunting schools of fish.", icon: "fish", load: loadSharks },
];

/** Below 1× the artwork no longer covers the hero: it shrinks inside it and its bare edges fade out (fadeRamp). */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
/** The most of the artwork's width or height an edge fade may take. */
const EDGE_FADE = 0.2;
/** Dragged past the frame's edge, the share of the artwork (or of the frame, if smaller) that stays in view. */
const MIN_VISIBLE = 0.25;
const VIEWPORT_RATIO = 0.72;
const MAX_HEIGHT = 760;
const COMPOSER_RADIUS = 26;
/** The cutout's underlay: half-strength artwork through the cleared area. */
const REVEAL_OPACITY = 0.5;

export const heroHeight = () => Math.min(innerHeight * VIEWPORT_RATIO, MAX_HEIGHT);

// ---------------- storage ----------------

const DB = "bismuth";
const STORE = "blobs";
const KEY = "newThreadBackground";
/** Where an image's file is in IndexedDB. */
const blobKey = (bg: BackgroundImage) => (bg.id ? `${KEY}:${bg.id}` : KEY);
/** How many images are remembered. */
const RECENT = 10;

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = run(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------- source pixels ----------------

type Source = { url: string; width: number; height: number; colors: Uint8ClampedArray; luma: Uint8Array };
let source: Promise<Source | null> | null = null;
const rendered = new Map<string, HTMLCanvasElement>();

const sameImage = (a: BackgroundImage | null | undefined, b: BackgroundImage | null | undefined) => !!a && !!b && a.id === b.id && a.name === b.name;

/** An image's file: the core's copy, which every window shares, else this window's own. */
async function imageBlob(bg: BackgroundImage): Promise<Blob | undefined> {
  const shared = bg.path ? await fetch(`/attachment?path=${encodeURIComponent(bg.path)}`).then((r) => (r.ok ? r.blob() : undefined), () => undefined) : undefined;
  if (shared) return shared;
  const own = await idb<Blob | undefined>("readonly", (s) => s.get(blobKey(bg))).catch(() => undefined);
  // Chosen before images were shared: it goes to the core now, so other windows (a phone) get it too.
  if (own && !bg.path) void share(own, bg);
  return own;
}

async function share(blob: Blob, bg: BackgroundImage) {
  const path = await upload(blob, bg.name).catch(() => null);
  if (!path) return;
  const withPath = <T extends BackgroundImage>(b: T): T => (sameImage(b, bg) && !b.path ? { ...b, path } : b);
  setPrefs({ background: prefs.background && withPath(prefs.background), recentBackgrounds: prefs.recentBackgrounds.map(withPath) });
}

/** A URL to show a remembered image at (a menu's thumbnail); null if its file is gone. */
export async function imageUrl(bg: BackgroundImage): Promise<string | null> {
  if (bg.path) return `/attachment?path=${encodeURIComponent(bg.path)}`;
  const own = await idb<Blob | undefined>("readonly", (s) => s.get(blobKey(bg))).catch(() => undefined);
  return own ? URL.createObjectURL(own) : null;
}

/** Decode the image in use once, as a ≤2048px proxy with its luminance (BT.709). */
export function loadSource(): Promise<Source | null> {
  source ??= (async () => {
    const blob = prefs.background && (await imageBlob(prefs.background));
    if (!blob) return null;
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (!bitmap) return null;
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const c = new OffscreenCanvas(width, height).getContext("2d")!;
    c.drawImage(bitmap, 0, 0, width, height);
    const colors = c.getImageData(0, 0, width, height).data;
    const luma = new Uint8Array(width * height);
    for (let i = 0; i < luma.length; i++) luma[i] = Math.round(0.2126 * colors[i * 4] + 0.7152 * colors[i * 4 + 1] + 0.0722 * colors[i * 4 + 2]);
    return { url: URL.createObjectURL(blob), width, height, colors, luma };
  })();
  return source;
}

/** Show `bg` with `effect`, first among the remembered images; the oldest past RECENT is forgotten. */
function useImage(bg: BackgroundImage, effect: BackgroundEffect) {
  const recent = [{ ...bg, effect }, ...prefs.recentBackgrounds.filter((r) => !sameImage(r, bg))];
  for (const old of recent.slice(RECENT)) void idb("readwrite", (s) => s.delete(blobKey(old))).catch(() => {});
  if (!sameImage(bg, prefs.background)) forget();
  setPrefs({ background: bg, backgroundEffect: effect, backgroundAnimation: null, recentBackgrounds: recent.slice(0, RECENT) });
}

/** A file chosen: as it was left if it's one of the remembered images, else new, as is and centred. */
export async function setImage(file: File) {
  const known = prefs.recentBackgrounds.find((r) => r.name === file.name && r.size === file.size);
  if (known) return useImage(known, known.effect);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const bg: BackgroundImage = { id, name: file.name, size: file.size, focalX: 0.5, focalY: 0.5, zoom: 1 };
  await idb("readwrite", (s) => s.put(file, blobKey(bg)));
  // A format the core doesn't take (or one too large) stays this window's alone.
  const path = await upload(file, file.name).catch(() => undefined);
  useImage(path ? { ...bg, path } : bg, "none");
}

/** Back to a remembered image, framed and with the effect it had. */
export const useRecent = (bg: BackgroundImage & { effect: BackgroundEffect }) => useImage(bg, bg.effect);

/** A new framing or effect for the image in use, remembered with it. */
export function adjustImage(framing: Framing | null, effect = prefs.backgroundEffect) {
  if (prefs.background) useImage({ ...prefs.background, ...framing }, effect);
}

/** No background at all, or (`animation`) that animation in place of the image. The image stays remembered. */
export function clearBackground(animation: BackgroundAnimation | null = null) {
  forget();
  setPrefs({ background: null, backgroundAnimation: animation });
}

/** Stop remembering an image (and stop showing it, if it's the one in use). */
export function forgetRecent(bg: BackgroundImage) {
  void idb("readwrite", (s) => s.delete(blobKey(bg))).catch(() => {});
  if (sameImage(bg, prefs.background)) clearBackground();
  setPrefs({ recentBackgrounds: prefs.recentBackgrounds.filter((r) => !sameImage(r, bg)) });
}

function forget() {
  void source?.then((s) => s && URL.revokeObjectURL(s.url));
  source = null;
  rendered.clear();
}

// ---------------- effects (raster, at the proxy's resolution) ----------------

const ASCII_GLYPHS = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 4, 0],
  [0, 4, 0, 0, 4, 0, 0],
  [0, 0, 0, 14, 0, 0, 0],
  [0, 0, 14, 0, 14, 0, 0],
  [0, 4, 4, 31, 4, 4, 0],
  [0, 21, 14, 31, 14, 21, 0],
  [10, 10, 31, 10, 31, 10, 10],
  [17, 2, 4, 4, 8, 16, 17],
  [14, 17, 23, 21, 23, 16, 14],
];
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function applyEffect(s: Source, effect: BackgroundEffect, light: boolean): Uint8ClampedArray<ArrayBuffer> {
  const { width: w, height: h, colors: src, luma } = s;
  const out = new Uint8ClampedArray(src.length);
  const paper = light ? 255 : 0;
  if (effect === "scanlines") {
    for (let y = 0; y < h; y++) {
      const gain = y % 3 === 0 ? 0.52 : 1;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = light ? src[i + c] + (255 - src[i + c]) * (1 - gain) : src[i + c] * gain;
        out[i + 3] = src[i + 3];
      }
    }
  } else if (effect === "ascii") {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx = Math.min(Math.floor(x / 6) * 6 + 3, w - 1);
        const sy = Math.min(Math.floor(y / 8) * 8 + 4, h - 1);
        const sample = sy * w + sx;
        const density = light ? 255 - luma[sample] : luma[sample];
        const glyph = ASCII_GLYPHS[Math.floor(Math.sqrt(density / 255) * 9)];
        const ink = x % 6 < 5 && y % 8 < 7 && (glyph[y % 8] & (1 << (4 - (x % 6)))) !== 0;
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) out[i + c] = src[i + c] * 0.6 + (ink ? src[sample * 4 + c] : paper) * 0.4;
        out[i + 3] = src[i + 3];
      }
  } else if (effect === "halftone") {
    out.fill(paper);
    for (let y = 0; y < h; y += 4)
      for (let x = 0; x < w; x += 4) {
        let l = luma[y * w + x];
        if (light) l = 255 - l;
        const radius = 2 * (0.3 + 0.7 * Math.sqrt(l / 255));
        const d = (Math.min(y + 2, h - 1) * w + Math.min(x + 2, w - 1)) * 4;
        for (let dy = 0; dy < Math.min(4, h - y); dy++)
          for (let dx = 0; dx < Math.min(4, w - x); dx++) {
            const dist = Math.hypot(dx - 1.5, dy - 1.5);
            const cover = (Math.min(1, Math.max(0, radius + 0.5 - dist)) * src[d + 3]) / 255;
            const i = ((y + dy) * w + x + dx) * 4;
            for (let c = 0; c < 3; c++) out[i + c] = src[i + c] * 0.6 + (src[d + c] * cover + paper * (1 - cover)) * 0.4;
            out[i + 3] = src[i + 3];
          }
      }
  } else if (effect === "dither") {
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const p = (Math.min(y + 1, h - 1) * w + Math.min(x + 1, w - 1)) * 4;
        const peak = Math.max(src[p], src[p + 1], src[p + 2]);
        const bright = peak / 255 > (BAYER[(y / 2) % 4][(x / 2) % 4] + 0.5) / 16;
        const gain = bright ? 255 / Math.max(peak, 1) : 0.08;
        for (let dy = 0; dy < Math.min(2, h - y); dy++)
          for (let dx = 0; dx < Math.min(2, w - x); dx++) {
            const i = ((y + dy) * w + x + dx) * 4;
            for (let c = 0; c < 3; c++) out[i + c] = Math.round(src[p + c] * gain);
            out[i + 3] = src[p + 3];
          }
      }
  } else out.set(src);
  return out;
}

/** The artwork with the current effect, rendered once per (effect, light) pair. */
async function artwork(): Promise<{ canvas: HTMLCanvasElement; source: Source } | null> {
  const s = await loadSource();
  if (!s) return null;
  const effect = prefs.backgroundEffect;
  // Light themes print on white paper; dither and the original don't depend on it.
  const light = activeTheme().appearance === "light" && effect !== "none" && effect !== "dither";
  const key = `${effect}:${light}`;
  let canvas = rendered.get(key);
  if (!canvas) {
    canvas = el("canvas");
    canvas.width = s.width;
    canvas.height = s.height;
    canvas.getContext("2d")!.putImageData(new ImageData(applyEffect(s, effect, light), s.width, s.height), 0, 0);
    rendered.set(key, canvas);
  }
  return { canvas, source: s };
}

// ---------------- framing ----------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const normalized = (f: Framing): Required<Framing> => ({
  focalX: clamp(f.focalX, 0, 1),
  focalY: clamp(f.focalY, 0, 1),
  zoom: clamp(f.zoom, MIN_ZOOM, MAX_ZOOM),
  shiftX: f.shiftX ?? 0,
  shiftY: f.shiftY ?? 0,
});

/** How far one axis of the artwork (`size` long, in a frame `extent` long) may go: off either edge, but never
 *  out of view. */
const reach = (size: number, extent: number) => {
  const keep = Math.min(size, extent) * MIN_VISIBLE;
  return [keep - size, extent - keep] as const;
};

/** One axis of the placement: the artwork's point `focal` at the frame's point `focal` (so while it's within
 *  the frame, or covers it, a resize keeps it so), then pushed `shift` of its own length past that. */
function place(size: number, extent: number, focal: number, shift: number) {
  const [lo, hi] = reach(size, extent);
  return clamp((extent - size) * focal + shift * size, lo, hi);
}

/** The focal and shift that put one axis at `to`: the focal alone while the artwork stays within or covers the
 *  frame, else the bound it passed plus the shift beyond. */
function aim(size: number, extent: number, focal: number, to: number): [number, number] {
  to = clamp(to, ...reach(size, extent));
  // Focal 0 aligns the leading edges (at 0), focal 1 the trailing ones (at `span`).
  const span = extent - size;
  if (to >= Math.min(0, span) && to <= Math.max(0, span)) return [span ? to / span : focal, 0];
  const bound = span === 0 ? focal : (to < 0) === (span < 0) ? 1 : 0;
  return [bound, (to - span * bound) / size];
}

/** Cover-fit `sw×sh` into `w×h`, scaled by the zoom, and placed by the focal point and shift. */
export function fitted(sw: number, sh: number, w: number, h: number, framing: Framing) {
  const f = normalized(framing);
  const cover = Math.max(w / sw, h / sh);
  const fw = sw * cover * f.zoom;
  const fh = sh * cover * f.zoom;
  return { x: place(fw, w, f.focalX, f.shiftX), y: place(fh, h, f.focalY, f.shiftY), w: fw, h: fh };
}

/** The framing that puts the artwork's top-left corner at (x, y), at its current zoom. */
function moveTo(sw: number, sh: number, w: number, h: number, framing: Framing, x: number, y: number): Framing {
  const f = normalized(framing);
  const g = fitted(sw, sh, w, h, f);
  const [focalX, shiftX] = aim(g.w, w, f.focalX, x);
  const [focalY, shiftY] = aim(g.h, h, f.focalY, y);
  return { ...f, focalX, focalY, shiftX, shiftY };
}

/** A drag of (dx, dy) px moves the image with the pointer, past the frame's edges if need be. */
export function pan(sw: number, sh: number, w: number, h: number, framing: Framing, dx: number, dy: number): Framing {
  const g = fitted(sw, sh, w, h, framing);
  return moveTo(sw, sh, w, h, framing, g.x + dx, g.y + dy);
}

/** Change magnification keeping the image point under (ax, ay) in place. */
export function zoomAround(sw: number, sh: number, w: number, h: number, framing: Framing, zoom: number, ax = w / 2, ay = h / 2): Framing {
  const prev = fitted(sw, sh, w, h, framing);
  const next = normalized({ ...framing, zoom });
  const g = fitted(sw, sh, w, h, next);
  return moveTo(sw, sh, w, h, next, ax - ((ax - prev.x) / prev.w) * g.w, ay - ((ay - prev.y) / prev.h) * g.h);
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const RAMP_STEPS = [0, 0.2, 0.4, 0.6, 0.8, 1];

/** The artwork's alpha along one axis, as (px from its leading edge, alpha) stops: where it stops short of the
 *  hero's edge it eases out toward it, over the gap's width up to EDGE_FADE of the artwork, so the fade grows
 *  in from nothing as you zoom out. Null when it reaches both edges. */
function fadeRamp(from: number, size: number, extent: number): [number, number][] | null {
  const lead = clamp(from, 0, size * EDGE_FADE);
  const trail = clamp(extent - from - size, 0, size * EDGE_FADE);
  if (!lead && !trail) return null;
  return [
    ...(lead ? RAMP_STEPS.map((t): [number, number] => [t * lead, smooth(t)]) : [[0, 1] as [number, number]]),
    ...(trail ? RAMP_STEPS.map((t): [number, number] => [size - trail + t * trail, 1 - smooth(t)]) : [[size, 1] as [number, number]]),
  ];
}

type Placement = { x: number; y: number; w: number; h: number };

/** Fade the bare edges of the artwork drawn at `g` on a `w×h` canvas. */
function fadeEdges(c: CanvasRenderingContext2D, g: Placement, w: number, h: number) {
  c.globalCompositeOperation = "destination-in";
  for (const horizontal of [true, false]) {
    const [from, size, extent] = horizontal ? [g.x, g.w, w] : [g.y, g.h, h];
    const ramp = fadeRamp(from, size, extent);
    if (!ramp) continue;
    const grad = horizontal ? c.createLinearGradient(0, 0, extent, 0) : c.createLinearGradient(0, 0, 0, extent);
    for (const [px, a] of ramp) grad.addColorStop(clamp((from + px) / extent, 0, 1), `rgba(0, 0, 0, ${a})`);
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
  }
}

/** The same fade as a CSS mask, for an element sized and placed at `g`. */
function edgeMask(g: Placement, w: number, h: number): string {
  const layer = (dir: string, ramp: [number, number][] | null) =>
    ramp ? `linear-gradient(${dir}, ${ramp.map(([px, a]) => `rgba(0, 0, 0, ${a}) ${px}px`).join(", ")})` : "linear-gradient(#000, #000)";
  const x = fadeRamp(g.x, g.w, w);
  const y = fadeRamp(g.y, g.h, h);
  return x || y ? `${layer("to right", x)}, ${layer("to bottom", y)}` : "none";
}

// ---------------- the hero ----------------

let hero: HTMLCanvasElement;
let painting = 0;

/** The composer's resting box inside #main, ignoring the route glide's transform. */
function composerBox(): DOMRect | null {
  const composer = document.querySelector<HTMLElement>("#dock .composer");
  if (!composer || !composer.offsetParent) return null;
  let x = 0;
  let y = 0;
  for (let n: HTMLElement | null = composer; n && n.id !== "main"; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return new DOMRect(x, y, composer.offsetWidth, composer.offsetHeight);
}

/** How strongly the hero shows at each point (its alpha): fading out from its top edge to its bottom, at half
 *  strength in a feathered cutout around the composer (open through the hero's bottom), full outside it. A `full`
 *  hero (an animation's, over the whole screen) doesn't fade, and its cutout only rings the composer. */
function heroMask(w: number, h: number, dpr: number, full = false): HTMLCanvasElement {
  const layer = () => {
    const c = el("canvas");
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [c, ctx] as const;
  };
  const [fade, fc] = layer();
  const grad = fc.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#000");
  grad.addColorStop(1, full ? "#000" : "transparent");
  fc.fillStyle = grad;
  fc.fillRect(0, 0, w, h);

  const [mask, mc] = layer();
  // Half strength everywhere, so the cutout reveals a softened background rather than nothing.
  mc.globalAlpha = REVEAL_OPACITY;
  mc.drawImage(fade, 0, 0, w, h);
  mc.globalAlpha = 1;
  const box = composerBox();
  if (!box) {
    mc.drawImage(fade, 0, 0, w, h);
    return mask;
  }
  const feather = full ? 120 : clamp(h * 0.52, 120, 280);
  const clearance = 8;
  const [cut, cc] = layer();
  cc.drawImage(fade, 0, 0, w, h);
  cc.globalCompositeOperation = "destination-out";
  cc.filter = `blur(${feather / 4}px)`;
  const grow = clearance + feather / 2;
  cc.beginPath();
  const bottom = full ? box.bottom : Math.max(box.bottom, h) + feather;
  cc.roundRect(box.x - grow, box.y - grow, box.width + grow * 2, bottom - box.y + grow * 2, COMPOSER_RADIUS + grow);
  cc.fill();
  mc.drawImage(cut, 0, 0, w, h);
  return mask;
}

let mask: HTMLCanvasElement | null = null;

/** Show only what the mask lets through of what's on the hero. */
function applyMask(ctx: CanvasRenderingContext2D) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask!, 0, 0);
  ctx.globalCompositeOperation = "source-over";
}

async function paintHero() {
  const main = $("main");
  // Only the new-session screen shows it; elsewhere the last frame just fades out.
  if (!main.classList.contains("new-thread")) return;
  const ticket = ++painting;
  const animation = prefs.backgroundAnimation;
  const art = !animation && prefs.background ? await artwork() : null;
  const live = animation ? await sceneFor(animation) : null;
  if (ticket !== painting) return;
  shown = live;
  const w = main.clientWidth;
  // An image crowns the screen; an animation fills it.
  const h = Math.round(live ? main.clientHeight : heroHeight());
  hero.hidden = !art && !live;
  if ((!art && !live) || !w || !h) return;
  const dpr = devicePixelRatio || 1;
  hero.width = Math.round(w * dpr);
  hero.height = Math.round(h * dpr);
  hero.style.height = `${h}px`;
  mask = heroMask(w, h, dpr, !!live);
  const ctx = hero.getContext("2d")!;

  if (live) {
    live.avoid(composerBox());
    live.resize(w, h, dpr);
    drawScene();
    playScene();
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const g = fitted(art!.source.width, art!.source.height, w, h, prefs.background!);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(art!.canvas, g.x, g.y, g.w, g.h);
  fadeEdges(ctx, g, w, h);
  applyMask(ctx);
}

let queued = false;
export function repaintHero() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    void paintHero();
  });
}

// ---------------- the animation ----------------

let scene: { id: BackgroundAnimation; scene: Promise<Scene | null> } | null = null;
const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";

/** The animation's scene, loaded the first time it's shown and kept while it stays the one chosen. */
function sceneFor(id: BackgroundAnimation): Promise<Scene | null> {
  if (scene?.id !== id) {
    const entry = ANIMATIONS.find((a) => a.id === id);
    scene = { id, scene: entry ? entry.load().then((m) => m.createScene(monoFont()), () => null) : Promise.resolve(null) };
  }
  return scene.scene;
}

/** The scene once it's loaded, if it's the one showing. */
let shown: Scene | null = null;

const TICK = 1 / 60;
/** Frames are drawn at 30 a second: the cells snap anyway, and the app stays open for hours. */
const FRAME = 1 / 30;

function drawScene() {
  if (!shown) return;
  const ctx = hero.getContext("2d")!;
  shown.draw(ctx, activeTheme().appearance === "light");
  applyMask(ctx);
}

/** Whether the animation should be moving: on screen, the window shown, and motion allowed. */
function playing() {
  const app = $("app");
  return (
    !!shown &&
    !hero.hidden &&
    $("main").classList.contains("new-thread") &&
    !document.hidden &&
    !reducedMotion() &&
    !document.documentElement.classList.contains("paused") &&
    !app.classList.contains("settings-open") &&
    !app.classList.contains("ph-home")
  );
}

let last = 0;
let owed = 0;
let sinceDrawn = 0;
const playScene = animator((now) => {
  if (!playing()) {
    last = 0;
    return false;
  }
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  owed += dt;
  sinceDrawn += dt;
  for (let i = 0; owed >= TICK && i < 4; i++, owed -= TICK) shown!.step(TICK);
  owed = Math.min(owed, TICK);
  if (sinceDrawn >= FRAME) {
    sinceDrawn = 0;
    drawScene();
  }
  return true;
});

/** Where the pointer is on the hero, or null once it's off it. */
function heroPoint(e: PointerEvent) {
  const r = hero.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  return x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y } : null;
}

export function initBackground() {
  hero = el("canvas", "nt-hero");
  hero.hidden = true;
  const main = $("main");
  main.prepend(hero);
  new ResizeObserver(repaintHero).observe(main);
  new MutationObserver(repaintHero).observe(main, { attributes: true, attributeFilter: ["class"] });
  const dock = $("dock");
  new ResizeObserver(repaintHero).observe(dock);
  new MutationObserver(repaintHero).observe(dock, { childList: true });
  addEventListener("resize", repaintHero);
  onTheme(repaintHero);
  onPrefs((prev) => {
    // Another window picked another image (or removed it): this one loads it afresh.
    if (!sameImage(prev.background, prefs.background) || (prev.background?.path && prev.background.path !== prefs.background?.path)) forget();
    if (prev.background !== prefs.background || prev.backgroundEffect !== prefs.backgroundEffect || prev.backgroundAnimation !== prefs.backgroundAnimation) repaintHero();
  });

  // The image in use before images were remembered becomes the first one remembered.
  if (prefs.background && !prefs.recentBackgrounds.some((r) => sameImage(r, prefs.background))) adjustImage(null);

  // The animation stops while it can't be seen and picks up where it was once it can.
  new MutationObserver(playScene).observe($("app"), { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(playScene).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", playScene);
  // Fish shy from the pointer, and scatter from a click on open water.
  main.addEventListener("pointermove", (e) => shown?.pointer(e.pointerType === "touch" ? null : heroPoint(e)), { passive: true });
  main.addEventListener("pointerleave", () => shown?.pointer(null));
  main.addEventListener("pointerdown", (e) => {
    const at = heroPoint(e);
    if (!at || !playing() || (e.target as Element).closest(".composer, button, a, input, textarea, select, [contenteditable], [role=button], .menu")) return;
    shown!.splash(at.x, at.y);
  });
  repaintHero();
}

// ---------------- Adjust dialog ----------------

const STEP = 0.1;

/** Size of the preview: the hero's proportions, scaled into the dialog. */
function previewSize() {
  const sidebar = isPhone() || $("app").classList.contains("sidebar-collapsed") ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w")) || 224;
  const heroW = Math.max(1, innerWidth - sidebar);
  const heroH = Math.max(1, heroHeight());
  const maxW = clamp(innerWidth - 84, 1, 556);
  const scale = Math.min(maxW / heroW, 258 / heroH);
  return { w: Math.round(heroW * scale), h: Math.round(heroH * scale) };
}

export async function openAdjust() {
  const s = await loadSource();
  const current = prefs.background;
  if (!current) return;
  let draft: Framing = normalized(current);

  const scrim = el("div", "s-scrim");
  const dialog = el("div", "s-dialog adjust-dialog menu-in");
  dialog.tabIndex = -1;
  const head = el("div", "s-dialog-head");
  const titles = el("div", "");
  titles.append(el("div", "s-dialog-title", "Adjust background"), el("div", "s-dialog-body", "Drag to reposition. Scroll or pinch to zoom."));
  const closeBtn = el("button", "s-dialog-close");
  closeBtn.setAttribute("aria-label", "Close background adjustment");
  closeBtn.append(icon("x"));
  head.append(titles, closeBtn);

  const { w, h } = previewSize();
  const stage = el("div", "adjust-stage");
  const frame = el("div", "adjust-frame");
  frame.style.width = `${w + 2}px`;
  frame.style.height = `${h + 2}px`;
  const img = el("img");
  img.alt = "";
  img.draggable = false;
  const thirds = el("div", "adjust-thirds");
  thirds.append(el("i"), el("i"), el("i"), el("i"));
  if (s) {
    img.src = s.url;
    frame.append(img, thirds);
  } else frame.append(el("div", "adjust-note", "Image unavailable. Choose a replacement or remove it."));
  stage.append(frame);

  const pct = el("span", "zoom-pct");
  const slider = el("div", "s-slider zoom");
  slider.tabIndex = 0;
  slider.setAttribute("role", "slider");
  slider.setAttribute("aria-label", "Background zoom");
  const track = el("div", "s-slider-track");
  const fill = el("div", "s-slider-fill");
  const knob = el("div", "s-slider-knob");
  track.append(fill, knob);
  slider.append(track);

  const paint = () => {
    draft = normalized(draft);
    if (s) {
      const g = fitted(s.width, s.height, w, h, draft);
      Object.assign(img.style, { width: `${g.w}px`, height: `${g.h}px`, transform: `translate(${g.x}px, ${g.y}px)`, maskImage: edgeMask(g, w, h) });
    }
    const f = (draft.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM);
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
    pct.textContent = `${Math.round(draft.zoom * 100)}%`;
    slider.setAttribute("aria-valuetext", pct.textContent);
  };
  const zoomTo = (z: number, ax?: number, ay?: number) => {
    draft = s ? zoomAround(s.width, s.height, w, h, draft, z, ax, ay) : { ...draft, zoom: z };
    paint();
  };

  // Drag to pan, wheel or pinch to zoom around the pointer.
  frame.onpointerdown = (e) => {
    if (!s) return;
    frame.setPointerCapture(e.pointerId);
    frame.classList.add("dragging");
    let last = { x: e.clientX, y: e.clientY };
    frame.onpointermove = (m) => {
      draft = pan(s.width, s.height, w, h, draft, m.clientX - last.x, m.clientY - last.y);
      last = { x: m.clientX, y: m.clientY };
      paint();
    };
    frame.onpointerup = frame.onpointercancel = () => {
      frame.onpointermove = null;
      frame.classList.remove("dragging");
    };
  };
  frame.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      zoomTo(draft.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - r.left - 1, e.clientY - r.top - 1);
    },
    { passive: false },
  );
  const zoomFromX = (x: number) => {
    const r = slider.getBoundingClientRect();
    zoomTo(MIN_ZOOM + clamp((x - r.left - 7) / Math.max(1, r.width - 14), 0, 1) * (MAX_ZOOM - MIN_ZOOM));
  };
  slider.onpointerdown = (e) => {
    slider.setPointerCapture(e.pointerId);
    zoomFromX(e.clientX);
    slider.onpointermove = (m) => zoomFromX(m.clientX);
    slider.onpointerup = () => (slider.onpointermove = null);
  };
  slider.onkeydown = (e) => {
    const to = { ArrowLeft: draft.zoom - STEP, ArrowDown: draft.zoom - STEP, ArrowRight: draft.zoom + STEP, ArrowUp: draft.zoom + STEP, Home: MIN_ZOOM, End: MAX_ZOOM }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    zoomTo(to);
  };

  const controls = el("div", "adjust-controls");
  const zoomBox = el("div", "adjust-zoom");
  const minus = action("", "filled", () => zoomTo(draft.zoom - STEP), "minus");
  minus.setAttribute("aria-label", "Zoom out");
  const plus = action("", "filled", () => zoomTo(draft.zoom + STEP), "plus");
  plus.setAttribute("aria-label", "Zoom in");
  zoomBox.append(minus, slider, pct, plus);
  controls.append(
    action("Reset", "filled", () => {
      draft = { focalX: 0.5, focalY: 0.5, zoom: 1 };
      paint();
    }),
    zoomBox,
  );

  const footer = el("div", "s-dialog-footer");
  const close = () => {
    scrim.remove();
    removeEventListener("keydown", onKey, true);
  };
  const apply = action("Apply", "solid", () => {
    adjustImage(normalized(draft));
    close();
  });
  apply.disabled = !s;
  footer.append(action("Cancel", "filled", close), apply);
  closeBtn.onclick = close;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  addEventListener("keydown", onKey, true);
  scrim.onpointerdown = (e) => e.target === scrim && close();

  dialog.append(head, stage, controls, footer);
  scrim.append(dialog);
  ($("settings") ?? document.body).append(scrim);
  paint();
  dialog.focus();
}
