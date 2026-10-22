// Sharks hunting schools of fish, drawn in ASCII: an animated new-thread background (background.ts plays it).
// After the look of stackedlol/ascii-sharks, in greys only: a faint cell grid; sharks rasterised cell by cell as
// shaded blocks, each carrying a glyph that's denser the darker the skin there, with a soft punctuation edge; fish
// as single dashes; a wake that dots the cells wherever anything swims and spreads like a ripple; a spark where a
// fish is caught. Fish school as boids and flee the sharks and the pointer; bull sharks wander, circle and hunt the
// stragglers, keeping clear of the composer, and once in a while a hammerhead swims in, hunts a while and leaves.

export type Box = { x: number; y: number; width: number; height: number };

export type Scene = {
  /** Lay the scene out at w×h CSS px; the first call fills it. */
  resize(w: number, h: number, dpr: number): void;
  /** Where the composer is. Set before the first `resize`. */
  avoid(box: Box | null): void;
  step(dt: number): void;
  /** One frame onto `ctx`, a canvas of w·dpr × h·dpr, transparent where there's nothing. */
  draw(ctx: CanvasRenderingContext2D, light: boolean): void;
  pointer(at: { x: number; y: number } | null): void;
  splash(x: number, y: number): void;
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const smooth = (t: number) => ((t = clamp(t, 0, 1)), t * t * (3 - 2 * t));

/** A stable [0, 1) per integer triple, so a glyph keeps to its patch of skin. */
function hash(a: number, b: number, c: number) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2f2c3a8d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The cells' size for a scene `w` wide: about 120 across. */
function cellSize(w: number) {
  const cw = clamp(Math.round(w / 120), 8, 12);
  return { cw, ch: Math.round(cw * 1.48) };
}

/** The faint grid the cells sit on, at device pixels. */
function paintGrid(g: HTMLCanvasElement, w: number, h: number, dpr: number, cw: number, ch: number, light: boolean) {
  g.width = Math.round(w * dpr);
  g.height = Math.round(h * dpr);
  const c = g.getContext("2d")!;
  c.strokeStyle = light ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.055)";
  c.lineWidth = 1;
  c.beginPath();
  for (let x = 0; x <= Math.ceil(w / cw); x++) {
    const px = Math.round(x * cw * dpr) + 0.5;
    c.moveTo(px, 0);
    c.lineTo(px, g.height);
  }
  for (let y = 0; y <= Math.ceil(h / ch); y++) {
    const py = Math.round(y * ch * dpr) + 0.5;
    c.moveTo(0, py);
    c.lineTo(g.width, py);
  }
  c.stroke();
}

const TAU = Math.PI * 2;
/** The signed turn from angle a to b, the short way round. */
function turnTo(a: number, b: number) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

// ---------------- fish ----------------

/** How a school behaves: speeds (px/s), the room each fish keeps (in cells, x and y, so each gets a cell of its
 *  own), and how strongly it lines up, closes in, wheels round its middle, wavers and keeps level. */
type Temper = { cruise: number; top: number; slow: number; gap: [number, number]; align: number; cohere: number; mill: number; jitter: number; level: number; size: [number, number] };
const TEMPERS: Temper[] = [
  // A bait ball, wheeling round its own middle.
  { cruise: 34, top: 62, slow: 16, gap: [1.8, 1.1], align: 1.5, cohere: 1.6, mill: 65, jitter: 40, level: 0.5, size: [16, 26] },
  // A ribbon: long, quick and all one way.
  { cruise: 46, top: 80, slow: 22, gap: [1.5, 1], align: 3.2, cohere: 0.45, mill: 0, jitter: 30, level: 1.4, size: [18, 30] },
  // A loose shoal that keeps together without quite lining up.
  { cruise: 30, top: 60, slow: 14, gap: [2.4, 1.3], align: 1.8, cohere: 1, mill: 0, jitter: 30, level: 1.8, size: [6, 12] },
  // Drifters, milling about.
  { cruise: 24, top: 54, slow: 10, gap: [1.4, 1.1], align: 0.35, cohere: 1.4, mill: 0, jitter: 100, level: 0.3, size: [8, 12] },
];

type Fish = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: number;
  /** 0 calm → 1 bolting; passes from fish to fish. */
  alarm: number;
  alive: boolean;
  /** When an eaten fish swims back in. */
  due: number;
  /** Smoothed rate of turn (rad/s): a hard turn glints. */
  turn: number;
  /** 0.55 far (dim) → 1 near. */
  near: number;
  /** Which way its school wheels. */
  spin: 1 | -1;
};

// ---------------- sharks ----------------

const NODES = 18;

type Shark = {
  id: number;
  kind: Kind;
  length: number;
  near: number;
  /** The spine, snout first: x0, y0, x1, y1, … */
  nodes: Float32Array;
  heading: number;
  speed: number;
  /** Tail beat. */
  phase: number;
  turn: number;
  hunger: number;
  wander: number;
  /** The radius of its circuit, in the water's shorter side. */
  orbit: number;
  spin: 1 | -1;
  prey: Fish | null;
  retarget: number;
  /** A visitor (the hammerhead): when it heads off, and which way out. */
  leaves?: { at: number; dx: number; dy: number };
};

/** How long until a hammerhead comes by (s): the first soon after the screen is up, then now and then. */
const FIRST_VISIT: [number, number] = [20, 50];
const NEXT_VISIT: [number, number] = [70, 160];
/** How long one stays. */
const STAY: [number, number] = [25, 45];

/** Half a requiem shark's width at s (0 snout → 1 tail), in lengths: a rounded snout, the girth just behind the
 *  gills, a long taper to the tail stalk. */
function requiem(s: number) {
  if (s < 0.12) return 0.095 * Math.sqrt(Math.sin(((s / 0.12) * Math.PI) / 2));
  if (s < 0.28) return 0.095 + 0.01 * smooth((s - 0.12) / 0.16);
  if (s < 0.86) return 0.018 + 0.087 * Math.pow(1 - (s - 0.28) / 0.58, 1.3);
  return 0.006 + 0.012 * (1 - (s - 0.86) / 0.14);
}

/** A fin as `onFin` takes it: front and back of its root, its tip's place along the body, its reach, its sweep. */
type Fin = [number, number, number, number, number];

/** A species seen from above, in lengths and in s along the body (0 snout → 1 tail). */
type Shape = {
  /** Half the body's width at s. */
  girth: (s: number) => number;
  pectoral: Fin;
  pelvic: Fin;
  caudal: Fin;
  /** Where along the back the first dorsal (lit, a ridge) and the second dorsal are. */
  dorsal: [number, number];
  second: [number, number];
  /** null: the eyes are at the hammer's tips. */
  eye: [number, number] | null;
  gills: [number, number];
  /** A hammerhead's cephalofoil: its half span and its depth, at the front of the head. */
  head?: { span: number; depth: number };
};

type Kind = "bull" | "hammerhead";
const SHAPES: Record<Kind, Shape> = {
  // Stocky: a short, blunt, broad snout, a heavy body, big triangular pectorals and a broad first dorsal.
  bull: {
    girth: (s) => {
      if (s < 0.07) return 0.105 * Math.pow(Math.sin(((s / 0.07) * Math.PI) / 2), 0.4);
      if (s < 0.26) return 0.105 + 0.02 * smooth((s - 0.07) / 0.19);
      if (s < 0.84) return 0.02 + 0.105 * Math.pow(1 - (s - 0.26) / 0.58, 1.15);
      return 0.006 + 0.014 * (1 - (s - 0.84) / 0.16);
    },
    pectoral: [0.15, 0.38, 0.5, 0.28, 1.5],
    pelvic: [0.58, 0.64, 0.69, 0.08, 1.2],
    caudal: [0.85, 0.95, 1, 0.1, 1.4],
    dorsal: [0.3, 0.45],
    second: [0.72, 0.75],
    eye: [0.06, 0.09],
    gills: [0.15, 0.25],
  },
  // A slim neck behind the hammer, a tall first dorsal, a long upper tail lobe.
  hammerhead: {
    girth: (s) => {
      if (s < 0.07) return 0.04;
      if (s < 0.3) return 0.04 + 0.062 * smooth((s - 0.07) / 0.23);
      return requiem(s) * 0.92;
    },
    head: { span: 0.17, depth: 0.075 },
    pectoral: [0.17, 0.38, 0.48, 0.22, 1.8],
    pelvic: [0.56, 0.63, 0.67, 0.07, 1.2],
    caudal: [0.86, 0.95, 1, 0.11, 1.5],
    dorsal: [0.28, 0.44],
    second: [0.7, 0.74],
    eye: null,
    gills: [0.16, 0.26],
  },
};

/** Whether (s along, a out from the spine, in lengths) is on a fin rooted along the spine from `front` to `back`
 *  with its tip `reach` out at `tip`. A `sweep` over 1 bows the trailing edge in, a sickle's. */
function onFin(s: number, a: number, front: number, back: number, tip: number, reach: number, sweep: number) {
  const t = a / reach;
  return t <= 1 && s >= front + (tip - front) * t && s <= back + (tip - back) * Math.pow(t, sweep);
}

// What a cell of shark is.
const BODY = 1;
const EDGE = 2;
const FIN = 3;
const RIDGE = 4;
const EYE = 5;

// Sparse glyphs on lit skin, dense ones in shadow, so the texture deepens the shading.
const SKIN = ":;t%SX8#@";
const FINS = "%;tS:";
const RIDGES = "@8%";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";
/** Where in a cell the coverage samples fall, besides its centre. */
const SAMPLES = [0.25, 0.28, 0.75, 0.28, 0.25, 0.72, 0.75, 0.72];
const LEVELS = 6;

class Ocean implements Scene {
  private w = 0;
  private h = 0;
  private dpr = 1;
  private cw = 10;
  private ch = 15;
  private cols = 0;
  private rows = 0;
  private time = 0;
  private fish: Fish[] = [];
  private sharks: Shark[] = [];
  private box: Box | null = null;
  private at: { x: number; y: number } | null = null;
  private lastSchool = 0;
  /** The bull sharks' length; a visitor is a little smaller. */
  private longest = 300;
  private nextVisit = rand(...FIRST_VISIT);

  // The school's neighbourhoods: a bucket grid as wide as a fish can see.
  private sight = 60;
  private gapX: number[] = [];
  private gapY: number[] = [];
  private apart = 30;
  private bCols = 0;
  private bRows = 0;
  private head = new Int32Array(0);
  private count = new Uint16Array(0);
  private next = new Int32Array(0);

  // Per cell.
  private wake = new Float32Array(0);
  private wakeTmp = new Float32Array(0);
  private heat = new Float32Array(0);
  private code = new Uint8Array(0);
  private shade = new Float32Array(0);
  private key = new Uint32Array(0);
  private depth = new Float32Array(0);
  private fishAt = new Uint32Array(0);
  private frame = 0;
  private grid: HTMLCanvasElement = document.createElement("canvas");
  private gridLight: boolean | null = null;

  // The shark being rasterised, and what the last sample hit.
  private spine = new Float32Array(NODES * 2);
  private arc = new Float32Array(NODES);
  private total = 1;
  private length = 1;
  private shape: Shape = SHAPES.bull;
  private finLeft = 0.25;
  private finRight = 0.25;
  private hitA = 0;
  private hitS = 0;
  private hitV = 0;
  private hitShade = 0;

  constructor(private font: string) {}

  resize(w: number, h: number, dpr: number) {
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    const first = !this.w;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    Object.assign(this, cellSize(w));
    this.cols = Math.ceil(w / this.cw);
    this.rows = Math.ceil(h / this.ch);
    const n = this.cols * this.rows;
    this.wake = new Float32Array(n);
    this.wakeTmp = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.code = new Uint8Array(n);
    this.shade = new Float32Array(n);
    this.key = new Uint32Array(n);
    this.depth = new Float32Array(n);
    this.fishAt = new Uint32Array(n);
    this.gridLight = null;
    this.gapX = TEMPERS.map((t) => t.gap[0] * this.cw);
    this.gapY = TEMPERS.map((t) => t.gap[1] * this.ch);
    this.sight = Math.max(this.ch * 3, this.cw * 5.5);
    this.apart = this.cw * 3;
    if (first) {
      this.seed();
      // Let the schools find their shapes before the first frame.
      for (let i = 0; i < 180; i++) this.step(1 / 60);
    } else
      for (const f of this.fish) {
        f.x = clamp(f.x, 0, w);
        f.y = clamp(f.y, 0, h);
      }
  }

  avoid(box: Box | null) {
    this.box = box;
  }


  pointer(at: { x: number; y: number } | null) {
    this.at = at;
  }

  splash(x: number, y: number) {
    this.stamp(this.wake, x, y, 6, 1.4);
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d > 240 || d < 1e-3) continue;
      const k = (1 - d / 240) * 260;
      f.vx += (dx / d) * k;
      f.vy += (dy / d) * k;
      f.alarm = 1;
    }
  }

  private seed() {
    const { w, h } = this;
    const side = Math.min(w, h);
    this.longest = clamp(Math.max(side * 0.6, w * 0.25), 160, 420);
    const sizes = w < 700 ? [1, 0.75] : [1, 0.8, 0.68];
    this.sharks = sizes.map((size, i) => {
      const orbit = rand(0.26, 0.38);
      const a = (i / sizes.length) * TAU + rand(-0.4, 0.4);
      const spin: 1 | -1 = i % 2 ? -1 : 1;
      return this.shark(i + 1, "bull", size, w / 2 + Math.cos(a) * orbit * w * 0.9, h / 2 + Math.sin(a) * orbit * side, a + (spin * Math.PI) / 2, orbit, spin);
    });
    // The far ones go first so the nearest swims over them.
    this.sharks.sort((a, b) => a.length - b.length);

    const total = clamp(Math.round((w * h) / 4600), 70, 300);
    this.fish = [];
    while (this.fish.length < total) {
      const kind = Math.floor(Math.random() * TEMPERS.length);
      const t = TEMPERS[kind];
      const size = Math.min(Math.round(rand(t.size[0], t.size[1])), total - this.fish.length);
      const cx = rand(w * 0.06, w * 0.94);
      const cy = rand(h * 0.08, h * 0.9);
      const dir = (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5);
      const spin: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      for (let k = 0; k < size; k++)
        this.fish.push({
          x: cx + rand(-1, 1) * this.gapX[kind] * Math.sqrt(size),
          y: cy + rand(-1, 1) * this.gapY[kind] * Math.sqrt(size) * 0.6,
          vx: Math.cos(dir) * t.cruise,
          vy: Math.sin(dir) * t.cruise,
          kind,
          alarm: 0,
          alive: true,
          due: 0,
          turn: 0,
          near: rand(0.55, 1),
          spin,
        });
    }
  }

  /** A shark `size` of the longest, snout at (x, y), lying straight back from its heading. */
  private shark(id: number, kind: Kind, size: number, x: number, y: number, heading: number, orbit: number, spin: 1 | -1): Shark {
    const length = this.longest * size;
    const nodes = new Float32Array(NODES * 2);
    for (let k = 0; k < NODES; k++) {
      nodes[k * 2] = x - (Math.cos(heading) * length * k) / (NODES - 1);
      nodes[k * 2 + 1] = y - (Math.sin(heading) * length * k) / (NODES - 1);
    }
    return { id, kind, length, near: size, nodes, heading, speed: 30, phase: rand(0, TAU), turn: 0, hunger: rand(0.4, 0.8), wander: 0, orbit, spin, prey: null, retarget: 0 };
  }

  /** Now and then a hammerhead swims in from one side; after a while it heads out the other way, and is gone. */
  private visit() {
    const { w, h, time } = this;
    const visitor = this.sharks.find((sh) => sh.leaves);
    if (visitor) {
      // Gone once the whole body is off the screen.
      const n = visitor.nodes;
      const out = (k: number) => n[k * 2] < -40 || n[k * 2] > w + 40 || n[k * 2 + 1] < -40 || n[k * 2 + 1] > h + 40;
      if (time > visitor.leaves!.at && out(0) && out(NODES - 1)) {
        this.sharks = this.sharks.filter((sh) => sh !== visitor);
        this.nextVisit = time + rand(...NEXT_VISIT);
      }
      return;
    }
    if (time < this.nextVisit) return;
    const fromLeft = Math.random() < 0.5;
    const y = rand(h * 0.15, h * 0.85);
    const size = 0.86;
    const heading = (fromLeft ? 0 : Math.PI) + rand(-0.3, 0.3);
    const x = fromLeft ? -20 : w + 20;
    const hammer = this.shark(Math.max(0, ...this.sharks.map((sh) => sh.id)) + 1, "hammerhead", size, x, y, heading, rand(0.26, 0.38), fromLeft ? 1 : -1);
    // It leaves by the side it didn't come in from.
    hammer.leaves = { at: time + rand(...STAY), dx: fromLeft ? 1 : -1, dy: 0 };
    this.sharks.push(hammer);
    this.sharks.sort((a, b) => a.length - b.length);
  }

  // ---------------- simulation ----------------

  step(dt: number) {
    if (!this.w) return;
    this.time += dt;
    this.bucket();
    this.swim(dt);
    this.visit();
    this.hunt(dt);
    this.restock();
    this.ripple(dt);
  }

  private bucketOf(x: number, y: number) {
    const c = clamp(Math.floor(x / this.sight) + 1, 0, this.bCols - 1);
    const r = clamp(Math.floor(y / this.sight) + 1, 0, this.bRows - 1);
    return r * this.bCols + c;
  }

  private bucket() {
    this.bCols = Math.ceil(this.w / this.sight) + 2;
    this.bRows = Math.ceil(this.h / this.sight) + 2;
    const n = this.bCols * this.bRows;
    if (this.head.length !== n) {
      this.head = new Int32Array(n);
      this.count = new Uint16Array(n);
    }
    if (this.next.length !== this.fish.length) this.next = new Int32Array(this.fish.length);
    this.head.fill(-1);
    this.count.fill(0);
    this.fish.forEach((f, i) => {
      if (!f.alive) return;
      const b = this.bucketOf(f.x, f.y);
      this.next[i] = this.head[b];
      this.head[b] = i;
      this.count[b]++;
    });
  }

  private swim(dt: number) {
    const { fish, sharks, w, h, time, sight, apart, head, next, bCols, bRows } = this;
    const sight2 = sight * sight;
    const calming = Math.exp(-dt * 0.7);
    const spread = Math.min(1, dt * 6);
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const t = TEMPERS[f.kind];
      // A frightened school opens out, and closes up again once it's calm.
      const room = 1 + 1.8 * f.alarm;
      const gx = this.gapX[f.kind] * room;
      const gy = this.gapY[f.kind] * room;
      const speed = Math.hypot(f.vx, f.vy) || 1;
      const hx = f.vx / speed;
      const hy = f.vy / speed;

      let sx = 0;
      let sy = 0;
      let vx = 0;
      let vy = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      let heard = 0;
      const bc = clamp(Math.floor(f.x / sight) + 1, 0, bCols - 1);
      const br = clamp(Math.floor(f.y / sight) + 1, 0, bRows - 1);
      for (let r = Math.max(0, br - 1); r <= Math.min(bRows - 1, br + 1); r++)
        for (let c = Math.max(0, bc - 1); c <= Math.min(bCols - 1, bc + 1); c++)
          for (let j = head[r * bCols + c]; j !== -1; j = next[j]) {
            if (j === i) continue;
            const o = fish[j];
            const dx = o.x - f.x;
            const dy = o.y - f.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= sight2 || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            // Nothing straight behind is seen.
            if ((dx * hx + dy * hy) / d < -0.6) continue;
            // Room kept in an ellipse, wide along x: one fish to a cell.
            const qx = dx / gx;
            const qy = dy / gy;
            const q2 = qx * qx + qy * qy;
            if (q2 < 1) {
              const q = Math.sqrt(q2) || 1e-3;
              sx -= (qx * (1 - q)) / q;
              sy -= (qy * (1 - q)) / q;
            }
            if (o.kind === f.kind) {
              vx += o.vx;
              vy += o.vy;
              cx += dx;
              cy += dy;
              n++;
            } else if (d < apart) {
              // Other schools stay their own.
              const k = ((1 - d / apart) / d) * 0.6;
              sx -= dx * k;
              sy -= dy * k;
            }
            heard = Math.max(heard, o.alarm);
          }

      let ax = sx * 420;
      let ay = sy * 420;
      if (n) {
        const cohere = t.cohere * (1 - 0.8 * f.alarm);
        ax += (vx / n - f.vx) * 1.4 * t.align + (cx / n) * cohere;
        ay += (vy / n - f.vy) * 1.4 * t.align + (cy / n) * cohere;
        if (t.mill) {
          const cl = Math.hypot(cx, cy) || 1;
          ax += (-cy / cl) * f.spin * t.mill * (1 - f.alarm);
          ay += (cx / cl) * f.spin * t.mill * (1 - f.alarm);
        }
      }

      // Sharks: kept at a distance from the front half of the body, and dodged sideways off the line it swims.
      let fear = 0;
      for (const sh of sharks) {
        const range = sh.length * 0.6 + 60;
        let best = Infinity;
        let bx = 0;
        let by = 0;
        for (let k = 0; k <= 9; k += 3) {
          const d2 = (f.x - sh.nodes[k * 2]) ** 2 + (f.y - sh.nodes[k * 2 + 1]) ** 2;
          if (d2 < best) [best, bx, by] = [d2, sh.nodes[k * 2], sh.nodes[k * 2 + 1]];
        }
        const d = Math.sqrt(best);
        if (d >= range || d < 1e-3) continue;
        const wt = (1 - d / range) ** 2;
        const px = Math.cos(sh.heading);
        const py = Math.sin(sh.heading);
        const side = px * (f.y - sh.nodes[1]) - py * (f.x - sh.nodes[0]) >= 0 ? 1 : -1;
        ax += (((f.x - bx) / d) * 0.7 - py * side * 0.9) * 1100 * wt;
        ay += (((f.y - by) / d) * 0.7 + px * side * 0.9) * 1100 * wt;
        fear = Math.max(fear, Math.sqrt(wt));
      }
      if (this.at) {
        const dx = f.x - this.at.x;
        const dy = f.y - this.at.y;
        const d = Math.hypot(dx, dy);
        if (d < 130 && d > 1e-3) {
          const wt = (1 - d / 130) ** 2;
          ax += (dx / d) * 1100 * wt;
          ay += (dy / d) * 1100 * wt;
          fear = Math.max(fear, Math.sqrt(wt) * 0.8);
        }
      }
      // Alarm: set by a threat, passed on a little weaker by each neighbour, fading by itself.
      let alarm = Math.max(f.alarm * calming, fear);
      if (heard * 0.86 > alarm) alarm += (heard * 0.86 - alarm) * spread;
      f.alarm = alarm;

      // Soft walls.
      const m = 36;
      if (f.x < m) ax += (m - f.x) * 7;
      else if (f.x > w - m) ax -= (f.x - (w - m)) * 7;
      if (f.y < m) ay += (m - f.y) * 7;
      else if (f.y > h - m) ay -= (f.y - (h - m)) * 7;

      // A slow current that wheels the schools about without herding them into a corner (the curl of a drifting
      // field, so it neither gathers nor scatters), and each fish's own restlessness.
      const p = f.x / 280 + time * 0.07;
      const q = f.y / 320 - time * 0.05;
      ax += (-Math.sin(p) * Math.sin(q) * 6 + (Math.random() - 0.5) * t.jitter);
      ay += (-Math.cos(p) * Math.cos(q) * 6 * (320 / 280) + (Math.random() - 0.5) * t.jitter);
      // Fish swim level, but for bolting.
      ay -= f.vy * t.level * (1 - 0.7 * f.alarm);
      const want = t.cruise * (1 + 1.3 * f.alarm);
      ax += (want - speed) * hx * 1.6;
      ay += (want - speed) * hy * 1.6;

      const was = Math.atan2(f.vy, f.vx);
      f.vx += ax * dt;
      f.vy += ay * dt;
      const top = t.top * (1 + 1.8 * f.alarm);
      const s = Math.hypot(f.vx, f.vy);
      const k = s > top ? top / s : s < t.slow && s > 1e-3 ? t.slow / s : 1;
      f.vx *= k;
      f.vy *= k;
      f.turn += (turnTo(was, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
      f.x = clamp(f.x + f.vx * dt, -60, w + 60);
      f.y = clamp(f.y + f.vy * dt, -60, h + 60);
    }
  }

  private hunt(dt: number) {
    const { sharks, w, h, time } = this;
    const side = Math.min(w, h);
    const cx = w / 2;
    const cy = h / 2;
    for (const sh of sharks) {
      const L = sh.length;
      const n = sh.nodes;
      const hx = n[0];
      const hy = n[1];
      sh.hunger = Math.min(1, sh.hunger + dt * 0.03);

      let dx = Math.cos(sh.heading);
      let dy = Math.sin(sh.heading);
      // Wander: a slowly drifting aim off the snout.
      sh.wander = clamp(sh.wander + (Math.random() - 0.5) * dt * 3.2, -1.1, 1.1);
      dx += Math.cos(sh.heading + sh.wander) * 0.45;
      dy += Math.sin(sh.heading + sh.wander) * 0.45;

      if (time >= sh.retarget) {
        sh.prey = this.pick(sh);
        sh.retarget = time + 0.45;
      }
      const prey = sh.prey;
      const leaving = !!sh.leaves && time > sh.leaves.at;
      const hunting = !leaving && !!prey?.alive && sh.hunger > 0.3;
      let closing = 0;
      if (leaving) {
        // On its way out.
        dx += sh.leaves!.dx * 2.5;
        dy += sh.leaves!.dy * 2.5;
      } else if (hunting) {
        // Where the fish is about to be.
        const tx = prey!.x + prey!.vx * 0.35 - hx;
        const ty = prey!.y + prey!.vy * 0.35 - hy;
        const d = Math.hypot(tx, ty) || 1;
        dx += (tx / d) * (1.4 + 2.6 * sh.hunger);
        dy += (ty / d) * (1.4 + 2.6 * sh.hunger);
        closing = clamp(1 - d / (L * 0.9), 0, 1);
      } else {
        // A lazy circuit, its ring breathing in and out.
        const rx = (hx - cx) / (w / side);
        const ry = hy - cy;
        const r = Math.hypot(rx, ry) || 1;
        const ring = sh.orbit * side * (1 + 0.15 * Math.sin(time * 0.05 + sh.id));
        const out = clamp((ring - r) / ring, -1, 1);
        dx += ((-ry / r) * sh.spin + (rx / r) * out * 0.9) * 0.55;
        dy += ((rx / r) * sh.spin + (ry / r) * out * 0.9) * 0.55;
      }

      for (const o of sharks) {
        if (o === sh) continue;
        const range = (L + o.length) * 0.45;
        for (let k = 0; k < NODES; k += 4) {
          const ox = hx - o.nodes[k * 2];
          const oy = hy - o.nodes[k * 2 + 1];
          const d = Math.hypot(ox, oy);
          if (d >= range || d < 1e-3) continue;
          dx += (ox / d) * (1 - d / range) * 3;
          dy += (oy / d) * (1 - d / range) * 3;
        }
      }

      // The composer, with room round it: a soft ellipse the sharks turn away from (less so on a chase).
      if (this.box) {
        const b = this.box;
        const ex = (hx - (b.x + b.width / 2)) / (b.width / 2 + 60);
        const ey = (hy - (b.y + b.height / 2)) / (b.height / 2 + 70);
        const e = Math.hypot(ex, ey);
        if (e < 1.25) {
          const wt = (1.25 - e) * (hunting ? 1.5 : 3);
          dx += (ex / (e || 1e-3)) * wt;
          dy += (ey / (e || 1e-3)) * wt;
        }
      }

      // Once the snout leaves the frame, back in: a body dips out of view now and then, but never for long.
      const over = Math.max(-hx, hx - w, -hy, hy - h);
      if (over > -L * 0.05 && !leaving) {
        const wt = clamp((over + L * 0.05) / (L * 0.35), 0, 1) * 3.5;
        const d = Math.hypot(cx - hx, cy - hy) || 1;
        dx += ((cx - hx) / d) * wt;
        dy += ((cy - hy) / d) * wt;
      }

      // No turning on the spot: the faster, the wider the turn.
      const most = Math.min(hunting ? 1.7 + closing : 0.8, sh.speed / (L * 0.22)) * dt;
      const turned = clamp(turnTo(sh.heading, Math.atan2(dy, dx)), -most, most);
      sh.heading += turned;
      sh.turn += (turned / dt - sh.turn) * Math.min(1, dt * 3);
      const cruise = 30 + L * 0.04;
      sh.speed += ((hunting ? cruise * (1.45 + closing * 1.5) : cruise) - sh.speed) * Math.min(1, dt * 1.1);
      sh.phase += dt * (2 + sh.speed / 24);

      n[0] += Math.cos(sh.heading) * sh.speed * dt;
      n[1] += Math.sin(sh.heading) * sh.speed * dt;
      // The body follows the snout, each joint bending only so far: a C at most, never folded.
      const seg = L / (NODES - 1);
      let prev = sh.heading + Math.PI;
      for (let k = 1; k < NODES; k++) {
        const px = n[(k - 1) * 2];
        const py = n[(k - 1) * 2 + 1];
        const a = prev + clamp(turnTo(prev, Math.atan2(n[k * 2 + 1] - py, n[k * 2] - px)), -0.16, 0.16);
        n[k * 2] = px + Math.cos(a) * seg;
        n[k * 2 + 1] = py + Math.sin(a) * seg;
        prev = a;
      }

      if (sh.hunger > 0.15) {
        const mouth = L * 0.05 + 8;
        for (const f of this.fish) {
          if (!f.alive || (f.x - n[0]) ** 2 + (f.y - n[1]) ** 2 >= mouth * mouth) continue;
          f.alive = false;
          f.due = time + rand(3, 8);
          sh.hunger = Math.max(0, sh.hunger - 0.16);
          this.stamp(this.heat, f.x, f.y, 2, 1);
          this.stamp(this.wake, f.x, f.y, 3, 0.9);
        }
      }
    }
  }

  /** Prey ahead of the snout, near, and preferably a straggler: a dense school confuses a hunter. A shark keeps
   *  its quarry unless another is clearly better. */
  private pick(sh: Shark): Fish | null {
    const range = sh.length * 0.9 + 160;
    const hx = sh.nodes[0];
    const hy = sh.nodes[1];
    const fx = Math.cos(sh.heading);
    const fy = Math.sin(sh.heading);
    let best: Fish | null = null;
    let bestScore = Infinity;
    let kept = Infinity;
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - hx;
      const dy = f.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1e-3) continue;
      const ahead = (dx * fx + dy * fy) / d;
      if (ahead < 0.2) continue;
      const score = d * (1 + (1 - ahead) * 0.8) * (1 + this.count[this.bucketOf(f.x, f.y)] * 0.07);
      if (score < bestScore) [bestScore, best] = [score, f];
      if (f === sh.prey) kept = score;
    }
    return sh.prey && kept < bestScore * 1.3 ? sh.prey : best;
  }

  /** Eaten fish come back as a new school swimming in from an edge. */
  private restock() {
    const { time, w, h } = this;
    const due = this.fish.filter((f) => !f.alive && f.due <= time);
    if (!due.length || (due.length < 6 && time - this.lastSchool < 9)) return;
    this.lastSchool = time;
    const edge = Math.floor(Math.random() * 4);
    const along = rand(0.15, 0.85);
    const x = edge === 0 ? -20 : edge === 1 ? w + 20 : along * w;
    const y = edge === 2 ? -20 : edge === 3 ? h + 20 : along * h;
    const dir = Math.atan2(h / 2 - y, w / 2 - x) + rand(-0.5, 0.5);
    const kind = Math.floor(Math.random() * TEMPERS.length);
    const t = TEMPERS[kind];
    const spin: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    for (const f of due.slice(0, t.size[1]))
      Object.assign(f, {
        alive: true,
        kind,
        alarm: 0,
        turn: 0,
        spin,
        x: x + rand(-1, 1) * this.sight,
        y: y + rand(-1, 1) * this.sight,
        vx: Math.cos(dir) * t.cruise * 1.4,
        vy: Math.sin(dir) * t.cruise * 1.4,
      });
  }

  // ---------------- the wake ----------------

  private cell(x: number, y: number) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c;
  }

  private stamp(field: Float32Array, x: number, y: number, radius: number, amount: number) {
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++)
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
      }
  }

  /** Swimming stirs the water (a shark's tail most); the stirring spreads to the cells round it and settles. */
  private ripple(dt: number) {
    const { cols, rows, wake, wakeTmp: out, heat } = this;
    for (const f of this.fish) {
      const i = f.alive ? this.cell(f.x, f.y) : -1;
      if (i >= 0) wake[i] = Math.min(1.6, wake[i] + 0.012 + f.alarm * 0.03);
    }
    for (const sh of this.sharks)
      for (let k = NODES - 6; k < NODES; k++) {
        const i = this.cell(sh.nodes[k * 2], sh.nodes[k * 2 + 1]);
        if (i >= 0) wake[i] = Math.min(1.6, wake[i] + 0.05 + sh.speed * 0.0012);
      }
    if (this.at) this.stamp(wake, this.at.x, this.at.y, 1, 0.08);
    const settle = Math.exp(-dt * 1.5) / 8;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        out[i] = (wake[i] * 4 + wake[c > 0 ? i - 1 : i] + wake[c < cols - 1 ? i + 1 : i] + wake[r > 0 ? i - cols : i] + wake[r < rows - 1 ? i + cols : i]) * settle;
      }
    this.wake = out;
    this.wakeTmp = wake;
    const cool = Math.exp(-dt * 2.2);
    for (let i = 0; i < heat.length; i++) heat[i] *= cool;
  }

  // ---------------- drawing ----------------

  draw(ctx: CanvasRenderingContext2D, light: boolean) {
    if (!this.cols) return;
    const { dpr, cw, ch } = this;
    if (this.gridLight !== light) {
      paintGrid(this.grid, this.w, this.h, this.dpr, this.cw, this.ch, light);
      this.gridLight = light;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(this.grid, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.rasterize();
    const fish = this.markFish();
    this.drawWake(ctx, light);
    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const { cols, heat } = this;
    for (let i = 0; i < heat.length; i++) {
      const v = heat[i];
      if (v < 0.08) continue;
      ctx.fillStyle = `rgba(${light ? "20,20,20" : "245,245,245"},${Math.min(1, v * 1.2).toFixed(2)})`;
      ctx.fillText(v > 0.6 ? "*" : "·", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    }
    fish.forEach((cells, level) => {
      if (!cells.length) return;
      const a = 0.28 + level * 0.155;
      ctx.fillStyle = light ? `rgba(30,30,30,${a})` : `rgba(235,235,235,${a})`;
      for (const i of cells) ctx.fillText("-", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
    });
    this.drawSharks(ctx, light);
  }



  /** Which cells each shark covers, and as what: the body bending in a wave that grows toward the tail, the
   *  fins spreading on the outside of a turn. A cell the shape covers is skin; one it only clips is an edge. */
  private rasterize() {
    const { code, shade, key, depth, spine, arc, cw, ch, cols, rows } = this;
    code.fill(0);
    for (const sh of this.sharks) {
      const L = sh.length;
      const n = sh.nodes;
      const swim = clamp(sh.speed / 60, 0.4, 1.4);
      for (let k = 0; k < NODES; k++) {
        const s = k / (NODES - 1);
        const a = Math.max(0, k - 1);
        const b = Math.min(NODES - 1, k + 1);
        const tx = n[a * 2] - n[b * 2];
        const ty = n[a * 2 + 1] - n[b * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        const off = L * 0.05 * (0.1 + 0.9 * Math.pow(s, 1.8)) * swim * Math.sin(sh.phase - s * 5.2);
        spine[k * 2] = n[k * 2] - (ty / tl) * off;
        spine[k * 2 + 1] = n[k * 2 + 1] + (tx / tl) * off;
      }
      arc[0] = 0;
      for (let k = 1; k < NODES; k++) arc[k] = arc[k - 1] + Math.hypot(spine[k * 2] - spine[k * 2 - 2], spine[k * 2 + 1] - spine[k * 2 - 1]);
      this.total = arc[NODES - 1] || 1;
      this.length = L;
      const bank = clamp(sh.turn * 0.45, -0.35, 0.35);
      const flex = 1 + 0.06 * Math.sin(sh.phase * 0.5);
      this.shape = SHAPES[sh.kind];
      this.finRight = this.shape.pectoral[3] * flex * (1 - bank);
      this.finLeft = this.shape.pectoral[3] * flex * (1 + bank);

      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < NODES; k++) {
        x0 = Math.min(x0, spine[k * 2]);
        x1 = Math.max(x1, spine[k * 2]);
        y0 = Math.min(y0, spine[k * 2 + 1]);
        y1 = Math.max(y1, spine[k * 2 + 1]);
      }
      const pad = L * 0.34;
      const far = pad + Math.hypot(cw, ch);
      for (let r = Math.max(0, Math.floor((y0 - pad) / ch)); r <= Math.min(rows - 1, Math.floor((y1 + pad) / ch)); r++)
        for (let c = Math.max(0, Math.floor((x0 - pad) / cw)); c <= Math.min(cols - 1, Math.floor((x1 + pad) / cw)); c++) {
          const x = c * cw;
          const y = r * ch;
          const hit = this.sample(x + cw / 2, y + ch / 2);
          if (!hit && this.hitA > far) continue;
          const [s, v, tone] = [this.hitS, this.hitV, this.hitShade];
          let hits = hit ? 1 : 0;
          for (let k = 0; k < SAMPLES.length; k += 2) if (this.sample(x + SAMPLES[k] * cw, y + SAMPLES[k + 1] * ch)) hits++;
          if (!hits) continue;
          const i = r * cols + c;
          // Keyed to the patch of skin, not the cell, so the texture rides along with the body.
          key[i] = (hash(Math.round(s * 52), Math.round(v / (cw * 0.9)), sh.id) * 4294967295) >>> 0;
          depth[i] = sh.near;
          if (hit && hits >= 3) {
            code[i] = hit;
            shade[i] = clamp(tone, 0, 1);
          } else {
            code[i] = EDGE;
            shade[i] = hits / 5;
          }
        }
    }
  }

  /** What's at (px, py) on the shark being rasterised: its kind of cell (0 for water), with where along and
   *  across the body it is and how lit, for a back lit from the top left. */
  private sample(px: number, py: number): number {
    const { spine, arc } = this;
    let best = Infinity;
    let along = 0;
    let side = 1;
    let nx = 0;
    let ny = 0;
    for (let k = 0; k < NODES - 1; k++) {
      const ax = spine[k * 2];
      const ay = spine[k * 2 + 1];
      const ex = spine[k * 2 + 2] - ax;
      const ey = spine[k * 2 + 3] - ay;
      const len2 = ex * ex + ey * ey || 1;
      const u = clamp(((px - ax) * ex + (py - ay) * ey) / len2, 0, 1);
      const dx = px - ax - ex * u;
      const dy = py - ay - ey * u;
      const d2 = dx * dx + dy * dy;
      if (d2 >= best) continue;
      best = d2;
      const len = Math.sqrt(len2);
      along = (arc[k] + u * len) / this.total;
      side = ex * dy - ey * dx >= 0 ? 1 : -1;
      nx = (-ey / len) * side;
      ny = (ex / len) * side;
    }
    const L = this.length;
    const a = Math.sqrt(best);
    const s = along;
    this.hitA = a;
    this.hitS = s;
    this.hitV = a * side;
    const out = a / L;
    const shape = this.shape;
    if (shape.head) {
      // The hammer: a wide bar across the front of the head, its tips swept back a little, an eye at each.
      const r = out / shape.head.span;
      if (r <= 1 && s >= 0.03 * r * r && s <= 0.03 * r * r + shape.head.depth * (1 - 0.3 * r ** 4)) {
        this.hitShade = r > 0.84 ? 0 : 0.62 - 0.2 * r;
        return r > 0.84 ? EYE : BODY;
      }
    }
    const half = shape.girth(s) * L;
    if (a <= half) {
      const across = a / (half || 1);
      let tone = 0.58 - across * across * 0.42 + (nx * -0.6 + ny * -0.8) * across * 0.26;
      let what = BODY;
      const [g0, g1] = shape.gills;
      if (s > shape.dorsal[0] && s < shape.dorsal[1] && across < 0.3) [what, tone] = [RIDGE, 1];
      else if (s > shape.second[0] && s < shape.second[1] && across < 0.4) tone = Math.max(tone, 0.82);
      else if (shape.eye && s > shape.eye[0] && s < shape.eye[1] && across > 0.6) [what, tone] = [EYE, 0];
      else if (s > g0 && s < g1 && across > 0.58) tone *= Math.floor(((s - g0) / (g1 - g0)) * 5) % 2 ? 1 : 0.45;
      else if (s < 0.04) tone = Math.max(tone, 0.7);
      this.hitShade = tone;
      return what;
    }
    const reach = side > 0 ? this.finRight : this.finLeft;
    const [p0, p1, p2, , ps] = shape.pectoral;
    if (onFin(s, out, p0, p1, p2, reach, ps)) {
      this.hitShade = 0.38 + 0.22 * (1 - clamp(out / reach, 0, 1));
      return FIN;
    }
    if (onFin(s, out, ...shape.pelvic) || onFin(s, out, ...shape.caudal)) {
      this.hitShade = 0.36;
      return FIN;
    }
    return 0;
  }

  /** Fish cells this frame, by brightness: far fish dim, near ones brighter, a turning or frightened one glinting.
   *  A near fish takes a cell before a far one; a shark hides both. */
  private markFish(): number[][] {
    const levels: number[][] = [[], [], [], [], []];
    const frame = ++this.frame;
    for (const nearFirst of [true, false])
      for (const f of this.fish) {
        if (!f.alive || f.near > 0.78 !== nearFirst) continue;
        const i = this.cell(f.x, f.y);
        if (i < 0 || this.fishAt[i] === frame || this.code[i]) continue;
        this.fishAt[i] = frame;
        const glint = Math.max(clamp(Math.abs(f.turn) / 3.5, 0, 1), f.alarm);
        const v = 0.3 + (0.4 * (f.near - 0.55)) / 0.45 + 0.3 * glint;
        levels[clamp(Math.floor(v * 5), 0, 4)].push(i);
      }
    return levels;
  }

  /** A dot low in each stirred cell, brighter the more it's stirred. */
  private drawWake(ctx: CanvasRenderingContext2D, light: boolean) {
    const { wake, code, fishAt, frame, cols, cw, ch } = this;
    const levels: number[][] = Array.from({ length: LEVELS }, () => []);
    for (let i = 0; i < wake.length; i++) {
      if (wake[i] <= 0.45 || code[i] || fishAt[i] === frame) continue;
      levels[clamp(Math.floor((wake[i] - 0.45) * 5), 0, LEVELS - 1)].push(i);
    }
    const size = Math.max(2, Math.round(cw * 0.19)) + 1;
    levels.forEach((cells, l) => {
      ctx.fillStyle = `rgba(${light ? "40,40,40" : "215,215,215"},${(((l + 1) / LEVELS) * 0.75).toFixed(3)})`;
      for (const i of cells) ctx.fillRect(Math.round((i % cols) * cw + cw * 0.66 - size / 2), Math.round(((i / cols) | 0) * ch + ch * 0.64 - size / 2), size, size);
    });
  }

  private drawSharks(ctx: CanvasRenderingContext2D, light: boolean) {
    const { code, shade, key, depth, cols, cw, ch } = this;
    const grey = (v: number) => ((v = Math.round(clamp(v, 0, 255))), `rgb(${v},${v},${v})`);
    for (let i = 0; i < code.length; i++) {
      const what = code[i];
      if (!what) continue;
      const x = (i % cols) * cw;
      const y = ((i / cols) | 0) * ch;
      const k = key[i];
      const tone = shade[i];
      const dim = 0.7 + 0.3 * depth[i];
      if (what === EDGE) {
        ctx.fillStyle = grey((70 + tone * 80) * dim);
        const set = tone >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
        ctx.fillText(set[(k >>> 8) % set.length], x + cw / 2, y + ch / 2 + 1);
        continue;
      }
      let level: number;
      let glyph: string;
      if (what === RIDGE) [level, glyph] = [226, RIDGES[(k >>> 8) % RIDGES.length]];
      else if (what === EYE) [level, glyph] = [12, "o"];
      else if (what === FIN) [level, glyph] = [40 + tone * 120, FINS[(k >>> 8) % FINS.length]];
      else [level, glyph] = [46 + tone * 160, SKIN[clamp(Math.floor((1 - tone) * 8.99) + ((k >>> 4) % 3) - 1, 0, SKIN.length - 1)]];
      level *= dim;
      // On white the shadowed flanks would be holes: the whole shark is paler there.
      if (light && what !== EYE) level = 84 + level * 0.66;
      ctx.fillStyle = grey(level);
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      ctx.fillStyle = what === EYE ? "#9a9a9a" : tone > 0.55 ? "#0e0e0e" : "#1c1c1c";
      ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
    }
  }

}

export const createScene = (font: string): Scene => new Ocean(font);
