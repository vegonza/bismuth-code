// The sidebar's "…" view menu (Zeron shell/spaces.rs): Organize / Sort / Show submenus that open on hover,
// and the Compact and Jump hints switches. Options persist in localStorage and re-render the session list.
import { el } from "./dom";
import { isPhone } from "./phone";
import { icon, type IconName } from "./icons";
import { menuHeading, menuSeparator, openPopover, toggleSwitch, type Popover } from "./popover";
import { persist, render, store, type ViewOptions } from "./store";

/** `shown`: whether the current view draws what it toggles (left out of the menu where it doesn't). */
type Choice = { label: string; icon: IconName; selected: () => boolean; pick: () => void; shown?: () => boolean };
type Group = { label: string; value?: () => string; choices: Choice[] };

const set = <K extends keyof ViewOptions>(key: K, value: ViewOptions[K]) => () => {
  store.view = { ...store.view, [key]: value };
};
const flip = (key: "branch" | "harness" | "projectIcon" | "location") => () => {
  store.view = { ...store.view, [key]: !store.view[key] };
};

const GROUPS: Group[] = [
  {
    label: "Organize",
    value: () => ({ device: "By device", project: "By project", none: "None" })[store.view.organize],
    choices: [
      { label: "By device", icon: "laptop", selected: () => store.view.organize === "device", pick: set("organize", "device") },
      { label: "By project", icon: "folder", selected: () => store.view.organize === "project", pick: set("organize", "project") },
      { label: "None", icon: "list", selected: () => store.view.organize === "none", pick: set("organize", "none") },
    ],
  },
  {
    label: "Sort",
    value: () => (store.view.sort === "updated" ? "Last updated" : "Created"),
    choices: [
      { label: "Last updated", icon: "clock", selected: () => store.view.sort === "updated", pick: set("sort", "updated") },
      { label: "Created", icon: "calendar", selected: () => store.view.sort === "created", pick: set("sort", "created") },
    ],
  },
  {
    label: "Show",
    choices: [
      { label: "Branch", icon: "gitBranch", selected: () => store.view.branch, pick: flip("branch") },
      { label: "Harness", icon: "bot", selected: () => store.view.harness, pick: flip("harness") },
      { label: "Project icon", icon: "box", selected: () => store.view.projectIcon, pick: flip("projectIcon") },
      // Compact rows are the title line alone; cards under a project's header leave out the project line.
      { label: "Location", icon: "folder", selected: () => store.view.location, pick: flip("location"), shown: () => !store.view.compact && store.view.organize !== "project" },
    ],
  },
];

let open: Popover | null = null;

export function toggleViewMenu(trigger: HTMLElement) {
  if (open) return open.close();
  const card = el("div", "card view-menu");
  let sub: HTMLElement | null = null;
  let subGroup = -1;
  const rows: HTMLElement[] = [];

  // Picks update the open menu in place, so nothing re-animates.
  const values: (HTMLElement | null)[] = [];
  const marks: { choice: Choice; row: HTMLElement }[] = [];
  const apply = () => {
    persist();
    render("sidebar");
    GROUPS.forEach((g, gi) => g.value && values[gi] && (values[gi]!.textContent = g.value()));
    for (const { choice, row } of marks) {
      row.classList.toggle("selected", choice.selected());
      row.querySelector(".check-slot")!.replaceChildren(...(choice.selected() ? [icon("check")] : []));
    }
  };
  const closeSub = () => {
    sub?.remove();
    sub = null;
    subGroup = -1;
    rows.forEach((r) => r.classList.remove("open"));
  };
  // Menu aim: the way from a group to its open submenu crosses the rows beside it. A row the pointer enters while
  // heading into the submenu waits instead of taking over, and does once the pointer stops or turns away.
  const trail: { x: number; y: number }[] = [];
  let aimed: (() => void) | null = null;
  let aimTimer = 0;
  const track = (e: PointerEvent) => {
    const p = trail.at(-1);
    if (p && p.x === e.clientX && p.y === e.clientY) return;
    trail.push({ x: e.clientX, y: e.clientY });
    if (trail.length > 4) trail.shift();
  };
  // Whether the pointer moves inside the triangle from where it was a few moves ago to the submenu's near edge.
  const headingIn = () => {
    if (!sub || trail.length < 2) return false;
    const s = sub.getBoundingClientRect();
    const a = trail[0];
    const p = trail.at(-1)!;
    if (p.x <= a.x || s.left <= a.x) return false;
    const slope = (p.y - a.y) / (p.x - a.x);
    return slope >= (s.top - a.y) / (s.left - a.x) && slope <= (s.bottom - a.y) / (s.left - a.x);
  };
  const settle = () => {
    clearTimeout(aimTimer);
    aimed = null;
  };
  const aim = (fn: () => void) => {
    settle();
    if (!headingIn()) return fn();
    aimed = fn;
    aimTimer = window.setTimeout(() => {
      aimed = null;
      fn();
    }, 300);
  };
  card.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    track(e);
    if (sub?.contains(e.target as Node)) settle();
    else if (aimed) aim(aimed);
  });
  const hover = (fn: () => void) => (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    track(e);
    aim(fn);
  };

  const openSub = (gi: number, row: HTMLElement) => {
    if (subGroup === gi) return;
    closeSub();
    subGroup = gi;
    row.classList.add("open");
    const g = GROUPS[gi];
    sub = el("div", "card view-submenu menu-in-side");
    sub.append(menuHeading(g.label));
    marks.length = 0;
    for (const c of g.choices.filter((c) => c.shown?.() ?? true)) {
      const r = el("div", `menu-row${c.selected() ? " selected" : ""}`);
      const check = el("span", "check-slot");
      if (c.selected()) check.append(icon("check"));
      r.append(icon(c.icon, undefined, "lead"), el("span", "grow", c.label), check);
      r.onclick = (e) => {
        e.stopPropagation();
        c.pick();
        apply();
      };
      marks.push({ choice: c, row: r });
      sub.append(r);
    }
    row.append(sub);
  };

  function draw() {
    GROUPS.forEach((g, gi) => {
      if (gi === 2) card.append(menuSeparator());
      const row = el("div", "menu-row group");
      row.append(el("span", "grow", g.label));
      values[gi] = g.value ? el("span", "value", g.value()) : null;
      if (values[gi]) row.append(values[gi]!);
      row.append(icon("chevronRight", undefined, "chev"));
      // A mouse opens a group by pointing at it; a tap (which also "enters") leaves that to the click.
      row.onpointerenter = hover(() => openSub(gi, row));
      row.onclick = (e) => {
        if (sub?.contains(e.target as Node)) return;
        settle();
        if (subGroup === gi) closeSub();
        else openSub(gi, row);
      };
      rows.push(row);
      card.append(row);
    });
    card.append(menuSeparator());
    const switchRow = (label: string, key: "compact" | "jumpHints") => {
      const r = el("div", "menu-row");
      r.append(el("span", "grow", label), toggleSwitch(store.view[key]));
      r.onpointerenter = hover(closeSub);
      r.onclick = () => {
        store.view = { ...store.view, [key]: !store.view[key] };
        persist();
        render("sidebar");
        r.querySelector(".switch")!.classList.toggle("on", store.view[key]);
      };
      return r;
    };
    // Jump hints cover a row's status while the modifier is held; the Alt+N jumps work either way.
    // (Not on a phone: no keyboard to hold the modifier.)
    card.append(switchRow("Compact", "compact"));
    if (!isPhone()) card.append(switchRow("Jump hints", "jumpHints"));
  }

  draw();
  trigger.classList.add("open");
  // Opens to the right of the "…" button, top-aligned with it, so it never covers the session list. On a phone the
  // list fills the screen: there it drops below the button.
  const app = document.getElementById("app")!;
  const r = trigger.getBoundingClientRect();
  const a = app.getBoundingClientRect();
  if (isPhone()) {
    card.style.left = `${r.left - a.left}px`;
    card.style.top = `${r.bottom - a.top + 6}px`;
  } else {
    card.style.left = `${r.right - a.left + 8}px`;
    card.style.top = `${r.top - a.top}px`;
  }
  open = openPopover(app, card, {
    from: isPhone() ? "above" : "left",
    keep: [trigger],
    onClose: () => {
      settle();
      open = null;
      trigger.classList.remove("open");
    },
  });
}
