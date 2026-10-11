// Real-time screenshot via Chrome DevTools Protocol: bun scripts/shot.ts <url> <out.png> [waitMs] [width] [height] [clickSelector]
// SCALE=1.25 sets the device scale factor; EVAL="js" runs in the page before capture (after any click);
// MOUSE="x,y" hovers that CSS-pixel point last.
const [url, out, waitMs = "3000", w = "1300", h = "850", click] = process.argv.slice(2);
const port = 9333;
const chrome = Bun.spawn(["chromium", "--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/bismuth-cdp", `--window-size=${w},${h}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
try {
  let target: any;
  for (let i = 0; i < 50 && !target; i++) {
    await Bun.sleep(100);
    target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l: any[]) => l.find((t) => t.type === "page")).catch(() => null);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); waiting.get(m.id)?.(m.result); };
  const cdp = (method: string, params = {}) => new Promise<any>((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cdp("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: +(process.env.SCALE ?? 1), mobile: false });
  await cdp("Page.navigate", { url });
  await Bun.sleep(+waitMs);
  if (click) { await cdp("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(click)})?.click()` }); await Bun.sleep(400); }
  if (process.env.EVAL) { const r = await cdp("Runtime.evaluate", { expression: process.env.EVAL, awaitPromise: true, returnByValue: true }); if (r?.result?.value !== undefined) console.log(JSON.stringify(r.result.value)); await Bun.sleep(500); }
  if (process.env.MOUSE) { const [x, y] = process.env.MOUSE.split(",").map(Number); await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await Bun.sleep(400); }
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(out, Buffer.from(data, "base64"));
  console.log("wrote", out);
} finally {
  chrome.kill();
}

export {};
