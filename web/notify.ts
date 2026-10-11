// Session chimes and desktop banners (Zeron's shell.rs session detector + notify.rs + sound.rs): a thread that
// finishes, asks for input or fails plays its sound and, unless bismuth is focused and banners are set to
// background-only, posts a notification. Losing the core does the same once per outage.
import type { ThreadStatus } from "../shared/model";
import { prefs } from "./prefs";
import attentionWav from "./sounds/attention.wav";
import doneWav from "./sounds/done.wav";
import requestWav from "./sounds/request.wav";
import { actions } from "./store";

type Sound = "done" | "request" | "attention";
const FILES: Record<Sound, string> = { done: doneWav, request: requestWav, attention: attentionWav };
const BODY: Record<Sound, string> = { done: "Run finished", request: "Waiting on your input", attention: "Run failed" };
const ENABLED: Record<Sound, () => boolean> = { done: () => prefs.soundDone, request: () => prefs.soundInput, attention: () => prefs.soundError };

// Failures can arrive in bursts; one attention chime covers them.
const ATTENTION_GAP_MS = 4000;
let lastAttention = 0;

export function play(sound: Sound) {
  if (!prefs.sounds || !ENABLED[sound]()) return;
  if (sound === "attention") {
    const now = Date.now();
    if (now - lastAttention < ATTENTION_GAP_MS) return;
    lastAttention = now;
  }
  void new Audio(FILES[sound]).play().catch(() => {});
}

function post(title: string, body: string, threadId: string | null) {
  if (!prefs.notifications || (prefs.notifyInBackgroundOnly && document.hasFocus())) return;
  banner(title, body, () => threadId && actions.open(threadId));
}

/** A system notification; a click brings the window forward and runs `onClick`. */
function banner(title: string, body: string, onClick: () => void) {
  if (typeof Notification === "undefined") return;
  const show = () => {
    let n: Notification;
    try {
      n = new Notification(title, { body, silent: true }); // the chime is ours
    } catch {
      return; // a phone's browser only notifies through a service worker
    }
    n.onclick = () => {
      window.focus();
      onClick();
    };
  };
  if (Notification.permission === "granted") show();
  else if (Notification.permission !== "denied") void Notification.requestPermission().then((p) => p === "granted" && show());
}

/** The sound a thread's status change earns, if any: settling from a run, or stopping to ask. */
function soundFor(prev: ThreadStatus, next: ThreadStatus): Sound | null {
  if (prev === next) return null;
  if (next === "waiting") return "request";
  if (next === "error") return "attention";
  if (prev === "running" && next === "idle") return "done";
  return null;
}

/** Feed every summary change; the first sighting of a thread only seeds its baseline. */
export function threadChanged(id: string, title: string, prev: ThreadStatus | undefined, next: ThreadStatus) {
  if (prev === undefined) return;
  const sound = soundFor(prev, next);
  if (!sound) return;
  play(sound);
  post(title || "New session", BODY[sound], id);
}

/** A restart would load changed core code: a system notification even while bismuth is focused (that's when
 *  changes get applied), under its own switch (Settings → Notifications → Restart needed). */
export function restartNeededBanner(files: string[], restart: () => void) {
  if (!prefs.notifyRestart) return;
  const what = files.length === 1 ? files[0] : `${files.length} files`;
  banner("Restart needed", `Changes to ${what} load after a restart. Click to restart bismuth.`, restart);
}

let offline = false;
/** The socket to the core dropped (true) or came back (false). */
export function connectionChanged(lost: boolean) {
  if (lost === offline) return;
  offline = lost;
  if (!lost) return;
  play("attention");
  post("Connection unavailable", "bismuth is trying to reconnect", null);
}
