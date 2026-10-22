// Clawd, Claude Code's mascot, acting out the working trailer's word, in the harness's colours (transcript.ts pairs each
// word with its emote). His animations are the ones the Claude desktop app plays, read from the copy installed here
// when the UI is bundled (web/clawd-macro.ts); a few more are drawn below in the same pose, for words the app has
// nothing for. Each plays the way the app plays it: into a loop he keeps up while the word holds and out of it, or
// once through and again after a rest.
import { clawdSprites } from "../clawd-macro.ts" with { type: "macro" };
import type { Move, Packed } from "../clawd-macro.ts";
import type { HarnessId } from "../../shared/model";

const CLEAR = 255;

type Sprite = {
  w: number;
  h: number;
  /** Where his feet are, at the middle of the standing pose's bottom edge: what every animation is lined up by. */
  ax: number;
  ay: number;
  palette: string[];
  frames: () => Uint8Array[];
  n: number;
  move: Move;
  /** Each frame drawn, per skin, as it's first shown, at the scale it was drawn for. */
  drawn: Partial<Record<HarnessId, { u: number; frames: HTMLCanvasElement[] }>>;
};

function unpack(p: Packed): Uint8Array[] {
  const cur = Uint8Array.from(p.base, (c) => (c === "." ? CLEAR : parseInt(c, 36)));
  const frames = [cur.slice()];
  for (const delta of p.deltas) {
    if (delta)
      for (const change of delta.split(",")) {
        const v = change[change.length - 1];
        cur[parseInt(change.slice(0, -1), 36)] = v === "." ? CLEAR : parseInt(v, 36);
      }
    frames.push(cur.slice());
  }
  return frames;
}

function packed(p: Packed): Sprite {
  const [x, y, w, h] = p.a0[2] > 0 ? p.a0 : [0, 0, p.w, p.h];
  let frames: Uint8Array[] | null = null;
  const n = p.deltas.length + 1;
  // A sprite the app has no move for plays through once.
  const move = p.move ?? { start: 0, end: n - 1, fps: p.fps };
  return { w: p.w, h: p.h, ax: x + w / 2, ay: y + h, palette: p.palette, n, move, frames: () => (frames ??= unpack(p)), drawn: {} };
}

// ---------------- drawn here ----------------
// On the app's standing pose, 24×16: body x4–19 rows 0–11, eyes 2×2 at x6 and x16 rows 2–3, arms 4×4 at x0 and x20
// rows 4–7, legs 2×4 rows 12–15. Drawn in those coordinates, with 2 columns spare each side and 6 rows above for
// what reaches out or pops up over him.

const SIDE = 2;
const TOP = 6;
const DW = 24 + 2 * SIDE;
const DH = 16 + TOP;
const [EYE, MAIN, GOLD, SHINE, GLASS] = [0, 1, 2, 3, 4];
// The shades' black isn't his eyes', so a skin that lights his eyes up leaves them dark.
const PALETTE = ["#141413", "#d97757", "#efb154", "#faf7e5", "#101012"];

class Frame {
  data = new Uint8Array(DW * DH).fill(CLEAR);
  rect(x: number, y: number, w: number, h: number, c: number) {
    for (let yy = Math.max(0, y); yy < Math.min(DH, y + h); yy++)
      for (let xx = Math.max(0, x + SIDE); xx < Math.min(DW, x + SIDE + w); xx++) this.data[yy * DW + xx] = c;
    return this;
  }
  /** The same rect on both sides, mirrored about his middle. */
  pair(x: number, y: number, w: number, h: number, c: number) {
    return this.rect(x, y, w, h, c).rect(24 - x - w, y, w, h, c);
  }
  glyph(x: number, y: number, rows: string[], c: number) {
    rows.forEach((row, dy) => [...row].forEach((ch, dx) => ch === "#" && this.rect(x + dx, y + dy, 1, 1, c)));
    return this;
  }
}

type Pose = {
  larm?: number;
  rarm?: number;
  eyes?: "open" | "wink" | "halfWink";
  look?: number;
  /** Rows taller, stretched up from the legs. */
  grow?: number;
  /** Both arms up in a bicep flex: halfway or all the way. */
  flex?: 0 | 1 | 2;
  /** Sunglasses, by their top row. */
  shades?: number | null;
  /** A glint crossing the lenses, by column. */
  glint?: number | null;
};

const SIX = ["###", "#..", "###", "#.#", "###"];
const SEVEN = ["###", "..#", "..#", ".#.", ".#."];
const SPARKLE = [".#.", "###", ".#."];

/** Clawd standing: arms raised (−) or lowered (+) by rows, eyes glancing `look` columns. */
function clawd({ larm = 0, rarm = 0, eyes = "open", look = 0, grow = 0, flex = 0, shades = null, glint = null }: Pose = {}): Frame {
  const top = TOP - grow;
  const f = new Frame().rect(4, top, 16, 12 + grow, MAIN);
  if (flex) {
    // Upper arm out from the shoulder, forearm up from the elbow; at full flex a fist on it and the bicep bunched.
    f.pair(-2, top + 4, 6, 3, MAIN);
    if (flex === 1) f.pair(-2, top + 2, 2, 2, MAIN);
    else f.pair(-2, top, 2, 4, MAIN).pair(-2, top - 2, 3, 2, MAIN).pair(1, top + 3, 2, 1, MAIN);
  } else f.rect(0, top + 4 + larm, 4, 4, MAIN).rect(20, top + 4 + rarm, 4, 4, MAIN);
  for (const x of [4, 8, 14, 18]) f.rect(x, TOP + 12, 2, 4, MAIN);
  // Shut, an eye is a line along its bottom row, as the desktop app draws one.
  f.rect(6 + look, top + 2, 2, 2, EYE);
  if (eyes === "open") f.rect(16 + look, top + 2, 2, 2, EYE);
  else if (eyes === "halfWink") f.rect(16, top + 3, 2, 1, EYE);
  else f.rect(15, top + 3, 4, 1, EYE);
  if (shades !== null) {
    f.rect(5, shades, 14, 1, GLASS).pair(5, shades + 1, 4, 1, GLASS).pair(6, shades + 2, 2, 1, GLASS);
    if (glint !== null) f.rect(glint, shades + 1, 1, 1, SHINE).rect(glint + 1, shades, 1, 1, SHINE);
  }
  return f;
}

const times = (n: number, make: (i: number) => Frame) => Array.from({ length: n }, (_, i) => make(i));
const standing = (n: number) => times(n, () => clawd());

type Drawn = { frames: Frame[]; move: Move };

/** The 6‑7 hands: palms weighing up and down in turn, a 6 over the left one up, a 7 over the right. */
function sixSeven(): Drawn {
  const bob = [0, -2, -3, -3, -2, 0, 2, 3, 3, 2];
  const hands = bob.map((d) => {
    const f = clawd({ larm: d, rarm: -d, look: Math.sign(d) });
    if (d <= -2) f.glyph(0, 0, SIX, MAIN);
    if (d >= 2) f.glyph(21, 0, SEVEN, MAIN);
    return f;
  });
  return { frames: [...standing(2), ...hands, ...standing(2)], move: { start: 0, loop: [2, 11], out: [12, 13], fps: 12 } };
}

/** A wink, an arm up, a sparkle twinkling by his face. */
function rizzing(): Drawn {
  const twinkle = [SPARKLE, SPARKLE, SPARKLE, ["#"], ["#"], null, null];
  const wink = twinkle.map((s) => {
    const f = clawd({ eyes: "wink", rarm: -1 });
    return s ? f.glyph(s === SPARKLE ? 20 : 21, s === SPARKLE ? 1 : 2, s, GOLD) : f;
  });
  const half = clawd({ eyes: "halfWink" });
  return { frames: [...standing(6), half, ...wink, half, ...standing(3)], move: { start: 3, loop: [7, 13], out: [14, 17], fps: 12 } };
}

/** Shades drop onto his face and a glint runs across them; he stretches up tall into a double-bicep flex, a sparkle
 *  twinkling off the lenses, held while the word is; then lets it go and the shades lift away. */
function mogging(): Drawn {
  const on = TOP + 2;
  const drop = [0, 2, 4, 6, 7].map((y) => clawd({ shades: y }));
  const sweep = [5, 6, 7, null, 15, 16, 17, null].map((glint) => clawd({ shades: on, glint }));
  const twinkle = [SPARKLE, SPARKLE, SPARKLE, ["#"], ["#"], null, null, null];
  const flexed = twinkle.map((s) => {
    const f = clawd({ grow: 2, flex: 2, shades: on - 2 });
    return s ? f.glyph(s === SPARKLE ? 20 : 21, s === SPARKLE ? on - 4 : on - 3, s, GOLD) : f;
  });
  const half = clawd({ grow: 1, flex: 1, shades: on - 1 });
  const lift = [6, 4, 2, 0].map((y) => clawd({ shades: y }));
  return {
    frames: [...standing(4), ...drop, ...sweep, half, ...flexed, half, ...times(4, () => clawd({ shades: on })), ...lift, ...standing(3)],
    move: { start: 2, loop: [18, 25], out: [26, 37], fps: 12 },
  };
}

function drawn(make: () => Drawn): Sprite {
  const { frames, move } = make();
  const data = frames.map((f) => f.data);
  return { w: DW, h: DH, ax: DW / 2, ay: DH, palette: PALETTE, frames: () => data, n: data.length, move, drawn: {} };
}

// ---------------- the player ----------------

// Read once: Bun pastes a macro's value in wherever a constant holding it is used.
const OFFICIAL = Object.entries(clawdSprites()).map(([name, p]) => [name, packed(p)] as const);
const SPRITES: Record<string, Sprite> = {
  ...Object.fromEntries(OFFICIAL),
  SixSeven: drawn(sixSeven),
  Rizzing: drawn(rizzing),
  Mogging: drawn(mogging),
};

/** Whether the build found the desktop app's animations: without them he isn't shown at all. */
export const ready = OFFICIAL.length > 0;
export const has = (name: string) => name in SPRITES;

// One box fits every animation, lined up by his feet, so nothing around him moves when he changes.
const all = Object.values(SPRITES);
const LEFT = Math.max(...all.map((s) => s.ax));
const RIGHT = Math.max(...all.map((s) => s.w - s.ax));
const UP = Math.max(...all.map((s) => s.ay));
const DOWN = Math.max(...all.map((s) => s.h - s.ay));
/** The standing pose (half its width, its height): all he takes up in the row; the rest draws over what's around. */
const [HALF, STAND] = [12, 16];
/** CSS px per sprite pixel. */
const SCALE = 1;
/** About how long a word stays: a loop keeps going, or a short move plays again, until then. */
const HOLD = 6000;
/** Standing still after a move, before the next. */
const REST = 600;

// ---------------- skins ----------------
// Each harness's Clawd, by the colours his sprites are drawn in: Claude's own orange; for Codex the blue of its pet,
// eyes glowing like its terminal face; for Cursor the greys of its cube, eyes bright. The app paints his body in two
// near-identical oranges and shades, and his eyes in two blacks, so each is listed.

function skin(body: string, shade: string, eyes: string, props: Record<string, string> = {}): Record<string, string> {
  const pairs = [["#d97757", body], ["#d87656", body], ["#be684d", shade], ["#bf694d", shade], ["#141413", eyes], ["#000000", eyes]];
  return { ...Object.fromEntries(pairs), ...props };
}
const SKINS: Record<HarnessId, Record<string, string>> = {
  claude: {},
  codex: skin("#5b7cfa", "#4560d8", "#a8f0ff"),
  // The laptop's grey would melt into him: a darker one.
  cursor: skin("#8e8e96", "#6f6f77", "#f4f4f5", { "#8b8b8b": "#4b4b52" }),
};

/** Frame `i` in `harness`'s skin, scaled here to `u` device pixels a sprite pixel (nearest, on the box's grid, so
 *  every sprite's pixels fall the same way) for drawing 1:1. Scaled by the canvas instead, the GPU samples just past
 *  the frame's edge and paints its bottom row (feet, the laptop's base) as a line over his head. */
function frameCanvas(s: Sprite, harness: HarnessId, i: number, u: number): HTMLCanvasElement {
  const cache = s.drawn[harness]?.u === u ? s.drawn[harness]! : (s.drawn[harness] = { u, frames: [] });
  if (cache.frames[i]) return cache.frames[i];
  // The sprite column (or row) each device pixel it covers shows.
  const span = (from: number, n: number) => {
    const [a, b] = [Math.round(from * u), Math.round((from + n) * u)];
    return Array.from({ length: b - a }, (_, k) => Math.min(n - 1, Math.max(0, Math.floor((a + k + 0.5) / u) - from)));
  };
  const cols = span(LEFT - s.ax, s.w);
  const rows = span(UP - s.ay, s.h);
  const canvas = document.createElement("canvas");
  canvas.width = cols.length;
  canvas.height = rows.length;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(canvas.width, canvas.height);
  const colours = SKINS[harness];
  const rgb = s.palette.map((c) => colours[c.toLowerCase()] ?? c).map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
  const frame = s.frames()[i];
  rows.forEach((sy, y) =>
    cols.forEach((sx, x) => {
      const v = frame[sy * s.w + sx];
      if (v === CLEAR) return;
      const at = (y * cols.length + x) * 4;
      img.data.set(rgb[v], at);
      img.data[at + 3] = 255;
    }),
  );
  ctx.putImageData(img, 0, 0);
  return (cache.frames[i] = canvas);
}

type Stage = "intro" | "loop" | "out" | "once" | "rest";
type Phase = { stage: Stage; from: number; to: number; fps: number };

export type Player = {
  el: HTMLElement;
  /** How far (CSS px) he can draw above his row. */
  rise(): number;
};

/** Clawd in `harness`'s colours, going through `words` from `first` on, each acted out by its emote; `shown` runs as
 *  each one starts. With `still` on he strikes each move's pose instead of playing it. */
export function player(
  harness: HarnessId,
  words: [word: string, emote: string][],
  first: number,
  shown: (word: string) => void,
  still: () => boolean,
): Player {
  const el = document.createElement("span");
  el.className = "clawd";
  const canvas = document.createElement("canvas");
  el.append(canvas);
  const ctx = canvas.getContext("2d")!;
  let at = first - 1;
  let sprite = all[0];
  let began = 0; // when this word's move started
  let phase: Phase = { stage: "rest", from: 0, to: 0, fps: 1 };
  let entered = 0; // when the phase started
  let drawn = -1;
  let dpr = 0;
  let raf = 0;

  const enter = (stage: Stage, from: number, to: number, fps: number, now: number) => {
    phase = { stage, from, to, fps };
    entered = now;
  };
  const rest = (now: number) => enter("rest", 0, 0, 1000 / REST, now);
  const once = (now: number) => enter("once", sprite.move.start, sprite.move.end!, sprite.move.fps, now);
  const loop = (now: number, from = sprite.move.loop![0]) => enter("loop", from, sprite.move.loop![1], sprite.move.fps, now);

  /** On to the next word and into its move: through its intro, or straight into its loop where it starts inside it. */
  const next = (now: number) => {
    at = (at + 1) % words.length;
    const [word, emote] = words[at];
    sprite = SPRITES[emote];
    began = now;
    drawn = -1;
    shown(word);
    const m = sprite.move;
    if (!m.loop) once(now);
    else if (m.start < m.loop[0]) enter("intro", m.start, m.loop[0] - 1, m.fps, now);
    else loop(now, Math.min(m.start, m.loop[1]));
  };

  /** The phase played out: what comes after it. */
  const advance = (now: number) => {
    const m = sprite.move;
    const spent = now - began;
    switch (phase.stage) {
      case "intro":
        return loop(now);
      case "loop":
        if (spent < HOLD) return loop(now);
        // Out the app's way back to standing, where it has one.
        return m.out ? enter("out", m.out[0], m.out[1], m.outFps ?? m.fps, now) : rest(now);
      case "out":
      case "once":
        return rest(now);
      case "rest": {
        const again = m.loop ? Infinity : ((m.end! - m.start + 1) * 1000) / m.fps + REST;
        return spent + again <= HOLD ? once(now) : next(now);
      }
    }
  };

  const fit = () => {
    if (devicePixelRatio === dpr) return;
    dpr = devicePixelRatio || 1;
    // Device pixels exactly, so his pixels land on whole ones (nearest neighbour where the zoom isn't a whole number).
    canvas.width = Math.round((LEFT + RIGHT) * SCALE * dpr);
    canvas.height = Math.round((UP + DOWN) * SCALE * dpr);
    Object.assign(el.style, { width: `${(HALF + RIGHT) * SCALE}px`, height: `${STAND * SCALE}px` });
    Object.assign(canvas.style, {
      left: `${-(LEFT - HALF) * SCALE}px`,
      bottom: `${-DOWN * SCALE}px`,
      width: `${canvas.width / dpr}px`,
      height: `${canvas.height / dpr}px`,
    });
    drawn = -1;
  };

  const tick = (now: number) => {
    // Gone with the trailer (the turn ended): stop.
    if (!el.isConnected) return void (raf = 0);
    raf = requestAnimationFrame(tick);
    fit();
    let frame: number;
    if (still()) {
      if (now - began >= HOLD) next(now);
      const m = sprite.move;
      frame = m.loop ? (m.loop[0] + m.loop[1]) >> 1 : Math.floor(m.start + (m.end! - m.start) * 0.4);
    } else {
      frame = phase.from + Math.max(0, Math.floor(((now - entered) * phase.fps) / 1000));
      if (frame > phase.to) {
        advance(now);
        frame = phase.from;
      }
    }
    if (frame === drawn) return;
    drawn = frame;
    const u = SCALE * dpr; // device px per sprite pixel
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frameCanvas(sprite, harness, frame, u), Math.round((LEFT - sprite.ax) * u), Math.round((UP - sprite.ay) * u));
  };

  fit();
  next(performance.now());
  raf = requestAnimationFrame(tick);
  return { el, rise: () => (UP - STAND) * SCALE };
}
