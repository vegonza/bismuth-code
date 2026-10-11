// Image attachments (Zeron's engine/uploads.rs, lean): the composer uploads each staged image here, the file lands
// in `{STATE}/uploads/{id8}-{name}`, and its absolute path rides the prompt text so the agent opens it with its own
// tools. Reads back (the transcript's thumbnails) are jailed to that folder.
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join, sep } from "node:path";

/** Zeron's MAX_ATTACHMENT_BYTES. */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** The image formats agents read, by their leading bytes. */
function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return ".png";
  if (at(0, 0xff, 0xd8, 0xff)) return ".jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return ".gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return ".webp";
  return null;
}

/** A file name safe on every platform, its extension matching what the bytes are. */
function sanitize(name: string, ext: string): string {
  const base = name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}._ -]+/gu, "-").replace(/^[.\s-]+|[.\s-]+$/g, "").slice(0, 80) || "image";
  return base + ext;
}

export class Uploads {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "uploads");
    mkdirSync(this.dir, { recursive: true });
  }

  /** Store an image's bytes; returns its absolute path. */
  save(name: string, bytes: Uint8Array): string {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`${name} is too large (24 MB max).`);
    const ext = sniff(bytes);
    if (!ext) throw new Error(`${name} is not a supported image (PNG, JPEG, GIF or WebP).`);
    const path = join(this.dir, `${randomUUID().slice(0, 8)}-${sanitize(name, ext)}`);
    writeFileSync(path, bytes);
    return path;
  }

  /** An uploaded image to serve back, or null for anything outside the uploads folder. */
  read(path: string): { file: string; type: string } | null {
    try {
      const file = realpathSync(path);
      const type = MIME[extname(file).toLowerCase()];
      if (!type || !file.startsWith(realpathSync(this.dir) + sep) || !statSync(file).isFile()) return null;
      return { file, type };
    } catch {
      return null;
    }
  }
}
