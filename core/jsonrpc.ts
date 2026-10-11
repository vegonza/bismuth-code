// Minimal JSON-RPC peer over a child process's stdio, newline-delimited.
// Codex's app-server speaks JSON-RPC 2.0 semantics without the "jsonrpc" field.
import type { Subprocess } from "bun";

export type Id = string | number;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private closed: Error | null = null;
  onNotification: (method: string, params: any) => void = () => {};
  // Return the result, or throw RpcError to answer with an error.
  onRequest: (method: string, params: any, id: Id) => Promise<unknown> = async (method) => {
    throw new RpcError(-32601, `method not supported by client: ${method}`);
  };
  onClose: (err: Error) => void = () => {};

  constructor(private proc: Subprocess<"pipe", "pipe", "pipe">) {
    void this.readLoop();
  }

  /** `timeoutMs`: give up on an answer that never comes (the app-server has been seen to stall on a request
   *  while staying alive), so callers fail loudly instead of hanging everything waiting on them. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = <V>(fn: (v: V) => void) => (v: V) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve as (v: unknown) => void), reject: done(reject), method });
      if (timeoutMs)
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          console.error(`[codex] ${method} (#${id}) got no answer within ${timeoutMs / 1000}s; ${this.pending.size} other request(s) pending: ${[...this.pending.values()].map((p) => p.method).join(", ") || "none"}`);
          reject(new RpcError(-32000, `${method}: codex app-server did not answer within ${timeoutMs / 1000}s`));
        }, timeoutMs);
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(msg: unknown) {
    if (this.closed) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush();
  }

  private async readLoop() {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of this.proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          // A handler that throws must not end the loop: nothing would read stdout again and every request
          // (now and later) would hang without a trace.
          if (line)
            try {
              this.dispatch(line);
            } catch (err: any) {
              console.error("[codex] handling message failed:", err?.stack ?? err, "\n  message:", line.slice(0, 300));
            }
        }
      }
    } finally {
      this.close(new Error(`codex app-server exited (${await this.proc.exited})`));
    }
  }

  private dispatch(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn("[codex] non-JSON line:", line.slice(0, 200));
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // server -> client request
      this.onRequest(msg.method, msg.params, msg.id).then(
        (result) => this.write({ id: msg.id, result }),
        (err) => {
          const e = err instanceof RpcError ? err : new RpcError(-32603, String(err?.message ?? err));
          this.write({ id: msg.id, error: { code: e.code, message: e.message, data: e.data } });
        },
      );
    } else if (msg.method !== undefined) {
      this.onNotification(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, `${p.method}: ${msg.error.message}`, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private close(err: Error) {
    if (this.closed) return;
    this.closed = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.onClose(err);
  }
}
