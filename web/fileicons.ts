// File and folder artwork: the Symbols VS Code theme, as Zeron carries it (crates/ui/src/file_icons.rs). Exact names
// win, then the longest matching compound extension ("d.ts" before "ts"), then the generic file or folder. Each icon is
// a file of the build, fetched the first time it's needed and kept; dark appearances lift the palette's darker accents
// (Zeron's dark_icon_svg). Shown as images, so the many copies of one icon never share their SVG ids.
import { ICON_URLS } from "./file-icons/index";
import manifest from "./file-icons/manifest.json";
import { currentAppearance } from "./theme";

type Manifest = { file: string; folder: string; fileNames: Record<string, string>; fileExtensions: Record<string, string>; folderNames: Record<string, string> };
const M = manifest as Manifest;

const DARK_LIFT: [string, string][] = [
  ["#64748B", "#CBD5E1"],
  ["#71717A", "#D4D4D8"],
  ["#2563EB", "#60A5FA"],
  ["#EA580C", "#FB923C"],
  ["#16A34A", "#4ADE80"],
  ["#8B5CF6", "#A78BFA"],
  ["#A855F7", "#C084FC"],
];

/** The icon a path wears: a key of ICON_URLS ("files/ts", "folders/folder-blue"). */
export function iconKey(path: string, dir = false): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (dir) return M.folderNames[name] ?? M.folder;
  const exact = M.fileNames[name];
  if (exact) return exact;
  for (let i = name.indexOf("."); i >= 0; i = name.indexOf(".", i + 1)) {
    const hit = M.fileExtensions[name.slice(i + 1)];
    if (hit) return hit;
  }
  return M.file;
}

const svgs = new Map<string, string>();
const loading = new Map<string, Promise<void>>();
const urls = new Map<string, string>();

/** Resolves once every one of these icons can be drawn at once (already-loaded ones cost nothing). */
export function loadIcons(keys: Iterable<string>): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const key of new Set(keys)) {
    if (svgs.has(key)) continue;
    let wait = loading.get(key);
    if (!wait) {
      wait = fetch(ICON_URLS[key] ?? ICON_URLS[M.file])
        .then((r) => r.text())
        .catch(() => "")
        .then((text) => void svgs.set(key, text))
        .finally(() => loading.delete(key));
      loading.set(key, wait);
    }
    waits.push(wait);
  }
  return waits.length ? Promise.all(waits).then(() => {}) : Promise.resolve();
}

function urlFor(key: string): string | null {
  const dark = currentAppearance() === "dark";
  const id = `${dark ? "d" : "l"}:${key}`;
  const hit = urls.get(id);
  if (hit) return hit;
  let svg = svgs.get(key);
  if (svg === undefined) return null;
  if (dark) for (const [from, to] of DARK_LIFT) svg = svg.replaceAll(from, to).replaceAll(from.toLowerCase(), to);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  urls.set(id, url);
  return url;
}

/** A path's icon (a folder's when `dir`): drawn at once when it's loaded, else as soon as it is. Size it with CSS. */
export function fileGlyph(path: string, dir = false): HTMLElement {
  const span = document.createElement("span");
  span.className = "file-glyph";
  const key = iconKey(path, dir);
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  const url = urlFor(key);
  if (url) img.src = url;
  else void loadIcons([key]).then(() => (img.src = urlFor(key) ?? ""));
  span.append(img);
  return span;
}
