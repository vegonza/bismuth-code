// Views: an agent shows UI inline in the conversation, built with the project's own frontend. bismuth serves an MCP
// server of its own (`bismuth`, passed to every run like servers carried over: see mcp.ts) whose `render` tool takes
// a view's source. The project builds it: `.bismuth/view/build <view-file> <out.html>`, a script the project keeps
// (an agent writes it the first time, from the setup this hands back, starting from view-templates/), writes one
// self-contained page, or fails with errors that go back to the agent and nothing is shown. bismuth adds the script
// that sizes the page's frame and passes its theme, stores the page, and serves it to a sandboxed frame in the
// transcript.
import { createHmac, randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpDef } from "./mcp";

export const VIEW_SERVER = "bismuth";
const BUILD_MS = 120_000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_CHARS = 12_000;
const TEMPLATES = join(import.meta.dir, "..", "view-templates");
// What a view's page may do: run its own inline code, show inline and data/https images and fonts. Nothing else:
// no connections (the core, the app's API), no forms, an origin of its own (sandbox) even opened directly.
const VIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'";

// Added to every page, first thing in its head: follows the theme the window passes (?theme=, then messages) as
// class="dark"/"light" and data-theme on <html>, and reports the body's height so the frame fits it.
const BRIDGE = `<script>(() => {
  const d = document.documentElement;
  const set = (t) => { d.classList.toggle("dark", t === "dark"); d.classList.toggle("light", t !== "dark"); d.dataset.theme = t; d.style.colorScheme = t; };
  set(new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light");
  addEventListener("message", (e) => { if (e.source === parent && e.data && e.data.bismuthView === "theme") set(e.data.theme === "dark" ? "dark" : "light"); });
  const start = () => {
    const b = document.body;
    let last = -1;
    const post = () => {
      const s = getComputedStyle(b);
      const h = Math.ceil(b.getBoundingClientRect().height + parseFloat(s.marginTop) + parseFloat(s.marginBottom));
      if (h !== last) { last = h; parent.postMessage({ bismuthView: "height", height: h }, "*"); }
    };
    new ResizeObserver(post).observe(b);
    post();
  };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start);
})();</script>`;

function withBridge(html: string): string {
  for (const tag of [/<head\b[^>]*>/i, /<html\b[^>]*>/i]) {
    const m = tag.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + BRIDGE + html.slice(m.index + m[0].length);
  }
  return BRIDGE + html;
}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };
/** A project's views: set up (its build script and how to write a view for it), or what's wrong with the setup. */
type Setup = { build: string; ext: string; guide: string } | { problem: string } | null;

export class Views {
  private dir: string;
  private key = randomBytes(32);

  constructor(stateDir: string, private port: () => number) {
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
      return new Response(Bun.file(file), {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": VIEW_CSP, "cache-control": "max-age=31536000, immutable", "x-content-type-options": "nosniff" },
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
          serverInfo: { name: VIEW_SERVER, title: "bismuth", version: "1.0.0" },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: [this.tool(cwd)] });
      case "tools/call":
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
      "Show a view inline in this conversation, built with this project's own frontend: its real components, styles and theme. Use it when seeing beats reading: a mockup of a screen or state, a component and its variants, a chart, a table, a comparison, a small interactive prototype.";
    const how = ready
      ? `\n\nPass the view's source as \`code\`: a ${ready.ext} file for the project's view build (.bismuth/view/build), which builds it into a page. If it doesn't build or typecheck, nothing is shown and you get the errors: fix them and call again.` +
        (ready.guide ? `\n\nWriting a view for this project:\n${ready.guide}` : "") +
        "\n\nThe view runs sandboxed with no network: fetch, APIs and remote scripts fail, so put realistic sample data in it. Light and dark mode follow bismuth through class=\"dark\"/\"light\" on <html>. The frame fits the view's height; keep views compact."
      : "\n\nViews aren't set up in this project yet: the first call explains how (a build script the project keeps in .bismuth/view/, written once). That adds files to the repo, so set it up when the user wants to see UI, not on your own.";
    return {
      name: "render",
      title: "Render view",
      description: intro + how + "\n\nThe user sees the view above your reply: don't announce it, say where it is, or restate what it shows.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: ready ? `The view's source: a ${ready.ext} file.` : "The view's source, in the form the project's view build takes." },
          title: { type: "string", description: "A short name for the view." },
        },
        required: ["code", "title"],
        additionalProperties: false,
      },
      annotations: { title: "Render view", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    };
  }

  private async render(cwd: string, args: { code?: unknown; title?: unknown }) {
    const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    const setup = this.setup(cwd);
    if (!setup) return fail(setupGuide(cwd));
    if ("problem" in setup) return fail(`Views are half set up in this project, so nothing was shown: ${setup.problem}`);
    if (typeof args.code !== "string" || !args.code.trim()) return fail("`code` must be the view's source.");

    const id = randomBytes(10).toString("hex");
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
      writeFileSync(join(this.dir, `${id}.html`), withBridge(html));
    } finally {
      rmSync(src, { force: true });
      rmSync(out, { force: true });
    }
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "View";
    return { content: [{ type: "text", text: `Shown to the user: "${title}" (bismuth-view:${id}).` }] };
  }
}

/** What an agent is told the first time it calls render in a project without views set up. */
function setupGuide(cwd: string): string {
  let templates: string[] = [];
  try {
    templates = readdirSync(TEMPLATES).sort();
  } catch {}
  const listed = templates.length
    ? templates.map((t) => `- ${join(TEMPLATES, t)}${t.startsWith("vite-react-tailwind") ? ": a Vite + React + Tailwind v4 app (shadcn/ui setups included). A view is a TSX module whose default export is the view. Copy it, set APP to the app's folder, adapt what differs." : ""}`).join("\n")
    : "(none installed)";
  return `Views aren't set up in this project yet, so nothing was shown. Set them up once (the setup lives in the repo, so everyone working on it gets it), then call render again with your view.

bismuth shows a view by running the project's own build for it. Create two files in .bismuth/view/ at the project root (${cwd}):

1. .bismuth/view/build, an executable (a script in any language, with a shebang line; chmod +x). bismuth runs \`.bismuth/view/build <view-file> <out.html>\` from the project root. <view-file> holds the \`code\` passed to render; <out.html> is where the page goes. Both are in .bismuth/view/.tmp/, which bismuth keeps out of git and cleans up. The build must:
   - Write ONE self-contained HTML page to <out.html>: every script, stylesheet, image and font inline (data: URLs). The page is shown in a sandbox with no network: anything it would fetch fails (https images and fonts aside).
   - Render the view with the project's real components, its global styles and theme, and the providers its pages need, so the view looks like the app.
   - Fail when the view is broken: exit non-zero and print the errors (bundling errors, and type errors in the view: typecheck it with the project's own config and compiler), readably, with line:column in the view file. They're returned verbatim to whoever called render.
   - Be fast (a few seconds; it's stopped after ${BUILD_MS / 1000}s) and leave tracked files alone: scratch files go somewhere gitignored and are cleaned up.
   - Leave sizing and theme switching to bismuth: it adds a script to every page that reports the page's height so its frame fits, and sets class="dark" or class="light" (and data-theme) on <html> as bismuth's appearance changes. Make the project's dark mode follow that class (most Tailwind/shadcn setups already do). Keep the body margin at 0, and no viewport heights (100vh) on the page's outer elements.

2. .bismuth/view/view.json: { "ext": ".tsx", "guide": "..." }. "ext" is the extension a view file takes for the build (.tsx, .vue, .svelte, .html…). "guide" is a few sentences for agents writing views in this project: what a view must export, how to import the project's components (its path aliases), what's at hand (styles, icons, charts), what to avoid. bismuth puts it in the render tool's description.

Templates to start from:
${listed}
For another stack, write the same with the project's own toolchain (its bundler, compiler and typechecker).

Then try it: run .bismuth/view/build on a small sample view and on a broken one; check the page renders (open it in a browser if you can) and the errors read well. Then call render again.`;
}
