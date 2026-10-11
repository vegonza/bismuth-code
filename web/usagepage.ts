// Settings → Usage (t3code's Usage page): tokens and API-rate cost across the subscriptions — Claude Code and
// Codex from this machine's transcripts, Cursor from its account history — over 24h / 7 / 30 / 90 days.
// The core scans in a worker and answers `usage.report`; reports are cached per period so switching is instant
// while a fresh one loads underneath.
import type { UsageProvider, UsageReport } from "../shared/model";
import { el } from "./dom";
import { harnessIcon, icon } from "./icons";
import { net } from "./store";
import { pageColumn } from "./widgets";

type Metric = "cost" | "tokens";
const PERIODS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;
// Fixed order = fixed color slot (validated categorical palette: orange, blue, aqua).
const PROVIDERS: { id: UsageProvider; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "cursor", name: "Cursor" },
];

const saved = JSON.parse(localStorage.getItem("bismuth.usagePage") ?? "{}");
let metric: Metric = saved.metric === "tokens" ? "tokens" : "cost";
// Every opening starts on 7 days: longer periods are scanned only when picked (a cold 90 days reads ~1 GB).
const DEFAULT_DAYS = 7;
let days: number = DEFAULT_DAYS;
let breakdown: "model" | "time" = "model";
const reports = new Map<number, UsageReport>();
const pending = new Set<number>();
const failures = new Map<number, string>();
let mount: HTMLElement | null = null;

const persist = () => localStorage.setItem("bismuth.usagePage", JSON.stringify({ metric }));

function request(d: number) {
  if (pending.has(d)) return;
  pending.add(d);
  failures.delete(d);
  net.send({ type: "usage.report", days: d });
}

/** Wired from app.ts: a report (or its failure) arrived. */
export function usageArrived(d: number, report: UsageReport | null, error?: string) {
  pending.delete(d);
  if (report) reports.set(d, report);
  else failures.set(d, error ?? "Usage couldn't be read.");
  if (d === days) paint();
}

export function renderUsagePage(): HTMLElement {
  const page = pageColumn();
  page.classList.add("wide", "usage-page");
  mount = page;
  days = DEFAULT_DAYS;
  // Every showing asks for a fresh report; the cached one shows meanwhile.
  request(days);
  paint();
  return page;
}

// ---------------- formatting ----------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const trim = (v: number) => v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
export function formatTokens(v: number) {
  const a = Math.abs(v);
  if (a >= 1e12) return `${trim(v / 1e12)}T`;
  if (a >= 1e9) return `${trim(v / 1e9)}B`;
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e3) return `${trim(v / 1e3)}K`;
  return integer.format(Math.round(v));
}
const formatUsd = (v: number) => usd.format(v);
const formatPercent = (share: number) => {
  const p = share * 100;
  return p > 0 && p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`;
};
const format = (v: number) => (metric === "cost" ? formatUsd(v) : formatTokens(v));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function periodLabel(key: string, hourly: boolean) {
  if (hourly) return new Date(Number(key)).toLocaleTimeString("en-US", { hour: "numeric" });
  const [, m, d] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// ---------------- the page ----------------

function paint() {
  if (!mount) return;
  const report = reports.get(days) ?? null;
  const loading = pending.has(days);
  mount.replaceChildren(header(loading));
  const failure = failures.get(days);
  if (!report) {
    mount.append(failure ? el("div", "u-empty", failure) : skeleton());
    return;
  }
  for (const note of report.notes) mount.append(el("div", "u-note", note));
  if (failure) mount.append(el("div", "u-note", `Couldn't refresh: ${failure}`));
  if (!report.totalTokens) {
    mount.append(el("div", "u-empty", `No usage in the ${days === 1 ? "past 24 hours" : `past ${days} days`}.`));
    return;
  }
  const top = el("section", "u-top");
  top.append(summary(report), chartBlock(report));
  mount.append(top, totals(report), shareBar(report), breakdownBlock(report));
}

function header(loading: boolean): HTMLElement {
  const head = el("div", "s-header u-head");
  head.append(el("div", "s-title", "Usage"));
  const controls = el("div", "u-controls");
  controls.append(
    segmented(
      "Usage metric",
      [
        { value: "cost", label: "Cost" },
        { value: "tokens", label: "Tokens" },
      ],
      metric,
      (v) => {
        metric = v as Metric;
        persist();
        paint();
      },
    ),
    segmented(
      "Usage period",
      PERIODS.map((p) => ({ value: String(p.days), label: p.label })),
      String(days),
      (v) => {
        days = Number(v);
        paint();
        request(days);
      },
    ),
  );
  const refresh = el("button", `s-icon-btn${loading ? " spinning" : ""}`);
  refresh.title = "Refresh usage";
  refresh.setAttribute("aria-label", "Refresh usage");
  refresh.setAttribute("aria-busy", String(loading));
  refresh.disabled = loading;
  refresh.append(icon("refreshCw"));
  refresh.onclick = () => {
    request(days);
    paint();
  };
  controls.append(refresh);
  head.append(controls);
  return head;
}

function segmented(label: string, options: { value: string; label: string }[], selected: string, onSelect: (v: string) => void): HTMLElement {
  const group = el("div", "u-seg");
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (const o of options) {
    const b = el("button", `u-seg-btn${o.value === selected ? " on" : ""}`, o.label);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(o.value === selected));
    b.onclick = () => o.value !== selected && onSelect(o.value);
    group.append(b);
  }
  return group;
}

const dot = (p: UsageProvider) => el("span", `u-dot series-${p}`);

function summary(r: UsageReport): HTMLElement {
  const box = el("div", "u-summary");
  const hero = el("div", "u-hero");
  hero.append(el("div", "u-hero-value", metric === "cost" ? formatUsd(r.cost) : formatTokens(r.totalTokens)));
  const sub = el("div", "u-hero-sub", `${integer.format(r.sessions)} sessions`);
  if (metric === "cost") {
    sub.append(" · API estimate");
    if (r.unpricedShare > 0) {
      const info = icon("info", 12, "u-info");
      info.title = `The estimate excludes ${formatPercent(r.unpricedShare)} of tokens from models without a known price.`;
      sub.append(info);
    }
  }
  hero.append(sub);
  box.append(hero);
  const sumMetric = metric === "cost" ? r.cost : r.totalTokens;
  for (const { id, name } of PROVIDERS) {
    const p = r.providers.find((x) => x.provider === id);
    if (!p || (!p.tokens && !p.cost)) continue;
    const row = el("div", "u-prov");
    const line = el("div", "u-prov-line");
    const who = el("span", "u-prov-name");
    const label = el("span", "u-prov-label");
    label.append(el("span", "", name), el("span", "u-prov-sessions", `${integer.format(p.sessions)} ${p.sessions === 1 ? "session" : "sessions"}`));
    who.append(dot(id), harnessIcon(id, 14, "u-prov-icon"), label);
    line.append(who, el("span", "u-prov-value", metric === "cost" ? formatUsd(p.cost) : formatTokens(p.tokens)));
    const share = sumMetric ? (metric === "cost" ? p.cost : p.tokens) / sumMetric : 0;
    row.append(line, el("div", "u-prov-sub", metric === "cost" ? `${formatPercent(share)} of cost · ${formatTokens(p.tokens)} tokens` : `${formatPercent(share)} of tokens · ${formatUsd(p.cost)}`));
    box.append(row);
  }
  return box;
}

// ---------------- the chart ----------------

const VIEW_W = 960;
const VIEW_H = 240;
const PLOT_TOP = 8;

/** A 1/2/5 × 10^n step whose top tick is at or above the peak, so the tallest point is never clipped. */
function niceScale(peak: number, count = 4) {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const raw = peak / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n > 5 ? 10 : n > 2 ? 5 : n > 1 ? 2 : 1) * mag;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(v);
  return { max, ticks };
}

/** Monotone cubic through the points: smooth, but never overshooting spiky usage below zero or above a peak. */
function curve(points: { x: number; y: number }[]): string {
  if (!points.length) return "";
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  const n = points.length;
  const slopes = points.slice(0, -1).map((p, i) => (points[i + 1].y - p.y) / (points[i + 1].x - p.x || 1));
  const tan = points.map((_, i) => (i === 0 ? slopes[0] : i === n - 1 ? slopes[n - 2] : slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      tan[i] = tan[i + 1] = 0;
      continue;
    }
    const a = tan[i] / slopes[i];
    const b = tan[i + 1] / slopes[i];
    const m = a * a + b * b;
    if (m > 9) {
      const k = 3 / Math.sqrt(m);
      tan[i] = k * a * slopes[i];
      tan[i + 1] = k * b * slopes[i];
    }
  }
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const p = points[i];
    const q = points[i + 1];
    const dx = q.x - p.x;
    d += ` C${(p.x + dx / 3).toFixed(1)},${(p.y + (tan[i] * dx) / 3).toFixed(1)} ${(q.x - dx / 3).toFixed(1)},${(q.y - (tan[i + 1] * dx) / 3).toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`;
  }
  return d;
}

const SVG = "http://www.w3.org/2000/svg";
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

function chartBlock(r: UsageReport): HTMLElement {
  const box = el("div", "u-chart-block");
  box.append(el("h2", "u-h2", `${r.hourly ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "processed tokens"}`));
  const active = PROVIDERS.filter(({ id }) => r.providers.some((p) => p.provider === id && (p.tokens || p.cost)));
  const value = (i: number, p: UsageProvider) => {
    const cell = r.periods[i].byProvider[p];
    return cell ? (metric === "cost" ? cell.cost : cell.tokens) : 0;
  };
  // Each series measures from zero, so the scale tops out at the largest single provider-period.
  let peak = 0;
  r.periods.forEach((_, i) => active.forEach(({ id }) => (peak = Math.max(peak, value(i, id)))));
  const { max, ticks } = niceScale(peak);
  const n = r.periods.length;
  const stepX = n > 1 ? VIEW_W / (n - 1) : 0;
  const toY = (v: number) => (max === 0 ? VIEW_H : VIEW_H - (v / max) * (VIEW_H - PLOT_TOP));

  const wrap = el("div", "u-chart");
  const axis = el("div", "u-yaxis");
  for (const t of ticks) {
    const label = el("span", "u-tick", format(t));
    label.style.top = `${(toY(t) / VIEW_H) * 100}%`;
    axis.append(label);
  }
  const plot = el("div", "u-plot");
  const graph = svg("svg", { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, preserveAspectRatio: "none", class: "u-svg", role: "img", "aria-label": `${metric === "cost" ? "Cost" : "Tokens"} per ${r.hourly ? "hour" : "day"} by provider` });
  for (const t of ticks) graph.append(svg("line", { x1: 0, x2: VIEW_W, y1: toY(t), y2: toY(t), class: "u-grid" }));
  // Heavier series first, so a lighter one isn't buried under its wash.
  const totalOf = (p: UsageProvider) => r.periods.reduce((s, _, i) => s + value(i, p), 0);
  for (const { id } of [...active].sort((a, b) => totalOf(b.id) - totalOf(a.id))) {
    const line = curve(r.periods.map((_, i) => ({ x: i * stepX, y: toY(value(i, id)) })));
    graph.append(svg("path", { d: `${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`, class: `u-area series-${id}` }));
    graph.append(svg("path", { d: line, class: `u-line series-${id}` }));
  }
  const cross = el("div", "u-cross");
  const markers = active.map(({ id }) => {
    const m = el("span", `u-marker series-${id}`);
    plot.append(m);
    return { id, m };
  });
  const tip = el("div", "u-tip");
  plot.append(graph, cross, tip);
  const hide = () => plot.classList.remove("hover");
  plot.onpointerleave = hide;
  plot.onpointermove = (e) => {
    const rect = plot.getBoundingClientRect();
    if (!rect.width || !n) return;
    const x = Math.min(rect.width, Math.max(0, e.clientX - rect.left));
    const i = Math.round((x / rect.width) * (n - 1));
    const px = n > 1 ? (i / (n - 1)) * rect.width : rect.width / 2;
    plot.classList.add("hover");
    cross.style.left = `${px}px`;
    for (const { id, m } of markers) {
      m.style.left = `${px}px`;
      m.style.top = `${(toY(value(i, id)) / VIEW_H) * rect.height}px`;
    }
    tip.replaceChildren(el("div", "u-tip-head", periodLabel(r.periods[i].key, r.hourly)));
    let sum = 0;
    for (const { id, name } of active) {
      const v = value(i, id);
      sum += v;
      const row = el("div", "u-tip-row");
      const who = el("span", "u-tip-name");
      who.append(dot(id), name);
      row.append(who, el("span", "u-tip-value", format(v)));
      tip.append(row);
    }
    const foot = el("div", "u-tip-row u-tip-total");
    foot.append(el("span", "u-tip-name", "Total"), el("span", "u-tip-value", format(sum)));
    tip.append(foot);
    // Beside the pointer, flipped to stay inside the plot.
    const gap = 12;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const y = e.clientY - rect.top;
    tip.style.left = `${Math.max(0, Math.min(rect.width - w, x + gap + w <= rect.width ? x + gap : x - gap - w))}px`;
    tip.style.top = `${Math.max(0, Math.min(rect.height - h, y + gap + h <= rect.height ? y + gap : y - gap - h))}px`;
  };
  wrap.append(axis, plot);
  const xs = el("div", "u-xaxis");
  const pick = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0];
  for (const i of pick) xs.append(el("span", "", r.hourly && i === n - 1 ? "Now" : periodLabel(r.periods[i].key, r.hourly)));
  // Legend: identity never rests on color alone.
  const legend = el("div", "u-legend");
  for (const { id, name } of active) {
    const item = el("span", "u-legend-item");
    item.append(dot(id), name);
    legend.append(item);
  }
  box.append(wrap, xs, legend);
  return box;
}

// ---------------- totals, mix, breakdown ----------------

function totals(r: UsageReport): HTMLElement {
  const box = el("section", "u-section");
  box.append(el("h2", "u-h2", "Totals"));
  const grid = el("div", "u-metrics");
  for (const [label, value] of [
    ["Processed tokens", formatTokens(r.totalTokens)],
    ["Cached input", formatTokens(r.tokens.cacheRead)],
    ["Uncached input", formatTokens(r.tokens.input + r.tokens.cacheWrite)],
    ["Output", formatTokens(r.tokens.output)],
    ["Cache savings", formatUsd(r.cacheSavings)],
  ]) {
    const m = el("div", "u-metric");
    m.append(el("span", "u-metric-label", label), el("span", "u-metric-value", value));
    grid.append(m);
  }
  box.append(grid);
  return box;
}

/** Part-to-whole by token type (or cost by type): neutral steps, labeled in the legend, values on hover. */
function shareBar(r: UsageReport): HTMLElement {
  const segments =
    metric === "tokens"
      ? [
          { label: "Input", value: r.tokens.input, tone: 60 },
          { label: "Cache read", value: r.tokens.cacheRead, tone: 30 },
          { label: "Cache write", value: r.tokens.cacheWrite, tone: 72 },
          { label: "Output", value: r.tokens.output, tone: 100 },
        ]
      : [
          { label: "Input", value: r.costSplit.input, tone: 60 },
          { label: "Cache read", value: r.costSplit.cacheRead, tone: 30 },
          { label: "Cache write", value: r.costSplit.cacheWrite, tone: 72 },
          { label: "Output", value: r.costSplit.output, tone: 100 },
          // Reported cost with no rates to split it; under a cent is rounding.
          { label: "Other", value: r.costSplit.unsplit >= 0.005 ? r.costSplit.unsplit : 0, tone: 44 },
        ];
  const visible = segments.filter((s) => s.value > 0);
  const sum = visible.reduce((a, s) => a + s.value, 0);
  const box = el("section", "u-section");
  if (!sum) return box;
  const label = metric === "tokens" ? "Tokens by type" : "Cost by type";
  box.append(el("h2", "u-h2", label));
  const bar = el("div", "u-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${label}: ${visible.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`);
  const legend = el("div", "u-bar-legend");
  for (const s of visible) {
    const seg = el("span", "u-bar-seg");
    seg.style.flex = `${s.value} 1 0`;
    seg.style.setProperty("--tone", `${s.tone}%`);
    seg.title = `${s.label} · ${format(s.value)} · ${formatPercent(s.value / sum)}`;
    bar.append(seg);
    const item = el("span", "u-legend-item");
    const swatch = el("span", "u-swatch");
    swatch.style.setProperty("--tone", `${s.tone}%`);
    item.append(swatch, el("span", "u-muted", s.label), el("span", "u-num", format(s.value)));
    legend.append(item);
  }
  box.append(bar, legend);
  return box;
}

function breakdownBlock(r: UsageReport): HTMLElement {
  const box = el("section", "u-section");
  const head = el("div", "u-breakdown-head");
  head.append(
    el("h2", "u-h2", "Breakdown"),
    segmented(
      "Usage breakdown",
      [
        { value: "model", label: "Model" },
        { value: "time", label: r.hourly ? "Hour" : "Day" },
      ],
      breakdown,
      (v) => {
        breakdown = v as "model" | "time";
        paint();
      },
    ),
  );
  box.append(head, breakdown === "model" ? modelTable(r) : timeTable(r));
  return box;
}

function table(headers: { label: string; cls?: string }[], rows: HTMLElement[], empty: string): HTMLTableElement {
  const t = el("table", "u-table");
  const thead = el("thead");
  const tr = el("tr");
  for (const h of headers) tr.append(el("th", h.cls ?? "", h.label));
  thead.append(tr);
  const body = el("tbody");
  if (rows.length) body.append(...rows);
  else {
    const row = el("tr");
    const cell = el("td", "u-table-empty", empty);
    cell.colSpan = headers.length;
    row.append(cell);
    body.append(row);
  }
  t.append(thead, body);
  return t;
}

function modelTable(r: UsageReport): HTMLElement {
  const models = [...r.models].sort((a, b) => (metric === "tokens" ? b.tokens - a.tokens || b.cost - a.cost : b.cost - a.cost || b.tokens - a.tokens));
  const peak = models.reduce((m, x) => Math.max(m, metric === "tokens" ? x.tokens : x.cost), 0);
  const sum = metric === "tokens" ? r.totalTokens : r.cost;
  const rows = models.map((m, i) => {
    const tr = el("tr");
    const name = el("td", "u-model");
    const label = el("div", "u-model-name");
    label.append(harnessIcon(m.provider, 13, "u-prov-icon"), m.model);
    const v = metric === "tokens" ? m.tokens : m.cost;
    const meter = el("div", "u-model-bar");
    const fill = el("div", `series-${m.provider}`);
    // A short minimum keeps a tiny share a dash, not a dot.
    fill.style.width = v > 0 && peak > 0 ? `max(6px, ${(v / peak) * 100}%)` : "0";
    meter.append(fill);
    name.append(label, meter);
    const share = metric === "cost" && m.unpriced ? "" : sum ? formatPercent(v / sum) : "";
    tr.append(el("td", "u-rank", String(i + 1)), name, el("td", "u-num", m.unpriced ? "Unpriced" : formatUsd(m.cost)), el("td", "u-num u-share", share), el("td", "u-num", formatTokens(m.tokens)));
    if (m.unpriced) tr.children[2].classList.add("u-muted");
    return tr;
  });
  return table([{ label: "#", cls: "u-rank" }, { label: "Model", cls: "u-left" }, { label: "Cost" }, { label: "Share", cls: "u-share" }, { label: "Tokens" }], rows, "No activity in this window.");
}

function timeTable(r: UsageReport): HTMLElement {
  const active = PROVIDERS.filter(({ id }) => r.providers.some((p) => p.provider === id && (p.tokens || p.cost)));
  // Newest first: the interesting end of a 90-row window belongs at the top.
  const rows = [...r.periods]
    .reverse()
    .filter((p) => Object.keys(p.byProvider).length)
    .map((p) => {
      const tr = el("tr");
      tr.append(el("td", "u-left", periodLabel(p.key, r.hourly)));
      let cost = 0;
      let tokens = 0;
      for (const { id } of active) {
        const c = p.byProvider[id];
        cost += c?.cost ?? 0;
        tokens += c?.tokens ?? 0;
        tr.append(el("td", "u-num u-muted", metric === "cost" ? formatUsd(c?.cost ?? 0) : formatTokens(c?.tokens ?? 0)));
      }
      tr.append(el("td", "u-num", metric === "cost" ? formatUsd(cost) : formatTokens(tokens)), el("td", "u-num u-muted", metric === "cost" ? formatTokens(tokens) : formatUsd(cost)));
      return tr;
    });
  return table(
    [{ label: r.hourly ? "Hour" : "Day", cls: "u-left" }, ...active.map(({ name }) => ({ label: name })), { label: "Total" }, { label: metric === "cost" ? "Tokens" : "Cost" }],
    rows,
    "No activity in this window.",
  );
}

/** The loaded page's shape while the first report scans (a cold 90 days reads ~1 GB of transcripts). */
function skeleton(): HTMLElement {
  const box = el("div", "u-skeleton");
  const top = el("section", "u-top");
  const left = el("div", "u-summary");
  left.append(el("div", "sk sk-hero"), el("div", "sk sk-line"));
  for (let i = 0; i < 3; i++) left.append(el("div", "sk sk-row"));
  const right = el("div", "u-chart-block");
  right.append(el("div", "sk sk-line"), el("div", "sk sk-chart"));
  top.append(left, right);
  box.append(top, el("div", "sk sk-wide"), el("div", "sk sk-table"));
  return box;
}
