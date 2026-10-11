// Go to definition. A language server answers when there's one for the file: TypeScript and JavaScript through the
// TypeScript 7 bismuth ships with (its `tsc --lsp`), others through whichever server is installed (pyright,
// rust-analyzer, gopls, clangd). One per server and folder, started on first use and stopped when idle. Without a
// server, ripgrep looks for where the word is declared.
import { existsSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { FileLocation } from "../shared/model";

const IDLE_MS = 10 * 60_000;
const REQUEST_MS = 20_000;

type Spec = { id: string; exts: RegExp; language: (ext: string) => string; command: () => string[] | null };

const which = (name: string) => Bun.which(name);
const firstOf = (...cmds: string[][]) => cmds.find((c) => which(c[0])) ?? null;

/** TypeScript 7's native compiler, as installed with bismuth (it has the language server built in). */
function bundledTsc(): string | null {
  const path = join(import.meta.dir, "..", "node_modules", "@typescript", `typescript-${process.platform}-${process.arch}`, "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
  return existsSync(path) ? path : null;
}

const SPECS: Spec[] = [
  {
    id: "typescript",
    exts: /^\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
    language: (ext) => ({ ".tsx": "typescriptreact", ".jsx": "javascriptreact" })[ext] ?? (/^\.[mc]?ts$/.test(ext) ? "typescript" : "javascript"),
    command: () => {
      const tsc = bundledTsc();
      return tsc ? [tsc, "--lsp", "--stdio"] : firstOf(["typescript-language-server", "--stdio"], ["vtsls", "--stdio"]);
    },
  },
  { id: "python", exts: /^\.pyi?$/, language: () => "python", command: () => firstOf(["basedpyright-langserver", "--stdio"], ["pyright-langserver", "--stdio"], ["pylsp"]) },
  { id: "rust", exts: /^\.rs$/, language: () => "rust", command: () => firstOf(["rust-analyzer"]) },
  { id: "go", exts: /^\.go$/, language: () => "go", command: () => firstOf(["gopls"]) },
  { id: "c", exts: /^\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/, language: (ext) => (ext === ".c" || ext === ".h" ? "c" : "cpp"), command: () => firstOf(["clangd"]) },
];

const uri = (abs: string) => pathToFileURL(abs).href;

class Server {
  private proc: ReturnType<typeof Bun.spawn>;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private versions = new Map<string, { version: number; text: string }>();
  private ready: Promise<void>;
  private idle: Timer | null = null;
  dead = false;

  constructor(
    command: string[],
    readonly root: string,
    private onExit: () => void,
  ) {
    this.proc = Bun.spawn(command, { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "ignore", onExit: () => this.exited() });
    void this.read();
    this.ready = this.request("initialize", {
      processId: process.pid,
      rootUri: uri(root),
      workspaceFolders: [{ uri: uri(root), name: root.split(sep).pop() || root }],
      capabilities: { textDocument: { definition: { linkSupport: true }, synchronization: { didSave: false } }, workspace: { workspaceFolders: true, configuration: true } },
      initializationOptions: {},
    }).then(() => this.notify("initialized", {}));
    this.touch();
  }

  private exited() {
    this.dead = true;
    for (const p of this.pending.values()) p.reject(new Error("The language server stopped"));
    this.pending.clear();
    if (this.idle) clearTimeout(this.idle);
    this.onExit();
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
  }

  kill() {
    this.proc.kill();
  }

  stop() {
    if (this.dead) return;
    void this.request("shutdown", null)
      .catch(() => {})
      .finally(() => {
        this.notify("exit", null);
        setTimeout(() => this.proc.kill(), 500);
      });
  }

  private write(msg: object) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    stdin.flush();
  }
  private notify(method: string, params: unknown) {
    if (!this.dead) this.write({ method, params });
  }
  private request(method: string, params: unknown): Promise<any> {
    if (this.dead) return Promise.reject(new Error("The language server stopped"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The language server took too long"));
      }, REQUEST_MS);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.write({ id, method, params });
    });
  }

  private async read() {
    let buf = Buffer.alloc(0);
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf = Buffer.concat([buf, Buffer.from(chunk)]);
      for (;;) {
        const head = buf.indexOf("\r\n\r\n");
        if (head < 0) break;
        const len = Number(/Content-Length: *(\d+)/i.exec(buf.subarray(0, head).toString())?.[1] ?? -1);
        if (len < 0) {
          buf = buf.subarray(head + 4);
          continue;
        }
        if (buf.length < head + 4 + len) break;
        let msg: any;
        try {
          msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString());
        } catch {
          msg = null;
        }
        buf = buf.subarray(head + 4 + len);
        if (msg) this.message(msg);
      }
    }
  }

  private message(msg: any) {
    if (msg.id !== undefined && msg.method) {
      // The server asking: settings (none of ours), progress tokens, capability registrations: all fine as they are.
      const result = msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null;
      this.write({ id: msg.id, result });
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error.message ?? "Language server error")));
    else p.resolve(msg.result);
  }

  /** The file's definitions at a position, its text as the editor has it (sent first: opened, or changed). */
  async definition(abs: string, languageId: string, text: string, line: number, character: number): Promise<FileLocation[]> {
    this.touch();
    await this.ready;
    const u = uri(abs);
    const known = this.versions.get(u);
    if (!known) {
      this.versions.set(u, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri: u, languageId, version: 1, text } });
    } else if (known.text !== text) {
      known.version++;
      known.text = text;
      this.notify("textDocument/didChange", { textDocument: { uri: u, version: known.version }, contentChanges: [{ text }] });
    }
    const result = await this.request("textDocument/definition", { textDocument: { uri: u }, position: { line, character } });
    const list = result == null ? [] : Array.isArray(result) ? result : [result];
    return list
      .map((l: any) => {
        const target = l.targetUri ?? l.uri;
        const range = l.targetSelectionRange ?? l.targetRange ?? l.range;
        if (!target?.startsWith("file:") || !range) return null;
        return { path: fileURLToPath(target), line: range.start.line, character: range.start.character };
      })
      .filter((l: FileLocation | null): l is FileLocation => !!l);
  }
}

const servers = new Map<string, Server>();
/** Servers that couldn't start, so a missing one isn't looked for on every request. */
const missing = new Set<string>();

function serverFor(spec: Spec, root: string): Server | null {
  const key = `${spec.id}\0${root}`;
  const running = servers.get(key);
  if (running && !running.dead) return running;
  if (missing.has(spec.id)) return null;
  const command = spec.command();
  if (!command) {
    missing.add(spec.id);
    setTimeout(() => missing.delete(spec.id), 60_000);
    return null;
  }
  try {
    const s = new Server(command, root, () => servers.get(key) === s && servers.delete(key));
    servers.set(key, s);
    return s;
  } catch {
    return null;
  }
}

/** Every language server, on the core's way out (synchronously: the process is exiting). */
export function killLanguageServers() {
  for (const s of servers.values()) s.kill();
}

const WORD = /[\p{L}\p{N}_$]/u;

/** The identifier at a position of the text, if any. */
function wordAt(text: string, line: number, character: number): string | null {
  const l = text.split("\n")[line] ?? "";
  let a = character;
  let b = character;
  while (a > 0 && WORD.test(l[a - 1])) a--;
  while (b < l.length && WORD.test(l[b])) b++;
  const w = l.slice(a, b);
  return w && !/^\d/.test(w) ? w : null;
}

/** Without a language server: lines that look like the word being declared, by ripgrep (in the folder, ignored
 *  files left out). The file asked from comes first. */
async function declarations(root: string, abs: string, word: string): Promise<FileLocation[]> {
  const rg = which("rg");
  if (!rg) return [];
  const w = word.replace(/[$]/g, "\\$");
  const patterns = [
    `\\b(def|class|function|func|fn|struct|enum|trait|interface|type|const|let|var|val|module|record|object|protocol|typedef|macro|impl|namespace|package)\\s+\\*?${w}\\b`,
    `\\bfunc\\s+\\([^)]*\\)\\s+${w}\\b`,
    `#define\\s+${w}\\b`,
    `\\b${w}\\s*(:[^=;]*)?=\\s*(async\\s+)?(function\\b|\\([^)]*\\)\\s*(:[^=]*)?=>)`,
  ];
  const p = Bun.spawn([rg, "--no-heading", "--line-number", "--color", "never", "--max-count", "5", "--max-filesize", "1M", ...patterns.flatMap((x) => ["-e", x]), "--", "."], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 4_000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  const here = relative(root, abs);
  const hits: FileLocation[] = [];
  const exact = new RegExp(`(^|[^\\p{L}\\p{N}_$])${w}(?![\\p{L}\\p{N}_$])`, "u");
  for (const line of out.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const at = exact.exec(m[3]);
    if (!at) continue;
    hits.push({ path: resolve(root, m[1]), line: Number(m[2]) - 1, character: at.index + at[1].length });
    if (hits.length >= 40) break;
  }
  const rel = (h: FileLocation) => relative(root, h.path);
  return hits.sort((a, b) => Number(rel(b) === here) - Number(rel(a) === here));
}

/** Where what's at the position is defined. Paths come back as the UI names them: relative inside the folder. */
export async function definition(rootPath: string, path: string, text: string, line: number, character: number): Promise<FileLocation[]> {
  const root = realpathSync(resolve(rootPath));
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const ext = extname(abs).toLowerCase();
  const spec = SPECS.find((s) => s.exts.test(ext));
  // A file outside the folder is read in its own.
  const base = abs.startsWith(root + sep) ? root : dirname(abs);
  const server = spec ? serverFor(spec, base) : null;
  let found: FileLocation[];
  if (server) found = await server.definition(abs, spec!.language(ext), text, line, character);
  else {
    const word = wordAt(text, line, character);
    found = word ? await declarations(base, abs, word) : [];
  }
  const named = (p: string) => {
    const rel = relative(root, p);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : p;
  };
  // The definition at the very spot asked from is no jump at all.
  const seen = new Set<string>();
  return found
    .map((l) => ({ ...l, path: named(l.path) }))
    .filter((l) => {
      const k = `${l.path}:${l.line}:${l.character}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}
