// Settings page building blocks (Zeron's settings/widgets.rs): page column and header, sections, filled cards
// of rows, switches, select dropdowns, action buttons, option cards and the error strip.
import { el } from "./dom";
import { icon, type IconName } from "./icons";
import { openPopover, toggleSwitch, type Popover } from "./popover";

export const pageColumn = () => el("div", "s-page");

export function pageHeader(title: string): HTMLElement {
  const h = el("div", "s-header");
  h.append(el("div", "s-title", title));
  return h;
}

export const pageSubtitle = (text: string) => el("div", "s-subtitle", text);

/** A muted label above a block, 32px below the previous one. */
export function section(label: string, ...blocks: HTMLElement[]): HTMLElement {
  const s = el("div", "s-section");
  s.append(el("div", "s-section-label", label), ...blocks);
  return s;
}

/** A filled, rounded block of rows split by inset hairlines. */
export function card(...rows: HTMLElement[]): HTMLElement {
  const c = el("div", "s-card");
  c.append(...rows);
  return c;
}

/** One row: title and muted meta on the left, controls on the right. */
export function row(title: string, meta: (string | Node)[] | null, ...controls: HTMLElement[]): HTMLElement {
  const r = el("div", "s-row");
  r.append(rowText(title, meta), ...controls);
  return r;
}

export function rowText(title: string, meta: (string | Node)[] | null): HTMLElement {
  const text = el("div", "s-row-text");
  text.append(el("div", "s-row-title", title));
  if (meta?.length) text.append(metaLine(meta));
  return text;
}

/** Fragments joined by faint middots. */
export function metaLine(parts: (string | Node)[]): HTMLElement {
  const line = el("div", "s-meta");
  parts.forEach((p, i) => {
    if (i) line.append(el("span", "s-dot", "·"));
    line.append(typeof p === "string" ? el("span", "", p) : p);
  });
  return line;
}

export function toggle(on: boolean, label: string, onChange: (next: boolean) => void): HTMLButtonElement {
  const b = el("button", "s-switch");
  b.setAttribute("role", "switch");
  b.setAttribute("aria-label", label);
  b.setAttribute("aria-checked", String(on));
  const sw = toggleSwitch(on);
  b.append(sw);
  b.onclick = () => {
    on = !on;
    sw.classList.toggle("on", on);
    b.setAttribute("aria-checked", String(on));
    onChange(on);
  };
  return b;
}

export type Tone = "quiet" | "filled" | "solid" | "danger";
export function action(label: string, tone: Tone, onClick: () => void, iconName?: IconName): HTMLButtonElement {
  const b = el("button", `s-action ${tone}`);
  if (iconName) b.append(icon(iconName));
  b.append(label);
  b.onclick = onClick;
  return b;
}

/** A quiet Copy action whose icon turns to a check for a moment once the text is on the clipboard. */
export function copyAction(text: () => string): HTMLButtonElement {
  const b = el("button", "s-action quiet copy-action");
  const glyphs = el("span", "copy-swap");
  glyphs.append(icon("copy"), icon("check"));
  b.append(glyphs, "Copy");
  let timer: ReturnType<typeof setTimeout> | undefined;
  b.onclick = () =>
    void navigator.clipboard.writeText(text()).then(() => {
      b.classList.add("copied");
      clearTimeout(timer);
      timer = setTimeout(() => b.classList.remove("copied"), 1400);
    }, () => {});
  return b;
}

export function errorStrip(text: string): HTMLElement {
  const s = el("div", "s-error");
  s.append(icon("triangleAlert"), el("span", "", text));
  return s;
}

/** A preview frame with a caption; the selected one takes the accent edge. */
export function optionCard(iconName: IconName, label: string, selected: boolean, preview: HTMLElement, onClick: () => void): HTMLElement {
  const c = el("button", `s-option${selected ? " selected" : ""}`);
  const frame = el("div", "s-option-frame");
  frame.append(preview);
  const caption = el("div", "s-option-caption");
  caption.append(icon(iconName), label);
  c.append(frame, caption);
  c.onclick = onClick;
  return c;
}

// ---------------- select ----------------

/** `trailing`: drawn after the label, before the check (a count, filled in when it's read). */
export type Option = { label: string; leading?: () => HTMLElement; trailing?: () => HTMLElement; disabled?: boolean };
type SelectOpts = {
  options: Option[];
  selected: number;
  width?: number;
  menuWidth?: number;
  heading?: string;
  /** A filter field above the list (the font pickers). */
  search?: boolean;
  mono?: boolean;
  onSelect: (index: number) => void;
  /** Its list closed (chosen from or not). */
  onClose?: () => void;
};

let openSelect: Popover | null = null;
export const closeSelect = () => openSelect?.close();

/** A borderless filled pill showing the value, opening a check-marked list. */
export function select(opts: SelectOpts): HTMLButtonElement {
  const trigger = el("button", `s-select${opts.mono ? " mono" : ""}`);
  if (opts.width) trigger.style.width = `${opts.width}px`;
  const current = opts.options[opts.selected];
  if (current?.leading) trigger.append(current.leading());
  trigger.append(el("span", "s-select-value", current?.label ?? ""), icon("chevronDown", undefined, "s-chev"));
  trigger.onclick = () => {
    if (trigger.classList.contains("open")) return closeSelect();
    closeSelect();
    showMenu(trigger, opts);
  };
  trigger.onkeydown = (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !trigger.classList.contains("open")) {
      e.preventDefault();
      showMenu(trigger, opts);
    }
  };
  return trigger;
}

function showMenu(trigger: HTMLElement, opts: SelectOpts) {
  const rect = trigger.getBoundingClientRect();
  const menu = el("div", `card s-menu${opts.mono ? " mono" : ""}`);
  const minWidth = Math.max(160, opts.menuWidth ?? rect.width);
  // With something after the labels (counts), the menu grows to fit them rather than cutting the labels short.
  const fit = opts.options.some((o) => o.trailing);
  if (fit) (menu.style.minWidth = `${minWidth}px`), (menu.style.width = "max-content"), (menu.style.maxWidth = `${innerWidth - 16}px`);
  else menu.style.width = `${minWidth}px`;
  let query = "";
  let highlighted = opts.selected;
  let visible: number[] = [];
  const list = el("div", "s-menu-list");
  const rows: HTMLElement[] = [];
  const paint = () => {
    visible = opts.options.map((_, i) => i).filter((i) => !query || opts.options[i].label.toLowerCase().includes(query));
    if (!visible.includes(highlighted)) highlighted = visible[0] ?? -1;
    rows.length = 0;
    list.replaceChildren(
      ...visible.map((i) => {
        const o = opts.options[i];
        const r = el("div", `menu-row s-menu-row${i === highlighted ? " active" : ""}${o.disabled ? " disabled" : ""}`);
        if (o.leading) r.append(o.leading());
        r.append(el("span", "grow", o.label));
        if (o.trailing) r.append(o.trailing());
        const check = el("span", "s-check");
        if (i === opts.selected) check.append(icon("check"));
        r.append(check);
        r.onpointerenter = () => setHighlight(i);
        r.onclick = () => choose(i);
        rows[i] = r;
        return r;
      }),
    );
    if (!visible.length) list.append(el("div", "s-menu-empty", query ? "No matches" : "Nothing to choose"));
  };
  const setHighlight = (i: number) => {
    rows[highlighted]?.classList.remove("active");
    highlighted = i;
    rows[i]?.classList.add("active");
  };
  const choose = (i: number) => {
    if (opts.options[i]?.disabled) return;
    pop.close();
    if (i !== opts.selected) opts.onSelect(i);
  };
  if (opts.heading) menu.append(el("div", "menu-heading", opts.heading));
  let input: HTMLInputElement | null = null;
  if (opts.search) {
    const frame = el("div", "s-menu-search");
    input = el("input");
    input.placeholder = "Search";
    input.oninput = () => {
      query = input!.value.trim().toLowerCase();
      paint();
    };
    frame.append(icon("search"), input);
    menu.append(frame);
  }
  menu.append(list);
  paint();

  // Fixed to the viewport so the page's scroll box doesn't clip it; below the trigger unless only above fits.
  const host = document.getElementById("settings") ?? document.body;
  menu.style.position = "fixed";
  const place = () => (menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - (menu.offsetWidth || minWidth) - 8))}px`);
  place();
  const below = innerHeight - rect.bottom - 14;
  const above = rect.top - 14;
  const up = below < 200 && above > below;
  list.style.maxHeight = `${Math.min(320, up ? above : below) - (opts.search ? 48 : 8) - (opts.heading ? 26 : 0)}px`;
  if (up) menu.style.bottom = `${innerHeight - rect.top + 6}px`;
  else menu.style.top = `${rect.bottom + 6}px`;

  trigger.classList.add("open");
  const pop = openPopover(host, menu, {
    from: up ? "below" : "above",
    keep: [trigger],
    onClose: () => {
      trigger.classList.remove("open");
      if (openSelect === pop) openSelect = null;
      removeEventListener("resize", dismiss);
      scroller?.removeEventListener("scroll", dismiss);
      grew?.disconnect();
      opts.onClose?.();
    },
  });
  openSelect = pop;
  // Kept inside the window once it's measured, and again as counts filled in later widen it.
  place();
  const grew = fit ? new ResizeObserver(place) : null;
  grew?.observe(menu);
  const dismiss = () => pop.close();
  const scroller = trigger.closest<HTMLElement>(".s-scroll");
  addEventListener("resize", dismiss);
  scroller?.addEventListener("scroll", dismiss, { passive: true });
  rows[highlighted]?.scrollIntoView({ block: "nearest" });
  (input ?? menu).focus({ preventScroll: true });
  menu.addEventListener("keydown", (e) => {
    const at = visible.indexOf(highlighted);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = visible[(at + (e.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length];
      if (next !== undefined) setHighlight(next), rows[next]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlighted >= 0) choose(highlighted);
    }
  });
}

/** A small modal: title, body, and actions (the last is the default). Escape or a click outside cancels. */
export function dialog(title: string, body: HTMLElement | string, buttons: [string, "filled" | "solid" | "danger", () => void][]) {
  const scrim = el("div", "s-scrim");
  const box = el("div", "s-dialog small-dialog");
  box.tabIndex = -1;
  const close = () => {
    scrim.remove();
    removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  addEventListener("keydown", onKey, true);
  scrim.onpointerdown = (e) => e.target === scrim && close();
  const footer = el("div", "s-dialog-footer");
  footer.append(...buttons.map(([label, tone, run]) => action(label, tone, () => (close(), run()))));
  box.append(el("div", "s-dialog-title", title), typeof body === "string" ? el("div", "s-dialog-body", body) : body, footer);
  scrim.append(box);
  document.body.append(scrim);
  (footer.lastElementChild as HTMLElement).focus();
}
