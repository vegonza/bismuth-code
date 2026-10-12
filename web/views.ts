// Views an agent rendered with the project's own frontend (bismuth's `render` tool, core/views.ts): each is a page the
// core built and serves at /view/<id>, framed in the transcript in a sandbox with no origin of its own and no network.
// The page (its script: view-bridge.js) reports its size: the frame takes the view's own width, lined up with the
// text when it fits the column and growing past it, centred, when it doesn't; and its height. It follows the
// theme's light/dark as it changes. A plain HTML view (a project with no view build of its own) is part of the reply:
// borderless, in bismuth's theme variables and fonts, sent to it when it says hello. A view rendered at a viewport
// width (`width`: a desktop layout's breakpoints) lays out at that width and is scaled down to fit the row.
import { el } from "./dom";
import { openCitedPath } from "./refs";
import { activeTheme, onTheme, themeVars } from "./theme";

/** The tool's name as every adapter names an MCP call: server · tool (`bismuth` in conversations from before the
 *  server was `bismuth-preview`). */
export const isViewTool = (name: string) => name === "bismuth-preview · render" || name === "bismuth · render";
const MIN_H = 40;
const MAX_H = 900;
/** Sizes views last reported, so a frame built again (a re-render, coming back to the thread) opens at its size. */
const sizes = new Map<string, { width: number | null; height: number }>();
/** Views known to be plain HTML, so a frame built again opens borderless. */
const plainViews = new Set<string>();
const frames = () => document.querySelectorAll<HTMLIFrameElement>("iframe.uiview");

const theme = () => (activeTheme().appearance === "dark" ? "dark" : "light");

/** What a plain view styles itself with: the theme's colours and the window's font settings. */
function vars(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const out = themeVars(theme());
  for (const name of ["--sans", "--mono", "--fs", "--code-size"]) out[name] = root.getPropertyValue(name).trim();
  return out;
}

type Face = { family: string; weight: string; style: string; data: ArrayBuffer };
let faces: Promise<Face[]> | null = null;
/** bismuth's own fonts (style.css's @font-face rules, wherever the bundle put the files), for pages that can't load them. */
function fonts(): Promise<Face[]> {
  faces ??= (async () => {
    const rules: { family: string; weight: string; style: string; url: string }[] = [];
    for (const sheet of document.styleSheets) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of list) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
        const url = rule.style.getPropertyValue("src").match(/url\(["']?([^"')]+)/)?.[1];
        if ((family === "Geist" || family === "Geist Mono") && url)
          rules.push({ family, weight: rule.style.getPropertyValue("font-weight") || "400", style: rule.style.getPropertyValue("font-style") || "normal", url: new URL(url, sheet.href ?? location.href).href });
      }
    }
    const loaded = await Promise.all(
      rules.map(async ({ url, ...face }) => {
        try {
          return { ...face, data: await (await fetch(url)).arrayBuffer() };
        } catch {
          return null;
        }
      }),
    );
    return loaded.filter((f) => f != null);
  })();
  return faces;
}

const tell = (frame: HTMLIFrameElement, extra: object = {}) =>
  frame.contentWindow?.postMessage({ bismuthView: "theme", theme: theme(), ...(frame.classList.contains("plain") ? { vars: vars() } : {}), ...extra }, "*");

/** The view a finished render call showed: its page id, title and viewport width, from the call's result and arguments. */
export function viewOf(item: { name: string; input: string; output: string; status: string }): { id: string; title: string; viewport: number | null } | null {
  if (!isViewTool(item.name) || item.status !== "completed") return null;
  const id = item.output.match(/bismuth-view:([0-9a-f]{20})/)?.[1];
  if (!id) return null;
  let title = "View";
  let viewport: number | null = null;
  try {
    const input = JSON.parse(item.input);
    title = String(input.title || title);
    if (Number.isInteger(input.width) && input.width > 0) viewport = input.width;
  } catch {}
  return { id, title, viewport };
}

/** Frames laid out at a viewport width, rescaled as their row's width changes: on the next frame, as fitting sets the
 *  box's height, which changing inside the observer's callback would loop it. */
const scaled = new ResizeObserver((entries) => {
  requestAnimationFrame(() => {
    for (const { target } of entries) {
      const frame = target.querySelector<HTMLIFrameElement>("iframe.uiview");
      if (frame) fit(target as HTMLElement, frame, sizes.get(frame.dataset.view!) ?? { width: null, height: 120 });
    }
  });
});

export function viewFrame(id: string, title: string, viewport: number | null = null): HTMLElement {
  const box = el("div", "uiview-box");
  const frame = el("iframe", "uiview");
  frame.sandbox.add("allow-scripts");
  frame.title = title;
  frame.dataset.view = id;
  frame.classList.toggle("plain", plainViews.has(id));
  frame.src = `/view/${id}?theme=${theme()}`;
  box.append(frame);
  if (viewport) {
    frame.dataset.viewport = String(viewport);
    box.classList.add("scaled");
    scaled.observe(box);
  }
  fit(box, frame, sizes.get(id) ?? { width: null, height: 120 });
  return box;
}

/** `--w`: the frame's width with its border (style.css keeps it within the row and lines a narrow one up with the text).
 *  A frame at a viewport width keeps that width and is scaled to the box, which takes the scaled height. */
function fit(box: HTMLElement, frame: HTMLIFrameElement, size: { width: number | null; height: number }) {
  const border = frame.classList.contains("plain") ? 0 : 2;
  const viewport = Number(frame.dataset.viewport);
  if (!viewport) {
    if (size.width != null) box.style.setProperty("--w", `${size.width + border}px`);
    frame.style.height = `${size.height + border}px`;
    return;
  }
  box.style.setProperty("--w", `${viewport + border}px`);
  frame.style.width = `${viewport + border}px`;
  frame.style.height = `${size.height + border}px`;
  // Not laid out yet (built before it's in the page): the observer fits it once it is.
  if (!box.clientWidth) return;
  const scale = Math.min(1, box.clientWidth / (viewport + border));
  frame.style.transform = scale < 1 ? `scale(${scale})` : "";
  box.style.height = `${(size.height + border) * scale}px`;
}

addEventListener("message", (e) => {
  const kind = e.data?.bismuthView;
  if (kind === "hello") {
    const frame = [...frames()].find((f) => f.contentWindow === e.source);
    if (!frame) return;
    const plain = e.data.plain === true;
    frame.classList.toggle("plain", plain);
    if (plain) plainViews.add(frame.dataset.view!);
    const size = sizes.get(frame.dataset.view!);
    if (size) fit(frame.parentElement!, frame, size);
    tell(frame);
    if (plain) void fonts().then((list) => tell(frame, { fonts: list }));
    return;
  }
  // A local image in the view, clicked: it opens in the file panel, as a file link does. Only images: what the core
  // inlines, and all a view's page may ask to open.
  if (kind === "open") {
    const path = e.data.path;
    if (![...frames()].some((f) => f.contentWindow === e.source) || typeof path !== "string" || !/^\/.*\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path)) return;
    openCitedPath({ path }, e.data.keep === true);
    return;
  }
  // Every page gets the current bridge as it's served, so every one reports "size" (and says hello on each load,
  // which is when it's told the theme).
  if (kind !== "size") return;
  for (const frame of frames()) {
    if (frame.contentWindow !== e.source) continue;
    const id = frame.dataset.view!;
    const height = Math.min(MAX_H, Math.max(MIN_H, Math.ceil(Number(e.data.height) || 0)));
    const width = Math.max(1, Math.ceil(Number(e.data.width) || 0));
    sizes.set(id, { width, height });
    fit(frame.parentElement!, frame, { width, height });
    return;
  }
});

onTheme(() => {
  for (const frame of frames()) tell(frame);
});
