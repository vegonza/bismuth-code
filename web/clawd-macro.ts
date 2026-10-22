// Runs when the UI is bundled, as a Bun macro (web/lazy/clawd.ts imports it `with { type: "macro" }`): Clawd's
// animations as the Claude desktop app plays them, read from the copy installed on this machine. They're
// Anthropic's artwork, so this repository doesn't carry them: they only land in the local build. No app found, or
// its layout changed: none, and the working trailer keeps its dots.
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

/** A sprite as the desktop app packs it: palette indices row by row ("." is clear), then each later frame as the
 *  pixels that changed, each a base-36 index and a palette digit. `a0` is the standing pose's box [x, y, w, h]. */
export type Packed = { w: number; h: number; fps: number; palette: string[]; base: string; deltas: string[]; a0: number[]; move?: Move };

/** How the app plays a sprite (frames inclusive): from `start`, either once through to `end`, or through an intro to
 *  a `loop` it repeats, leaving by `out` (at `outFps`) when the sprite has a way back to standing. */
export type Move = { start: number; fps: number; end?: number; loop?: [number, number]; out?: [number, number]; outFps?: number };

function installs(): string[] {
  const found = [
    process.env.CLAUDE_DESKTOP_ASAR ?? "",
    "/usr/lib/claude-desktop/resources/app.asar",
    "/opt/Claude/resources/app.asar",
    "/Applications/Claude.app/Contents/Resources/app.asar",
  ];
  const win = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "AnthropicClaude");
  if (win && existsSync(win))
    for (const d of readdirSync(win).filter((d) => d.startsWith("app-")).sort().reverse()) found.push(join(win, d, "resources", "app.asar"));
  return found.filter((p) => p && existsSync(p));
}

type AsarNode = { files?: Record<string, AsarNode>; size?: number; offset?: string; unpacked?: boolean };

/** The app's Clawd engine script, out of its asar: a pickled header, the JSON file tree, then the files' bytes. */
function engine(asar: string): string | null {
  const fd = openSync(asar, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    readSync(fd, json, 0, json.length, 16);
    const find = (node: AsarNode): AsarNode | null => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const hit = child.files ? find(child) : /^clawdQuestEngine-.*\.js$/.test(name) && !child.unpacked ? child : null;
        if (hit) return hit;
      }
      return null;
    };
    const file = find(JSON.parse(json.toString("utf8")));
    if (!file?.size) return null;
    const body = Buffer.alloc(file.size);
    readSync(fd, body, 0, file.size, 8 + head.readUInt32LE(4) + Number(file.offset));
    return body.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const MOVE = /(\w+):\{sp:"(\w+)",start:(\d+),(?:loop:\[(\d+),(\d+)\]|end:(\d+)),fps:(\d+)(?:,oneShot:!0)?\}/g;
const SPRITE = /[,{](\w+):\{cat:"\w+",w:(\d+),h:(\d+),fps:(\d+),palette:(\[[^\]]*\]),base:"([^"]*)",deltas:/g;
const CHANGE = /^[0-9a-z]+[0-9a-z.]$/;

/** Every sprite in the engine's table, by name; one that doesn't read as expected is left out. */
function sprites(src: string): Record<string, Packed> {
  const out: Record<string, Packed> = {};
  for (const m of src.matchAll(SPRITE)) {
    const [, name, w, h, fps, palette, base] = m;
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 400_000);
    let deltas: string[];
    let tail: string;
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      deltas = rest.slice(1, end).split("(");
      tail = rest.slice(end);
    } else {
      const end = rest.indexOf("]");
      deltas = JSON.parse(rest.slice(0, end + 1));
      tail = rest.slice(end + 1);
    }
    const a0 = /^[^}]*?a0:(\[[\d,]*\])/.exec(tail);
    if (base.length !== +w * +h || !deltas.every((d) => !d || d.split(",").every((c) => CHANGE.test(c)))) continue;
    out[name] = { w: +w, h: +h, fps: +fps, palette: JSON.parse(palette), base, deltas, a0: a0 ? JSON.parse(a0[1]) : [0, 0, +w, +h] };
  }
  return out;
}

/** The app's moves, by the sprite they play: a looping one over a one-shot of the same sprite, with its way out. */
function moves(src: string): Record<string, Move> {
  const named = new Map<string, { sprite: string; move: Move }>();
  for (const [, name, sprite, start, a, b, end, fps] of src.matchAll(MOVE))
    named.set(name, { sprite, move: { start: +start, fps: +fps, ...(a ? { loop: [+a, +b] as [number, number] } : { end: +end }) } });
  const out: Record<string, Move> = {};
  for (const [name, { sprite, move }] of named) {
    if (name.endsWith("Out")) continue;
    const exit = named.get(`${name}Out`);
    if (exit?.sprite === sprite && exit.move.end !== undefined) Object.assign(move, { out: [exit.move.start, exit.move.end], outFps: exit.move.fps });
    if (!out[sprite] || (move.loop && !out[sprite].loop)) out[sprite] = move;
  }
  return out;
}

/** Whether every frame a move names is one the sprite has. */
const fits = (m: Move, n: number) => [m.start, m.end ?? 0, ...(m.loop ?? []), ...(m.out ?? [])].every((f) => f >= 0 && f < n);

export function clawdSprites(): Record<string, Packed> {
  for (const asar of installs()) {
    try {
      const src = engine(asar);
      const found = src ? sprites(src) : {};
      if (!Object.keys(found).length) continue;
      for (const [name, move] of Object.entries(moves(src!))) {
        const sprite = found[name];
        if (sprite && fits(move, sprite.deltas.length + 1)) sprite.move = move;
      }
      return found;
    } catch {
      // unreadable or laid out otherwise: try the next install
    }
  }
  return {};
}
