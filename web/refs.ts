// Files an agent's text refers to, made links that open them in the panel. Each harness cites its own way:
//   Codex        :codex-file-citation{path="/abs/a.py" line_range_start="3" line_range_end="9"}, the older 【F:a.py†L3-L9】,
//                and links [a.py](/abs/a.py:12), <…> around targets with spaces
//   Claude Code  `src/a.ts:42`, `src/a.ts:42-51`, links [a.ts](src/a.ts#L42-L51)
//   Cursor       ```12:15:src/a.ts fences, relative links [config](backend/config.py), bare `a.py`
// Links open as they are (a miss says so); inline code and bare paths in the text become links only once the core
// finds the file they name. A name several files end with (`README.md`) links too, and asks which one.
import type { FileRef } from "../shared/model";
import { fileGlyph } from "./fileicons";
import { contextMenu, menuItem, menuPoint } from "./popover";
import { call, store, workFolder } from "./store";

/** A cited place: the path as written, with a 1-based line (and column, and last line) when it gives one. */
export type Cited = { path: string; line?: number; column?: number; end?: number };
/** Opens what a citation resolved to (or says it's missing). `keep`: not as a preview (a double click). */
export type Opener = (ref: FileRef | null, cited: Cited, keep: boolean) => void;

let opener: Opener = () => {};
export const setOpener = (fn: Opener) => void (opener = fn);

const num = (s: string | undefined) => (s ? Number(s) : undefined);

/** `a.ts:12`, `a.ts:12:5`, `a.ts:12-20`, `a.ts#L12`, `a.ts#L12C5-L20`: the path and where in it. */
export function parseCited(raw: string): Cited {
  let m = /^(.+?)#L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C\d+)?)?$/.exec(raw);
  if (m) return { path: m[1], line: num(m[2]), column: num(m[3]), end: num(m[4]) };
  m = /^(.+?):(\d+)(?::(\d+))?(?:-(\d+)(?::\d+)?)?$/.exec(raw);
  if (m) return { path: m[1], line: num(m[2]), column: num(m[3]), end: num(m[4]) };
  return { path: raw };
}

/** `5-9`, `L5-L9`: a range's text. */
export const rangeText = (c: Cited) => (c.line ? `:${c.line}${c.end && c.end !== c.line ? `-${c.end}` : ""}` : "");

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

// ---------------- the markdown side: citations into links ----------------

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A citation as the link the rest of this file treats like any other. */
function citeHtml(c: Cited): string {
  const href = encodeURI(c.path).replace(/#/g, "%23").replace(/\?/g, "%3F") + (c.line ? `#L${c.line}${c.end && c.end !== c.line ? `-L${c.end}` : ""}` : "");
  return `<a class="file-cite" href="${escapeAttr(href)}" title="${escapeAttr(c.path + rangeText(c))}">${escapeText(baseName(c.path) + rangeText(c))}</a>`;
}

/** marked's inline extensions for Codex's citations. */
export const citations = [
  {
    name: "codexCitation",
    level: "inline" as const,
    start: (src: string) => src.match(/:codex-file-citation\{/)?.index,
    tokenizer(src: string) {
      const m = /^:codex-file-citation\{([^}\n]*)\}/.exec(src);
      if (!m) return undefined;
      const attrs: Record<string, string> = {};
      for (const [, k, v] of m[1].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[k] = v;
      if (!attrs.path?.trim()) return { type: "codexCitation", raw: m[0], cite: null };
      const cite: Cited = { path: attrs.path.trim(), line: num(attrs.line_range_start) || undefined, end: num(attrs.line_range_end) || undefined };
      return { type: "codexCitation", raw: m[0], cite };
    },
    renderer: (token: any) => (token.cite ? citeHtml(token.cite) : ""),
  },
  {
    name: "codexOldCitation",
    level: "inline" as const,
    start: (src: string) => src.indexOf("【F:") >= 0 ? src.indexOf("【F:") : undefined,
    tokenizer(src: string) {
      const m = /^【F:([^†】\n]+)(?:†L(\d+)(?:-L(\d+))?)?】/.exec(src);
      if (!m) return undefined;
      return { type: "codexOldCitation", raw: m[0], cite: { path: m[1].trim(), line: num(m[2]), end: num(m[3]) } };
    },
    renderer: (token: any) => citeHtml(token.cite),
  },
];

// ---------------- the DOM side: links that open files ----------------

/** What the core said each path is (null: nothing there, or `many` files end with it), per folder; a miss is asked
 *  again after a while. */
const known = new Map<string, Map<string, { ref: FileRef | null; many?: string[]; at: number }>>();
const MISS_MS = 30_000;
const cached = (r: string, path: string) => {
  const hit = known.get(r)?.get(path);
  return hit && (hit.ref || Date.now() - hit.at < MISS_MS) ? hit : undefined;
};

async function resolveAll(r: string, paths: string[]): Promise<void> {
  const ask = [...new Set(paths.filter((p) => !cached(r, p)))];
  if (!ask.length) return;
  let refs: (FileRef | null)[];
  try {
    refs = await call("files.resolve", { root: r, refs: ask });
  } catch {
    return;
  }
  // A name or tail the core couldn't pick one file for: the folder's files that end with it.
  const many = await Promise.all(ask.map((p, i) => (refs[i] || /^(?:\/|~\/|\.\.\/)/.test(p) ? null : endingWith(r, p))));
  let m = known.get(r);
  if (!m) known.set(r, (m = new Map()));
  const at = Date.now();
  ask.forEach((p, i) => m!.set(p, { ref: refs[i] ?? null, many: many[i] ?? undefined, at }));
}

async function endingWith(r: string, path: string): Promise<string[] | null> {
  const tail = path.replace(/^\.\//, "");
  let found: string[];
  try {
    found = await call("files.search", { root: r, query: tail, all: false });
  } catch {
    return null;
  }
  const hits = found.filter((f) => f === tail || f.endsWith(`/${tail}`));
  return hits.length > 1 ? hits.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)) : null;
}

/** `base/../x` and `./x` worked out, the way a browser would for a relative link. */
function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/") || rel.startsWith("~/")) return rel;
  const out = base ? base.split("/") : [];
  const lead = base.startsWith("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.length > (lead ? 1 : 0) && out[out.length - 1] !== ".." ? out.pop() : out.push("..");
    else out.push(part);
  }
  return out.join("/") || (lead ? "/" : ".");
}

/** A link's target as a cited file, or null for a web address (or a jump within the page). */
function linkTarget(href: string, base: string): Cited | null {
  if (!href || href.startsWith("#")) return null;
  if (/^[a-z][\w+.-]*:/i.test(href) && !/^file:/i.test(href)) return null;
  let raw = href.replace(/^file:\/\//i, "");
  const hash = raw.indexOf("#");
  const frag = hash >= 0 ? raw.slice(hash) : "";
  raw = hash >= 0 ? raw.slice(0, hash) : raw;
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  const c = parseCited(raw + (/^#L\d/.test(frag) ? frag : ""));
  return c.path ? { ...c, path: joinPath(base, c.path) } : null;
}

/** A cited file opened (resolved first: a name, a tail, a path outside the folder). A name several files end with
 *  asks which, in a menu at `at`. */
export function openCitedPath(c: Cited, keep = false, at?: { x: number; y: number }) {
  const r = workFolder();
  if (!r) return;
  void resolveAll(r, [c.path]).then(() => {
    const hit = cached(r, c.path);
    if (!hit?.many || !at) return opener(hit?.ref ?? null, c, keep);
    contextMenu(
      at,
      hit.many.map((path) => {
        const row = menuItem({ label: path, run: () => opener({ path, dir: false }, { ...c, path }, keep) });
        row.prepend(fileGlyph(path));
        return row;
      }),
      { className: "cite-choices" },
    );
  });
}

function wire(node: HTMLElement, c: Cited) {
  node.classList.add("file-link");
  node.dataset.path = c.path;
  node.title ||= c.path + rangeText(c);
  const go = (e: MouseEvent, keep: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.getSelection()?.toString() && !keep) return; // selecting the text, not following it
    openCitedPath(c, keep, menuPoint(e, node));
  };
  node.onclick = (e) => go(e, false);
  node.ondblclick = (e) => go(e, true);
  node.onauxclick = (e) => e.button === 1 && go(e, true);
}

/** Inline code that could name a file: a path (with a folder, or an extension), maybe a line after it. */
const PATHLIKE = /^(?:~\/|\.{0,2}\/)?[\w@+\-. ()[\]]*(?:\/[\w@+\-. ()[\]]+)*\/?(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:-L\d+)?)?$/;
function codeCandidate(text: string): Cited | null {
  const t = text.trim();
  if (t.length < 3 || t.length > 400 || !PATHLIKE.test(t) || /\/\//.test(t)) return null;
  const c = parseCited(t);
  const abs = c.path.startsWith("/") || c.path.startsWith("~/");
  if (/\s/.test(c.path) && !abs) return null;
  // A folder in it, or a name with an extension (not `1.5`, not `e.g.`).
  if (!c.path.includes("/") && !/^\.?[\w@+\-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]{0,11}$/.test(c.path)) return null;
  if (/^\.+$/.test(c.path) || c.path === "/") return null;
  return c;
}

/** Absolute or home paths written into the prose (Codex names files so). */
const BARE = /(^|[\s(“"'])((?:~|\/)(?:[\w@+\-.]+\/)+[\w@+\-.]*[\w-](?::\d+(?:-\d+)?)?)/g;

/** The rendered markdown's file references, linked. `base`: what a document's relative links are relative to (a
 *  Markdown file's folder; the session folder when empty). Named files are looked up from the session folder. */
export function linkFiles(into: HTMLElement, base = "") {
  const r = workFolder();
  if (!r) return;
  for (const a of into.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    // Citations name files from the session folder; a document's own links, from where it is.
    const cite = a.matches(".file-cite, .code-file");
    const c = linkTarget(a.getAttribute("href") ?? "", cite ? "" : base);
    if (!c) continue;
    a.removeAttribute("target");
    if (a.classList.contains("file-cite")) a.prepend(fileGlyph(c.path));
    wire(a, c);
  }
  // Code and prose that might name a file: linked once the core finds it.
  const maybe: { node: Node; c: Cited; from?: number; to?: number }[] = [];
  for (const code of into.querySelectorAll<HTMLElement>(":not(pre) > code")) {
    if (code.closest("a")) continue;
    const c = codeCandidate(code.textContent ?? "");
    if (c) maybe.push({ node: code, c });
  }
  const walker = document.createTreeWalker(into, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("a, code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (const m of (n.textContent ?? "").matchAll(BARE)) {
      // A trailing full stop ends the sentence, not the name.
      const text = m[2].replace(/\.+$/, "");
      const from = m.index! + m[1].length;
      maybe.push({ node: n, c: parseCited(text), from, to: from + text.length });
    }
  }
  if (!maybe.length) return;
  const apply = () => {
    // Text nodes split from the back, so earlier matches' offsets hold.
    for (const { node, c, from, to } of maybe.reverse()) {
      const hit = cached(r, c.path);
      // (Not yet in the page, when it's known at once: the caller inserts it.)
      if (!(hit?.ref || hit?.many) || !node.parentNode) continue;
      if (node instanceof HTMLElement) {
        if (!node.querySelector(".file-glyph")) node.prepend(fileGlyph(hit.ref?.path ?? c.path, hit.ref?.dir));
        wire(node, c);
        continue;
      }
      const text = node as Text;
      const tail = text.splitText(from!);
      tail.splitText(to! - from!);
      const a = document.createElement("a");
      a.href = "#";
      tail.replaceWith(a);
      a.append(tail);
      wire(a, c);
    }
  };
  const paths = maybe.map((x) => x.c.path);
  if (paths.every((p) => cached(r, p))) apply();
  else void resolveAll(r, paths).then(apply);
}
