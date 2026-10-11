// Settings → General: where New project's folder browser opens, and what Enter and Ctrl+Enter do with a prompt
// while the agent is working (queue it for when the turn ends, or steer it in now), how the file explorer orders files,
// and whether the file editor takes Vim's keys.
import { el } from "./dom";
import { displayCombo } from "./keymap";
import { prefs, setPrefs, type FileSort, type WorkingSend } from "./prefs";
import { refresh } from "./settings";
import { call, tildePath } from "./store";
import { card, errorStrip, pageColumn, pageHeader, row, section, select, toggle } from "./widgets";

/** The base folder field: saved on Enter or leaving it once the core can list it; empty means home. */
function baseFolder(): HTMLElement[] {
  const input = el("input", "compact-input folder-input");
  input.spellcheck = false;
  input.placeholder = "~";
  input.value = prefs.projectsDir ?? "";
  input.setAttribute("aria-label", "Base project folder");
  const strip = el("div");
  let checking = 0;
  const save = async () => {
    const typed = input.value.trim();
    if (typed === (prefs.projectsDir ?? "")) return;
    if (!typed) {
      setPrefs({ projectsDir: null });
      return void strip.replaceChildren();
    }
    const n = ++checking;
    try {
      const { path } = await call("fs.list", { path: typed });
      if (n !== checking) return;
      setPrefs({ projectsDir: tildePath(path) });
      input.value = prefs.projectsDir!;
      input.classList.remove("invalid");
      strip.replaceChildren();
    } catch (err: any) {
      if (n !== checking) return;
      input.classList.add("invalid");
      strip.replaceChildren(errorStrip(String(err?.message ?? err)));
    }
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") void save();
    else if (e.key === "Escape" && input.value !== (prefs.projectsDir ?? "")) {
      e.stopPropagation(); // leave Settings open: this only undoes the edit
      input.value = prefs.projectsDir ?? "";
      input.classList.remove("invalid");
      strip.replaceChildren();
    }
  };
  input.onblur = () => void save();
  return [row("Base folder", ["Where New project starts browsing", "Empty for your home folder"], input), strip];
}

const SENDS: { id: WorkingSend; label: string }[] = [
  { id: "queue", label: "Queue" },
  { id: "steer", label: "Steer" },
];

/** One key's row; picking a behaviour gives the other key the other one. */
function sendKey(combo: "enter" | "mod-enter"): HTMLElement {
  const enter = combo === "enter";
  const current: WorkingSend = enter ? prefs.enterWhileWorking : prefs.enterWhileWorking === "queue" ? "steer" : "queue";
  const picker = select({
    options: SENDS.map((s) => ({ label: s.label })),
    selected: SENDS.findIndex((s) => s.id === current),
    width: 120,
    onSelect: (i) => {
      const picked = SENDS[i].id;
      setPrefs({ enterWhileWorking: enter ? picked : picked === "queue" ? "steer" : "queue" });
      refresh();
    },
  });
  const meta = current === "queue" ? "Holds the message until the current turn ends" : "Sends it into the running turn now, without stopping it";
  const empty = current === "steer" ? ["With an empty box, steers the newest queued message"] : [];
  return row(displayCombo(combo), [meta, ...empty], picker);
}

const SORTS: { id: FileSort; label: string; meta: string }[] = [
  { id: "name", label: "Name", meta: "Files in alphabetical order" },
  { id: "type", label: "Type", meta: "Files with the same extension together, then by name" },
];

function fileSort(): HTMLElement {
  const at = Math.max(0, SORTS.findIndex((s) => s.id === prefs.fileSort));
  const picker = select({
    options: SORTS.map((s) => ({ label: s.label })),
    selected: at,
    width: 120,
    onSelect: (i) => {
      setPrefs({ fileSort: SORTS[i].id });
      refresh();
    },
  });
  return row("Sort files by", [SORTS[at].meta, "Folders always come first"], picker);
}

function vimKeys(): HTMLElement {
  const meta = [`Normal, insert and visual modes in the file editor`, `${displayCombo("alt-j")} and ${displayCombo("alt-k")} move lines, with Shift they copy them`];
  return row("Vim keys", meta, toggle(prefs.vimKeys, "Vim keys", (on) => setPrefs({ vimKeys: on })));
}

export function renderGeneral(): HTMLElement {
  const page = pageColumn();
  const folders = section("Projects", card(...baseFolder()));
  folders.classList.add("first");
  const sending = section("While the agent works", card(sendKey("enter"), sendKey("mod-enter")));
  const files = section("Files", card(fileSort(), vimKeys()));
  page.append(pageHeader("General"), folders, sending, files);
  return page;
}
