// Image attachments (Zeron's attachments.rs): the composer's staged images, their upload to the core, the plain-text
// transport that rides the prompt (Zeron's `withAttachments` / `parseUserMessageImages`: the files' local paths
// listed under the text, which is what the harness records), and the full-size lightbox.
import { el } from "./dom";

/** Zeron's MAX_ATTACHMENT_BYTES (the core enforces it too). */
const MAX_BYTES = 24 * 1024 * 1024;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const ACCEPT = TYPES.join(",");

// ---------------- text transport ----------------

/** The body of an image-only send. */
const ATTACHMENT_ONLY_TEXT = "See the attached image(s).";
const TRAILER = "Attached images (local files — open them to view):";

export type SentImage = { label: string | null; path: string };

/** The prompt as sent: the text, then each image's label and path for the agent to open with its own tools
 *  ("- Image 1: /…/ab12cd34-shot.png", so "Image 1" in the text names that file). */
export function withAttachments(text: string, images: SentImage[]): string {
  if (!images.length) return text;
  const lines = images.map((i) => `- ${i.label ? `${i.label}: ` : ""}${i.path}`);
  return `${text || ATTACHMENT_ONLY_TEXT}\n\n${TRAILER}\n${lines.join("\n")}`;
}

/** A user message split back into what was typed and the images it carried (Zeron's tolerant marker match; lines
 *  without a label are Zeron's plain "- path"). */
export function parseUserMessage(content: string): { text: string; images: SentImage[] } {
  const m = /\n\nattached images \(local files[^\n]*\):[ \t]*\r?\n/i.exec(content);
  if (!m) return { text: content, images: [] };
  const images = content
    .slice(m.index + m[0].length)
    .split("\n")
    .flatMap((l) => {
      const hit = /^- (?:(Image \d+): )?(.+)$/.exec(l.trim());
      return hit ? [{ label: hit[1] ?? null, path: hit[2].trim() }] : [];
    });
  const body = content.slice(0, m.index).trimEnd();
  return { text: body === ATTACHMENT_ONLY_TEXT ? "" : body, images };
}

// ---------------- copying ----------------
// A copied user message carries its images beside its text, as HTML only the composer reads back: pasting it there
// attaches the same files again (they're on disk already) with its "Image N"s as their chips, not as bare text.

const CLIP_ATTR = "data-bismuth-images";

/** The HTML a copied message's text goes to the clipboard with. */
export function clipboardHtml(text: string, images: SentImage[]): string {
  const span = el("span", "", text);
  span.setAttribute(CLIP_ATTR, JSON.stringify(images));
  return span.outerHTML;
}

/** The images a pasted message carried (null for any other paste). */
export function clipboardImages(data: DataTransfer): SentImage[] | null {
  const html = data.getData("text/html");
  if (!html.includes(CLIP_ATTR)) return null;
  const raw = new DOMParser().parseFromString(html, "text/html").querySelector(`[${CLIP_ATTR}]`)?.getAttribute(CLIP_ATTR);
  try {
    const list = JSON.parse(raw ?? "") as unknown;
    if (!Array.isArray(list)) return null;
    return list.filter((i): i is SentImage => typeof i?.path === "string" && (i.label === null || typeof i.label === "string"));
  } catch {
    return null;
  }
}

export const attachmentUrl = (path: string) => `/attachment?path=${encodeURIComponent(path)}`;
export const attachmentName = (path: string) => path.split(/[\\/]/).pop()!.replace(/^[0-9a-f]{8}-/, "");

// ---------------- staging ----------------
// Each draft (a session's, or a new session's: drafts.ts) holds its own images, labelled Image 1, Image 2… by
// their place in it: removing one renumbers the rest (the composer relabels their chips). The label rides the
// prompt's list beside the path, so it never has to be part of the file's name.

export type Staged = { id: string; label: string; name: string; url: string; path: string | null };

const KEY = "bismuth.attachments";
/** Prefix of the draft key a queued message's images use while it's being edited in the composer. */
export const QUEUE_EDIT = "queue:";
const drafts = new Map<string, Staged[]>(
  Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string[]>)
    .filter(([key]) => !key.startsWith(QUEUE_EDIT)) // an edit the window was reloaded under is over
    .map(([key, paths]) => [key, paths.map(fromPath)]),
);
let current = "";

function fromPath(path: string, i: number): Staged {
  return { id: crypto.randomUUID(), label: `Image ${i + 1}`, name: attachmentName(path), url: attachmentUrl(path), path };
}

/** Uploaded images last with their draft across reloads and restarts (the files are on disk already). */
function save() {
  const out: Record<string, string[]> = {};
  for (const [key, list] of drafts) {
    const paths = list.flatMap((s) => (s.path ? [s.path] : []));
    if (paths.length) out[key] = paths;
  }
  localStorage.setItem(KEY, JSON.stringify(out));
}

/** The open draft's images. */
export const staged = (): Staged[] => drafts.get(current) ?? [];
/** Whose images are open (the composer animates changes within one draft, not a switch to another). */
export const stagedKey = () => current;
/** Switch to another draft's images (the composer follows the open session, loading its text before redrawing). */
export function setStagedKey(key: string) {
  current = key;
}

let changed = () => {};
let failed = (_message: string) => {};
/** The composer redraws on every change and shows refusals. */
export function onStaged(onChange: () => void, onError: (message: string) => void) {
  changed = onChange;
  failed = onError;
}

export const uploading = () => staged().some((s) => !s.path);

export async function upload(file: Blob, name: string): Promise<string> {
  const res = await fetch(`/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "x-bismuth-upload": "1" }, body: file });
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res.ok || !body.path) throw new Error(body.error ?? `Couldn't attach ${(file instanceof File && file.name) || name} (${res.status}).`);
  return body.path;
}

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** Stage files (picker, paste, drop) in the open draft: images upload right away, anything else is refused with a
 *  reason. Returns the ones taken, for the composer to mention. */
export function stageFiles(files: Iterable<File>): Staged[] {
  const key = current;
  const list = drafts.get(key) ?? [];
  drafts.set(key, list);
  const added: Staged[] = [];
  for (const file of files) {
    const original = file.name || "image";
    if (!TYPES.includes(file.type)) {
      failed(`${original} is not a supported image (PNG, JPEG, GIF or WebP).`);
      continue;
    }
    if (file.size > MAX_BYTES) {
      failed(`${original} is too large (24 MB max).`);
      continue;
    }
    const name = file.name || `image${EXT[file.type]}`;
    const s: Staged = { id: crypto.randomUUID(), label: `Image ${list.length + 1}`, name, url: URL.createObjectURL(file), path: null };
    list.push(s);
    added.push(s);
    upload(file, s.name).then(
      (path) => {
        s.path = path;
        save();
        changed();
      },
      (err) => {
        drop(key, s.id);
        failed(String(err?.message ?? err));
      },
    );
  }
  changed();
  return added;
}

function drop(key: string, id: string) {
  const list = drafts.get(key) ?? [];
  const at = list.findIndex((s) => s.id === id);
  if (at < 0) return;
  const [s] = list.splice(at, 1);
  if (s.url.startsWith("blob:")) URL.revokeObjectURL(s.url);
  list.forEach((x, i) => (x.label = `Image ${i + 1}`));
  if (!list.length) drafts.delete(key);
  save();
  changed();
}

/** Stage images already uploaded (a pasted message's) in the open draft, after its own; one it holds already is
 *  reused. Returns each image's entry, in order. */
export function stageUploaded(images: SentImage[]): Staged[] {
  const list = drafts.get(current) ?? [];
  const out = images.map((i) => {
    const had = list.find((s) => s.path === i.path);
    if (had) return had;
    const s = fromPath(i.path, list.length);
    list.push(s);
    return s;
  });
  if (list.length) drafts.set(current, list);
  save();
  changed();
  return out;
}

export const unstage = (id: string) => drop(current, id);

/** Take the open draft's uploaded images for a send, emptying it. */
export function takeStaged(): SentImage[] {
  const list = staged();
  drafts.delete(current);
  for (const s of list) if (s.url.startsWith("blob:")) URL.revokeObjectURL(s.url);
  save();
  changed();
  return list.flatMap((s) => (s.path ? [{ label: s.label, path: s.path }] : []));
}

/** Fill a draft's images with ones already uploaded (a queued message taken back into the composer). */
export function restoreStaged(key: string, images: SentImage[]) {
  if (images.length) drafts.set(key, images.map((i, ix) => fromPath(i.path, ix)));
  else drafts.delete(key);
  save();
  changed();
}

/** The open draft's uploaded images, left staged (takeStaged empties the draft). */
export const stagedImages = (): SentImage[] => staged().flatMap((s) => (s.path ? [{ label: s.label, path: s.path }] : []));

/** How many images a draft holds. */
export const stagedCount = (key: string) => drafts.get(key)?.length ?? 0;

/** Move a draft's images to another key (the composer isn't showing either). */
export function renameStaged(from: string, to: string) {
  const list = drafts.get(from);
  if (!list) return;
  drafts.delete(from);
  drafts.set(to, list);
  save();
}

/** A session went away: its images go with its draft. */
export function forgetStaged(key: string) {
  if (!drafts.delete(key)) return;
  save();
  changed();
}

// ---------------- lightbox ----------------

/** The full-size view of an image (Zeron's lightbox): a click anywhere or Escape closes it. */
export function openLightbox(src: string, name: string) {
  const scrim = el("div", "lightbox");
  const img = el("img");
  img.src = src;
  img.alt = name;
  scrim.append(img, el("div", "lightbox-name", name));
  const close = () => {
    scrim.remove();
    removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  scrim.onclick = close;
  addEventListener("keydown", onKey, true);
  document.body.append(scrim);
}
