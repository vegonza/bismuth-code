// Settings → Notifications (Zeron's settings/notifications.rs): desktop banners and session sounds, each a
// master switch over sub-switches that dim and go inert while it's off.
import { prefs, setPrefs, type Prefs } from "./prefs";
import { card, pageColumn, pageHeader, row, section, toggle } from "./widgets";

type Flag = { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs];

const flag = (key: Flag, title: string, label = title) => row(title, null, toggle(prefs[key], label, (on) => setPrefs({ [key]: on })));

/** Sub-rows follow their master switch without a re-render, so the switch keeps its motion. */
function dependents(master: Flag, rows: HTMLElement[]) {
  const sync = () => rows.forEach((r) => r.toggleAttribute("inert", !prefs[master]));
  sync();
  return sync;
}

export function renderNotifications(): HTMLElement {
  const page = pageColumn();

  const background = flag("notifyInBackgroundOnly", "Only when in the background", "Only notify when bismuth is in the background");
  const syncDesktop = dependents("notifications", [background]);
  const desktop = row("Desktop notifications", null, toggle(prefs.notifications, "Desktop notifications", (on) => {
    setPrefs({ notifications: on });
    syncDesktop();
    // Ask while the click still counts as a user gesture.
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
  }));

  const subs = [flag("soundDone", "Task completed", "Task completed sound"), flag("soundInput", "Input required", "Input required sound"), flag("soundError", "Errors and disconnections", "Errors and disconnections sound")];
  const syncSounds = dependents("sounds", subs);
  const sounds = row("Session sounds", null, toggle(prefs.sounds, "Session sounds", (on) => {
    setPrefs({ sounds: on });
    syncSounds();
  }));

  const desktopSection = section("Desktop", card(desktop, background));
  desktopSection.classList.add("first");
  // `bun run apply` changing core code: a system notification (a click restarts).
  const restart = row("Restart needed", ["A system notification when a change to bismuth only loads after a restart"], toggle(prefs.notifyRestart, "Restart needed notice", (on) => setPrefs({ notifyRestart: on })));
  page.append(pageHeader("Notifications"), desktopSection, section("Sounds", card(sounds, ...subs)), section("App", card(restart)));
  return page;
}
