// Settings → Remote: this UI on the machine's Tailscale address, for its owner's phone and other devices. The core
// does the work (`core/remote.ts`: `tailscale serve`, and only the owner's devices get in); this page is its switch.
import { encode } from "uqr";
import type { RemoteAccess } from "../shared/model";
import { el } from "./dom";
import { refresh } from "./settings";
import { call } from "./store";
import { action, card, copyAction, dialog, errorStrip, pageColumn, pageHeader, pageSubtitle, row, section, toggle } from "./widgets";

/** What the core last said (null until it has), and why the last switch failed. */
let remote: RemoteAccess | null = null;
let remoteError: string | null = null;
let switching = false;

function showRemote(next: RemoteAccess) {
  if (switching) return; // the switch's own answer is the newer one
  const changed = JSON.stringify(next) !== JSON.stringify(remote);
  remote = next;
  if (changed) refresh();
}

async function setRemote(enabled: boolean) {
  switching = true;
  remoteError = null;
  refresh();
  try {
    remote = await call("remote.set", { enabled });
  } catch (err: any) {
    remoteError = String(err?.message ?? err);
  }
  switching = false;
  refresh();
}

function rows(): HTMLElement[] {
  if (!remote) return [row("Remote access", ["Checking…"])];
  if (remote.state === "unavailable") return [row("Remote access", [remote.reason, "Install it and sign in to reach bismuth from your other devices"])];
  const on = remote.state === "on";
  const meta = on ? [`Open on any device signed in to Tailscale as ${remote.login}`] : ["Reach this bismuth from your phone or other devices on your tailnet", `Only ${remote.login} gets in`];
  const sw = toggle(on, "Remote access over Tailscale", (next) => void setRemote(next));
  sw.disabled = switching;
  const out = [row("Remote access", meta, sw)];
  if (on) {
    const link = el("a", "", remote.url) as HTMLAnchorElement;
    link.href = remote.url;
    link.target = "_blank";
    const { url, login } = remote;
    const actions = el("div", "s-actions");
    actions.append(action("QR code", "quiet", () => showQr(url, login), "qrCode"), copyAction(() => url));
    out.push(row("Address", [link, "Tailnet only, over HTTPS", "Reachable while bismuth runs here"], actions));
  } else if (remote.taken) {
    out.push(errorStrip("Something else already uses this port on your tailnet address"));
  }
  if (remoteError) out.push(errorStrip(remoteError));
  return out;
}

/** The address as a QR code, for a phone's camera. */
function showQr(url: string, login: string) {
  const { data, size } = encode(url, { ecc: "M", border: 0 });
  let path = "";
  data.forEach((line, y) => line.forEach((dark, x) => dark && (path += `M${x} ${y}h1v1h-1z`)));
  const tile = el("div", "qr-tile");
  tile.innerHTML = `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code for ${url}"><path d="${path}" fill="#000"/></svg>`;
  const body = el("div", "qr-body");
  body.append(tile, el("div", "qr-url", url), el("div", "qr-note", `Scan it with your phone's camera. The phone needs Tailscale on, signed in as ${login}.`));
  dialog("Open on your phone", body, [["Done", "filled", () => {}]]);
}

export function renderRemote(): HTMLElement {
  void call("remote.get", {}).then(showRemote, () => {});
  const page = pageColumn();
  const titles = el("div");
  titles.append(pageHeader("Remote"), pageSubtitle("Use bismuth from your phone or another computer. Sessions keep running on this machine."));
  const access = section("Tailscale", card(...rows()));
  access.classList.add("first");
  page.append(titles, access);
  return page;
}
