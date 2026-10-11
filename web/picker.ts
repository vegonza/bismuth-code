// Zeron's compact model picker (crates/ui/src/pickers/compact.rs): a 256px card whose height glides between
// the effort panel and the model list, an effort slider painted like Zeron's (accent glass fill, fast-mode
// light flowing toward the thumb, quiet stops), a fast-mode bolt and a searchable, starrable model list.
import type { HarnessId, ModelOption } from "../shared/model";
import { effortLabel, el } from "./dom";
import { HARNESS_NAMES, harnessIcon, icon } from "./icons";
import { animator, reducedMotion, rollText, Tween } from "./motion";
import { harnessEnabled } from "./prefs";
import { persist, render, store } from "./store";
import { accentChannels, activeTheme } from "./theme";

// ---------------- settings ----------------

/** An open thread keeps the harness it started on; a new session uses the one last picked. */
const lockedHarness = (): HarnessId | null => store.thread?.harness ?? null;
/** A provider disabled in Settings offers nothing to new sessions; threads already on it keep their models. */
const offered = (h: HarnessId) => lockedHarness() === h || harnessEnabled(h);
const harnessModels = (h: HarnessId) => (offered(h) ? store.models.filter((m) => m.harness === h) : []);

export function currentHarness(): HarnessId {
  const h = lockedHarness() ?? store.settings.harness;
  // A harness that offers nothing (disabled, not installed, failed to start) falls back to one that does.
  return harnessModels(h).length || lockedHarness() ? h : (store.models.find((m) => offered(m.harness))?.harness ?? h);
}

export function currentModel(): ModelOption | undefined {
  const models = harnessModels(currentHarness());
  return models.find((m) => m.id === store.settings.model) ?? models.find((m) => m.isDefault) ?? models[0];
}

export function currentEffort(m = currentModel()): string | null {
  if (!m?.efforts.length) return null;
  return store.settings.effort && m.efforts.includes(store.settings.effort) ? store.settings.effort : m.defaultEffort;
}

export const fastOn = (m = currentModel()) => !!m?.fastTier && store.settings.serviceTier === m.fastTier;

function setModel(m: ModelOption) {
  const effort = currentEffort();
  store.settings = {
    harness: m.harness,
    model: m.id,
    effort: effort && m.efforts.includes(effort) ? effort : m.defaultEffort,
    serviceTier: m.fastTier && fastOn() ? m.fastTier : null,
  };
  persist();
  render("composer");
}

function setEffort(effort: string) {
  if (currentEffort() === effort) return;
  store.settings = { ...store.settings, harness: currentHarness(), model: currentModel()?.id ?? null, effort };
  persist();
  renderTrigger();
  updatePanel();
}

function toggleFast() {
  const m = currentModel();
  if (!m?.fastTier) return;
  store.settings = { ...store.settings, harness: m.harness, model: m.id, serviceTier: fastOn(m) ? null : m.fastTier };
  persist();
  renderTrigger();
  updatePanel();
}

// ---------------- trigger ----------------

let slot: HTMLElement;
let trigger: HTMLButtonElement;
let triggerLabel: HTMLElement;
let triggerSuffix: HTMLElement;
let triggerBolt: HTMLElement;
let triggerIcon: HTMLElement;

export function renderTrigger() {
  const m = currentModel();
  const effort = currentEffort(m);
  const brand = harnessIcon(m?.harness ?? currentHarness());
  if (triggerIcon.className !== brand.className) triggerIcon.replaceWith((triggerIcon = brand));
  rollText(triggerLabel, m?.name ?? (store.models.length ? "Select model" : "Loading models…"));
  triggerSuffix.hidden = !effort;
  if (effort) rollText(triggerSuffix, effortLabel(effort));
  triggerBolt.hidden = !fastOn(m);
  trigger.title = `${m?.name ?? "Model"} · ${HARNESS_NAMES[m?.harness ?? currentHarness()]}${effort ? ` · ${effortLabel(effort)}` : ""}${fastOn(m) ? " · Fast" : ""}`;
}

// ---------------- card ----------------

const CARD_BORDERS = 2;
const MENU_OUT_MS = 100;

let card: HTMLElement | null = null;
let content: HTMLElement;
let page: "panel" | "models" = "panel";
const height = new Tween(0);
const reveal = new Tween(1);

export const pickerOpen = () => !!card;

export function togglePicker() {
  if (card) closePicker();
  else openPicker();
}

function openPicker() {
  page = "panel";
  card = el("div", "card picker menu-in");
  card.tabIndex = -1;
  card.addEventListener("keydown", onKey);
  content = el("div", "picker-page");
  card.append(content);
  slot.append(card);
  trigger.classList.add("open");
  content.append(panel());
  height.snap(content.offsetHeight + CARD_BORDERS);
  reveal.snap(1);
  card.style.height = `${height.value()}px`;
  card.focus({ preventScroll: true });
}

export function closePicker() {
  if (!card) return;
  const closing = card;
  card = null;
  panelRefs = null;
  trigger.classList.remove("open");
  closing.classList.replace("menu-in", "menu-out");
  closing.style.pointerEvents = "none";
  setTimeout(() => closing.remove(), reducedMotion() ? 0 : MENU_OUT_MS + 20);
}

/** Swap pages: the new page fades in while the card resizes to it. */
function show(next: "panel" | "models") {
  if (!card) return;
  page = next;
  content.replaceChildren(next === "panel" ? panel() : modelList());
  reveal.snap(0);
  reveal.set(1);
  resize();
  if (next === "panel") card.focus({ preventScroll: true });
}

function resize() {
  if (!card) return;
  height.set(content.offsetHeight + CARD_BORDERS);
  kick();
}

// One frame loop for everything that moves: card height, page reveal, the slider.
const kick = animator((now) => {
  if (!card) return false;
  card.style.height = `${height.value(now)}px`;
  content.style.opacity = String(reveal.value(now));
  const sliding = panelRefs?.slider ? paintSlider(now) : false;
  return height.moving(now) || reveal.moving(now) || sliding;
});

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    if (page === "models") show("panel");
    else {
      closePicker();
      onClosed();
    }
    return;
  }
  if (page !== "panel") return;
  const m = currentModel();
  const efforts = m?.efforts ?? [];
  const ix = efforts.indexOf(currentEffort(m) ?? "");
  if (e.key === "ArrowLeft" && ix > 0) setEffort(efforts[ix - 1]);
  else if (e.key === "ArrowRight" && ix >= 0 && ix < efforts.length - 1) setEffort(efforts[ix + 1]);
  else if (e.key === "Home" && efforts.length) setEffort(efforts[0]);
  else if (e.key === "End" && efforts.length) setEffort(efforts[efforts.length - 1]);
  else if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFast();
  else if (e.key === "Enter" || e.key === " " || e.key === "ArrowUp" || e.key === "ArrowDown") show("models");
  else return;
  e.preventDefault();
}

let onClosed = () => {};

// ---------------- panel ----------------

type SliderRefs = { root: HTMLElement; canvas: HTMLCanvasElement; thumb: HTMLElement; count: number };
let panelRefs: { effort: HTMLElement; name: HTMLElement; fast: HTMLElement | null; slider: SliderRefs | null } | null = null;

// Slider motion, kept across panel rebuilds so reopening never replays a slide from zero.
const fraction = new Tween(0);
const fastT = new Tween(0);
const press = new Tween(0);
let dragFraction: number | null = null;
let phase = 0;
let lastFrame = 0;

function panel(): HTMLElement {
  const m = currentModel();
  const efforts = m?.efforts ?? [];
  const box = el("div", "panel");
  const head = el("div", `p-head${efforts.length ? "" : " single"}`);
  const title = el("button", "p-title");
  const effortEl = el("span", "p-effort");
  if (efforts.length) title.append(effortEl);
  const modelLine = el("span", "p-model");
  const name = el("span", "name");
  modelLine.append(name, icon("chevronRight", undefined, "lean"));
  title.append(modelLine);
  title.onclick = () => show("models");
  head.append(title);

  let fast: HTMLElement | null = null;
  if (m?.fastTier) {
    fast = el("button", "fast");
    fast.append(icon("zap", undefined, "off"), icon("zap", undefined, "on", true));
    fast.onclick = toggleFast;
    head.append(fast);
  }
  box.append(head);

  let slider: SliderRefs | null = null;
  if (efforts.length) {
    const block = el("div", "slider-block");
    slider = effortSlider(efforts.length);
    block.append(slider.root);
    box.append(block);
  }
  panelRefs = { effort: effortEl, name, fast, slider };
  // First sight of the panel: everything already where it belongs.
  const target = targetFraction();
  fraction.snap(target);
  fastT.snap(fastOn() ? 1 : 0);
  effortEl.removeAttribute("data-roll");
  name.removeAttribute("data-roll");
  updatePanel();
  requestAnimationFrame(() => kick());
  return box;
}

function targetFraction() {
  const m = currentModel();
  const efforts = m?.efforts ?? [];
  const ix = efforts.indexOf(currentEffort(m) ?? "");
  return efforts.length > 1 && ix >= 0 ? ix / (efforts.length - 1) : 0;
}

/** Sync the panel to the settings in place: the title rolls, the slider glides. */
export function updatePanel() {
  if (!panelRefs || !card) return;
  const m = currentModel();
  const effort = currentEffort(m);
  rollText(panelRefs.effort, effort ? effortLabel(effort) : "Default");
  rollText(panelRefs.name, m?.name ?? "Select model");
  if (panelRefs.fast) {
    const on = fastOn(m);
    panelRefs.fast.classList.toggle("active", on);
    panelRefs.fast.title = on ? "Fast mode on · Turn off" : "Fast mode off · Turn on";
  }
  if (dragFraction === null) fraction.set(targetFraction());
  fastT.set(fastOn(m) ? 1 : 0);
  kick();
}

/** Refresh after outside changes (thread switched, models arrived) without disturbing an open card. */
export function refreshPicker() {
  renderTrigger();
  if (card && page === "panel") updatePanel();
}

// Geometry: a 28px rail under a 44×32 thumb; stops and pointer share the thumb centre's 22px inset,
// and the fill runs a rail radius past the centre, always hidden under the thumb.
const SLIDER_H = 36;
const RAIL_TOP = 4;
const RAIL_H = 28;
const THUMB_INSET = 22;
const FILL_PAST = RAIL_H / 2;
const BLEED = 24; // canvas margin for the fill's glow

function effortSlider(count: number): SliderRefs {
  const root = el("div", "slider");
  root.setAttribute("role", "slider");
  root.setAttribute("aria-label", "Reasoning effort");
  const canvas = el("canvas", "slider-paint");
  const track = el("div", "thumb-track");
  const thumb = el("div", "thumb");
  track.append(thumb);
  root.append(el("div", "rail"), canvas, track);

  const fractionAt = (clientX: number) => {
    const r = root.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left - THUMB_INSET) / Math.max(1, r.width - 2 * THUMB_INSET)));
  };
  const follow = (clientX: number) => {
    const m = currentModel();
    const efforts = m?.efforts ?? [];
    dragFraction = fractionAt(clientX);
    fraction.snap(dragFraction);
    const pick = efforts[Math.round(dragFraction * (efforts.length - 1))];
    if (pick) setEffort(pick);
    kick();
  };
  root.onpointerdown = (e) => {
    e.preventDefault();
    root.setPointerCapture(e.pointerId);
    card?.focus({ preventScroll: true });
    press.set(1);
    follow(e.clientX);
  };
  root.onpointermove = (e) => {
    if (dragFraction !== null) follow(e.clientX);
  };
  const release = () => {
    if (dragFraction === null) return;
    // The release glides from the pointer to the chosen stop.
    dragFraction = null;
    press.set(0);
    fraction.set(targetFraction());
    kick();
  };
  root.onpointerup = release;
  root.onpointercancel = release;
  return { root, canvas, thumb, count };
}

// Accent tones, refreshed from the theme on each paint.
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const rgba = (c: number[], a: number) => `rgba(${c.map((v) => Math.round(v)).join(",")},${Math.max(0, Math.min(1, a))})`;
const WHITE = [255, 255, 255];
let ACCENT: number[] = [];
let LIFTED: number[] = [];
let SHIFTED: number[] = [];
function syncAccent() {
  const next = accentChannels();
  if (next.every((v, i) => v === ACCENT[i])) return;
  ACCENT = next;
  LIFTED = mix(ACCENT, WHITE, 0.45);
  SHIFTED = hueShift(ACCENT, 0.07, 0.14);
}

function hueShift([r, g, b]: number[], dh: number, dl: number): number[] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h / 6 + dh) % 1;
  const L = Math.min(l + dl, 0.9);
  const C = (1 - Math.abs(2 * L - 1)) * s;
  const X = C * (1 - Math.abs(((h * 6) % 2) - 1));
  const [r1, g1, b1] = h < 1 / 6 ? [C, X, 0] : h < 2 / 6 ? [X, C, 0] : h < 3 / 6 ? [0, C, X] : h < 4 / 6 ? [0, X, C] : h < 5 / 6 ? [X, 0, C] : [C, 0, X];
  const m = L - C / 2;
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

/** Paint the fill, fast-mode flow and stops; place the thumb. Returns whether anything is still moving. */
function paintSlider(now: number): boolean {
  const s = panelRefs!.slider!;
  syncAccent();
  const width = s.root.clientWidth;
  if (!width) return true;
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0;
  lastFrame = now;
  const f = dragFraction ?? fraction.value(now);
  const intensity = fastT.value(now);
  const alive = intensity > 0.001 && !reducedMotion() && document.hasFocus();
  if (alive) phase = (phase + dt * (0.32 + 0.22 * intensity)) % 1;
  const breath = alive ? 0.5 + 0.5 * Math.sin(2 * Math.PI * phase) : 0.5;

  const dpr = devicePixelRatio || 1;
  const cw = width + 2 * BLEED;
  const ch = SLIDER_H + 2 * BLEED;
  if (s.canvas.width !== Math.round(cw * dpr) || s.canvas.height !== Math.round(ch * dpr)) {
    s.canvas.width = Math.round(cw * dpr);
    s.canvas.height = Math.round(ch * dpr);
  }
  const ctx = s.canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, BLEED * dpr, BLEED * dpr);
  ctx.clearRect(-BLEED, -BLEED, cw, ch);

  const run = Math.max(0, width - 2 * THUMB_INSET);
  const center = THUMB_INSET + f * run;
  const end = Math.min(width, center + FILL_PAST);

  // Accent glass: lit from above, a soft lifted rim, a 1px inner top highlight, and a halo that
  // breathes with fast mode.
  const glow = intensity * (0.2 + 0.25 * breath);
  ctx.save();
  ctx.shadowColor = rgba(ACCENT, 0.3 * glow);
  ctx.shadowOffsetY = 2 + 2 * glow;
  ctx.shadowBlur = 6 + 14 * glow;
  const grad = ctx.createLinearGradient(0, RAIL_TOP, 0, RAIL_TOP + RAIL_H);
  grad.addColorStop(0, rgba(mix(ACCENT, WHITE, 0.06), 1));
  grad.addColorStop(1, rgba(ACCENT, 1));
  ctx.fillStyle = grad;
  roundRect(ctx, 0, RAIL_TOP, end, RAIL_H, RAIL_H / 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, 0, RAIL_TOP, end, RAIL_H, RAIL_H / 2);
  ctx.clip();
  // Inner top highlight: the plate minus itself shifted down a pixel.
  ctx.beginPath();
  ctx.rect(-1, RAIL_TOP - 1, end + 2, RAIL_H + 2);
  ctx.roundRect(0, RAIL_TOP + 1, end, RAIL_H, RAIL_H / 2);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fill("evenodd");

  // Fast mode: two slow waves drift through the fill toward the thumb, shading it between a lifted
  // accent and a hue-shifted one; the light gathers just before the thumb.
  if (intensity > 0.001 && end > RAIL_H) {
    const inset = 1;
    const from = inset;
    const to = end - inset;
    const tau = Math.PI * 2;
    const flow = (x: number) => {
      const slow = 0.5 + 0.5 * Math.sin(tau * (x / 150 - 2 * phase));
      const quick = 0.5 + 0.5 * Math.sin(tau * (x / 64 - 3 * phase) + 1.7);
      const g = (0.65 * slow + 0.35 * quick) ** 2;
      const charge = Math.exp(-Math.max(0, center - x) / 40) * (0.6 + 0.4 * breath);
      const lead = Math.min(1, Math.max(0, (x - from) / 28));
      const alpha = intensity * ((0.08 + 0.34 * g) * lead + 0.22 * charge);
      return rgba(mix(SHIFTED, LIFTED, slow), Math.min(1, alpha));
    };
    roundRect(ctx, from, RAIL_TOP + inset, to - from, RAIL_H - 2 * inset, (RAIL_H - 2 * inset) / 2);
    ctx.clip();
    // One gradient sampled every 4px (Zeron paints strips whose gradients join end to end).
    const g = ctx.createLinearGradient(from, 0, to, 0);
    for (let x = from; x < to; x += 4) g.addColorStop((x - from) / (to - from), flow(x));
    g.addColorStop(1, flow(to));
    ctx.fillStyle = g;
    ctx.fillRect(from, RAIL_TOP + inset, to - from, RAIL_H - 2 * inset);
  }
  ctx.restore();

  // Rim.
  ctx.strokeStyle = rgba(mix(ACCENT, WHITE, 0.35), 0.35);
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, RAIL_TOP + 0.5, end - 1, RAIL_H - 1, RAIL_H / 2 - 0.5);
  ctx.stroke();

  // Quiet stops; filled ones follow the animated front, never ahead of it.
  for (let i = 0; i < s.count; i++) {
    const stop = s.count > 1 ? i / (s.count - 1) : 0;
    ctx.fillStyle = stop <= f + 1e-4 ? "rgba(255,255,255,0.4)" : rgba(activeTheme().muted.slice(0, 3), 0.28);
    roundRect(ctx, THUMB_INSET + stop * run - 2, SLIDER_H / 2 - 2, 4, 4, 2);
    ctx.fill();
  }

  // The thumb: a press lifts it on a softer drop; fast mode breathes an accent halo beneath it.
  const p = press.value(now);
  const live = intensity * (0.55 + 0.45 * breath);
  s.thumb.style.left = `${f * 100}%`;
  s.thumb.style.boxShadow = [
    "inset 0 1px 0 rgba(255,255,255,0.8)",
    "0 1px 2px rgba(0,0,0,0.22)",
    p > 0.001 ? `0 ${2 * p}px 8px rgba(0,0,0,${0.12 * p})` : "",
    intensity > 0.001 ? `0 1px 10px ${rgba(ACCENT, 0.35 * live)}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  return fraction.moving(now) || fastT.moving(now) || press.moving(now) || alive || dragFraction !== null;
}

// ---------------- model list ----------------

const ROW_PITCH = 34;

/** Harnesses share model ids (Opus on Claude and on Cursor), so a model is its harness and id together. */
const modelKey = (m: ModelOption) => `${m.harness}:${m.id}`;
const isCurrent = (m: ModelOption) => {
  const c = currentModel();
  return !!c && modelKey(c) === modelKey(m);
};

/** Favorites saved by bare id star that id on every harness that has it, as they showed before. */
function migrateFavorites() {
  const legacy = [...store.favorites].filter((k) => !(k.split(":")[0] in HARNESS_NAMES));
  if (!legacy.length) return;
  for (const id of legacy) {
    const matches = store.models.filter((m) => m.id === id);
    if (!matches.length) continue;
    for (const m of matches) store.favorites.add(modelKey(m));
    store.favorites.delete(id);
  }
  persist();
}

/** Starred models first, then one run per harness (only the thread's own once a thread has started). Picking
 *  another harness's model on a new session moves the session to that harness. */
function modelList(): HTMLElement {
  panelRefs = null;
  const box = el("div", "list-page");
  const head = el("div", "list-head");
  const back = el("button", "sq-btn");
  back.title = "Back";
  back.append(icon("chevronLeft"));
  back.onclick = () => show("panel");

  const search = el("div", "search");
  const input = el("input");
  input.placeholder = "Search models…";
  search.append(icon("search"), input);

  const list = el("div", "mlist");
  let active = -1;
  let rows: ModelOption[] = [];
  // Tab strip: each tab jumps to its group, and the group at the top of the scroll lights its tab.
  let groups: { tab: HTMLElement; start: number }[] = [];
  const lightTabs = () => {
    const top = Math.round(list.scrollTop / ROW_PITCH);
    const current = groups.findLast((g) => g.start <= top);
    for (const g of groups) g.tab.classList.toggle("viewed", g === current);
  };
  const setActive = (i: number) => {
    active = i;
    list.querySelectorAll(".mrow").forEach((r, j) => r.classList.toggle("active", j === i));
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    migrateFavorites();
    const starred = (m: ModelOption) => store.favorites.has(modelKey(m));
    const locked = lockedHarness();
    const order = store.harnesses.map((h) => h.id);
    const choices = store.models.filter((m) => (locked ? m.harness === locked : harnessEnabled(m.harness)));
    const sorted = [...choices].sort((a, b) => Number(starred(b)) - Number(starred(a)) || order.indexOf(a.harness) - order.indexOf(b.harness));
    rows = q ? sorted.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || HARNESS_NAMES[m.harness].toLowerCase().includes(q)) : sorted;

    groups = [];
    if (!q) {
      rows.forEach((m, i) => {
        const key = starred(m) ? "starred" : m.harness;
        if (groups.length && groups[groups.length - 1].tab.dataset.key === key) return;
        const tab = el("button", "sq-btn");
        tab.dataset.key = key;
        tab.title = key === "starred" ? "Starred" : HARNESS_NAMES[m.harness];
        tab.append(key === "starred" ? icon("star", undefined, "", true) : harnessIcon(m.harness));
        tab.onclick = () => list.scrollTo({ top: i * ROW_PITCH, behavior: "smooth" });
        groups.push({ tab, start: i });
      });
    }
    head.replaceChildren(back, ...groups.map((g) => g.tab));
    if (active < 0 || active >= rows.length) active = Math.max(0, rows.findIndex(isCurrent));
    list.replaceChildren(
      ...(rows.length
        ? rows.map((m, i) => {
            const selected = isCurrent(m);
            const row = el("div", `mrow${selected ? " selected" : ""}${i === active ? " active" : ""}`);
            row.title = `${m.name} · ${HARNESS_NAMES[m.harness]}`;
            const fav = starred(m);
            const star = el("button", `star${fav ? " on" : ""}`);
            star.title = `${fav ? "Remove" : "Add"} ${m.name} ${fav ? "from" : "to"} favorites`;
            star.append(icon("star", undefined, "", fav));
            star.onclick = (e) => {
              e.stopPropagation();
              if (fav) store.favorites.delete(modelKey(m));
              else store.favorites.add(modelKey(m));
              persist();
              draw();
            };
            row.append(harnessIcon(m.harness), el("span", "mlabel", m.name), star);
            row.onmouseenter = () => setActive(i);
            row.onclick = () => {
              setModel(m);
              show("panel");
            };
            return row;
          })
        : [el("div", "empty", "No models match")]),
    );
    lightTabs();
    resize();
  };
  list.onscroll = lightTabs;
  input.oninput = () => {
    active = 0;
    draw();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.min(rows.length - 1, Math.max(0, active + (e.key === "ArrowDown" ? 1 : -1))));
      list.querySelector(".mrow.active")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && rows[active]) {
      e.preventDefault();
      setModel(rows[active]);
      show("panel");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      show("panel");
    }
  };
  box.append(head, search, list);
  draw();
  requestAnimationFrame(() => {
    input.focus({ preventScroll: true });
    // Open on the current model: its group at the top when the model sits near its start, else centred.
    const sel = list.querySelector<HTMLElement>(".mrow.selected");
    if (!sel) return;
    const ix = rows.findIndex(isCurrent);
    const group = groups.findLast((g) => g.start <= ix);
    const visible = Math.floor(list.clientHeight / ROW_PITCH);
    if (group && ix - group.start < visible - 2) list.scrollTop = Math.max(0, (group.start - (group.start > 0 ? 1 : 0)) * ROW_PITCH);
    else list.scrollTop = Math.max(0, sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2);
    lightTabs();
  });
  return box;
}

// ---------------- mount ----------------

export function initPicker(into: HTMLElement, closed: () => void) {
  slot = into;
  onClosed = closed;
  trigger = el("button", "trigger");
  triggerLabel = el("span", "label");
  triggerSuffix = el("span", "suffix");
  triggerBolt = icon("zap", undefined, "bolt", true);
  triggerIcon = harnessIcon(currentHarness());
  trigger.append(triggerIcon, triggerLabel, triggerSuffix, triggerBolt);
  trigger.onclick = (e) => {
    e.stopPropagation();
    togglePicker();
  };
  slot.append(trigger);
  addEventListener("focus", () => kick()); // fast mode's shimmer pauses while the window is in the background
  document.addEventListener("pointerdown", (e) => {
    if (card && !slot.contains(e.target as Node)) closePicker();
  });
  addEventListener("blur", () => card && closePicker()); // leaving the window, as the other menus (popover.ts)
  renderTrigger();
}
