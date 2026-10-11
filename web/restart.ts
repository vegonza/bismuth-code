// Restart bismuth (the command palette, like VS Code's): the core checks the code it would start with and restarts
// under the desktop shell; the window reconnects and reloads into the new build (the draft survives, as with any
// reload). Running sessions are never stopped without asking: restart when they finish, or now.
import type { RestartResult, ServerMessage } from "../shared/model";
import { el, miniSpinner } from "./dom";
import { restartNeededBanner } from "./notify";
import { call } from "./store";
import { action, dialog } from "./widgets";

let toast: HTMLElement | null = null;
/** The core is going down on purpose: the window shouldn't report a lost connection. */
let restarting = false;
export const isRestarting = () => restarting;

const sessions = (n: number) => `${n} running session${n === 1 ? "" : "s"}`;

export async function restartApp() {
  if (restarting) return;
  showToast("Checking before restarting…", true);
  let res: RestartResult;
  try {
    res = await call("app.restart", { mode: "ifIdle" });
  } catch (err: any) {
    hideToast();
    return showFailure(err.message);
  }
  if (res.state === "running") {
    hideToast();
    confirmRunning(res.running);
  }
}

/** The core's side of it: a wait started, ended, or the restart is underway. */
export function restartMessage(msg: Extract<ServerMessage, { type: "restart" }>) {
  if (msg.state === "restarting") {
    restarting = true;
    showToast("Restarting bismuth…", true);
  } else if (msg.state === "scheduled") {
    showToast(`Restarting when ${sessions(msg.running)} finish${msg.running === 1 ? "es" : ""}`, false, action("Cancel", "filled", () => void call("app.restart", { mode: "cancel" })));
  } else if (msg.state === "cancelled") hideToast();
  else if (msg.state === "failed") {
    hideToast();
    showFailure(msg.error ?? "The restart's checks failed.");
  }
}

/** `bun run apply` changed core code: a system notification, once per set of changes (a reconnect repeats the core's
 *  message). Clicking it restarts, asking first if sessions are running. */
export function restartNeeded(files: string[]) {
  const key = files.join("\n");
  if (restarting || sessionStorage.getItem("bismuth.restartNotified") === key) return;
  sessionStorage.setItem("bismuth.restartNotified", key);
  restartNeededBanner(files, () => void restartApp());
}

function showToast(text: string, busy: boolean, ...actions: HTMLElement[]) {
  toast?.remove();
  toast = el("div", "restart-toast");
  if (busy) toast.append(miniSpinner());
  toast.append(el("span", "text", text), ...actions);
  document.body.append(toast);
}

function hideToast() {
  toast?.remove();
  toast = null;
}

function confirmRunning(n: number) {
  dialog("Restart bismuth?", `${sessions(n)[0].toUpperCase()}${sessions(n).slice(1)}. Restarting now stops ${n === 1 ? "it" : "them"} mid-turn (the history so far is kept).`, [
    ["Cancel", "filled", () => {}],
    ["Restart now", "danger", () => void call("app.restart", { mode: "now" }).catch((err) => showFailure(err.message))],
    [n === 1 ? "When it finishes" : "When they finish", "solid", () => void call("app.restart", { mode: "whenIdle" }).catch((err) => showFailure(err.message))],
  ]);
}

/** Nothing restarted: the reason's first line, and any detail (typecheck or build output) below it. */
function showFailure(error: string) {
  const [first, ...rest] = error.split("\n");
  const body = el("div", "s-dialog-body");
  body.append(el("div", "", `bismuth kept running. ${first}`));
  if (rest.length) body.append(el("pre", "restart-error", rest.join("\n")));
  dialog("Can't restart", body, [["OK", "solid", () => {}]]);
}
