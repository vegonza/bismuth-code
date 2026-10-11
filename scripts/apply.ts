// bun run apply [--force]
// Validate the working tree and hot-swap the UI into every running bismuth app. Nothing in a running app changes unless
// every check passes:
//   1. typecheck (whole project)
//   2. the UI bundle builds
//   3. the new UI boots in headless Chromium against the live core, with a thread the core already has loaded open
//      (or none: opening another would resume it, which can stall or fail for reasons that aren't the UI's), without
//      throwing or logging errors, and sets window.__bismuthReady
// Exit codes: 0 applied / up to date · 1 change rejected (errors on stderr) · 3 core changed, restart the app to load it.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromeBin, openChrome } from "../core/chrome";
import * as ui from "../core/ui";

const force = process.argv.includes("--force");
const SMOKE_TIMEOUT_MS = 25_000;
const CALL_TIMEOUT_MS = 20_000;

function fail(title: string, detail = ""): never {
  console.error(`✗ ${title}${detail ? `\n\n${detail.trimEnd()}` : ""}`);
  process.exit(1);
}

// ---------------- running cores ----------------
function liveCores(): ui.CoreInfo[] {
  if (!existsSync(ui.CORES)) return [];
  const out: ui.CoreInfo[] = [];
  for (const name of readdirSync(ui.CORES)) {
    const file = join(ui.CORES, name);
    try {
      const info = JSON.parse(readFileSync(file, "utf8")) as ui.CoreInfo;
      process.kill(info.pid, 0);
      out.push(info);
    } catch {
      rmSync(file, { force: true }); // stale: that core is gone
    }
  }
  return out;
}

async function call<T>(core: ui.CoreInfo, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${core.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${core.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).catch((err) => {
    throw new Error(err?.name === "TimeoutError" ? `no answer within ${CALL_TIMEOUT_MS / 1000}s` : String(err?.message ?? err));
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---------------- smoke test ----------------
async function smoke(url: string): Promise<string[]> {
  if (!chromeBin()) return ["no Chromium/Chrome found for the smoke test (set CHROME=/path/to/browser)"];
  const chrome = await openChrome();
  if (!chrome) return ["could not start headless Chromium for the smoke test"];
  const errors: string[] = [];
  try {
    chrome.on((method, params) => {
      if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails;
        errors.push(`uncaught: ${d.exception?.description ?? d.text}`);
      } else if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        errors.push(`console.error: ${params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
      } else if (method === "Log.entryAdded" && params.entry.level === "error") {
        errors.push(`${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ""}`);
      }
    });
    const cdp = chrome.cdp;
    await cdp("Runtime.enable");
    await cdp("Log.enable");
    await cdp("Page.navigate", { url });

    const deadline = Date.now() + SMOKE_TIMEOUT_MS;
    let ready = false;
    while (!ready && !errors.length && Date.now() < deadline) {
      await Bun.sleep(100);
      ready = (await cdp("Runtime.evaluate", { expression: "window.__bismuthReady === true", returnByValue: true }))?.result?.value === true;
    }
    if (ready) await Bun.sleep(500); // let late async errors (first renders, follow-up messages) surface
    if (!ready && !errors.length) {
      const notice = (await cdp("Runtime.evaluate", { expression: "document.getElementById('notice')?.textContent ?? ''", returnByValue: true }))?.result?.value;
      errors.push(`UI never set window.__bismuthReady within ${SMOKE_TIMEOUT_MS / 1000}s${notice ? ` (notice shown: ${notice})` : ""}`);
    }
  } catch (err: any) {
    errors.push(String(err?.message ?? err));
  } finally {
    await chrome.close();
  }
  return errors;
}

// ---------------- main ----------------
// A core that doesn't answer (hung, or busy past the timeout) is left out rather than failing the whole apply: the
// others still get the build, and that app loads the latest UI on its next restart.
const found = liveCores();
const answers = await Promise.all(
  found.map((c) =>
    call<ui.CoreStatus>(c, "/_bismuth/status").catch((err) => {
      console.error(`! core ${c.pid} (port ${c.port}) did not answer — skipped: ${err.message}`);
      return null;
    }),
  ),
);
const cores = found.filter((_, i) => answers[i]);
const statuses = answers.filter((s): s is ui.CoreStatus => !!s);
if (found.length && !cores.length) fail("no running app answered — nothing applied", "Restart the app (it builds the current UI on start).");

const uiSource = ui.digest(ui.fingerprint(ui.UI_PATHS));
const coreNow = ui.fingerprint(ui.CORE_PATHS);
// Cores started at different times may differ; report against the union.
const coreChanged = [...new Set(statuses.flatMap((s) => ui.changed(s.core, coreNow)))].sort();
const uiChanged = force || !statuses.length || statuses.some((s) => s.build?.source !== uiSource);

if (statuses.length && !uiChanged && !coreChanged.length) {
  console.log("✓ up to date — nothing to apply");
  process.exit(0);
}

const tsc = Bun.spawnSync([join(ui.ROOT, "node_modules", ".bin", "tsc"), "--noEmit", "--pretty", "false"], { cwd: ui.ROOT });
if (tsc.exitCode !== 0) fail("typecheck failed — nothing applied", tsc.stdout.toString() + tsc.stderr.toString());
console.log("✓ typecheck");

// shared/ is the protocol between core and UI: a UI built against a new protocol can't safely talk to an old core.
const protocolChanged = coreChanged.filter((p) => p.startsWith("shared/"));
/** Tell the running apps a restart is needed (an older core without the endpoint just doesn't show it). */
const needRestart = (files: string[]) => Promise.all(cores.map((c) => call(c, "/_bismuth/restart-needed", { files }).catch(() => {})));

if (protocolChanged.length) {
  await needRestart(coreChanged);
  console.error(`! core⇄UI protocol changed (${protocolChanged.join(", ")}): restart the app — it builds and loads this UI on start; nothing hot-applied`);
  process.exit(3);
}

if (uiChanged) {
  const res = await ui.buildUI();
  if (!res.ok) fail("UI build failed — nothing applied", res.error);
  const { id } = res.meta;
  console.log(`✓ build ${id}`);

  if (!cores.length) {
    ui.removeBuild(id);
    console.log("· no running app — validated typecheck and build only (no smoke test)");
  } else {
    const [core, status] = [cores[0], statuses[0]];
    // Only a thread this core already has loaded (e.g. the conversation that's editing the app): opening it has no side effects.
    const recent = status.threads.find((t) => t.loaded)?.id;
    const errors = await smoke(`http://127.0.0.1:${core.port}/_bismuth/preview/${id}/${recent ? `#${encodeURIComponent(recent)}` : ""}`);
    if (errors.length) {
      ui.removeBuild(id);
      fail("smoke test failed — nothing applied", errors.map((e) => `  ${e}`).join("\n"));
    }
    console.log(`✓ smoke test${recent ? ` (opened thread ${recent})` : ""}`);

    let reloaded = 0;
    for (const c of cores) {
      const r = await call<{ reloaded: number }>(c, "/_bismuth/activate", { id }).catch((err) => fail(`core ${c.pid} refused the build`, String(err)));
      reloaded += r.reloaded;
    }
    console.log(`✓ applied to ${cores.length} app${cores.length > 1 ? "s" : ""} (${reloaded} window${reloaded === 1 ? "" : "s"} reloaded)`);
  }
}

if (coreChanged.length && cores.length) {
  await needRestart(coreChanged);
  console.error(`! core changed (${coreChanged.join(", ")}): restart the app to load it`);
  process.exit(3);
}
