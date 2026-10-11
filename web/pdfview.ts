// The file viewer's PDFs (pdf.js): every page down one scroll, fitted to the column's width, drawn only as it nears
// the view (and let go of far from it), with a text layer over it so text selects and copies. Ctrl+wheel (or a pinch)
// zooms about the pointer: the pages are laid out at the new size each frame (their drawings stretched), and drawn
// sharp once it settles. Under it, a page bar: the page in view of how many, typed into to go to another.
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs" with { type: "file" };
import { el } from "./dom";
import "./viewers.css";

GlobalWorkerOptions.workerSrc = workerUrl;

/** The column's padding (viewers.css .pdf). */
const PAD = 16;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
/** Pages this far (in viewports) past the edges are drawn ahead of the scroll; past it they're let go. */
const AHEAD = "150% 0px";
/** Zoom per wheel pixel with Ctrl held (a notch is ~100px: about 1.6×). */
const WHEEL_RATE = 0.005;
/** A pinch (Ctrl+wheel without Ctrl down) follows the fingers: Chromium sends -100·ln(scale) as its delta. */
const PINCH_RATE = 0.01;
/** A zoom settles this long after its last wheel step. */
const SETTLE_MS = 180;
/** A page's drawing is capped at this many pixels (pdf.js's own limit is 2^25); past it, it shows a little soft. */
const MAX_CANVAS_PIXELS = 16_777_216;

/** `drawn`: the scale the canvas shows (0: none). The text layer is drawn once: it scales with --scale-factor. */
type Page = { box: HTMLElement; page: PDFPageProxy; w: number; h: number; drawn: number; task: { cancel(): void } | null; canvas: HTMLCanvasElement | null; text: HTMLElement | null };
type View = { root: HTMLElement; bar: HTMLElement; mtime: number; doc: Promise<PDFDocumentProxy | null>; destroy(): void };

/** Whether Ctrl is physically down: a pinch arrives as Ctrl+wheel without it. */
let ctrlDown = false;
window.addEventListener("keydown", (e: KeyboardEvent) => e.key === "Control" && (ctrlDown = true), true);
window.addEventListener("keyup", (e: KeyboardEvent) => e.key === "Control" && (ctrlDown = false), true);
window.addEventListener("blur", () => (ctrlDown = false));

/** Views stay alive across the host's redraws (their canvases with them), one per open file. */
const views = new Map<string, View>();

/** The view of the PDF at `url`; the same one again while the file's unchanged (`mtime`). */
export function pdfView(key: string, url: string, mtime: number): HTMLElement {
  const had = views.get(key);
  if (had?.mtime === mtime) return had.root;
  had?.destroy();
  const view = open(url, mtime);
  views.set(key, view);
  return view.root;
}

/** The page bar of the PDF view at `key` (floats over the column's foot; the host puts it beside the scroller). */
export function pdfBar(key: string): HTMLElement | null {
  return views.get(key)?.bar ?? null;
}

/** The file's tab closed: its document and drawings go. */
export function dropPdf(key: string) {
  views.get(key)?.destroy();
  views.delete(key);
}

/** A PDF's first page drawn once (a LaTeX document's figure), at its own size (`style.width`, px) and sharp to twice
 *  that. Rejects when it can't be read. */
export async function pdfFigure(url: string): Promise<HTMLCanvasElement> {
  const task = getDocument({ url });
  try {
    const page = await (await task.promise).getPage(1);
    const css = page.getViewport({ scale: 96 / 72 });
    const ratio = Math.min((devicePixelRatio || 1) * 2, Math.sqrt(MAX_CANVAS_PIXELS / (css.width * css.height)));
    const viewport = page.getViewport({ scale: (96 / 72) * ratio });
    const canvas = el("canvas", "pdf-figure");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${css.width}px`;
    await page.render({ canvas, viewport }).promise;
    return canvas;
  } finally {
    void task.destroy();
  }
}

function open(url: string, mtime: number): View {
  const root = el("div", "pdf");
  const note = el("div", "fv-note", "");
  root.append(note);
  const task = getDocument({ url });
  const bar = el("div", "pdf-bar");
  bar.hidden = true;
  const input = el("input", "pdf-bar-input");
  input.inputMode = "numeric";
  input.setAttribute("aria-label", "Page");
  const count = el("span", "pdf-bar-count");
  bar.append(input, count);
  let current = 0;
  let pages: Page[] = [];
  let zoom = 1;
  let fit = 0;
  let gone = false;
  /** A zoom under way: the steps not yet laid out (a factor), and the pointer they're about. */
  let gesture: { k: number; x: number; y: number; frame: number } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const scale = () => fit * zoom;
  const scroller = () => (root.parentElement ?? root) as HTMLElement;
  const observer = new IntersectionObserver(
    (seen) =>
      seen.forEach((e) => {
        const p = pages[+(e.target as HTMLElement).dataset.n!];
        if (e.isIntersecting) draw(p);
        else release(p);
      }),
    { rootMargin: AHEAD },
  );

  /** The scale that fits the widest page to the column (0: not laid out). */
  const fitNow = () => Math.max(0, scroller().clientWidth - PAD * 2) / Math.max(...pages.map((p) => p.w));

  /** Every page at the current scale (the drawings stretch until they're drawn again). */
  function size() {
    if (!fit || !pages.length) return;
    const s = scale();
    for (const p of pages) {
      p.box.style.width = `${p.w * s}px`;
      p.box.style.height = `${p.h * s}px`;
      p.box.style.setProperty("--scale-factor", String(s));
    }
  }

  /** The pages in and around the view, drawn again at the scale they show at: nearest the middle first. */
  function redrawNear() {
    const v = scroller().getBoundingClientRect();
    const mid = (v.top + v.bottom) / 2;
    const near: { p: Page; d: number }[] = [];
    for (const p of pages) {
      const r = p.box.getBoundingClientRect();
      if (r.bottom > v.top - v.height && r.top < v.bottom + v.height) near.push({ p, d: Math.abs((r.top + r.bottom) / 2 - mid) });
    }
    for (const { p } of near.sort((a, b) => a.d - b.d)) draw(p);
  }

  async function draw(p: Page | undefined) {
    if (!p || gone || gesture) return;
    const s = scale();
    if (p.drawn === s) return;
    p.task?.cancel();
    p.drawn = s;
    const viewport = p.page.getViewport({ scale: s });
    const area = viewport.width * viewport.height;
    const ratio = Math.min(devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / area));
    const canvas = el("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    const render = p.page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    p.task = render;
    try {
      await render.promise;
    } catch {
      // Cancelled: by a newer drawing (which set its own scale), or by a zoom or a scroll away (drawn again later).
      if (p.drawn === s) p.drawn = 0;
      return;
    }
    if (p.drawn !== s || gone) return;
    p.task = null;
    // The new drawing replaces the stretched one only once it's done.
    p.canvas?.remove();
    p.canvas = canvas;
    p.box.prepend(canvas);
    if (!p.text) {
      p.text = el("div", "textLayer");
      p.box.append(p.text);
      await new TextLayer({ textContentSource: p.page.streamTextContent(), container: p.text, viewport }).render().catch(() => {});
    }
  }

  /** Far from the view: its drawing goes (memory), its text stays. */
  function release(p: Page | undefined) {
    if (!p || !p.drawn) return;
    p.task?.cancel();
    p.task = null;
    p.canvas?.remove();
    p.canvas = null;
    p.drawn = 0;
  }

  const doc = task.promise.then(
    async (d) => {
      if (gone) return null;
      pages = await Promise.all(
        Array.from({ length: d.numPages }, async (_, i) => {
          const page = await d.getPage(i + 1);
          const v = page.getViewport({ scale: 1 });
          const box = el("div", "pdf-page");
          box.dataset.n = String(i);
          return { box, page, w: v.width, h: v.height, drawn: 0, task: null, canvas: null, text: null } satisfies Page;
        }),
      );
      if (gone) return null;
      root.replaceChildren(...pages.map((p) => p.box));
      refit();
      count.textContent = `/ ${pages.length}`;
      // Wide enough for the longest page number.
      input.style.width = `${String(pages.length).length + 1}ch`;
      bar.hidden = false;
      track();
      for (const p of pages) observer.observe(p.box);
      return d;
    },
    (err: any) => {
      note.textContent = /password/i.test(String(err?.name)) ? "This PDF is password protected" : `Couldn't open this PDF · ${err?.message ?? err}`;
      return null;
    },
  );

  // ---- the page bar ----

  /** The page in view: the last one whose top is above 40% of the way down the view. */
  function pageInView(): number {
    const v = scroller().getBoundingClientRect();
    const line = v.top + v.height * 0.4;
    let n = 0;
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].box.getBoundingClientRect().top > line) break;
      n = i;
    }
    return n;
  }

  function showPage(n: number) {
    current = n;
    if (document.activeElement !== input) input.value = String(n + 1);
  }

  // The scroller may be swapped by the host, so scrolls are caught on their way up (they don't bubble; capture does).
  let trackFrame = 0;
  function track() {
    if (trackFrame || !pages.length) return;
    trackFrame = requestAnimationFrame(() => {
      trackFrame = 0;
      if (!gone && root.isConnected) showPage(pageInView());
    });
  }
  const onScroll = (e: Event) => e.target === root.parentElement && track();
  document.addEventListener("scroll", onScroll, true);

  /** Page `n` (0-based) at the top of the view, just its gap above it showing. */
  function goTo(n: number) {
    const p = pages[Math.max(0, Math.min(pages.length - 1, n))];
    if (!p) return;
    const sc = scroller();
    sc.scrollTop += p.box.getBoundingClientRect().top - sc.getBoundingClientRect().top - PAD;
    showPage(pages.indexOf(p));
  }

  input.addEventListener("focus", () => input.select());
  input.addEventListener("blur", () => showPage(current));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const n = parseInt(input.value, 10);
      if (Number.isFinite(n)) goTo(n - 1);
      input.value = String(current + 1);
      input.select();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.blur();
      scroller().focus({ preventScroll: true });
    }
  });

  // A new column width fits the pages again (after the resize settles, so a drag isn't redrawn per frame), what's at
  // the top middle of the view staying there. Only here: a zoom step picking up a new width would jump. Not mid-zoom:
  // it's looked at again once the zoom settles.
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  function refit() {
    if (gesture || gone || !pages.length) return;
    const next = fitNow();
    if (!next || next === fit) return;
    if (!fit) {
      fit = next;
      size();
    } else {
      const v = scroller().getBoundingClientRect();
      anchored(v.left + v.width / 2, v.top + 1, () => {
        fit = next;
        size();
      });
    }
    redrawNear();
  }
  // The column is watched, not the pages: zoomed past its width, they don't change size with it. It's the parent the
  // view was last put in (the host may move it).
  let watched: Element | null = null;
  const resize = new ResizeObserver(() => {
    if (root.parentElement && root.parentElement !== watched) {
      if (watched) resize.unobserve(watched);
      resize.observe((watched = root.parentElement));
    }
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refit, fit ? 120 : 0);
  });
  resize.observe(root);

  // Ctrl+wheel (and a trackpad's pinch, which arrives as one) zooms about the pointer. Steps are gathered per frame
  // and laid out for real (not a transform: that shrinks the scroll range and the browser clamps it, so the pages
  // jumped), the point under the pointer kept under it. Drawing waits until the steps stop.
  root.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || !pages.length) return;
      e.preventDefault();
      if (!gesture) {
        gesture = { k: 1, x: 0, y: 0, frame: 0 };
        for (const p of pages) p.task?.cancel();
        root.classList.add("zooming");
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      gesture.k *= Math.exp(-dy * (ctrlDown ? WHEEL_RATE : PINCH_RATE));
      gesture.x = e.clientX;
      gesture.y = e.clientY;
      if (!gesture.frame) gesture.frame = requestAnimationFrame(step);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, SETTLE_MS);
    },
    { passive: false },
  );

  /** The page under the client point (or the nearest one). */
  function pageAt(x: number, y: number): Page {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".pdf-page");
    if (hit && root.contains(hit)) return pages[+hit.dataset.n!];
    let best = pages[0];
    let off = Infinity;
    for (const p of pages) {
      const r = p.box.getBoundingClientRect();
      const d = y < r.top ? r.top - y : Math.max(0, y - r.bottom);
      if (d < off) (off = d), (best = p);
    }
    return best;
  }

  /** `change` to the layout, with the point at client (x, y) on its page put back there. */
  function anchored(x: number, y: number, change: () => void) {
    const p = pageAt(x, y);
    const before = p.box.getBoundingClientRect();
    const fx = (x - before.left) / before.width;
    const fy = (y - before.top) / before.height;
    change();
    const sc = scroller();
    const after = p.box.getBoundingClientRect();
    sc.scrollLeft += after.left + fx * after.width - x;
    sc.scrollTop += after.top + fy * after.height - y;
  }

  /** One frame of a zoom: the gathered steps laid out about the pointer. */
  function step() {
    const g = gesture;
    if (!g || gone) return;
    g.frame = 0;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * g.k));
    g.k = 1;
    if (next === zoom) return;
    anchored(g.x, g.y, () => {
      zoom = next;
      size();
    });
  }

  function settle() {
    const g = gesture;
    if (!g || gone) return;
    if (g.frame) cancelAnimationFrame(g.frame);
    step();
    gesture = null;
    root.classList.remove("zooming");
    refit();
    redrawNear();
  }

  return {
    root,
    bar,
    mtime,
    doc,
    destroy() {
      gone = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (gesture?.frame) cancelAnimationFrame(gesture.frame);
      if (trackFrame) cancelAnimationFrame(trackFrame);
      document.removeEventListener("scroll", onScroll, true);
      observer.disconnect();
      resize.disconnect();
      for (const p of pages) p.task?.cancel();
      void task.destroy();
    },
  };
}
