// Views: an agent shows UI inline in the conversation, built with the project's own frontend. bismuth serves an MCP
// server of its own (`bismuth-preview`, passed to every run like servers carried over: see mcp.ts) whose `render` tool takes
// a view's source. The project builds it: `.bismuth/view/build <view-file> <out.html>`, a script the project keeps
// (an agent writes it the first time, from the setup this hands back, starting from view-templates/), writes one
// self-contained page, or fails with errors that go back to the agent and nothing is shown. bismuth adds the script
// that sizes the page's frame and passes its theme, stores the page, and serves it to a sandboxed frame in the
// transcript. The agent gets a screenshot of the view back (headless Chromium: chrome.ts), so it sees what it made.
import { createHmac, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { openChrome } from "./chrome";
import type { McpDef } from "./mcp";

export const VIEW_SERVER = "bismuth-preview";
const BUILD_MS = 120_000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
/** Local images a page names are inlined (inlineImages): each up to this, the page with them up to MAX_PAGE_BYTES. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_CHARS = 12_000;
const TEMPLATES = join(import.meta.dir, "..", "view-templates");
const SHOT_MS = 30_000;
/** As the window frames views (web/views.ts): heights it clamps to, and the widest a conversation usually is. */
const MIN_H = 40;
const MAX_H = 900;
const ROW_W = 1200;
/** A view taller than its frame scrolls there; the agent still sees all of it, in frame-high slices (one tall image
 *  would be shrunk past reading), down to this far. */
const SHOT_MAX_H = 4 * MAX_H;
/** The viewport widths `width` may ask for. */
const VIEWPORT = { min: 320, max: 2560 };
// What a view's page may do: run its own inline code, show inline and data/https images and fonts. Nothing else:
// no connections (the core, the app's API), no forms, an origin of its own (sandbox) even opened directly.
const VIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'";

// The page's half of web/views.ts (sizing, theme), put first in every page as it's served: read from disk each
// time (kept while unchanged), so changing it reaches views already in threads without a restart.
const BRIDGE_FILE = join(import.meta.dir, "..", "web", "view-bridge.js");
let bridge = { at: -1, tag: "" };

function withBridge(html: string, extra = ""): string {
  try {
    const at = statSync(BRIDGE_FILE).mtimeMs;
    if (at !== bridge.at) bridge = { at, tag: `<script>${readFileSync(BRIDGE_FILE, "utf8").replace(/<\/script/gi, "<\\/script")}</script>` };
  } catch {}
  for (const tag of [/<head\b[^>]*>/i, /<html\b[^>]*>/i]) {
    const m = tag.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + bridge.tag + extra + html.slice(m.index + m[0].length);
  }
  return bridge.tag + extra + html;
}

// A plain view takes bismuth's fonts and background from the window it's framed in. Screenshotted on its own, it gets
// them here: web/style.css's @font-face rules with the files inline, and the theme's background behind it.
let shotStyle = "";
function plainShotStyle(): string {
  if (shotStyle) return shotStyle;
  const web = join(import.meta.dir, "..", "web");
  const faces = (readFileSync(join(web, "style.css"), "utf8").match(/@font-face\s*{[^}]*}/g) ?? []).map((face) =>
    face.replace(/url\((["']?)(\.\/fonts\/[^"')]+)\1\)/g, (all, _q, rel) => {
      const file = join(web, rel);
      return existsSync(file) ? `url("data:font/ttf;base64,${readFileSync(file).toString("base64")}")` : all;
    }),
  );
  shotStyle = `<style>${faces.join("\n")}\nhtml { background: var(--main); }</style>`;
  return shotStyle;
}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };
/** A project's views: set up (its build script and how to write a view for it), or what's wrong with the setup. */
type Setup = { build: string; ext: string; guide: string } | { problem: string } | null;

export class Views {
  private dir: string;
  private key = randomBytes(32);

  /** `look`: the window's appearance, from the user's settings, for screenshots. */
  constructor(
    stateDir: string,
    private port: () => number,
    private look: () => { appearance: "dark" | "light" },
  ) {
    this.dir = join(stateDir, "views");
    mkdirSync(this.dir, { recursive: true });
  }

  private sign = (cwd: string) => createHmac("sha256", this.key).update(cwd).digest("hex").slice(0, 32);

  /** The server a run in `cwd` gets. Its URL names the project, signed, so only the runs bismuth starts there can call it. */
  server(cwd: string): McpDef {
    return { transport: "http", url: `http://127.0.0.1:${this.port()}/mcp/${this.sign(cwd)}/${Buffer.from(cwd).toString("base64url")}`, headers: {} };
  }

  /** `.bismuth/view/` in the project: null until there's a build script. */
  private setup(cwd: string): Setup {
    const dir = join(cwd, ".bismuth", "view");
    const build = join(dir, "build");
    if (!existsSync(build)) return null;
    try {
      accessSync(build, constants.X_OK);
    } catch {
      return { problem: ".bismuth/view/build isn't executable: `chmod +x .bismuth/view/build`." };
    }
    let config: any;
    try {
      config = JSON.parse(readFileSync(join(dir, "view.json"), "utf8"));
    } catch {
      return { problem: '.bismuth/view/view.json is missing or isn\'t JSON. It should be { "ext": ".tsx", "guide": "how to write a view for this project" }.' };
    }
    const ext = typeof config?.ext === "string" && /^\.[\w.-]+$/.test(config.ext) ? config.ext : null;
    if (!ext) return { problem: '.bismuth/view/view.json needs "ext": the extension a view file takes for the build, like ".tsx".' };
    return { build, ext, guide: typeof config.guide === "string" ? config.guide.trim() : "" };
  }

  /** `/mcp/<signature>/<project>` and `/view/<id>`; null for any other path. */
  handle(req: Request, path: string): Promise<Response> | Response | null {
    const view = path.match(/^\/view\/([0-9a-f]{20})$/);
    if (view) {
      const file = join(this.dir, `${view[1]}.html`);
      if (!existsSync(file)) return new Response("none", { status: 404 });
      const html = readFileSync(file, "utf8");
      const shot = new URL(req.url).searchParams.has("shot") && /<html\b[^>]*\bdata-bismuth-plain\b/i.test(html);
      // Not cached: the bridge in it can change.
      return new Response(withBridge(html, shot ? plainShotStyle() : ""), {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": VIEW_CSP, "cache-control": "no-cache", "x-content-type-options": "nosniff" },
      });
    }
    const mcp = path.match(/^\/mcp\/([0-9a-f]{32})\/([\w-]+)$/);
    if (!mcp) return null;
    const cwd = Buffer.from(mcp[2], "base64url").toString();
    if (mcp[1] !== this.sign(cwd)) return new Response("forbidden", { status: 403 });
    // Streamable HTTP without a stream: every request is answered in its response.
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    return this.rpc(req, cwd);
  }

  private async rpc(req: Request, cwd: string): Promise<Response> {
    let body: Rpc | Rpc[];
    try {
      body = await req.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }
    const batch = Array.isArray(body);
    const messages: Rpc[] = Array.isArray(body) ? body : [body];
    const answers = (await Promise.all(messages.map((m) => this.answer(m, cwd)))).filter((a) => a !== null);
    if (!answers.length) return new Response(null, { status: 202 });
    return Response.json(batch ? answers : answers[0]);
  }

  private async answer(msg: Rpc, cwd: string): Promise<object | null> {
    if (msg.id === undefined || msg.id === null) return null; // a notification
    const ok = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: VIEW_SERVER, title: "bismuth inline preview", version: "1.0.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        // Setting up the project's own frontend is offered until it's done.
        return ok({ tools: this.setup(cwd) ? [this.tool(cwd)] : [this.tool(cwd), SETUP_TOOL] });
      case "tools/call":
        if (msg.params?.name === "setup_views") return ok({ content: [{ type: "text", text: setupGuide(cwd) }] });
        if (msg.params?.name !== "render") return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } };
        return ok(await this.render(cwd, msg.params?.arguments ?? {}));
      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  private tool(cwd: string) {
    const setup = this.setup(cwd);
    const ready = setup && "build" in setup ? setup : null;
    const intro =
      "Show a view inline in this conversation. Use it when seeing beats reading: a chart, a table, a diagram, a comparison, images (screenshots, generated or edited images, before/after), a mockup of a screen or state, a component and its variants, a small interactive prototype.";
    const sandbox =
      "\n\nThe view runs sandboxed with no network: fetch, APIs and remote scripts fail, so put realistic sample data in it. Local images can be shown by absolute path, written out whole as one string (src=\"/abs/shot.png\", CSS url(/abs/bg.webp), or a JS string literal; not put together from parts like a folder constant): bismuth inlines them.";
    const how = ready
      ? `\n\nPass the view's source as \`code\`: a ${ready.ext} file for the project's view build (.bismuth/view/build), which builds it into a page. If it doesn't build or typecheck, nothing is shown and you get the errors: fix them and call again.` +
        (ready.guide ? `\n\nWriting a view for this project:\n${ready.guide}` : "") +
        sandbox +
        " Light and dark mode follow bismuth through class=\"dark\"/\"light\" on <html>. The frame takes the view's natural (max-content) width and height: a narrow view sits in the text column like an image, a wide one grows past it, up to the conversation's full width. A view meant to fill the width (a fluid chart, a wide table) needs a width or min-width on its outer element. Keep views compact in height." +
        WIDTH_HELP
      : "\n\nThis project has no view build of its own (.bismuth/view/), so a view is plain HTML: pass a self-contained HTML fragment or document as `code`, with inline <style> and <script> (inline SVG for charts and diagrams)." +
        sandbox +
        " bismuth styles the page as part of your reply: it sits borderless on the conversation's background, its left edge on your text's, in bismuth's font and theme, which follow the user's settings and light/dark live. Leave html and body without a background or outer padding, and use bismuth's CSS variables rather than fixed colours: --text, --muted, --faint (text); --accent, --accent-wash; --danger, --warning, --success; --border, --border-strong; --bubble, --hover, --card-bg (surfaces); --sans, --mono. A box that needs its own background gets padding and rounded corners. The frame takes the view's natural width (up to the conversation's full width) and its height; keep it compact." +
        WIDTH_HELP +
        "\n\nPlain HTML is for views that aren't the project's own UI: charts, tables, diagrams, or any view in a project without a frontend. To show the project's own UI (a screen, a component, a variant of one), call setup_views first and set up its view build, then render with the real components: a hand-made HTML copy of the app is not what the user asked to see.";
    return {
      name: "render",
      title: "Render view",
      description:
        intro +
        how +
        "\n\nThe result has a screenshot of the view as the user sees it, all of it even when it's taller than its frame and scrolls (and any errors the page threw): look at it, and if it's wrong (broken layout, cut off, empty, unreadable), fix it and render again." +
        "\n\nThe user sees the view above your reply: don't announce it, say where it is, or restate what it shows.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: ready ? `The view's source: a ${ready.ext} file.` : "The view: a self-contained HTML fragment or document." },
          title: { type: "string", description: "A short name for the view." },
          width: {
            type: "integer",
            minimum: VIEWPORT.min,
            maximum: VIEWPORT.max,
            description: "Optional: the viewport width (CSS px) the page lays out at, for UI with breakpoints: 1280 or 1440 for a desktop layout, 390 for a phone. Scaled down to fit the conversation when wider.",
          },
        },
        required: ["code", "title"],
        additionalProperties: false,
      },
      annotations: { title: "Render view", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    };
  }

  private async render(cwd: string, args: { code?: unknown; title?: unknown; width?: unknown }) {
    const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    const setup = this.setup(cwd);
    if (setup && "problem" in setup) return fail(`Views are half set up in this project, so nothing was shown: ${setup.problem}`);
    if (typeof args.code !== "string" || !args.code.trim()) return fail("`code` must be the view's source.");
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "View";
    if (args.width !== undefined && !(Number.isInteger(args.width) && (args.width as number) >= VIEWPORT.min && (args.width as number) <= VIEWPORT.max))
      return fail(`\`width\` must be a whole number of CSS px from ${VIEWPORT.min} to ${VIEWPORT.max}, or left out.`);
    const width = (args.width as number | undefined) ?? null;
    const shown = async (id: string) => {
      const shot = await this.shoot(id, width);
      const said = [`Shown to the user: "${title}" (bismuth-view:${id}).`];
      if (shot.errors.length) said.push(`The page threw errors (fix them and render again):\n${shot.errors.join("\n")}`);
      if (!shot.pngs?.length) said.push(`No screenshot: ${shot.note}.`);
      else {
        said.push(`How it looks (${shot.size} CSS px, ${this.look().appearance}):`);
        if (shot.pngs.length > 1)
          said.push(`It's taller than the frame's ${MAX_H}px, so it scrolls for the user. The screenshot is the whole page in ${shot.pngs.length} slices, top to bottom.`);
        if (shot.cut) said.push(`Only its top ${SHOT_MAX_H}px are shown here; below that is cut off from the screenshot.`);
      }
      return { content: [{ type: "text", text: said.join("\n\n") }, ...(shot.pngs ?? []).map((data) => ({ type: "image", data, mimeType: "image/png" }))] };
    };

    const id = randomBytes(10).toString("hex");
    // No view build: the code is the page, marked for bismuth's own styling (web/view-bridge.js).
    if (!setup) {
      if (Buffer.byteLength(args.code) > MAX_HTML_BYTES) return fail("The view is over 8 MB.");
      const page = inlineImages(plainPage(args.code));
      if (page.missing.length) return fail(`These local images couldn't be read as images, so nothing was shown: ${page.missing.join(", ")}. Use absolute paths to existing image files.`);
      if (page.tooBig) return fail(page.tooBig);
      writeFileSync(join(this.dir, `${id}.html`), page.html);
      return shown(id);
    }
    // Scratch space inside the project, so the view's imports resolve like the app's; it ignores itself in git.
    const tmp = join(cwd, ".bismuth", "view", ".tmp");
    mkdirSync(tmp, { recursive: true });
    if (!existsSync(join(tmp, ".gitignore"))) writeFileSync(join(tmp, ".gitignore"), "*\n");
    const src = join(tmp, `${id}${setup.ext}`);
    const out = join(tmp, `${id}.html`);
    writeFileSync(src, args.code);
    try {
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([setup.build, src, out], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      } catch (err: any) {
        return fail(`.bismuth/view/build didn't start: ${err?.message ?? err}. It must be an executable file with a shebang line.`);
      }
      const timer = setTimeout(() => proc.kill(), BUILD_MS);
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
      clearTimeout(timer);
      const code = await proc.exited;
      // The view's errors name its scratch file: as the view itself, they read like its own lines.
      const said = `${stderr}\n${stdout}`.replaceAll(src, `view${setup.ext}`).replaceAll(tmp + "/", "").trim().slice(-MAX_ERROR_CHARS);
      if (proc.signalCode) return fail(`.bismuth/view/build took over ${BUILD_MS / 1000}s and was stopped, so nothing was shown.${said ? `\n\n${said}` : ""}`);
      if (code !== 0) return fail(`The view didn't build, so nothing was shown. Fix it and call render again:\n\n${said || `.bismuth/view/build exited with ${code} and printed nothing.`}`);
      let html: string;
      try {
        html = readFileSync(out, "utf8");
      } catch {
        return fail(`.bismuth/view/build succeeded but wrote no page to ${out.replace(cwd + "/", "")}: it must write the HTML to the path it's given as its second argument.`);
      }
      if (!html.trim()) return fail(".bismuth/view/build wrote an empty page.");
      if (Buffer.byteLength(html) > MAX_HTML_BYTES) return fail(`The view's page is ${(Buffer.byteLength(html) / 1048576).toFixed(1)} MB; the limit is 8 MB.`);
      // A bundle is full of strings that only look like paths: what isn't an image file stays as it is.
      const page = inlineImages(html);
      if (page.tooBig) return fail(page.tooBig);
      writeFileSync(join(this.dir, `${id}.html`), page.html);
    } finally {
      rmSync(src, { force: true });
      rmSync(out, { force: true });
    }
    return shown(id);
  }

  /** A screenshot of a view at the width its frame shows it (its natural width, or the viewport it asked for), all its
   *  height in frame-high slices, and what the page threw. */
  private async shoot(id: string, width: number | null): Promise<{ pngs?: string[]; size?: string; cut?: boolean; errors: string[]; note?: string }> {
    const chrome = await openChrome();
    if (!chrome) return { errors: [], note: "there's no Chromium to take one with" };
    const errors: string[] = [];
    chrome.on((method, params) => {
      if (method === "Runtime.exceptionThrown") errors.push(String(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text));
      else if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push(params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
    });
    const evaluate = async (expression: string) => (await chrome.cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
    const viewport = (w: number) => chrome.cdp("Emulation.setDeviceMetricsOverride", { width: w, height: MAX_H, deviceScaleFactor: 1, mobile: false });
    // As web/view-bridge.js measures it: the body's height, and its max-content width.
    const measure = async (): Promise<{ w: number; h: number }> =>
      evaluate(`new Promise((r) => requestAnimationFrame(() => { const b = document.body, s = getComputedStyle(b);
        const h = Math.ceil(b.getBoundingClientRect().height + parseFloat(s.marginTop) + parseFloat(s.marginBottom));
        const before = b.style.width; b.style.width = "max-content";
        const w = Math.ceil(b.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight));
        b.style.width = before; r({ w, h }); }))`);
    const work = async () => {
      await chrome.cdp("Runtime.enable");
      await viewport(width ?? ROW_W);
      await chrome.cdp("Page.navigate", { url: `http://127.0.0.1:${this.port()}/view/${id}?theme=${this.look().appearance}&shot` });
      // Loaded, its fonts in, and a moment for what draws after (effects, a chart's first frame).
      for (let i = 0; i < 100 && !(await evaluate(`location.pathname === "/view/${id}" && document.readyState === "complete"`)); i++) await Bun.sleep(100);
      await evaluate("document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400)))");
      let { w, h } = await measure();
      if (width) w = width;
      else {
        w = Math.min(ROW_W, Math.max(1, w));
        await viewport(w);
        h = (await measure()).h;
      }
      h = Math.max(MIN_H, h);
      const end = Math.min(h, SHOT_MAX_H);
      const pngs: string[] = [];
      for (let y = 0; y < end; y += MAX_H) {
        const shot = await chrome.cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y, width: w, height: Math.min(MAX_H, end - y), scale: 1 }, captureBeyondViewport: true });
        if (!shot?.data) return { size: `${w}×${h}` };
        pngs.push(shot.data as string);
      }
      return { pngs, size: `${w}×${h}`, cut: h > end };
    };
    try {
      const done = await Promise.race([work(), Bun.sleep(SHOT_MS).then(() => null)]);
      if (!done) return { errors: errors.slice(0, 10), note: `it took over ${SHOT_MS / 1000}s` };
      return { ...done, errors: errors.slice(0, 10).map((e) => e.slice(0, 1500)), note: done.pngs ? undefined : "Chromium didn't take it" };
    } catch (err: any) {
      return { errors: errors.slice(0, 10), note: String(err?.message ?? err) };
    } finally {
      await chrome.close();
    }
  }
}

const WIDTH_HELP =
  " Breakpoints (media queries, Tailwind's sm:/md:/lg:/xl:) follow the frame's width, the column's or less, so a responsive screen shows its mobile layout. To show a layout at a given screen size, pass `width` (1280 for a desktop layout): the page lays out at that viewport width and is scaled down to fit the conversation.";

// ---------------- local images ----------------

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};
const EXTS = Object.keys(IMAGE_TYPES).map((e) => e.slice(1)).join("|");
// An absolute path to an image as a whole quoted string (an attribute, a JS string) or in CSS url().
const LOCAL_IMAGE = new RegExp(String.raw`(["'\x60])(\/(?:(?!\1)[^\r\n]){1,2048}?\.(?:${EXTS}))\1|url\(\s*(\/[^\s"'\x60()]{1,2048}?\.(?:${EXTS}))\s*\)`, "gi");

/** Whether a file's bytes are an image of some kind, whatever it's named. */
function isImage(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 16);
  const at = (sig: number[], from = 0) => sig.every((b, i) => head[from + i] === b);
  return (
    at([0x89, 0x50, 0x4e, 0x47]) || // png
    at([0xff, 0xd8, 0xff]) || // jpeg
    at([0x47, 0x49, 0x46, 0x38]) || // gif
    (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) || // webp
    at([0x66, 0x74, 0x79, 0x70], 4) || // avif (ISO BMFF)
    at([0x42, 0x4d]) || // bmp
    at([0x00, 0x00, 0x01, 0x00]) || // ico
    /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg\b/i.test(bytes.subarray(0, 4096).toString("utf8"))
  );
}

/** The page with the local images it names by absolute path inlined as data: URLs (a view's page can't load files),
 *  each marked with its file so the window can open it.
 *  `missing`: paths that aren't readable images, left as they were. */
function inlineImages(html: string): { html: string; missing: string[]; tooBig?: string } {
  const read = new Map<string, string | null>();
  const big = new Set<string>();
  let tooBig: string | undefined;
  const dataUrl = (path: string): string | null => {
    if (read.has(path)) return read.get(path)!;
    let url: string | null = null;
    try {
      const size = statSync(path).size;
      if (size > MAX_IMAGE_BYTES) {
        big.add(path);
        tooBig ??= `${path} is ${(size / 1048576).toFixed(1)} MB; a local image can be at most ${MAX_IMAGE_BYTES / 1048576} MB.`;
      } else {
        const bytes = readFileSync(path);
        // The file rides along in the fragment, which loading a data: URL ignores: clicking the image opens it (web/view-bridge.js).
        // Every character a URL, CSS or quote could end at is escaped: encodeURIComponent leaves !'()* as they are.
        const mark = encodeURIComponent(path).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        if (isImage(bytes)) url = `data:${IMAGE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"};base64,${bytes.toString("base64")}#bismuth-file=${mark}`;
      }
    } catch {}
    read.set(path, url);
    return url;
  };
  const out = html.replace(LOCAL_IMAGE, (all, quote: string | undefined, quoted: string | undefined, inCss: string | undefined) => {
    const url = dataUrl((quoted ?? inCss)!);
    if (!url) return all;
    // Unquoted in CSS: base64 needs no quotes, and the url() may sit in a style="…" attribute.
    return quoted ? `${quote}${url}${quote}` : `url(${url})`;
  });
  const missing = [...read].filter(([path, url]) => !url && !big.has(path)).map(([path]) => path);
  if (!tooBig && Buffer.byteLength(out) > MAX_PAGE_BYTES)
    tooBig = `With its images inlined the page is ${(Buffer.byteLength(out) / 1048576).toFixed(1)} MB; the limit is ${MAX_PAGE_BYTES / 1048576} MB. Use smaller images.`;
  return { html: out, missing, tooBig };
}

const SETUP_TOOL = {
  name: "setup_views",
  title: "Set up views",
  description:
    "Explains how to set up views made with this project's own frontend (its real components, styles and theme) instead of plain HTML: a build script the project keeps in .bismuth/view/, written once. Call it before showing any of the project's own UI (a screen, a component, a variant of one), then follow it: the view build it explains renders the real components, which a hand-made HTML copy can't stand in for.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Set up views", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** A plain HTML view as a page: wrapped in a document if it's a fragment, marked so the bridge styles it as bismuth. */
function plainPage(code: string): string {
  const html = /<html\b/i.exec(code);
  if (html) return code.slice(0, html.index + 5) + " data-bismuth-plain" + code.slice(html.index + 5);
  const doc = /^\s*<!doctype[^>]*>/i.test(code) ? code.replace(/^\s*<!doctype[^>]*>/i, "") : code;
  return `<!doctype html>\n<html data-bismuth-plain>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n${doc}\n</body>\n</html>\n`;
}

/** What setup_views tells an agent: how to give the project a view build of its own. */
function setupGuide(cwd: string): string {
  let templates: string[] = [];
  try {
    templates = readdirSync(TEMPLATES).sort();
  } catch {}
  const listed = templates.length
    ? templates.map((t) => `- ${join(TEMPLATES, t)}${t.startsWith("vite-react-tailwind") ? ": a Vite + React + Tailwind v4 app (shadcn/ui setups included). A view is a TSX module whose default export is the view. Copy it, set APP to the app's folder, adapt what differs." : ""}`).join("\n")
    : "(none installed)";
  return `Set views up once (the setup lives in the repo, so everyone working on it gets it); render then takes views in the project's own form instead of plain HTML.

bismuth shows a view by running the project's own build for it. Create two files in .bismuth/view/ at the project root (${cwd}):

1. .bismuth/view/build, an executable (a script in any language, with a shebang line; chmod +x). bismuth runs \`.bismuth/view/build <view-file> <out.html>\` from the project root. <view-file> holds the \`code\` passed to render; <out.html> is where the page goes. Both are in .bismuth/view/.tmp/, which bismuth keeps out of git and cleans up. The build must:
   - Write ONE self-contained HTML page to <out.html>: every script, stylesheet, image and font inline (data: URLs). The page is shown in a sandbox with no network: anything it would fetch fails (https images and fonts aside).
   - Render the view with the project's real components, its global styles and theme, and the providers its pages need, so the view looks like the app.
   - Fail when the view is broken: exit non-zero and print the errors (bundling errors, and type errors in the view: typecheck it with the project's own config and compiler), readably, with line:column in the view file. They're returned verbatim to whoever called render.
   - Be fast (a few seconds; it's stopped after ${BUILD_MS / 1000}s) and leave tracked files alone: scratch files go somewhere gitignored and are cleaned up.
   - Leave sizing and theme switching to bismuth: it adds a script to every page that reports the page's size so its frame fits it, and sets class="dark" or class="light" (and data-theme) on <html> as bismuth's appearance changes. Make the project's dark mode follow that class (most Tailwind/shadcn setups already do). Keep the body margin at 0, and no viewport heights (100vh) on the page's outer elements.

2. .bismuth/view/view.json: { "ext": ".tsx", "guide": "..." }. "ext" is the extension a view file takes for the build (.tsx, .vue, .svelte, .html…). "guide" is a few sentences for agents writing views in this project: what a view must export, how to import the project's components (its path aliases), what's at hand (styles, icons, charts), what to avoid. bismuth puts it in the render tool's description.

Templates to start from:
${listed}
For another stack, write the same with the project's own toolchain (its bundler, compiler and typechecker).

Then try it: run .bismuth/view/build on a small sample view and on a broken one; check the page renders (open it in a browser if you can) and the errors read well. Then call render with your view.`;
}
