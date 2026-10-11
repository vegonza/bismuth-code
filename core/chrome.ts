// Headless Chromium driven over the DevTools protocol: `bun run apply`'s smoke test of a new UI build, and the
// screenshots of views that go back to the agent that rendered them (views.ts). One browser per use, with a
// throwaway profile, closed after.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Chrome = {
  /** A DevTools call; its result (undefined if it failed), or a throw once `ms` pass without an answer. */
  cdp(method: string, params?: object, ms?: number): Promise<any>;
  /** DevTools events: Runtime.exceptionThrown, Log.entryAdded… */
  on(fn: (method: string, params: any) => void): void;
  close(): Promise<void>;
};

export const chromeBin = (): string | undefined =>
  process.env.CHROME ?? ["chromium", "google-chrome-stable", "google-chrome", "chromium-browser"].map((b) => Bun.which(b)).find((b): b is string => !!b);

/** A headless browser with one blank page to drive; null if there's no Chromium or it didn't start. */
export async function openChrome(): Promise<Chrome | null> {
  const bin = chromeBin();
  if (!bin) return null;
  const profile = mkdtempSync(join(tmpdir(), "bismuth-chrome-"));
  const proc = Bun.spawn([bin, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const close = async () => {
    proc.kill();
    await proc.exited;
    rmSync(profile, { recursive: true, force: true });
  };
  // Chrome writes the port it picked to DevToolsActivePort.
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 100 && !target; i++) {
    await Bun.sleep(100);
    const portFile = join(profile, "DevToolsActivePort");
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    target = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json() as Promise<any[]>)
      .then((list) => list.find((t) => t.type === "page"))
      .catch(() => undefined);
  }
  if (!target) {
    await close();
    return null;
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  } catch {
    await close();
    return null;
  }
  let seq = 0;
  const waiting = new Map<number, (v: any) => void>();
  const listeners: ((method: string, params: any) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) return waiting.get(m.id)?.(m.result);
    for (const fn of listeners) fn(m.method, m.params);
  };
  return {
    cdp: (method, params = {}, ms = 15_000) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => (waiting.delete(id), reject(new Error(`${method}: no answer within ${ms / 1000}s`))), ms);
        waiting.set(id, (v) => (clearTimeout(timer), waiting.delete(id), resolve(v)));
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on: (fn) => void listeners.push(fn),
    close: async () => {
      ws.close();
      await close();
    },
  };
}
