// Drive the UI in headless Chromium like a user, for checking changes: bun scripts/drive.ts <url> <steps.json>
// steps: [{ "wait": ms } | { "eval": "js" } | { "init": "js run on every new document" } | { "reload": true } | { "type": "text" } | { "key": "Enter" or "a", "shift"?: true, "ctrl"?: true, "alt"?: true }
//         | { "move": [x, y] } | { "click": [x, y] } | { "drag": [x1, y1, x2, y2] } | { "wheel": [x, y, dy, dx?] } | { "shot": "/tmp/x.png", "clip"?: [x, y, w, h] }]
//         | { "tap": [x, y] } | { "profile": "start" } | { "profile": "/tmp/x.cpuprofile" } (CPU profile from start to here)
//         | { "frames": "/tmp/f-%03d.png", "count": 20, "clip"?: [x, y, w, h], "scale"?: 1 } (a burst of screenshots)
//         | { "cdp": "Animation.setPlaybackRate", "params": { "playbackRate": 0.25 } } (any DevTools protocol call)
// Coordinates are CSS pixels. `eval` results are printed. SCALE / W / H env vars set the viewport; MOBILE=1 makes it
// a phone (touch, mobile viewport and user agent; default 390×844 at 3×).
export {};
const [url, stepsFile] = process.argv.slice(2);
const steps: any[] = JSON.parse(await Bun.file(stepsFile).text());
const mobile = process.env.MOBILE === "1";
const scale = +(process.env.SCALE ?? (mobile ? 3 : 1.25));
const w = +(process.env.W ?? (mobile ? 390 : 1536));
const h = +(process.env.H ?? (mobile ? 844 : 838));
// A port of its own (Chromium picks a free one and writes it in the profile), so runs side by side don't meet.
const profile = `/tmp/bismuth-drive-${Date.now()}-${process.pid}`;
const chrome = Bun.spawn(["chromium", "--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
try {
  let target: any;
  for (let i = 0; i < 50 && !target; i++) {
    await Bun.sleep(100);
    const port = (await Bun.file(`${profile}/DevToolsActivePort`).text().catch(() => "")).split("\n")[0];
    if (port) target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l: any[]) => l.find((t) => t.type === "page")).catch(() => null);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Runtime.exceptionThrown") console.log("PAGE EXCEPTION:", m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") console.log("console.error:", m.params.args.map((a: any) => a.value ?? a.description).join(" "));
    waiting.get(m.id)?.(m.result ?? m.error);
  };
  const cdp = (method: string, params = {}) => new Promise<any>((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile });
  if (mobile) {
    await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
    await cdp("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" });
  }
  await cdp("Page.navigate", { url });
  await Bun.sleep(2500);
  for (const s of steps) {
    if (s.wait) await Bun.sleep(s.wait);
    else if (s.init) await cdp("Page.addScriptToEvaluateOnNewDocument", { source: s.init });
    else if (s.reload) {
      await cdp("Page.reload");
      await Bun.sleep(2500);
    } else if (s.eval) {
      const r = await cdp("Runtime.evaluate", { expression: s.eval, awaitPromise: true, returnByValue: true });
      if (r?.exceptionDetails) console.log("EVAL ERROR:", r.exceptionDetails.exception?.description);
      else if (r?.result?.value !== undefined) console.log(JSON.stringify(r.result.value));
      else console.log("EVAL:", JSON.stringify(r).slice(0, 300));
    } else if (s.type !== undefined) await cdp("Input.insertText", { text: s.type });
    else if (s.key) {
      const mods = (s.shift ? 8 : 0) | (s.ctrl ? 2 : 0) | (s.alt ? 1 : 0);
      const letter = /^[a-z]$/i.test(s.key);
      const digit = /^\d$/.test(s.key);
      const named: Record<string, number> = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 };
      const code = named[s.key] ?? (letter ? s.key.toUpperCase().charCodeAt(0) : digit ? 48 + Number(s.key) : 0);
      const plain = !s.ctrl && !s.alt;
      const base = { key: s.key, code: letter ? `Key${s.key.toUpperCase()}` : digit ? `Digit${s.key}` : s.key, windowsVirtualKeyCode: code, modifiers: mods, ...(s.key === "Enter" && !s.shift && plain ? { text: "\r" } : s.key.length === 1 && plain ? { text: s.key } : {}) };
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    } else if (s.move) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.move[0], y: s.move[1] });
    else if (s.click) {
      const [x, y] = s.click;
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } else if (s.tap) {
      const [x, y] = s.tap;
      await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else if (s.drag) {
      const [x1, y1, x2, y2] = s.drag;
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / 10, y: y1 + ((y2 - y1) * i) / 10, button: "left", buttons: 1 });
        await Bun.sleep(16);
      }
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
    } else if (s.frames) {
      // A burst of screenshots for an animation: `count` of them, as fast as they come, numbered from 0.
      const clip = s.clip ? { x: s.clip[0], y: s.clip[1], width: s.clip[2], height: s.clip[3], scale: s.scale ?? 1 } : undefined;
      for (let i = 0; i < (s.count ?? 20); i++) {
        const { data } = await cdp("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
        await Bun.write(s.frames.replace("%03d", String(i).padStart(3, "0")), Buffer.from(data, "base64"));
      }
      console.log("frames", s.frames);
    } else if (s.cdp) {
      const r = await cdp(s.cdp, s.params ?? {});
      if (r?.code) console.log("CDP ERROR:", JSON.stringify(r));
    } else if (s.profile === "start") {
      await cdp("Profiler.enable");
      await cdp("Profiler.setSamplingInterval", { interval: 200 });
      await cdp("Profiler.start");
    } else if (s.profile) {
      const { profile } = await cdp("Profiler.stop");
      await Bun.write(s.profile, JSON.stringify(profile));
      console.log("profile", s.profile);
    } else if (s.wheel) await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: s.wheel[0], y: s.wheel[1], deltaX: s.wheel[3] ?? 0, deltaY: s.wheel[2] });
    else if (s.shot) {
      const clip = s.clip ? { x: s.clip[0], y: s.clip[1], width: s.clip[2], height: s.clip[3], scale: 1 } : undefined;
      const { data } = await cdp("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
      await Bun.write(s.shot, Buffer.from(data, "base64"));
      console.log("shot", s.shot);
    }
  }
} finally {
  chrome.kill();
}
