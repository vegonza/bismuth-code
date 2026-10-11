// Views an agent rendered with the project's own React components (bismuth's `render` tool, core/views.ts): each is
// a page the core built and serves at /view/<id>, framed in the transcript in a sandbox with no origin of its own and
// no network. The page reports its height so the frame fits it, and follows the theme's light/dark as it changes.
import { el } from "./dom";
import { activeTheme, onTheme } from "./theme";

/** The tool's name as every adapter names an MCP call: server · tool. */
export const VIEW_TOOL = "bismuth · render";
const MIN_H = 40;
const MAX_H = 900;
/** Heights views last reported, so a frame built again (a re-render, coming back to the thread) opens at its size. */
const heights = new Map<string, number>();
const frames = () => document.querySelectorAll<HTMLIFrameElement>("iframe.uiview");

const theme = () => (activeTheme().appearance === "dark" ? "dark" : "light");

/** The view a finished render call showed: its page id and title, from the call's result and arguments. */
export function viewOf(item: { name: string; input: string; output: string; status: string }): { id: string; title: string } | null {
  if (item.name !== VIEW_TOOL || item.status !== "completed") return null;
  const id = item.output.match(/bismuth-view:([0-9a-f]{20})/)?.[1];
  if (!id) return null;
  let title = "View";
  try {
    title = String(JSON.parse(item.input).title || title);
  } catch {}
  return { id, title };
}

export function viewFrame(id: string, title: string): HTMLElement {
  const frame = el("iframe", "uiview");
  frame.sandbox.add("allow-scripts");
  frame.title = title;
  frame.dataset.view = id;
  frame.style.height = `${heights.get(id) ?? 120}px`;
  frame.src = `/view/${id}?theme=${theme()}`;
  return frame;
}

addEventListener("message", (e) => {
  if (!e.data || e.data.bismuthView !== "height") return;
  for (const frame of frames()) {
    if (frame.contentWindow !== e.source) continue;
    const h = Math.min(MAX_H, Math.max(MIN_H, Math.ceil(Number(e.data.height) || 0)));
    heights.set(frame.dataset.view!, h);
    frame.style.height = `${h}px`;
    // A page that loaded again (its frame moved) starts from the theme in its URL: tell it the current one.
    frame.contentWindow?.postMessage({ bismuthView: "theme", theme: theme() }, "*");
    return;
  }
});

onTheme(() => {
  for (const frame of frames()) {
    frame.contentWindow?.postMessage({ bismuthView: "theme", theme: theme() }, "*");
  }
});
