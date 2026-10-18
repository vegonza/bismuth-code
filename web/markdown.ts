// Markdown → sanitized DOM with Zeron's block treatments: accent list markers, framed code blocks.
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { marked } from "marked";
import { diagrams } from "./diagrams";
import { el, middleCopy } from "./dom";
import { fileGlyph } from "./fileicons";
import { icon } from "./icons";
import { mathExtension } from "./mathmd";
import { onPrefs, prefs, setPrefs } from "./prefs";
import { citations, linkFiles, rangeText } from "./refs";

/** Blocks past this stay plain: highlighting them on every streamed render would stall the window. */
const HIGHLIGHT_MAX = 50_000;

marked.use({ extensions: citations }, mathExtension);

/** `html`: a richer form to copy beside the text (a message's images: attachments.ts). */
export function copyText(text: string, button: HTMLElement, html?: string) {
  if (html && typeof ClipboardItem !== "undefined")
    void navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
  else void navigator.clipboard.writeText(text);
  button.replaceChildren(icon("check"));
  setTimeout(() => button.replaceChildren(icon("copy")), 1200);
}

// Wrapping long lines is one setting for every code block, whichever block's button turned it on.
const wrapCode = () => document.documentElement.classList.toggle("wrap-code", prefs.wrapCode);
wrapCode();
onPrefs((prev) => prev.wrapCode !== prefs.wrapCode && wrapCode());

const ruler = document.createElement("canvas").getContext("2d")!;
/** Whether a line of the block runs past its width when it isn't wrapped: the wrap button is only offered then. */
function overflows(pre: HTMLElement) {
  if (!prefs.wrapCode) return pre.scrollWidth > pre.clientWidth;
  const style = getComputedStyle(pre);
  ruler.font = style.font;
  const room = pre.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return (pre.textContent ?? "").split("\n").some((line) => ruler.measureText(line.replaceAll("\t", "        ")).width > room + 0.5);
}

function codeFrame(pre: HTMLPreElement): HTMLElement {
  const code = pre.querySelector("code");
  let lang = [...(code?.classList ?? [])].find((c) => c.startsWith("language-"))?.slice(9) ?? null;
  // Cursor's citation of a file's lines: ```12:15:src/a.ts, its header the file (a link), coloured by its extension.
  const cite = lang ? /^(\d+):(\d+):(.+)$/.exec(lang) : null;
  let file: HTMLElement | null = null;
  if (cite) {
    const at = { path: cite[3], line: Number(cite[1]), end: Number(cite[2]) };
    file = el("a", "code-file");
    file.setAttribute("href", `${encodeURI(at.path)}#L${at.line}-L${at.end}`);
    file.append(fileGlyph(at.path), el("span", "name", at.path), el("span", "range", rangeText(at)));
    const ext = at.path.slice(at.path.lastIndexOf(".") + 1);
    lang = ext && ext !== at.path ? ext : null;
  }
  if (code && lang && hljs.getLanguage(lang) && code.textContent!.length <= HIGHLIGHT_MAX) {
    code.innerHTML = hljs.highlight(code.textContent!, { language: lang, ignoreIllegals: true }).value;
    code.classList.add("hljs");
  }
  const frame = el("div", "code-block");
  if (lang === "mermaid") frame.dataset.mermaid = "";
  const copy = el("button", "code-action");
  copy.title = "Copy code";
  copy.append(icon("copy"));
  copy.onclick = () => copyText(code?.textContent ?? pre.textContent ?? "", copy);
  middleCopy(frame, copy);
  const actions = el("div", "code-actions");
  actions.append(copy);
  // A diagram keeps only the copy (diagrams.ts). The wrap button is settled as the block is hovered, which is
  // when it shows.
  if (lang !== "mermaid") {
    const wrap = el("button", "code-action code-wrap");
    wrap.title = "Wrap long lines";
    wrap.append(icon("wrapText"));
    wrap.onclick = () => setPrefs({ wrapCode: !prefs.wrapCode });
    frame.addEventListener("pointerenter", () => (wrap.hidden = !overflows(pre)));
    actions.append(wrap);
  }
  if (file || lang) {
    const head = el("div", "code-head");
    head.append(file ?? el("span", "lang", lang!), actions);
    frame.append(head);
  } else frame.append(actions);
  pre.replaceWith(frame);
  frame.append(pre);
  return frame;
}

/** Puts `button` out in the gutter right of `host`, clear of its text: shown while the host is hovered, it sticks
 *  below the titlebar as the host scrolls past (style.css: .gutter-rail). Every copy that would otherwise cover the
 *  text it copies goes through here. */
export function gutterAction(host: HTMLElement, button: HTMLElement) {
  host.classList.add("gutter-host");
  const rail = el("div", "gutter-rail");
  rail.append(button);
  host.append(rail);
}

/** Where there's a gutter (the transcript's rows): quoted prose (drafts, messages the agent writes for you to send)
 *  gets a copy beside it, and a code block without a head (or the diagram it becomes) has its actions moved there. */
function gutterCopies(into: HTMLElement) {
  into.querySelectorAll<HTMLElement>("blockquote:not(blockquote blockquote)").forEach((quote) => {
    const copy = el("button", "code-action");
    copy.title = "Copy quote";
    copy.append(icon("copy"));
    copy.onclick = () => copyText(quote.innerText.trim(), copy);
    middleCopy(quote, copy);
    gutterAction(quote, copy);
  });
  // The frame's own overflow would clip a rail inside it: it goes in a holder beside the frame, which a diagram
  // later takes the frame's place in (diagrams.ts).
  into.querySelectorAll<HTMLElement>(".code-block:not(:has(.code-head))").forEach((frame) => {
    const actions = frame.querySelector<HTMLElement>(":scope > .code-actions");
    if (!actions) return;
    const host = el("div");
    frame.replaceWith(host);
    host.append(frame);
    gutterAction(host, actions);
  });
}

/** Inline code is copied by a middle click too, with no button: it lights up for a moment, as a Vim yank does. Once
 *  it turns out to name a file (refs.ts, after this) it's a link, which a middle click opens instead (middleCopy). */
function inlineCopies(into: HTMLElement) {
  into.querySelectorAll<HTMLElement>(":not(pre) > code").forEach((code) =>
    middleCopy(code, () => {
      void navigator.clipboard.writeText(code.textContent ?? "");
      code.classList.remove("yanked");
      void code.offsetWidth; // a second copy restarts the flash
      code.classList.add("yanked");
      setTimeout(() => code.classList.remove("yanked"), 200);
    }),
  );
}

function listMarkers(list: HTMLOListElement | HTMLUListElement) {
  const start = list instanceof HTMLOListElement ? list.start || 1 : 1;
  [...list.children].forEach((li, i) => {
    if (!(li instanceof HTMLLIElement) || li.querySelector(":scope > .marker")) return;
    const body = el("div", "body");
    // Loose list items wrap their text in <p>; tight ones hold bare inline nodes.
    body.append(...li.childNodes);
    const marker = el("span", "marker", list instanceof HTMLOListElement ? `${start + i}.` : "");
    li.append(marker, body);
  });
}

/** `base`: the folder relative links to files are relative to (a Markdown file's own; the session's when empty).
 *  `gutter`: there's room right of `into` for copy buttons (gutterCopies); without it they sit inside the frames. */
export function renderMarkdown(text: string, into: HTMLElement, base = "", gutter = false) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: false }) as string);
  into.innerHTML = html;
  into.querySelectorAll("pre").forEach((pre) => codeFrame(pre));
  into.querySelectorAll<HTMLOListElement | HTMLUListElement>("ul, ol").forEach(listMarkers);
  into.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noreferrer";
    // A web address: opens as a browser tab in the desktop app (browser.ts).
    if (/^https?:\/\//i.test(a.getAttribute("href") ?? "")) a.dataset.web = "";
  });
  linkFiles(into, base);
  inlineCopies(into);
  if (gutter) gutterCopies(into);
  diagrams(into);
}
