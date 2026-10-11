// Settings → Appearance (Zeron's settings/appearance.rs): colour scheme cards, light and dark themes, accent,
// glass, the new-thread background, motion, then fonts, sizes and conversation width.
import { EFFECTS, loadSource, openAdjust, removeImage, setImage } from "./background";
import { el } from "./dom";
import type { IconName } from "./icons";
import { DEFAULTS, prefs, setPrefs, type CodeColors, type ReduceMotion, type Scheme, type Surface } from "./prefs";
import { refresh } from "./settings";
import { ACCENTS, activeTheme, css, deriveTheme, sidebarTone, systemReducesMotion, THEMES, themeFor, type Appearance, type Theme } from "./theme";
import { action, card, errorStrip, optionCard, pageColumn, pageHeader, row, rowText, section, select, toggle, type Option } from "./widgets";

export function renderAppearance(): HTMLElement {
  const page = pageColumn();
  page.append(pageHeader("Appearance"));

  const schemes: { id: Scheme; label: string; icon: IconName }[] = [
    { id: "system", label: "System", icon: "monitor" },
    { id: "light", label: "Light", icon: "sun" },
    { id: "dark", label: "Dark", icon: "moon" },
  ];
  const cards = el("div", "s-options");
  cards.append(...schemes.map((s) => optionCard(s.icon, s.label, prefs.scheme === s.id, schemePreview(s.id), () => change({ scheme: s.id }))));
  const schemeSection = section("Color scheme", cards);
  schemeSection.classList.add("first", "options");
  page.append(schemeSection);

  const colors = card(themeRow("light"), themeRow("dark"), accentRow(), codeColorsRow());
  colors.classList.add("near");
  page.append(colors);

  page.append(section("Material and background", card(...materialRows())));
  page.append(section("Motion", card(reduceMotionRow(), pauseRow())));
  page.append(section("Fonts and layout", card(fontRow("ui"), fontRow("terminal"), fontRow("code"), widthRow())));
  return page;
}

/** A change that reshapes the page: save it, then rebuild. */
function change(patch: Partial<typeof prefs>) {
  setPrefs(patch);
  refresh();
}

// ---------------- colour ----------------

const bar = (fraction: number, strong: boolean) => {
  const b = el("i", strong ? "strong" : "");
  b.style.width = `${fraction * 100}%`;
  return b;
};

/** A miniature window in a theme's own colours: sidebar lines beside a bordered content panel. */
function miniature(t: Theme): HTMLElement {
  const m = el("div", "mini");
  m.style.setProperty("--m-side", css(sidebarTone(t)));
  m.style.setProperty("--m-main", css(t.shell));
  m.style.setProperty("--m-text", `${t.text.slice(0, 3).join(", ")}`);
  m.style.setProperty("--m-border", css(t.border));
  const side = el("div", "mini-side");
  side.append(bar(0.7, true), bar(1, false), bar(0.85, false), bar(1, false));
  const main = el("div", "mini-main");
  main.append(bar(0.62, true), bar(0.88, false), bar(0.76, false), bar(0.52, false));
  m.append(side, main);
  return m;
}

function schemePreview(s: Scheme): HTMLElement {
  if (s !== "system") return miniature(themeFor(s));
  const split = el("div", "mini-split");
  split.append(miniature(themeFor("light")), miniature(themeFor("dark")));
  return split;
}

/** 30×18 chip: sidebar | content | accent. */
function palette(t: Theme): HTMLElement {
  const p = el("span", "palette");
  for (const c of [sidebarTone(t), t.shell, t.accent]) {
    const part = el("i");
    part.style.background = css(c);
    p.append(part);
  }
  return p;
}

function themeRow(appearance: Appearance): HTMLElement {
  const variants = THEMES.filter((t) => t.appearance === appearance);
  const selected = appearance === "dark" ? prefs.darkTheme : prefs.lightTheme;
  const options: Option[] = variants.map((v) => ({ label: v.name, leading: () => palette(deriveTheme(v.id, appearance, "theme", prefs.surface)) }));
  const picker = select({
    options,
    selected: Math.max(0, variants.findIndex((v) => v.id === selected)),
    width: 218,
    menuWidth: 260,
    heading: appearance === "dark" ? "Dark themes" : "Light themes",
    onSelect: (i) => change(appearance === "dark" ? { darkTheme: variants[i].id } : { lightTheme: variants[i].id }),
  });
  return row(appearance === "dark" ? "Dark theme" : "Light theme", null, picker);
}

function accentRow(): HTMLElement {
  // Swatches preview each accent on the theme showing right now.
  const current = activeTheme();
  const swatches = el("div", "swatches");
  const choices = ["theme" as const, ...ACCENTS.map((a) => a.id)];
  for (const choice of choices) {
    const t = deriveTheme(current.id, current.appearance, choice, prefs.surface);
    const label = choice === "theme" ? "Theme default" : ACCENTS.find((a) => a.id === choice)!.label;
    const s = el("button", `swatch${prefs.accent === choice ? " selected" : ""}`);
    s.title = label;
    s.setAttribute("aria-label", label);
    s.style.setProperty("--swatch", css(t.accent));
    const sample = el("span", "sample");
    if (choice === "theme") {
      sample.classList.add("theme");
      sample.style.background = css(t.accentWash);
      t.glyph.forEach((g) => {
        const b = el("i");
        b.style.background = css(g);
        sample.append(b);
      });
    } else sample.style.background = css(t.accent);
    s.append(sample);
    s.onclick = () => change({ accent: choice });
    swatches.append(s);
  }
  const helper = prefs.accent === "theme" ? "Theme default" : ACCENTS.find((a) => a.id === prefs.accent)!.label;
  return row("Accent color", [helper], swatches);
}

const CODE_COLORS: { id: CodeColors; label: string; meta: string }[] = [
  { id: "one-dark-pro", label: "One Dark Pro", meta: "One Light in light themes; functions in bold" },
  { id: "theme", label: "Theme", meta: "From the theme's terminal colors" },
];

function codeColorsRow(): HTMLElement {
  const at = Math.max(0, CODE_COLORS.findIndex((c) => c.id === prefs.codeColors));
  const picker = select({ options: CODE_COLORS.map((c) => ({ label: c.label })), selected: at, width: 218, onSelect: (i) => change({ codeColors: CODE_COLORS[i].id }) });
  return row("Code colors", [CODE_COLORS[at].meta], picker);
}

// ---------------- material and background ----------------

const SURFACES: { id: Surface; label: string }[] = [
  { id: "theme", label: "Theme default" },
  { id: "frosted", label: "Frosted" },
  { id: "opaque", label: "Opaque" },
];

let backgroundError: string | null = null;

function materialRows(): HTMLElement[] {
  const helper = prefs.surface === "theme" ? `Theme default: ${activeTheme().frost ? "frosted" : "opaque"}` : prefs.surface === "frosted" ? "Translucent surfaces" : "Solid surfaces";
  const glass = row(
    "Glass",
    [helper],
    select({ options: SURFACES.map((s) => ({ label: s.label })), selected: SURFACES.findIndex((s) => s.id === prefs.surface), width: 148, onSelect: (i) => change({ surface: SURFACES[i].id }) }),
  );

  const bg = prefs.background;
  const r = el("div", "s-row");
  if (bg) {
    const tile = el("span", "bg-tile");
    void loadSource().then((s) => {
      if (!s) return;
      const img = el("img");
      img.src = s.url;
      img.alt = "";
      tile.append(img);
    });
    r.append(tile);
  }
  r.append(rowText("New thread background", [bg ? bg.name : "No image selected"]));
  const actions = el("div", "s-actions");
  const choose = () => pickImage();
  if (bg) actions.append(action("Adjust", "filled", () => void openAdjust()), action("Replace image", "filled", choose), action("Remove", "danger", () => void removeImage().then(refresh)));
  else actions.append(action("Choose image", "filled", choose));
  r.append(actions);
  const rows = [glass, r];

  if (bg) {
    const effect = EFFECTS.find((e) => e.id === prefs.backgroundEffect) ?? EFFECTS[0];
    rows.push(row("Background effect", [effect.description], select({ options: EFFECTS.map((e) => ({ label: e.label })), selected: EFFECTS.indexOf(effect), width: 128, onSelect: (i) => change({ backgroundEffect: EFFECTS[i].id }) })));
  }
  if (backgroundError) {
    const strip = el("div", "s-row-strip");
    strip.append(errorStrip(backgroundError));
    rows.push(strip);
  }
  return rows;
}

function pickImage() {
  const input = el("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    backgroundError = null;
    // Prove it decodes before replacing the current one.
    const ok = await createImageBitmap(file).then(
      (b) => (b.close(), true),
      () => false,
    );
    if (!ok) backgroundError = `Couldn't read “${file.name}” as an image.`;
    else await setImage(file).catch((err) => (backgroundError = `Couldn't save the image: ${err?.message ?? err}`));
    refresh();
  };
  input.click();
}

// ---------------- motion ----------------

const MOTION: { id: ReduceMotion; label: string }[] = [
  { id: "system", label: "System" },
  { id: "on", label: "On" },
  { id: "off", label: "Off" },
];

function reduceMotionRow(): HTMLElement {
  const helper =
    prefs.reduceMotion === "system"
      ? systemReducesMotion()
        ? "Following reduced system motion. Activity indicators use a gentle brightness pulse."
        : "Following the system, which currently allows motion."
      : prefs.reduceMotion === "on"
        ? "Animations skip straight to their final state."
        : "Animations play even if the system asks for less motion.";
  return row("Reduce motion", [helper], select({ options: MOTION.map((m) => ({ label: m.label })), selected: MOTION.findIndex((m) => m.id === prefs.reduceMotion), width: 128, onSelect: (i) => change({ reduceMotion: MOTION[i].id }) }));
}

function pauseRow(): HTMLElement {
  return row("Pause animations in background", ["Hold animations still while bismuth isn't the focused window."], toggle(prefs.pauseInBackground, "Pause animations in background", (on) => setPrefs({ pauseInBackground: on })));
}

// ---------------- fonts and layout ----------------

type Slot = "ui" | "terminal" | "code";
const SLOTS: Record<Slot, { label: string; description: string; family: "uiFont" | "terminalFont" | "codeFont"; size: "uiSize" | "terminalSize" | "codeSize" }> = {
  ui: { label: "Interface font", description: "Menus and conversations", family: "uiFont", size: "uiSize" },
  terminal: { label: "Terminal font", description: "Command output · monospace only", family: "terminalFont", size: "terminalSize" },
  code: { label: "Code & diff font", description: "Code, diffs, and files", family: "codeFont", size: "codeSize" },
};
const UI_SIZES = [12, 13, 14, 15, 16, 18, 20];
const MONO_SIZES = [10, 11, 12, 12.5, 13, 14, 15, 16, 18, 20];

// Installed families come from the Local Font Access API, asked for on the first click (it needs a gesture).
type Family = { name: string; mono: boolean };
let installed: Family[] | null = null;

async function loadFamilies(): Promise<Family[]> {
  if (installed) return installed;
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  const names = query ? await query().then((fonts) => [...new Set(fonts.map((f) => f.family))], () => [] as string[]) : [];
  // Fixed width: an "i" run as wide as an "m" run (against a proportional fallback, so a missing face fails).
  const ctx = el("canvas").getContext("2d")!;
  const isMono = (name: string) => {
    ctx.font = `20px "${name}", serif`;
    return Math.abs(ctx.measureText("iiiiiiii").width - ctx.measureText("mmmmmmmm").width) < 0.5;
  };
  installed = names
    .filter((n) => n && !/^Geist( Mono)?$/.test(n))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, mono: isMono(name) }));
  return installed;
}

function familyOptions(slot: Slot): string[] {
  const bundled = slot === "terminal" ? ["Geist Mono"] : ["Geist", "Geist Mono", "System"];
  const extra = (installed ?? []).filter((f) => slot !== "terminal" || f.mono).map((f) => f.name);
  const current = prefs[SLOTS[slot].family];
  return [...new Set([...bundled, ...extra, current])];
}

function fontRow(slot: Slot): HTMLElement {
  const spec = SLOTS[slot];
  const families = familyOptions(slot);
  const fontPicker = select({
    options: families.map((label) => ({ label })),
    selected: families.indexOf(prefs[spec.family]),
    width: 220,
    search: true,
    mono: false,
    onSelect: (i) => change({ [spec.family]: families[i] }),
  });
  // The first open asks for the installed list, then opens with it.
  if (!installed)
    fontPicker.addEventListener(
      "click",
      (e) => {
        if (installed) return;
        e.stopImmediatePropagation();
        void loadFamilies().then(() => {
          refresh();
          document.querySelector<HTMLElement>(`.s-row[data-font="${slot}"] .s-select`)?.click();
        });
      },
      { capture: true, once: true },
    );
  const sizes = slot === "ui" ? UI_SIZES : MONO_SIZES;
  const current = prefs[spec.size];
  const nearest = sizes.reduce((best, s, i) => (Math.abs(s - current) < Math.abs(sizes[best] - current) ? i : best), 0);
  const sizePicker = select({ options: sizes.map((s) => ({ label: `${s} px` })), selected: nearest, width: 128, onSelect: (i) => change({ [spec.size]: sizes[i] }) });
  const controls = el("div", "s-actions");
  controls.append(fontPicker, sizePicker);
  const r = row(spec.label, [spec.description], controls);
  r.dataset.font = slot;
  return r;
}

const WIDTH_MIN = 560;
const WIDTH_MAX = 1200;
const WIDTH_STEP = 16;
const snapWidth = (w: number) => WIDTH_MIN + Math.round((Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w)) - WIDTH_MIN) / WIDTH_STEP) * WIDTH_STEP;

/** 240px slider; the value and Reset show above it, the range below, while it's hovered or dragged. */
function widthRow(): HTMLElement {
  const r = el("div", "s-row width-row");
  r.append(rowText("Conversation width", ["Maximum width for messages and the composer."]));
  let width = prefs.contentWidth;
  const control = el("div", "width-control");
  const top = el("div", "width-detail");
  const value = el("span", "");
  const reset = el("button", "width-reset", "Reset");
  top.append(value, reset);
  const slider = el("div", "s-slider");
  slider.tabIndex = 0;
  slider.setAttribute("role", "slider");
  slider.setAttribute("aria-label", "Conversation width");
  const track = el("div", "s-slider-track");
  const fill = el("div", "s-slider-fill");
  const knob = el("div", "s-slider-knob");
  track.append(fill, knob);
  slider.append(track);
  const bottom = el("div", "width-detail range");
  bottom.append(el("span", "", "560 px"), el("span", "", "1,200 px"));
  control.append(top, slider, bottom);
  r.append(control);

  // While dragging, the transcript follows live; the value is saved on release.
  const show = (w: number) => {
    width = snapWidth(w);
    const f = (width - WIDTH_MIN) / (WIDTH_MAX - WIDTH_MIN);
    fill.style.width = `${f * 100}%`;
    knob.style.left = `${f * 100}%`;
    value.textContent = `${width} px`;
    slider.setAttribute("aria-valuetext", value.textContent);
    document.documentElement.style.setProperty("--content-w", `${width}px`);
  };
  const commit = () => width !== prefs.contentWidth && setPrefs({ contentWidth: width });
  const fromX = (x: number) => {
    const rect = slider.getBoundingClientRect();
    show(WIDTH_MIN + Math.min(1, Math.max(0, (x - rect.left - 7) / Math.max(1, rect.width - 14))) * (WIDTH_MAX - WIDTH_MIN));
  };
  slider.onpointerdown = (e) => {
    slider.setPointerCapture(e.pointerId);
    control.classList.add("pressed");
    fromX(e.clientX);
    slider.onpointermove = (m) => fromX(m.clientX);
    slider.onpointerup = slider.onpointercancel = () => {
      slider.onpointermove = null;
      control.classList.remove("pressed");
      commit();
    };
  };
  slider.onkeydown = (e) => {
    const to = { ArrowLeft: width - WIDTH_STEP, ArrowDown: width - WIDTH_STEP, ArrowRight: width + WIDTH_STEP, ArrowUp: width + WIDTH_STEP, Home: WIDTH_MIN, End: WIDTH_MAX }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    control.classList.add("keyboard");
    show(to);
    commit();
  };
  slider.onblur = () => control.classList.remove("keyboard");
  control.onpointerenter = () => control.classList.remove("keyboard");
  reset.onclick = () => {
    show(DEFAULTS.contentWidth);
    commit();
  };
  show(width);
  return r;
}
