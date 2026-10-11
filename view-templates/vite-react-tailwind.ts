#!/usr/bin/env bun
// bismuth view build for a Vite + React + Tailwind (v4) app. bismuth's `render` tool runs it as
// `.bismuth/view/build <view-file> <out.html>` from the project root: the view file is a TSX module whose default
// export is the view, and the page it writes is one self-contained HTML document showing it.
//
// Bun.build bundles the view against the app's node_modules and its tsconfig paths (its `@/` aliases), the app's own
// Tailwind compiles its stylesheet (scanning the app like its Vite plugin does, plus the view), and the app's own tsc
// typechecks the view. Errors go to stderr with a non-zero exit. bismuth adds the script that sizes the page's frame
// and sets class="dark"/"light" on <html>.
//
// To use it: copy it to .bismuth/view/build, `chmod +x` it, and point APP at the React app's folder.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The project root (this file is .bismuth/view/build), and the React app in it: change APP for an app in a
 *  subfolder, e.g. join(ROOT, "frontend"). */
const ROOT = resolve(import.meta.dir, "..", "..");
const APP = ROOT;

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: build <view-file> <out.html>");
  process.exit(2);
}
const app = APP;
const code = readFileSync(src, "utf8");
const id = Math.random().toString(36).slice(2, 10);

const MAX_HTML_BYTES = 8 * 1024 * 1024;
const TSC_MS = 60_000;

// The view, its entry and stylesheet are virtual files in the app's folder, so imports resolve from there.
const viewFile = join(app, `.bismuth-view-${id}.tsx`);
const entryFile = join(app, `.bismuth-view-${id}.entry.ts`);
const cssFile = join(app, `.bismuth-view-${id}.css`);

function readJson(file: string): any {
  try {
    // tsconfig files allow comments and trailing commas.
    return Bun.JSONC.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The tsconfig the app's own code compiles with: Vite's split config keeps the paths in tsconfig.app.json. */
function appTsconfig(): string | null {
  for (const name of ["tsconfig.app.json", "tsconfig.json"]) if (existsSync(join(app, name))) return join(app, name);
  return null;
}

/** The app's tsconfig `paths` (its `@/` aliases), from the config that declares them along the `extends` chain. */
function tsPaths(): { dir: string; paths: Record<string, string[]> } | null {
  const seen = new Set<string>();
  let file = appTsconfig();
  while (file && !seen.has(file)) {
    seen.add(file);
    const config = readJson(file);
    const options = config?.compilerOptions ?? {};
    if (options.paths && typeof options.paths === "object") return { dir: resolve(dirname(file), options.baseUrl ?? "."), paths: options.paths };
    const ext = config?.extends;
    if (typeof ext !== "string") return null;
    try {
      file = ext.startsWith(".") || ext.startsWith("/") ? resolve(dirname(file), ext.endsWith(".json") ? ext : `${ext}.json`) : Bun.resolveSync(ext, dirname(file));
    } catch {
      return null;
    }
  }
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Resolves the app's path aliases the way its Vite config and tsconfig do. */
function aliases(): import("bun").BunPlugin | null {
  const found = tsPaths();
  if (!found) return null;
  const rules = Object.entries(found.paths).map(([pattern, targets]) => {
    const star = pattern.indexOf("*");
    return { prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? "" : pattern.slice(star + 1), exact: star < 0, targets: targets.map(String) };
  });
  const filter = new RegExp(`^(?:${rules.map((r) => escapeRe(r.prefix)).join("|")})`);
  return {
    name: "bismuth-tsconfig-paths",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        const p = args.path;
        for (const r of rules) {
          const hit = r.exact ? p === r.prefix : p.startsWith(r.prefix) && p.endsWith(r.suffix) && p.length >= r.prefix.length + r.suffix.length;
          if (!hit) continue;
          const middle = r.exact ? "" : p.slice(r.prefix.length, p.length - r.suffix.length);
          for (const target of r.targets) {
            try {
              const path = Bun.resolveSync(resolve(found.dir, target.replace("*", middle)), app);
              return ASSET.test(path) && args.kind !== "url-token" ? { path, namespace: "bismuth-asset" } : { path };
            } catch {}
          }
        }
        return undefined;
      });
    },
  };
}

// ---------------- styles ----------------

/** The app's Tailwind stylesheet: the one shadcn's components.json names, else the first CSS file under src/ that
 *  imports Tailwind. */
function tailwindEntry(): string | null {
  const named = readJson(join(app, "components.json"))?.tailwind?.css;
  if (typeof named === "string" && existsSync(join(app, named))) return join(app, named);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith(".css") && /@import\s+["']tailwindcss["']|@tailwind\s+base/.test(readFileSync(p, "utf8"))) found.push(p);
    }
  };
  walk(join(app, "src"), 0);
  return found.sort((a, b) => a.length - b.length)[0] ?? null;
}

/** A package as the app resolves it, imported from there (never bismuth's own copy). */
async function appImport(name: string, from = app): Promise<any> {
  return import(pathToFileURL(Bun.resolveSync(name, from)).href);
}

/** The app's stylesheet compiled the way its Vite plugin does it: every class the app uses, and the view's. */
async function tailwindCss(): Promise<string> {
  const entry = tailwindEntry();
  if (!entry) return "";
  // @tailwindcss/vite brings @tailwindcss/node and the oxide scanner; resolve them from it when it's there.
  let from = app;
  try {
    from = dirname(Bun.resolveSync("@tailwindcss/vite", app));
  } catch {}
  const node = await appImport("@tailwindcss/node", from);
  const { Scanner } = await appImport("@tailwindcss/oxide", from);
  const compiler = await node.compile(readFileSync(entry, "utf8"), { base: dirname(entry), shouldRewriteUrls: true, onDependency: () => {} });
  const sources = (compiler.root === "none" ? [] : compiler.root === null ? [{ base: app, pattern: "**/*", negated: false }] : [{ ...compiler.root, negated: false }]).concat(compiler.sources);
  const scanner = new Scanner({ sources });
  const candidates = new Set<string>(scanner.scan());
  for (const c of scanner.getCandidatesWithPositions({ content: code, extension: "tsx" })) candidates.add(c.candidate);
  let css: string = compiler.build([...candidates]);
  // Relative URLs were rewritten against the stylesheet's folder: the files they name (fonts, images) go inline.
  return css.replace(/url\((["']?)(\.{1,2}\/[^"')?#]+)([?#][^"')]*)?\1\)/g, (all, q, url) => {
    const inline = dataUrl(resolve(dirname(entry), url));
    return inline ? `url(${q}${inline}${q})` : all;
  });
}

// ---------------- environment ----------------

/** What Vite would put in import.meta.env for a production build: the VITE_ variables from the app's .env files. */
function viteEnv(): Record<string, string | boolean> {
  const env: Record<string, string | boolean> = { MODE: "production", DEV: false, PROD: true, SSR: false, BASE_URL: "/" };
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    let text: string;
    try {
      text = readFileSync(join(app, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?(VITE_[A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return env;
}

// ---------------- typecheck ----------------

/** The app's own tsc if it has one (the version its code is written against), else the one bismuth ships. */
function tscCommand(): string[] | null {
  const own = join(app, "node_modules", ".bin", "tsc");
  if (existsSync(own)) return [own];
  const shipped = join(import.meta.dir, "..", "node_modules", "@typescript", `typescript-${process.platform}-${process.arch}`, "lib", "tsc");
  return existsSync(shipped) ? [shipped] : null;
}

/** Type errors in the view, checked against the app's tsconfig (unused names aside: a view is a sketch). */
async function typecheck(): Promise<string[]> {
  const tsc = tscCommand();
  const base = appTsconfig();
  if (!tsc || !base) return [];
  const dir = join(app, "node_modules", ".cache", "bismuth-view", id);
  mkdirSync(dir, { recursive: true });
  try {
    const file = join(dir, "view.tsx");
    writeFileSync(file, code);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: base,
        compilerOptions: { noEmit: true, noUnusedLocals: false, noUnusedParameters: false, incremental: false, composite: false, tsBuildInfoFile: null },
        files: [file],
        include: [],
      }),
    );
    const proc = Bun.spawn([...tsc, "-p", join(dir, "tsconfig.json"), "--pretty", "false"], { cwd: app, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), TSC_MS);
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    clearTimeout(timer);
    await proc.exited;
    // Only the view's own errors: the app's may have some of its own, which aren't the view's to fix.
    const errors: string[] = [];
    let current: string[] | null = null;
    for (const line of out.split("\n")) {
      const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
      if (m) {
        current = resolve(app, m[1]) === file ? [`view.tsx:${m[2]}:${m[3]} ${m[4]}: ${m[5]}`] : null;
        if (current) errors.push(current[0]);
      } else if (current && /^\s+\S/.test(line)) errors[errors.length - 1] += `\n${line}`;
      else current = null;
    }
    return errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    try {
      rmdirSync(dirname(dir)); // once no other build is using it
    } catch {}
  }
}

// ---------------- bundle ----------------

const ENTRY = `import { Component, createElement } from "react";
import { createRoot } from "react-dom/client";
import View from "./${`.bismuth-view-${id}.tsx`}";
import "./${`.bismuth-view-${id}.css`}";

class Boundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return createElement("pre", { style: { margin: 0, padding: 16, font: "12px/1.5 ui-monospace, monospace", color: "#e5484d", whiteSpace: "pre-wrap" } },
      String((e && e.stack) || e));
  }
}
createRoot(document.getElementById("root")).render(createElement(Boundary, null, createElement(View)));
`;

/** Images and fonts go inline as data URLs: the page has no files beside it. (Bun's own dataurl loader yields an
 *  empty string.) */
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
};
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

function dataUrl(file: string): string | null {
  const type = MIME[extname(file).toLowerCase()];
  if (!type) return null;
  try {
    if (statSync(file).size > MAX_ASSET_BYTES) return null;
    return `data:${type};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

const ASSET = new RegExp(`(${Object.keys(MIME).map(escapeRe).join("|")})$`, "i");

/** An image or font imported from code is its data URL. */
const assets: import("bun").BunPlugin = {
  name: "bismuth-assets",
  setup(build) {
    build.onResolve({ filter: ASSET }, (args) => {
      if (args.kind !== "import-statement" && args.kind !== "dynamic-import" && args.kind !== "require-call") return undefined;
      try {
        return { path: Bun.resolveSync(args.path, dirname(args.importer)), namespace: "bismuth-asset" };
      } catch {
        return undefined;
      }
    });
    build.onLoad({ filter: /.*/, namespace: "bismuth-asset" }, (args) => {
      const url = dataUrl(args.path);
      if (!url) throw new Error(`${args.path} is too large to inline (2 MB max) or unreadable.`);
      return { contents: `export default ${JSON.stringify(url)};`, loader: "js" };
    });
  },
};

async function bundle(css: string): Promise<{ js: string; css: string } | string[]> {
  const tsconfig = appTsconfig();
  const alias = aliases();
  const env = viteEnv();
  const define: Record<string, string> = {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env": JSON.stringify(env),
    ...Object.fromEntries(Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])),
  };
  const result = await Bun.build({
    entrypoints: [entryFile],
    files: { [entryFile]: ENTRY, [viewFile]: code, [cssFile]: css },
    target: "browser",
    format: "esm",
    minify: true,
    splitting: false,
    throw: false,
    define,
    ...(tsconfig ? { tsconfig } : {}),
    plugins: [...(alias ? [alias] : []), assets],
  });
  if (!result.success) return result.logs.map((log) => String(log).replaceAll(viewFile, "view.tsx").replaceAll(app + "/", ""));
  let js = "";
  let styles = "";
  for (const out of result.outputs) {
    if (out.kind === "entry-point") js += await out.text();
    else if (out.path.endsWith(".css")) styles += await out.text();
  }
  return { js, css: styles };
}

// ---------------- page ----------------

const guard = (text: string, tag: string) => text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

function page(js: string, css: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${guard(css, "style")}</style>
<style>html, body { margin: 0; } #root { display: flow-root; }</style>
</head>
<body>
<div id="root"></div>
<script type="module">${guard(js, "script")}</script>
</body>
</html>
`;
}

// ---------------- main ----------------

const fail = (text: string) => {
  console.error(text);
  process.exit(1);
};

try {
  const [types, css] = await Promise.all([
    typecheck(),
    tailwindCss().catch((err: any) => {
      throw new Error(`The app's Tailwind stylesheet didn't compile: ${err?.message ?? err}`);
    }),
  ]);
  const built = await bundle(css);
  const errors = [...(Array.isArray(built) ? built : []), ...types];
  if (errors.length || Array.isArray(built)) fail(errors.join("\n\n"));
  else {
    const html = page(built.js, built.css);
    const size = Buffer.byteLength(html);
    if (size > MAX_HTML_BYTES) fail(`The view bundles to ${(size / 1048576).toFixed(1)} MB; the limit is 8 MB. Import less (a heavy library, large images).`);
    writeFileSync(out, html);
  }
} catch (err: any) {
  fail(String(err?.message ?? err));
}
