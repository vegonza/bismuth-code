// Remote access over Tailscale (Settings → General): `tailscale serve` puts the UI on the tailnet over HTTPS, on the
// core's own port, proxied to 127.0.0.1, so the core itself never listens beyond localhost. Tailscale keeps the
// setting (`--bg` persists it), so there's no state here beyond what `tailscale` reports. A proxied request says
// who sent it (`Tailscale-User-Login`, which Tailscale sets and a client can't forge): only this machine's own
// user gets in, never another tailnet member or a shared-in device.
import type { RemoteAccess } from "../shared/model";

const COMMAND_TIMEOUT = 10_000;
/** How long a known tailnet name and owner stand before a remote request looks again. */
const STALE = 30_000;

type Node = { host: string; login: string } | null;

export class RemoteAccessControl {
  private node: Node = null;
  private seen = 0;
  private looking: Promise<Node> | null = null;

  constructor(private port: () => number) {}

  /** Whether a request that didn't come from this machine's own windows may in: through this core's `serve`, sent by
   *  the machine's owner. */
  async admits(host: string | null, login: string | null): Promise<boolean> {
    if (!host || !login) return false;
    const node = Date.now() - this.seen < STALE ? this.node : await this.look();
    return !!node && host === node.host && login === node.login;
  }

  async get(): Promise<RemoteAccess> {
    const status = await tailscale(["status", "--json"]);
    if (status.missing) return { state: "unavailable", reason: "Tailscale isn't installed on this machine" };
    const s = parse(status.out);
    if (s?.BackendState !== "Running" || !s.Self?.DNSName) {
      this.remember(null);
      return { state: "unavailable", reason: s?.BackendState === "NeedsLogin" ? "Tailscale is signed out on this machine" : "Tailscale isn't running on this machine" };
    }
    const host = `${String(s.Self.DNSName).replace(/\.$/, "")}:${this.port()}`;
    const login = String(s.User?.[s.Self.UserID]?.LoginName ?? "");
    this.remember(login ? { host, login } : null);
    const served = parse((await tailscale(["serve", "status", "--json"])).out);
    const proxy = served?.Web?.[host]?.Handlers?.["/"]?.Proxy ?? null;
    const taken = !!served?.TCP?.[this.port()];
    const ours = proxy === this.target();
    return { state: ours ? "on" : "off", url: `https://${host.replace(/:443$/, "")}/`, login, taken: taken && !ours };
  }

  async set(enabled: boolean): Promise<RemoteAccess> {
    const now = await this.get();
    if (now.state === "unavailable" || (now.state === "on") === enabled) return now;
    if (enabled && now.taken) throw new Error(`Port ${this.port()} on this machine's tailnet address already serves something else. Free it with: tailscale serve --https=${this.port()} off`);
    const args = enabled ? ["serve", "--bg", `--https=${this.port()}`, this.target()] : ["serve", `--https=${this.port()}`, "off"];
    const res = await tailscale(args);
    if (res.code !== 0) throw new Error(explain(res.out));
    return this.get();
  }

  private target = () => `http://127.0.0.1:${this.port()}`;

  private remember(node: Node) {
    this.node = node;
    this.seen = Date.now();
  }

  private look(): Promise<Node> {
    return (this.looking ??= this.get()
      .catch(() => this.remember(null))
      .then(() => this.node)
      .finally(() => (this.looking = null)));
  }
}

/** `tailscale serve` explains a refusal on its output: the part worth showing. */
function explain(out: string): string {
  if (/access denied|permission denied|operator/i.test(out)) return "Tailscale won't let bismuth configure it. Allow your user once with: sudo tailscale set --operator=$USER";
  if (/not enabled|enable.*https|https.*disabled/i.test(out)) {
    const link = out.match(/https:\/\/login\.tailscale\.com\S*/)?.[0];
    return `HTTPS isn't enabled on your tailnet yet.${link ? ` Turn it on at ${link}, then try again.` : " Turn it on in the Tailscale admin console (DNS → HTTPS certificates), then try again."}`;
  }
  return out.trim() || "tailscale serve failed";
}

function parse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Runs the CLI, answering its output (both streams) and exit code. One that waits on input (enabling HTTPS asks
 *  for a visit to the admin console) is cut off and reports what it printed. */
async function tailscale(args: string[]): Promise<{ out: string; code: number; missing: boolean }> {
  if (!Bun.which("tailscale")) return { out: "", code: 127, missing: true };
  const proc = Bun.spawn(["tailscale", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { out: out + err, code, missing: false };
}
