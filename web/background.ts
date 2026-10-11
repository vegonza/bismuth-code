// The new-thread background (Zeron's new_thread_background_{image,effects,mask}.rs): an image across the top
// of the new-session screen, fading out downward and opening a soft cutout around the composer, optionally
// rebuilt by an effect (dither, ASCII, halftone, scanlines). The file lives in IndexedDB; its name and
// framing (focal point + zoom) in prefs. Also the Adjust dialog that sets the framing.
import { upload } from "./attachments";
import { $, el } from "./dom";
import { isPhone } from "./phone";
import { icon } from "./icons";
import { prefs, setPrefs, onPrefs, type BackgroundEffect, type Framing } from "./prefs";
import { activeTheme, onTheme } from "./theme";
import { action } from "./widgets";

export const EFFECTS: { id: BackgroundEffect; label: string; description: string }[] = [
  { id: "none", label: "None", description: "Shows the original artwork." },
  { id: "dither", label: "Dither", description: "Rebuilds the artwork with a dithered color palette." },
  { id: "ascii", label: "ASCII", description: "Recreates the artwork with colored characters on black." },
  { id: "halftone", label: "Halftone", description: "Recreates the artwork with colored print dots on black." },
  { id: "scanlines", label: "Scanlines", description: "Adds a pronounced horizontal display-line texture." },
];

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
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

/** The image: the core's copy, which every window shares, else this window's own. */
async function imageBlob(): Promise<Blob | undefined> {
  const bg = prefs.background;
  if (!bg) return undefined;
  const shared = bg.path ? await fetch(`/attachment?path=${encodeURIComponent(bg.path)}`).then((r) => (r.ok ? r.blob() : undefined), () => undefined) : undefined;
  if (shared) return shared;
  const own = await idb<Blob | undefined>("readonly", (s) => s.get(KEY)).catch(() => undefined);
  // Chosen before images were shared: it goes to the core now, so other windows (a phone) get it too.
  if (own && !bg.path) void share(own, bg.name);
  return own;
}

async function share(blob: Blob, name: string) {
  const path = await upload(blob, name).catch(() => null);
  if (path && prefs.background?.name === name && !prefs.background.path) setPrefs({ background: { ...prefs.background, path } });
}

/** Decode the stored image once, as a ≤2048px proxy with its luminance (BT.709). */
export function loadSource(): Promise<Source | null> {
  source ??= (async () => {
    const blob = await imageBlob();
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

export async function setImage(file: File) {
  await idb("readwrite", (s) => s.put(file, KEY));
  // A format the core doesn't take (or one too large) stays this window's alone.
  const path = await upload(file, file.name).catch(() => undefined);
  forget();
  setPrefs({ background: { name: file.name, ...(path ? { path } : {}), focalX: 0.5, focalY: 0.5, zoom: 1 } });
}

export async function removeImage() {
  await idb("readwrite", (s) => s.delete(KEY)).catch(() => {});
  forget();
  setPrefs({ background: null });
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
export const normalized = (f: Framing): Framing => ({ focalX: clamp(f.focalX, 0, 1), focalY: clamp(f.focalY, 0, 1), zoom: clamp(f.zoom, MIN_ZOOM, MAX_ZOOM) });

/** Cover-fit `sw×sh` into `w×h`, magnified by the zoom, with the overflow split by the focal point. */
export function fitted(sw: number, sh: number, w: number, h: number, framing: Framing) {
  const f = normalized(framing);
  const cover = Math.max(w / sw, h / sh);
  const fw = Math.max(w, sw * cover * f.zoom);
  const fh = Math.max(h, sh * cover * f.zoom);
  const ox = fw - w;
  const oy = fh - h;
  return { x: -ox * f.focalX, y: -oy * f.focalY, w: fw, h: fh, ox, oy };
}

/** A drag of (dx, dy) px moves the image with the pointer. */
export function pan(sw: number, sh: number, w: number, h: number, framing: Framing, dx: number, dy: number): Framing {
  const g = fitted(sw, sh, w, h, framing);
  return normalized({ ...framing, focalX: g.ox > 0 ? framing.focalX - dx / g.ox : framing.focalX, focalY: g.oy > 0 ? framing.focalY - dy / g.oy : framing.focalY });
}

/** Change magnification keeping the image point under (ax, ay) in place. */
export function zoomAround(sw: number, sh: number, w: number, h: number, framing: Framing, zoom: number, ax = w / 2, ay = h / 2): Framing {
  const prev = fitted(sw, sh, w, h, framing);
  const next = normalized({ ...framing, zoom });
  const g = fitted(sw, sh, w, h, next);
  const sx = (ax - prev.x) / prev.w;
  const sy = (ay - prev.y) / prev.h;
  if (g.ox > 0) next.focalX = (sx * g.w - ax) / g.ox;
  if (g.oy > 0) next.focalY = (sy * g.h - ay) / g.oy;
  return normalized(next);
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

async function paintHero() {
  const main = $("main");
  // Only the new-session screen shows it; elsewhere the last frame just fades out.
  if (!main.classList.contains("new-thread")) return;
  const ticket = ++painting;
  const art = prefs.background ? await artwork() : null;
  if (ticket !== painting) return;
  const w = main.clientWidth;
  const h = Math.round(heroHeight());
  hero.hidden = !art;
  if (!art || !w || !h) return;
  const dpr = devicePixelRatio || 1;
  hero.width = Math.round(w * dpr);
  hero.height = Math.round(h * dpr);
  hero.style.height = `${h}px`;
  const ctx = hero.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The artwork, fading out from the hero's top edge to its bottom.
  const layer = el("canvas");
  layer.width = hero.width;
  layer.height = hero.height;
  const lc = layer.getContext("2d")!;
  lc.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = fitted(art.source.width, art.source.height, w, h, prefs.background!);
  lc.imageSmoothingQuality = "high";
  lc.drawImage(art.canvas, g.x, g.y, g.w, g.h);
  lc.globalCompositeOperation = "destination-in";
  const fade = lc.createLinearGradient(0, 0, 0, h);
  fade.addColorStop(0, "#000");
  fade.addColorStop(1, "transparent");
  lc.fillStyle = fade;
  lc.fillRect(0, 0, w, h);

  ctx.clearRect(0, 0, w, h);
  // Pass one: half strength everywhere, so the cutout reveals a softened image rather than nothing.
  ctx.globalAlpha = REVEAL_OPACITY;
  ctx.drawImage(layer, 0, 0, w, h);
  ctx.globalAlpha = 1;
  // Pass two: full strength outside a feathered cutout around the composer, open through the hero's bottom.
  const box = composerBox();
  if (box) {
    const feather = clamp(h * 0.52, 120, 280);
    const clearance = 8;
    const cut = el("canvas");
    cut.width = hero.width;
    cut.height = hero.height;
    const cc = cut.getContext("2d")!;
    cc.setTransform(dpr, 0, 0, dpr, 0, 0);
    cc.drawImage(layer, 0, 0, w, h);
    cc.globalCompositeOperation = "destination-out";
    cc.filter = `blur(${feather / 4}px)`;
    const grow = clearance + feather / 2;
    cc.beginPath();
    cc.roundRect(box.x - grow, box.y - grow, box.width + grow * 2, Math.max(box.bottom, h) - box.y + grow * 2 + feather, COMPOSER_RADIUS + grow);
    cc.fill();
    ctx.drawImage(cut, 0, 0, w, h);
  } else ctx.drawImage(layer, 0, 0, w, h);
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

export function initBackground() {
  hero = el("canvas", "nt-hero");
  hero.hidden = true;
  $("main").prepend(hero);
  new ResizeObserver(repaintHero).observe($("main"));
  new MutationObserver(repaintHero).observe($("main"), { attributes: true, attributeFilter: ["class"] });
  const dock = $("dock");
  new ResizeObserver(repaintHero).observe(dock);
  new MutationObserver(repaintHero).observe(dock, { childList: true });
  addEventListener("resize", repaintHero);
  onTheme(repaintHero);
  onPrefs((prev) => {
    // Another window picked another image (or removed it): this one loads it afresh.
    if (prev.background?.name !== prefs.background?.name || (prev.background?.path && prev.background.path !== prefs.background?.path)) forget();
    if (prev.background !== prefs.background || prev.backgroundEffect !== prefs.backgroundEffect) repaintHero();
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
  let draft: Framing = { focalX: current.focalX, focalY: current.focalY, zoom: current.zoom };

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
      Object.assign(img.style, { width: `${g.w}px`, height: `${g.h}px`, transform: `translate(${g.x}px, ${g.y}px)` });
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
    if (prefs.background) setPrefs({ background: { ...prefs.background, ...normalized(draft) } });
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
