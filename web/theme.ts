// Zeron's theme model (crates/theme + crates/ui/src/theme.rs) for the DOM: the built-in catalog as seed colours,
// the same derivation into surface/text/accent roles, and the resolved theme painted onto :root as CSS variables.
// Typography, conversation width and motion preferences are applied here too.
import { onPrefs, prefs, type AccentPreset, type Prefs } from "./prefs";

// ---------------- colour math (zeron_theme::Color) ----------------

/** sRGB channels and alpha, all 0–255. */
export type Color = [number, number, number, number];
const WHITE: Color = [255, 255, 255, 255];
const BLACK: Color = [0, 0, 0, 255];

const hex = (s: string): Color => {
  const n = parseInt(s.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, s.length > 7 ? parseInt(s.slice(7, 9), 16) : 255];
};
const mix = (a: Color, b: Color, t: number): Color => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t)))) as Color;
const alpha = (c: Color, a: number): Color => [c[0], c[1], c[2], Math.round(Math.min(1, Math.max(0, a)) * 255)];
/** Composite `c` over an opaque `bg`. */
export const flatten = (c: Color, bg: Color): Color => {
  const a = c[3] / 255;
  return [0, 1, 2].map((i) => Math.round(c[i] * a + bg[i] * (1 - a))).concat(255) as Color;
};
const luminance = (c: Color) => {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
};
const contrast = (fg: Color, bg: Color) => {
  const [a, b] = [luminance(fg[3] === 255 ? fg : flatten(fg, bg)), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const bestOn = (c: Color) => (contrast(WHITE, c) >= contrast(BLACK, c) ? WHITE : BLACK);
/** Step toward black or white until the contrast is met. */
const ensureContrast = (c: Color, bg: Color, min: number): Color => {
  if (contrast(c, bg) >= min) return c;
  const target = contrast(BLACK, bg) >= contrast(WHITE, bg) ? BLACK : WHITE;
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(c, target, step / 20);
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return target;
};
export const css = (c: Color) => (c[3] === 255 ? `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${+(c[3] / 255).toFixed(3)})`);
const rgb = (c: Color) => c.slice(0, 3).join(", ");
/** hsl(0, 0%, l) as a colour. */
const grey = (l: number): Color => [Math.round(l * 255), Math.round(l * 255), Math.round(l * 255), 255];

// ---------------- the built-in catalog (zeron_theme::builtins) ----------------

export type Appearance = "light" | "dark";
type Treatment = "frosted" | "opaque";
// [id, family, name, appearance, recommended treatment,
//  "background shell raised card text muted faint accent danger warning success"]
const SEEDS: [string, string, string, Appearance, Treatment, string][] = [
  ["zeron-dark", "zeron", "Zeron Dark", "dark", "frosted", "#060606 #0d0d0d #343438 #0e0e0e #e8e8ea #a9a9ae #85858a #8b7cf6 #f87171 #facc15 #34d399"],
  ["zeron-light", "zeron", "Zeron Light", "light", "frosted", "#ffffff #f3f3f5 #ededf0 #ffffff #303035 #62626a #797981 #5b43e8 #dc2626 #a16207 #15803d"],
  ["vscode-dark-plus", "vscode-default", "Dark+", "dark", "opaque", "#1e1e1e #181818 #2a2d2e #252526 #d4d4d4 #a8a8a8 #858585 #007acc #f48771 #cca700 #89d185"],
  ["vscode-light-plus", "vscode-default", "Light+", "light", "opaque", "#ffffff #f3f3f3 #e8e8e8 #ffffff #1f1f1f #616161 #767676 #0078d4 #a1260d #895503 #008000"],
  ["catppuccin-mocha", "catppuccin", "Catppuccin Mocha", "dark", "opaque", "#1e1e2e #181825 #313244 #242436 #cdd6f4 #a6adc8 #9399b2 #cba6f7 #f38ba8 #f9e2af #a6e3a1"],
  ["catppuccin-latte", "catppuccin", "Catppuccin Latte", "light", "opaque", "#eff1f5 #e6e9ef #dce0e8 #f7f8fa #4c4f69 #5c5f77 #6c6f85 #8839ef #d20f39 #df8e1d #40a02b"],
  ["tokyo-night", "tokyo-night", "Tokyo Night", "dark", "opaque", "#1a1b26 #16161e #292e42 #1f2335 #c0caf5 #9aa5ce #7f87ad #7aa2f7 #f7768e #e0af68 #9ece6a"],
  ["tokyo-night-light", "tokyo-night", "Tokyo Night Light", "light", "opaque", "#d5d6db #cbccd1 #bfc0c6 #e1e2e7 #343b59 #485e7d #5a6378 #34548a #8c4351 #8f5e15 #33635c"],
  ["dracula", "dracula", "Dracula", "dark", "opaque", "#282a36 #21222c #44475a #2d303e #f8f8f2 #c5c8c6 #9a9cab #bd93f9 #ff5555 #f1fa8c #50fa7b"],
  ["github-light", "github", "GitHub Light", "light", "opaque", "#ffffff #f6f8fa #d0d7de #ffffff #1f2328 #656d76 #818b98 #0969da #cf222e #9a6700 #1a7f37"],
  ["github-dark", "github", "GitHub Dark", "dark", "opaque", "#0d1117 #010409 #21262d #161b22 #e6edf3 #8b949e #6e7681 #2f81f7 #f85149 #d29922 #3fb950"],
  ["ayu-light", "ayu", "Ayu Light", "light", "opaque", "#fcfcfc #f8f9fa #e6e9ed #fafafa #5c6166 #828e9f #969da8 #f29718 #e65050 #eba400 #6cbf43"],
  ["ayu-dark", "ayu", "Ayu Dark", "dark", "opaque", "#10141c #0d1017 #1b1f29 #141821 #bfbdb6 #8a9199 #5a6673 #e6b450 #d95757 #ffb454 #70bf56"],
  ["ayu-mirage", "ayu", "Ayu Mirage", "dark", "opaque", "#242936 #1f2430 #343d4d #282e3b #cccac2 #8a94a6 #6e7c8f #ffcc66 #ff6666 #ffcc66 #87d96c"],
  ["gruvbox-light", "gruvbox", "Gruvbox Light", "light", "opaque", "#fbf1c7 #f2e5bc #d5c4a1 #f9f5d7 #3c3836 #665c54 #7c6f64 #076678 #9d0006 #b57614 #79740e"],
  ["gruvbox-dark", "gruvbox", "Gruvbox Dark", "dark", "opaque", "#282828 #1d2021 #504945 #32302f #ebdbb2 #bdae93 #928374 #8ec07c #fb4934 #fabd2f #b8bb26"],
  ["rose-pine-dawn", "rose-pine", "Rosé Pine Dawn", "light", "opaque", "#faf4ed #f2e9e1 #dfdad9 #fffaf3 #575279 #797593 #9893a5 #907aa9 #b4637a #ea9d34 #56949f"],
  ["rose-pine-moon", "rose-pine", "Rosé Pine Moon", "dark", "opaque", "#232136 #1f1d2e #393552 #2a273f #e0def4 #908caa #6e6a86 #c4a7e7 #eb6f92 #f6c177 #9ccfd8"],
  ["nord", "nord", "Nord", "dark", "opaque", "#2e3440 #292e39 #434c5e #3b4252 #d8dee9 #aeb6c4 #7f899b #88c0d0 #bf616a #ebcb8b #a3be8c"],
  ["one-dark-pro", "one-dark-pro", "One Dark Pro", "dark", "opaque", "#282c34 #21252b #2c313a #21252b #abb2bf #9da5b4 #7f848e #528bff #e05561 #d19a66 #8cc265"],
  ["atom-one-dark", "atom-one-dark", "Atom One Dark", "dark", "opaque", "#282c34 #21252b #2c313a #21252b #abb2bf #9da5b4 #5c6370 #528bff #e06c75 #d19a66 #98c379"],
  ["night-owl", "night-owl", "Night Owl", "dark", "opaque", "#011627 #01111d #0b253a #071d2e #d6deeb #8ca6ba #637777 #82aaff #ef5350 #ffeb95 #22da6e"],
  ["night-owl-light", "night-owl", "Night Owl Light", "light", "opaque", "#fbfbfb #f0f0f0 #d3e8f8 #ffffff #403f53 #66657a #7a8297 #4876d6 #de3d3b #a67d00 #08916a"],
  ["winter-dark-blue", "winter-is-coming", "Winter is Coming Dark Blue", "dark", "opaque", "#011627 #01111d #0b253a #071d2e #d6deeb #8ca6ba #5f7e97 #219fd5 #ef5350 #ffca28 #22da6e"],
  ["winter-light", "winter-is-coming", "Winter is Coming Light", "light", "opaque", "#ffffff #f3f3f3 #e5e5e5 #ffffff #1857a4 #62626a #66768a #2f86d2 #de3d3b #9b6a00 #08916a"],
  ["palenight", "palenight", "Palenight", "dark", "opaque", "#292d3e #232635 #34384c #292d3e #eeffff #a6accd #697098 #82aaff #ff5572 #ffcb6b #c3e88d"],
  ["synthwave-84", "synthwave-84", "SynthWave '84", "dark", "opaque", "#262335 #241b2f #37294d #2a2139 #ffffff #b8b5c6 #848bbd #ff7edb #fe4450 #fede5d #72f1b8"],
  ["shades-of-purple", "shades-of-purple", "Shades of Purple", "dark", "opaque", "#2d2b55 #222244 #393668 #1e1e3f #ffffff #b8afea #8d84c7 #fad000 #ec3a37 #fad000 #3ad900"],
  ["cobalt2", "cobalt2", "Cobalt2", "dark", "opaque", "#193549 #15232d #20455e #122738 #ffffff #b7c9d3 #7da1b5 #ffc600 #ff628c #ffc600 #3ad900"],
  ["andromeda", "andromeda", "Andromeda", "dark", "opaque", "#23262e #1e2027 #2d313b #23262e #d5ced9 #a6a0aa #746f77 #00e8c6 #ee5d43 #ff9f2e #96e072"],
];

// Each theme's terminal palette (zeron_theme::builtins terminal_background + ansi): "background black red green
// yellow blue magenta cyan white, then the eight bright ones".
const TERMINAL_SEEDS: Record<string, string> = {
  "zeron-dark": "#090909 #242424 #f87171 #4ade80 #facc15 #60a5fa #c084fc #22d3ee #d4d4d8 #52525b #fca5a5 #86efac #fde047 #93c5fd #d8b4fe #67e8f9 #fafafa",
  "zeron-light": "#fafafa #1f1f1f #dc2626 #16a34a #b45309 #2563eb #9333ea #0e7490 #3f3f46 #71717a #b91c1c #15803d #92400e #1d4ed8 #7e22ce #155e75 #18181b",
  "vscode-dark-plus": "#1e1e1e #000000 #cd3131 #0dbc79 #e5e510 #2472c8 #bc3fbc #11a8cd #e5e5e5 #666666 #f14c4c #23d18b #f5f543 #3b8eea #d670d6 #29b8db #e5e5e5",
  "vscode-light-plus": "#ffffff #1f1f1f #dc2626 #16a34a #b45309 #2563eb #9333ea #0e7490 #3f3f46 #71717a #b91c1c #15803d #92400e #1d4ed8 #7e22ce #155e75 #18181b",
  "catppuccin-mocha": "#1e1e2e #45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8",
  "catppuccin-latte": "#eff1f5 #5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #bcc0cc",
  "tokyo-night": "#1a1b26 #15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5",
  "tokyo-night-light": "#d5d6db #0f0f14 #8c4351 #33635c #8f5e15 #34548a #5a4a78 #0f4b6e #828594 #4c505e #8c4351 #33635c #8f5e15 #34548a #5a4a78 #0f4b6e #343b59",
  "dracula": "#282a36 #21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff",
  "github-light": "#ffffff #24292f #cf222e #1a7f37 #9a6700 #0969da #8250df #1b7c83 #6e7781 #57606a #a40e26 #116329 #7d4e00 #0550ae #6639ba #0a6b74 #1f2328",
  "github-dark": "#0d1117 #484f58 #ff7b72 #3fb950 #d29922 #58a6ff #bc8cff #39c5cf #b1bac4 #6e7681 #ffa198 #56d364 #e3b341 #79c0ff #d2a8ff #56d4dd #f0f6fc",
  "ayu-light": "#f8f9fa #000000 #f06b6c #6cbf43 #e7a100 #21a1e2 #a176cb #4abc96 #c7c7c7 #686868 #f07171 #86b300 #eba400 #22a4e6 #a37acc #4cbf99 #d1d1d1",
  "ayu-dark": "#0d1017 #1b1f29 #f06b73 #70bf56 #fdb04c #4fbfff #d0a1ff #93e2c8 #c7c7c7 #686868 #f07178 #aad94c #ffb454 #59c2ff #d2a6ff #95e6cb #ffffff",
  "ayu-mirage": "#1f2430 #171b24 #f28273 #87d96c #fcca60 #6acdff #ddbbff #93e2c8 #c7c7c7 #686868 #f28779 #d5ff80 #ffcd66 #73d0ff #dfbfff #95e6cb #ffffff",
  "gruvbox-light": "#fbf1c7 #ebdbb2 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836",
  "gruvbox-dark": "#282828 #3c3836 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2",
  "rose-pine-dawn": "#faf4ed #f2e9e1 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279 #797593 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279",
  "rose-pine-moon": "#232136 #393552 #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ea9a97 #e0def4 #908caa #eb6f92 #3e8fb0 #f6c177 #9ccfd8 #c4a7e7 #ea9a97 #e0def4",
  "nord": "#2e3440 #3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4",
  "one-dark-pro": "#282c34 #3f4451 #e05561 #8cc265 #d18f52 #4aa5f0 #c162de #42b3c2 #d7dae0 #4f5666 #ff616e #a5e075 #f0a45d #4dc4ff #de73ff #4cd1e0 #e6e6e6",
  "atom-one-dark": "#282c34 #282c34 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #abb2bf #5c6370 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #ffffff",
  "night-owl": "#011627 #011627 #ef5350 #22da6e #c5e478 #82aaff #c792ea #21c7a8 #ffffff #575656 #ef5350 #22da6e #ffeb95 #82aaff #c792ea #7fdbca #ffffff",
  "night-owl-light": "#f6f6f6 #403f53 #de3d3b #08916a #e0af02 #288ed7 #d6438a #2aa298 #93a1a1 #403f53 #de3d3b #08916a #daaa01 #288ed7 #d6438a #2aa298 #403f53",
  "winter-dark-blue": "#011627 #011627 #ef5350 #22da6e #f7ecb5 #219fd5 #c792ea #80cbc4 #d6deeb #5f7e97 #ef9a9a #addb67 #ffcb6b #82aaff #c792ea #7fdbca #ffffff",
  "winter-light": "#ffffff #011627 #de3d3b #08916a #c5a332 #236ebf #7c4dff #0097a7 #7e8993 #403f53 #f76c6c #49d0b0 #e7c244 #4e8cdf #b15a91 #00bcd4 #403f53",
  "palenight": "#292d3e #676e95 #ff5572 #a9c77d #ffcb6b #82aaff #c792ea #89ddff #ffffff #676e95 #ff5572 #c3e88d #ffcb6b #82aaff #c792ea #89ddff #ffffff",
  "synthwave-84": "#262335 #242424 #fe4450 #72f1b8 #f3e70f #03edf9 #ff7edb #03edf9 #d4d4d8 #52525b #fe4450 #72f1b8 #fede5d #03edf9 #ff7edb #03edf9 #fafafa",
  "shades-of-purple": "#1e1e3f #000000 #ec3a37 #3ad900 #fad000 #7857fe #ff2c70 #80fcff #ffffff #5c5c61 #ec3a37 #3ad900 #fad000 #6943ff #fb94ff #80fcff #ffffff",
  "cobalt2": "#122738 #000000 #ff628c #3ad900 #ffc600 #0088ff #fb94ff #80fcff #ffffff #0050a4 #ff628c #3ad900 #ffc600 #0088ff #fb94ff #80fcff #ffffff",
  "andromeda": "#23262e #242424 #ee5d43 #96e072 #ffe66d #7cb7ff #ff00aa #00e8c6 #d4d4d8 #52525b #ee5d43 #96e072 #ffe66d #7cb7ff #ff00aa #00e8c6 #fafafa",
};

export type ThemeInfo = { id: string; family: string; name: string; appearance: Appearance };
export const THEMES: ThemeInfo[] = SEEDS.map(([id, family, name, appearance]) => ({ id, family, name, appearance }));
const FALLBACK: Record<Appearance, string> = { light: "zeron-light", dark: "zeron-dark" };

/** The accent presets (zeron_theme::AccentPreset), tuned per appearance. */
export const ACCENTS: { id: AccentPreset; label: string; dark: string; light: string }[] = [
  { id: "zeron", label: "Zeron", dark: "#8b7cf6", light: "#5b43e8" },
  { id: "orange", label: "Orange", dark: "#fb923c", light: "#c2410c" },
  { id: "amber", label: "Amber", dark: "#fbbf24", light: "#a16207" },
  { id: "green", label: "Green", dark: "#4ade80", light: "#15803d" },
  { id: "cyan", label: "Cyan", dark: "#22d3ee", light: "#0e7490" },
  { id: "blue", label: "Blue", dark: "#60a5fa", light: "#2563eb" },
  { id: "pink", label: "Pink", dark: "#f472b6", light: "#be185d" },
];

// ---------------- derivation ----------------

export type Theme = {
  id: string;
  name: string;
  appearance: Appearance;
  /** Floating surfaces paint a backdrop blur under translucent tints. */
  frost: boolean;
  bg: Color;
  shell: Color;
  raised: Color;
  card: Color;
  overlay: Color;
  input: Color;
  text: Color;
  muted: Color;
  faint: Color;
  accent: Color;
  accentStrong: Color;
  accentWash: Color;
  selection: Color;
  glyph: [Color, Color, Color];
  danger: Color;
  dangerMuted: Color;
  warning: Color;
  warningMuted: Color;
  success: Color;
  border: Color;
  borderStrong: Color;
  hover: Color;
  solid: Color;
  onSolid: Color;
};

/** AccentRoles::derive: the primary held to 3:1 on the background, plus its wash and glyph tones. */
function accentRoles(primary: Color, appearance: Appearance, bg: Color) {
  const dark = appearance === "dark";
  primary = ensureContrast(primary, bg, 3);
  const on = bestOn(primary);
  const strong = contrast(on, primary) < 4.5 ? ensureContrast(primary, on, 4.5) : primary;
  return {
    accent: primary,
    accentStrong: strong,
    accentWash: alpha(primary, dark ? 0.22 : 0.12),
    selection: alpha(primary, dark ? 0.35 : 0.24),
    glyph: [mix(primary, dark ? WHITE : bg, dark ? 0.28 : 0.18), primary, mix(primary, BLACK, dark ? 0.18 : 0.26)] as [Color, Color, Color],
  };
}

export function deriveTheme(id: string, appearance: Appearance, accent: Prefs["accent"], surface: Prefs["surface"]): Theme {
  const seed = SEEDS.find((s) => s[0] === id && s[3] === appearance) ?? SEEDS.find((s) => s[0] === FALLBACK[appearance])!;
  const [background, shell, raised, card, text, muted, faint, accentSeed, danger, warning, success] = seed[5].split(" ").map(hex);
  const dark = appearance === "dark";
  const tone = dark ? WHITE : BLACK;
  const solid: Color = dark ? [235, 235, 239, 255] : [35, 35, 40, 255];
  const preset = ACCENTS.find((a) => a.id === accent);
  return {
    id: seed[0],
    name: seed[2],
    appearance,
    frost: (surface === "theme" ? seed[4] : surface) === "frosted",
    bg: background,
    shell,
    raised,
    card,
    overlay: mix(card, raised, dark ? 0.34 : 0.02),
    input: dark ? alpha(raised, 0.72) : card,
    text,
    muted: ensureContrast(muted, background, 4.5),
    faint,
    ...accentRoles(preset ? hex(preset[appearance]) : accentSeed, appearance, background),
    danger,
    dangerMuted: mix(danger, text, 0.28),
    warning,
    warningMuted: mix(warning, text, 0.25),
    success,
    border: alpha(tone, dark ? 0.1 : 0.12),
    borderStrong: alpha(tone, dark ? 0.18 : 0.22),
    hover: alpha(tone, dark ? 0.11 : 0.06),
    solid,
    onSolid: bestOn(solid),
  };
}

export type TerminalPalette = { background: string; foreground: string; cursor: string; selection: string; ansi: string[] };

/** The terminal's colours for a theme (TerminalPalette): its own background and ANSI 16, the text held to 4.5:1. */
export function terminalPalette(t: Theme): TerminalPalette {
  const [background, ...ansi] = (TERMINAL_SEEDS[t.id] ?? TERMINAL_SEEDS[FALLBACK[t.appearance]]).split(" ").map(hex);
  const dark = t.appearance === "dark";
  return {
    // Glass lets the window's material through, as Zeron's terminal_panel_bg does.
    background: css(t.frost ? alpha(background, 0.4) : background),
    foreground: css(ensureContrast(t.text, background, 4.5)),
    cursor: css(t.accent),
    selection: css(alpha(dark ? WHITE : BLACK, dark ? 0.22 : 0.16)),
    ansi: ansi.map(css),
  };
}

/** Code colours by role, as CSS variables (--syn-*), for the editor's highlighting and the transcript's code. */
type Syntax = { text: string; comment: string; commentStyle: string; keyword: string; string: string; number: string; type: string; function: string; functionWeight: string; heading: string; tag: string; attr: string; variable: string; property: string; operator: string; constant: string; self: string };

/** One Dark Pro (its Night Flat's colours; the user's Cursor theme) with their tweaks: functions and methods bold,
 *  self yellow. In light themes, its light sibling, Atom's One Light. */
const ONE_DARK: Record<Appearance, Omit<Syntax, "commentStyle" | "functionWeight">> = {
  dark: { text: "#abb2bf", comment: "#7f848e", keyword: "#c678dd", string: "#98c379", number: "#d19a66", type: "#e5c07b", function: "#61afef", heading: "#e06c75", tag: "#e06c75", attr: "#d19a66", variable: "#e06c75", property: "#e06c75", operator: "#56b6c2", constant: "#e5c07b", self: "#e5c07b" },
  light: { text: "#383a42", comment: "#a0a1a7", keyword: "#a626a4", string: "#50a14f", number: "#986801", type: "#c18401", function: "#4078f2", heading: "#e45649", tag: "#e45649", attr: "#986801", variable: "#e45649", property: "#e45649", operator: "#0184bc", constant: "#c18401", self: "#c18401" },
};

function syntaxVars(t: Theme): Record<string, string> {
  let s: Syntax;
  if (prefs.codeColors === "one-dark-pro") s = { ...ONE_DARK[t.appearance], commentStyle: "normal", functionWeight: "700" };
  else {
    // The theme's terminal palette, so they suit every theme (Zeron's syntax theme does the same job).
    const p = terminalPalette(t).ansi;
    s = { text: "var(--text)", comment: "var(--faint)", commentStyle: "italic", keyword: p[5], string: p[2], number: p[3], type: p[6], function: p[4], functionWeight: "inherit", heading: p[4], tag: p[1], attr: p[3], variable: "inherit", property: p[3], operator: "inherit", constant: p[3], self: p[5] };
  }
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [`--syn-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`, v]));
}

// The context-free ink helpers (theme.rs): alphas are quoted in dark-mode terms.
const ink = (t: Theme, a: number) => (t.appearance === "dark" ? alpha(WHITE, a) : alpha(BLACK, a));
const hairline = (t: Theme, a: number) => (t.appearance === "dark" ? alpha(WHITE, a) : alpha(BLACK, Math.min(0.5, a * 1.35)));
const wash = (t: Theme, a: number) => alpha(t.appearance === "dark" ? grey(0.92) : grey(0.1), a);

/** Raise a translucent tint until text stays legible over the worst-case backdrop (Theme::contrast_checked_tint_alpha). */
function checkedAlpha(t: Theme, tint: Color, base: number) {
  const backdrop = t.appearance === "dark" ? WHITE : BLACK;
  for (let step = 0; step <= 20; step++) {
    const a = base + ((1 - base) * step) / 20;
    const composite = flatten(alpha(tint, a), backdrop);
    if (contrast(t.text, composite) >= 4.5 && contrast(t.muted, composite) >= 3) return a;
  }
  return 1;
}

/** The sidebar's plate: the shell lifted by a 4.5% ink (sampled from Zeron). */
export const sidebarTone = (t: Theme) => flatten(ink(t, 0.045), t.shell);

function vars(t: Theme): Record<string, string> {
  const dark = t.appearance === "dark";
  const inputTint = flatten(t.input, t.bg);
  // Floating cards: solid tones, or translucent tints over a backdrop blur when frosted. The composer stays solid.
  const cardBg = !t.frost ? inputTint : dark ? alpha(t.overlay, checkedAlpha(t, t.overlay, 0.5)) : alpha(t.overlay, 0.45);
  const switchOn = dark ? flatten(alpha(BLACK, 0.14), t.accentStrong) : flatten(alpha(mix(t.accent, WHITE, 0.1), 0.98), t.shell);
  const switchOff = flatten(ink(t, dark ? (t.frost ? 0.22 : 0.18) : t.frost ? 0.12 : 0.1), t.shell);
  const out: Record<string, string> = {
    "--main": css(t.shell),
    "--sidebar": css(sidebarTone(t)),
    "--theme-bg": css(t.bg),
    "--input": css(inputTint),
    "--card-bg": css(cardBg),
    "--frost": t.frost ? `blur(16px) saturate(1.4)` : "none",
    "--text": css(t.text),
    "--muted": css(t.muted),
    "--faint": css(t.faint),
    "--accent": css(t.accent),
    "--accent-strong": css(t.accentStrong),
    "--accent-wash": css(t.accentWash),
    "--selection": css(t.selection),
    "--glyph-light": css(t.glyph[0]),
    "--glyph-deep": css(t.glyph[2]),
    "--danger": css(t.danger),
    "--danger-muted": css(t.dangerMuted),
    "--warning": css(t.warning),
    "--warning-muted": css(t.warningMuted),
    "--success": css(t.success),
    "--border": css(t.border),
    "--border-strong": css(t.borderStrong),
    "--hover": css(t.hover),
    "--selected": css(wash(t, dark ? 0.11 : 0.06)),
    "--bubble": css(wash(t, dark ? 0.08 : 0.04)),
    "--hairline-12": css(hairline(t, 0.12)),
    "--solid": css(t.solid),
    "--on-solid": css(t.onSolid),
    "--switch-on": css(switchOn),
    "--switch-off": css(switchOff),
    "--switch-thumb": css(flatten(alpha(WHITE, dark ? 0.96 : 1), t.shell)),
    "--scrim": css(alpha(BLACK, dark ? 0.6 : 0.32)),
    "--band": css(alpha(BLACK, dark ? 0.16 : 0.045)),
    // Channel triplets for tones used at many alphas: rgba(var(--text-rgb), 0.3).
    "--ink-rgb": rgb(dark ? WHITE : BLACK),
    "--wash-rgb": rgb(dark ? grey(0.92) : grey(0.1)),
  };
  for (const [name, c] of [["text", t.text], ["muted", t.muted], ["faint", t.faint], ["accent", t.accent], ["danger", t.danger], ["danger-muted", t.dangerMuted], ["warning", t.warning], ["warning-muted", t.warningMuted], ["success", t.success]] as const)
    out[`--${name}-rgb`] = rgb(c);
  return out;
}

// ---------------- the live theme ----------------

const systemDark = matchMedia("(prefers-color-scheme: dark)");
const systemReduced = matchMedia("(prefers-reduced-motion: reduce)");

export const systemAppearance = (): Appearance => (systemDark.matches ? "dark" : "light");
export const currentAppearance = (): Appearance => (prefs.scheme === "system" ? systemAppearance() : prefs.scheme);
export const themeFor = (appearance: Appearance) => deriveTheme(appearance === "dark" ? prefs.darkTheme : prefs.lightTheme, appearance, prefs.accent, prefs.surface);

let active = themeFor(currentAppearance());
export const activeTheme = () => active;
/** An appearance's colours as CSS variables, for pages outside the window (a printed page's, a view's). */
export const themeVars = (appearance: Appearance) => vars(themeFor(appearance));
/** The accent's channels, for canvas painting. */
export const accentChannels = (): [number, number, number] => [active.accent[0], active.accent[1], active.accent[2]];

export const systemReducesMotion = () => systemReduced.matches;
export const motionReduced = () => (prefs.reduceMotion === "system" ? systemReduced.matches : prefs.reduceMotion === "on");

/** A font slot's CSS stack: the pick, then the bundled face it replaces. */
export function fontStack(family: string, mono: boolean) {
  const tail = mono ? `"Geist Mono", ui-monospace, monospace` : `"Geist", system-ui, sans-serif`;
  if (family === "System") return mono ? "ui-monospace, monospace" : "system-ui, sans-serif";
  if (family === "Geist" || family === "Geist Mono") return `"${family}", ${tail}`;
  return `"${family.replace(/"/g, "")}", ${tail}`;
}

const themeListeners: (() => void)[] = [];
/** Canvas painters repaint when the palette changes. */
export const onTheme = (fn: () => void) => themeListeners.push(fn);

let painted = "";

function apply() {
  active = themeFor(currentAppearance());
  const root = document.documentElement;
  const palette = vars(active);
  for (const [k, v] of Object.entries(palette)) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(syntaxVars(active))) root.style.setProperty(k, v);
  // index.html paints this before the bundle loads, so a light theme doesn't open on a dark flash.
  const paint = JSON.stringify(palette);
  localStorage.setItem("bismuth.paint", paint);
  root.style.colorScheme = active.appearance;
  root.dataset.appearance = active.appearance;
  root.classList.toggle("frost", active.frost);
  root.style.setProperty("--sans", fontStack(prefs.uiFont, false));
  root.style.setProperty("--mono", fontStack(prefs.codeFont, true));
  root.style.setProperty("--term", fontStack(prefs.terminalFont, true));
  root.style.setProperty("--fs", String(prefs.uiSize / 16));
  root.style.setProperty("--code-size", `${prefs.codeSize}px`);
  root.style.setProperty("--term-size", `${prefs.terminalSize}px`);
  root.style.setProperty("--content-w", `${prefs.contentWidth}px`);
  root.classList.toggle("reduce-motion", motionReduced());
  pauseCheck();
  if (paint !== painted) themeListeners.forEach((fn) => fn());
  painted = paint;
}

/** "Pause animations in background": hold everything still while the window isn't focused. */
function pauseCheck() {
  document.documentElement.classList.toggle("paused", prefs.pauseInBackground && !document.hasFocus());
}

export function initTheme() {
  apply();
  onPrefs(apply);
  systemDark.addEventListener("change", apply);
  systemReduced.addEventListener("change", apply);
  addEventListener("focus", pauseCheck);
  addEventListener("blur", pauseCheck);
}
