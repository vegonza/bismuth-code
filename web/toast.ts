// The toast: one short line at the top of the window (a restart under way, a preview switched), with a spinner while
// something runs and buttons when there's something to do. One at a time: a new one replaces what shows.
import { el, miniSpinner } from "./dom";
import { icon, type IconName } from "./icons";

let toast: HTMLElement | null = null;
let timer: Timer | null = null;

/** Show `text`; `ms`: gone on its own after that long (else until hidden or replaced). `pill`: a small one with an
 *  icon, for a state the window switched to (a preview). Answers a way to hide this one (a no-op once another took
 *  its place). */
export function showToast(text: string, opts: { busy?: boolean; actions?: HTMLElement[]; ms?: number; tone?: "error"; icon?: IconName; pill?: boolean; note?: string } = {}): () => void {
  hideToast();
  const t = el("div", ["toast", opts.tone, opts.pill && "pill"].filter(Boolean).join(" "));
  if (opts.busy) t.append(miniSpinner());
  else if (opts.icon) t.append(icon(opts.icon));
  t.append(el("span", "text", text));
  if (opts.note) t.append(el("span", "note", opts.note));
  t.append(...(opts.actions ?? []));
  document.body.append(t);
  toast = t;
  if (opts.ms) timer = setTimeout(hideToast, opts.ms);
  return () => toast === t && hideToast();
}

export function hideToast() {
  if (timer) clearTimeout(timer);
  timer = null;
  toast?.remove();
  toast = null;
}
