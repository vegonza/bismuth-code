// Token usage across the subscriptions (t3code's Usage page, apps/server/src/usage): every Claude Code and Codex
// transcript on this machine, plus Cursor's account history, priced against LiteLLM's public rate table.
// Runs in a Worker: a cold 90-day window is ~1 GB of JSONL, which must not stall the core's event loop.
//
// - Transcripts are append-only, so each file remembers where its last parse stopped (and the Codex reducer's
//   state there): a warm scan reads only appended bytes. A file that shrank or was rewritten is parsed again.
// - Claude Code writes one record per content block, each repeating the message's full `usage`: records are
//   de-duplicated by message/request id, first seen wins (ccusage's rule).
// - Codex `token_count` events carry deltas (`last_token_usage`) but no model: the model and service tier come
//   from the latest `turn_context` / `thread_settings_applied`. Forked rollouts open with a burst of copied
//   parent history, dropped by timing (the copy lands within a second of the fork's session_meta).
// - Cursor keeps no local usage: its dashboard's per-request events (tokens + billed cents) are read with the
//   `cursor-agent` CLI login, as t3code does. The SDK's key can't open that dashboard.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { UsageModelRow, UsageProvider, UsageReport, UsageTokens } from "../shared/model";

declare const self: Worker;

type Speed = "standard" | "fast" | "ultrafast";
type Rec = { provider: UsageProvider; t: number; model: string; rateModel?: string; session: string; tokens: UsageTokens; cost: number | null; speed: Speed; key: string | null };
type CodexState = { model: string; speed: Speed; session: string; last: string | null; sawMeta: boolean; forkCopies: boolean; forkAnchor: number };
type FileState = { size: number; mtime: number; offset: number; records: Rec[]; codex: CodexState | null };

const CHUNK = 4 * 1024 * 1024;
const FORK_COPY_MAX_GAP_MS = 1000;
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const RATES_MAX_AGE_MS = 24 * 3600_000;
const CURSOR_CACHE_MS = 60_000;

let stateDir = "";
const files = new Map<string, FileState>();

// ---------------- transcripts ----------------

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
const time = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
const total = (k: UsageTokens) => k.input + k.cacheRead + k.cacheWrite + k.output;

function parseClaude(line: string): Rec | null {
  if (!line.includes('"usage"')) return null;
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (r?.type !== "assistant" || !r.message?.usage) return null;
  const t = time(r.timestamp);
  const model = r.message.model;
  if (!Number.isFinite(t) || typeof model !== "string" || !model) return null;
  const u = r.message.usage;
  const id = typeof r.message.id === "string" ? r.message.id : null;
  const req = typeof r.requestId === "string" ? r.requestId : null;
  return {
    provider: "claude",
    t,
    model,
    session: typeof r.sessionId === "string" ? r.sessionId : "",
    tokens: { input: int(u.input_tokens), cacheRead: int(u.cache_read_input_tokens), cacheWrite: int(u.cache_creation_input_tokens), output: int(u.output_tokens), reasoning: 0 },
    cost: typeof r.costUSD === "number" && Number.isFinite(r.costUSD) ? r.costUSD : null,
    speed: u.speed === "fast" ? "fast" : "standard",
    key: id === null && req === null ? null : `${id ?? ""}:${req ?? ""}`,
  };
}

const newCodexState = (): CodexState => ({ model: "", speed: "standard", session: "", last: null, sawMeta: false, forkCopies: false, forkAnchor: 0 });
const codexSpeed = (tier: unknown): Speed => (tier === "priority" || tier === "fast" ? "fast" : tier === "ultrafast" ? "ultrafast" : "standard");

function parseCodex(line: string, s: CodexState): Rec | null {
  // Only these lines move the reducer or carry usage.
  if (!line.includes('"token_count"') && !line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) return null;
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  const p = r?.payload;
  if (!p || typeof p !== "object") return null;
  if (r.type === "session_meta") {
    // Only the first meta is this file's own session; a fork repeats its ancestors' after it.
    if (s.sawMeta) return null;
    s.sawMeta = true;
    const id = p.id ?? p.session_id;
    if (typeof id === "string") s.session = id;
    const t = time(r.timestamp);
    if (Number.isFinite(t) && (typeof p.forked_from_id === "string" || typeof p.source?.subagent?.thread_spawn?.parent_thread_id === "string")) {
      s.forkCopies = true;
      s.forkAnchor = t;
    }
    return null;
  }
  if (r.type === "turn_context") {
    if (typeof p.model === "string") s.model = p.model;
    return null;
  }
  if (p.type === "thread_settings_applied") {
    if (p.thread_settings && typeof p.thread_settings === "object") s.speed = codexSpeed(p.thread_settings.service_tier);
    return null;
  }
  if (p.type !== "token_count") return null;
  const last = p.info?.last_token_usage;
  if (!last || typeof last !== "object") return null;
  const t = time(r.timestamp);
  if (!Number.isFinite(t) || !s.model) return null;
  // Codex re-emits an unchanged token_count on some stream boundaries.
  const sig = JSON.stringify(last);
  if (sig === s.last) return null;
  s.last = sig;
  if (s.forkCopies) {
    if (t - s.forkAnchor < FORK_COPY_MAX_GAP_MS) {
      s.forkAnchor = t;
      return null;
    }
    s.forkCopies = false;
  }
  const cached = int(last.cached_input_tokens);
  const write = int(last.cache_write_input_tokens);
  const output = int(last.output_tokens);
  // `input_tokens` includes the cached part.
  const tokens = { input: Math.max(0, int(last.input_tokens) - cached - write), cacheRead: cached, cacheWrite: write, output, reasoning: Math.min(output, int(last.reasoning_output_tokens)) };
  if (!total(tokens)) return null;
  return { provider: "codex", t, model: s.model, session: s.session, tokens, cost: null, speed: s.speed, key: null };
}

/** Parse a transcript from its last stopping point, in chunks; only newline-terminated lines are consumed. */
function scanFile(path: string, provider: "claude" | "codex", size: number, mtime: number): FileState {
  let st = files.get(path);
  if (st && st.size === size && st.mtime === mtime) return st;
  if (!st || size < st.offset) st = { size: 0, mtime: 0, offset: 0, records: [], codex: provider === "codex" ? newCodexState() : null };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return st;
  }
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = st.offset;
  // Bytes after the last newline so far: the start of a line the next chunk finishes.
  let carry: Buffer = Buffer.alloc(0);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const bytes = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const cut = bytes.lastIndexOf(0x0a);
      if (cut < 0) {
        carry = Buffer.from(bytes);
        continue;
      }
      carry = Buffer.from(bytes.subarray(cut + 1));
      for (const line of bytes.toString("utf8", 0, cut).split("\n")) {
        const rec = provider === "claude" ? parseClaude(line) : parseCodex(line, st.codex!);
        if (rec) st.records.push(rec);
      }
    }
  } finally {
    closeSync(fd);
  }
  // The unterminated tail is re-read next time, once the writer finishes the line.
  st.offset = pos - carry.length;
  st.size = size;
  st.mtime = mtime;
  files.set(path, st);
  return st;
}

function listJsonl(root: string, since: number, out: { path: string; size: number; mtime: number }[]) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(root, e.name);
    if (e.isDirectory()) listJsonl(path, since, out);
    else if (e.name.endsWith(".jsonl"))
      try {
        const s = statSync(path);
        if (s.mtimeMs >= since) out.push({ path, size: s.size, mtime: s.mtimeMs });
      } catch {}
  }
}

function transcriptRecords(since: number): Rec[] {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const out: Rec[] = [];
  for (const [provider, roots] of [
    ["claude", [join(claudeHome, "projects")]],
    // Archiving moves a rollout; its usage still happened.
    ["codex", [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]],
  ] as const) {
    const found: { path: string; size: number; mtime: number }[] = [];
    for (const root of roots) listJsonl(root, since, found);
    // Stable order: first-seen dedupe must not depend on directory listing order.
    found.sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const f of found) for (const r of scanFile(f.path, provider, f.size, f.mtime).records) if (r.t >= since) out.push(r);
  }
  return out;
}

// ---------------- Cursor ----------------

let cursorCache: { since: number; at: number; records: Rec[]; note: string | null } | null = null;

/** Cursor's tiered names (`claude-sonnet-5-5-xhigh`, `cursor-grok-4.6-high-fast`) to their base model's rate key. */
function cursorRateModel(model: string) {
  const base = model.replace(/^cursor-/, "").replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  return base.startsWith("grok-") ? `xai/${base}` : base;
}

/** Longest suffix of `prev` equal to a prefix of `cur`: pages can overlap when events land mid-pagination. */
function overlap(prev: string[], cur: string[]) {
  const seq = [...cur, "", ...prev];
  const len = new Array(seq.length).fill(0);
  for (let i = 1; i < seq.length; i++) {
    let k = len[i - 1];
    while (k > 0 && seq[i] !== seq[k]) k = len[k - 1];
    if (seq[i] === seq[k]) k++;
    len[i] = k;
  }
  return len.at(-1) ?? 0;
}

async function cursorRecords(since: number, until: number): Promise<{ records: Rec[]; note: string | null }> {
  if (cursorCache && cursorCache.since <= since && Date.now() - cursorCache.at < CURSOR_CACHE_MS)
    return { records: cursorCache.records.filter((r) => r.t >= since), note: cursorCache.note };
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const authPath = join(config, "cursor", "auth.json");
  if (!existsSync(authPath)) return { records: [], note: null };
  const done = (records: Rec[], note: string | null) => {
    cursorCache = { since, at: Date.now(), records, note };
    return { records, note };
  };
  try {
    const token = JSON.parse(readFileSync(authPath, "utf8"))?.accessToken;
    if (typeof token !== "string" || !token) return done([], null);
    const sub = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())?.sub;
    const userId = typeof sub === "string" ? sub.split("|").at(-1) : null;
    if (!userId) return done([], "Cursor's login couldn't be read; sign in with “cursor-agent login”.");
    const pages: any[][] = [];
    let count: number | undefined;
    for (let page = 1; page <= 200; page++) {
      const res = await fetch("https://cursor.com/api/dashboard/get-filtered-usage-events", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", Origin: "https://cursor.com", Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}` },
        body: JSON.stringify({ page, pageSize: 1000, startDate: String(since), endDate: String(until) }),
      });
      if (res.status === 401 || res.status === 403) return done([], "Sign in to Cursor again (“cursor-agent login”) to read its usage.");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      const events: any[] = Array.isArray(body?.usageEventsDisplay) ? body.usageEventsDisplay : [];
      if (typeof body?.totalUsageEventsCount === "number") count = body.totalUsageEventsCount;
      pages.push(events);
      if (events.length < 1000) break;
    }
    let extra = count === undefined ? 0 : Math.max(0, pages.reduce((n, p) => n + p.length, 0) - count);
    const records: Rec[] = [];
    const seen = new Map<string, number>();
    let prevKeys: string[] = [];
    for (const events of pages) {
      const keys = extra > 0 ? events.map((e) => JSON.stringify(e)) : [];
      const drop = Math.min(extra, overlap(prevKeys, keys));
      extra -= drop;
      prevKeys = keys;
      for (const e of events.slice(drop)) {
        const u = e?.tokenUsage;
        if (!u) continue;
        const t = Number(e.timestamp);
        if (!Number.isFinite(t) || t < since || t > until || typeof e.model !== "string") continue;
        const tokens = { input: int(u.inputTokens), cacheRead: int(u.cacheReadTokens), cacheWrite: int(u.cacheWriteTokens), output: int(u.outputTokens), reasoning: 0 };
        const cost = typeof u.totalCents === "number" ? u.totalCents / 100 : null;
        const session = typeof e.conversationId === "string" ? e.conversationId : "";
        // No event id: identical billed rows stay distinct by occurrence.
        const k = createHash("sha256").update(JSON.stringify([t, e.model, session, tokens, cost])).digest("hex").slice(0, 24);
        const n = seen.get(k) ?? 0;
        seen.set(k, n + 1);
        records.push({ provider: "cursor", t, model: e.model, rateModel: cursorRateModel(e.model), session, tokens, cost, speed: "standard", key: `cursor:${k}:${n}` });
      }
    }
    return done(records, null);
  } catch (err: any) {
    console.warn("[usage] cursor:", err?.message ?? err);
    return done([], "Cursor's account usage couldn't be read right now.");
  }
}

// ---------------- pricing ----------------

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
type ModelRate = Rates & { fast: Rates | null; ultrafast: Rates | null };
let rateTable: Map<string, ModelRate> | null = null;
let rateTableAt = 0;
const resolved = new Map<string, ModelRate | null>();

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readRates(entry: any, suffix: string, standard?: Rates): Rates | null {
  const input = num(entry[`input_cost_per_token${suffix}`]);
  const output = num(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  // A tier without cache rates keeps the standard tier's cache-to-input ratio (or prices cache as input).
  const cache = (name: string, field: "cacheRead" | "cacheWrite") =>
    num(entry[`${name}${suffix}`]) ?? (standard && standard.input > 0 ? (standard[field] / standard.input) * input : input);
  return { input, output, cacheRead: cache("cache_read_input_token_cost", "cacheRead"), cacheWrite: cache("cache_creation_input_token_cost", "cacheWrite") };
}

const scale = (r: Rates, k: number): Rates => ({ input: r.input * k, output: r.output * k, cacheRead: r.cacheRead * k, cacheWrite: r.cacheWrite * k });
const sameRates = (a: Rates | null, b: Rates | null) => (a === null || b === null ? a === b : a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite);

function buildRateTable(doc: any): Map<string, ModelRate> {
  const table = new Map<string, ModelRate>();
  for (const [name, entry] of Object.entries<any>(doc ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const standard = readRates(entry, "");
    if (!standard) continue;
    const fastMultiple = num(entry.provider_specific_entry?.fast);
    table.set(name.trim().toLowerCase(), {
      ...standard,
      fast: fastMultiple && fastMultiple > 0 ? scale(standard, fastMultiple) : readRates(entry, "_priority", standard),
      ultrafast: readRates(entry, "_ultrafast", standard),
    });
  }
  // A bare name ("gpt-5.5" for "openai/gpt-5.5") aliases only when every qualified entry agrees on its rates.
  const aliases = new Map<string, ModelRate | null>();
  for (const [key, rate] of table) {
    const bare = key.slice(key.lastIndexOf("/") + 1);
    if (!bare || bare === key || table.has(bare)) continue;
    const held = aliases.get(bare);
    if (held === undefined) aliases.set(bare, rate);
    else if (held && !(sameRates(held, rate) && sameRates(held.fast, rate.fast) && sameRates(held.ultrafast, rate.ultrafast))) aliases.set(bare, null);
  }
  for (const [bare, rate] of aliases) if (rate) table.set(bare, rate);
  return table;
}

/** LiteLLM's table: refreshed daily, kept on disk so pricing survives offline starts. */
async function rates(): Promise<{ table: Map<string, ModelRate>; note: string | null }> {
  if (rateTable && Date.now() - rateTableAt < RATES_MAX_AGE_MS) return { table: rateTable, note: null };
  const cache = join(stateDir, "litellm-prices.json");
  let doc: any = null;
  let fresh = false;
  try {
    const s = statSync(cache);
    if (Date.now() - s.mtimeMs < RATES_MAX_AGE_MS) {
      doc = JSON.parse(readFileSync(cache, "utf8"));
      fresh = true;
    }
  } catch {}
  if (!fresh)
    try {
      const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      doc = JSON.parse(text);
      writeFileSync(cache, text);
    } catch (err: any) {
      console.warn("[usage] rate table:", err?.message ?? err);
      try {
        doc = JSON.parse(readFileSync(cache, "utf8"));
      } catch {}
    }
  if (!doc) return { table: rateTable ?? new Map(), note: "Model prices couldn't be loaded, so costs only include what providers report." };
  rateTable = buildRateTable(doc);
  rateTableAt = Date.now();
  resolved.clear();
  return { table: rateTable, note: null };
}

/** Never priced: locally generated messages, and bare family names that span generations. */
const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);

function lookup(table: Map<string, ModelRate>, model: string): ModelRate | null {
  let rate = resolved.get(model);
  if (rate !== undefined) return rate;
  // `claude-fable-5-1[1m]` prices as its base tier.
  let key = model.trim().toLowerCase();
  if (key.includes("[")) key = key.slice(0, key.indexOf("["));
  const bare = key.slice(key.lastIndexOf("/") + 1);
  rate = !bare || UNPRICEABLE.has(bare) ? null : (table.get(key) ?? null);
  resolved.set(model, rate);
  return rate;
}

type Priced = { cost: number; split: { input: number; cacheRead: number; cacheWrite: number; output: number } | null; savings: number; priced: boolean };

/** A provider-reported cost is kept as is (split by the list rates when known); otherwise the list price. */
function price(table: Map<string, ModelRate>, r: Rec): Priced {
  const rate = lookup(table, r.rateModel ?? r.model);
  if (!rate) return { cost: r.cost ?? 0, split: null, savings: 0, priced: r.cost !== null };
  const at = (r.speed === "standard" ? null : rate[r.speed]) ?? rate;
  const list = { input: r.tokens.input * at.input, cacheRead: r.tokens.cacheRead * at.cacheRead, cacheWrite: r.tokens.cacheWrite * at.cacheWrite, output: r.tokens.output * at.output };
  const listCost = list.input + list.cacheRead + list.cacheWrite + list.output;
  const savings = r.tokens.cacheRead * (at.input - at.cacheRead);
  if (r.cost !== null && listCost <= 0) return { cost: r.cost, split: null, savings, priced: true };
  const k = r.cost === null ? 1 : r.cost / listCost;
  return { cost: r.cost ?? listCost, split: { input: list.input * k, cacheRead: list.cacheRead * k, cacheWrite: list.cacheWrite * k, output: list.output * k }, savings, priced: true };
}

// ---------------- the report ----------------

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hourStart = (t: number) => {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

const emptyTokens = (): UsageTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
function addTokens(into: UsageTokens, k: UsageTokens) {
  into.input += k.input;
  into.cacheRead += k.cacheRead;
  into.cacheWrite += k.cacheWrite;
  into.output += k.output;
  into.reasoning += k.reasoning;
}

async function report(days: number): Promise<UsageReport> {
  const now = Date.now();
  const hourly = days === 1;
  // Past 24h: the last 24 hour buckets. Otherwise whole local days, today included.
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const since = hourly ? hourStart(now) - 23 * 3600_000 : start.getTime();
  const periods: string[] = [];
  if (hourly) for (let t = since; t <= now; t += 3600_000) periods.push(String(t));
  else for (const d = new Date(since); d.getTime() <= now; d.setDate(d.getDate() + 1)) periods.push(dayKey(d.getTime()));

  const [{ table, note: priceNote }, cursor] = await Promise.all([rates(), cursorRecords(since, now)]);
  const records = [...transcriptRecords(since), ...cursor.records];

  const tokens = emptyTokens();
  const split = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 };
  let cost = 0;
  let savings = 0;
  let unpricedTokens = 0;
  const sessions = new Set<string>();
  const providers = new Map<UsageProvider, { tokens: number; cost: number; sessions: Set<string> }>();
  const series = new Map<string, Partial<Record<UsageProvider, { tokens: number; cost: number }>>>();
  const models = new Map<string, UsageModelRow & { unpricedTokens: number }>();
  const seen = new Set<string>();
  for (const r of records) {
    if (r.key) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
    }
    const n = total(r.tokens);
    const p = price(table, r);
    addTokens(tokens, r.tokens);
    cost += p.cost;
    savings += p.savings;
    if (p.split) {
      split.input += p.split.input;
      split.cacheRead += p.split.cacheRead;
      split.cacheWrite += p.split.cacheWrite;
      split.output += p.split.output;
    } else split.unsplit += p.cost;
    if (!p.priced) unpricedTokens += n;
    const sessionKey = `${r.provider}:${r.session}`;
    if (r.session) sessions.add(sessionKey);
    const prov = providers.get(r.provider) ?? { tokens: 0, cost: 0, sessions: new Set() };
    prov.tokens += n;
    prov.cost += p.cost;
    if (r.session) prov.sessions.add(sessionKey);
    providers.set(r.provider, prov);
    const period = hourly ? String(hourStart(r.t)) : dayKey(r.t);
    const bucket = series.get(period) ?? {};
    const cell = (bucket[r.provider] ??= { tokens: 0, cost: 0 });
    cell.tokens += n;
    cell.cost += p.cost;
    series.set(period, bucket);
    const mk = `${r.provider}:${r.model}`;
    const m = models.get(mk) ?? { provider: r.provider, model: r.model, tokens: 0, cost: 0, unpriced: false, unpricedTokens: 0 };
    m.tokens += n;
    m.cost += p.cost;
    if (!p.priced) m.unpricedTokens += n;
    models.set(mk, m);
  }
  const totalTokens = total(tokens);
  return {
    days,
    since,
    until: now,
    hourly,
    totalTokens,
    tokens,
    cost,
    costSplit: split,
    cacheSavings: savings,
    unpricedShare: totalTokens ? unpricedTokens / totalTokens : 0,
    sessions: sessions.size,
    providers: [...providers].map(([provider, p]) => ({ provider, tokens: p.tokens, cost: p.cost, sessions: p.sessions.size })),
    periods: periods.map((key) => ({ key, byProvider: series.get(key) ?? {} })),
    // A model counts as unpriced only when none of its tokens could be priced.
    models: [...models.values()].map(({ unpricedTokens: u, ...m }) => ({ ...m, unpriced: u > 0 && u === m.tokens })),
    notes: [priceNote, cursor.note].filter((n): n is string => !!n),
  };
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "init") {
    stateDir = msg.stateDir;
    return;
  }
  if (msg.type !== "report") return;
  try {
    self.postMessage({ id: msg.id, report: await report(msg.days) });
  } catch (err: any) {
    self.postMessage({ id: msg.id, error: String(err?.stack ?? err?.message ?? err) });
  }
};
