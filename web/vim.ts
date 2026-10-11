// Vim keys as the user has them in Cursor (VSCodeVim's settings.json): their mappings, Ctrl keys left to the editor
// and the app but for the few Vim keeps, and the system clipboard as the unnamed register. Vim's state is global, so
// this runs once, the first time an editor takes Vim keys.
import type { EditorView } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";

type Map = [lhs: string, rhs: string, ctx?: "normal" | "visual" | "operatorPending"];

/** vim.normalModeKeyBindingsNonRecursive and the rest, less what needs an extension (EasyMotion, surround) or a
 *  VS Code command bismuth hasn't got (peek definition, the problems list). */
const NOREMAP: Map[] = [
  // Deleting and changing don't overwrite what was yanked (the black hole register).
  ['d', '"_d', "normal"],
  ['D', '"_D', "normal"],
  ['c', '"_c', "normal"],
  ['s', '"_s', "normal"],
  ['d', '"_d', "visual"],
  ['D', '"_D', "visual"],
  ['c', '"_c', "visual"],
  // Tab and Shift+Tab indent the line (or the selection, kept selected).
  ["<Tab>", ">>", "normal"],
  ["<S-Tab>", "<<", "normal"],
  ["<Tab>", ">gv", "visual"],
  ["<S-Tab>", "<gv", "visual"],
  ["gc", "gcc", "normal"],
  ["K", "@@", "normal"],
  ["z", "zz", "normal"],
  // Space f: an f-string, the f before the quote behind the cursor.
  ["<Space>f", 'F"if<Esc>', "normal"],
  // Operators on the brackets or quotes inside (( [ { " '), or around () ] }: as Cursor has them, ")" too).
  ["(", "i(", "operatorPending"],
  ["[", "i[", "operatorPending"],
  ["{", "i{", "operatorPending"],
  ['"', 'i"', "operatorPending"],
  ["'", "i'", "operatorPending"],
  [")", "a]", "operatorPending"],
  ["]", "a]", "operatorPending"],
  ["}", "a}", "operatorPending"],
];

/** vim.normalModeKeyBindings and its operator-pending and visual ones: a Spanish keyboard's keys for ^ ; and ,. */
const MAP: Map[] = [
  ["·", "^", "normal"],
  ["ñ", ";", "normal"],
  ["Ñ", ",", "normal"],
  ["·", "^", "operatorPending"],
  ["·", "^", "visual"],
];

/** vim.useCtrlKeys off: Vim's own Ctrl keys go, so Ctrl+C copies, Ctrl+V pastes, Ctrl+D and Ctrl+W are the app's.
 *  vim.handleKeys keeps Ctrl+E (scroll), Ctrl+O (back in the jump list) and Ctrl+R (redo). Ctrl+[ stays Escape.
 *  And vim.leader is Space: it only starts a leader mapping (Space f), no longer also moving right, which would win. */
const DROPPED: [string, string?][] = [
  ["<Space>"],
  ["<C-Space>"],
  ["<C-BS>"],
  ["<C-n>"],
  ["<C-p>"],
  ["<C-c>"],
  ["<C-c>", "insert"],
  ["<C-f>"],
  ["<C-b>"],
  ["<C-d>"],
  ["<C-u>"],
  ["<C-u>", "insert"],
  ["<C-w>", "insert"],
  ["<C-w>", "normal"],
  ["<C-i>"],
  ["<C-y>"],
  ["<C-v>"],
  ["<C-q>"],
  ["<C-a>"],
  ["<C-x>"],
  ["<C-t>", "insert"],
  ["<C-d>", "insert"],
];

/** vim.useSystemClipboard: what's yanked or deleted (not into the black hole) goes to the system clipboard too, and
 *  p and P put what's there, whatever copied it; text copied from elsewhere goes in by lines when it ends with one. */
function systemClipboard() {
  const registers = Vim.getRegisterController();
  const push = registers.pushText.bind(registers);
  registers.pushText = (name: string | null | undefined, operator: string, text: string, linewise?: boolean, blockwise?: boolean) => {
    push(name, operator, text, linewise, blockwise);
    if (name === "_" || (name && name !== '"' && name !== "+")) return;
    void navigator.clipboard.writeText(registers.unnamedRegister.toString()).catch(() => {});
  };
  Vim.defineAction("paste", function (this: any, cm: any, args: any, vim: any) {
    const name = args.registerName;
    const register = registers.getRegister(name);
    if (name && name !== '"' && name !== "+") return this.continuePaste(cm, args, vim, register.toString(), register);
    navigator.clipboard.readText().then(
      (text) => {
        if (text && text !== register.toString()) register.setText(text, text.endsWith("\n"));
        this.continuePaste(cm, args, vim, register.toString(), register);
      },
      () => this.continuePaste(cm, args, vim, register.toString(), register),
    );
  });
}

let set = false;
/** `definition`: go to definition from an editor's caret, for gd (VSCodeVim's: Vim's own only searches the file). */
export function setUpVim(definition: (view: EditorView) => void) {
  if (set) return;
  set = true;
  for (const [keys, ctx] of DROPPED) Vim.unmap(keys, ctx as string);
  for (const [lhs, rhs, ctx] of NOREMAP) Vim.noremap(lhs, rhs, ctx as string);
  for (const [lhs, rhs, ctx] of MAP) Vim.map(lhs, rhs, ctx as string);
  systemClipboard();
  Vim.defineAction("goToDefinition", (cm: any) => definition(cm.cm6));
  Vim.mapCommand("gd", "action", "goToDefinition", {}, { context: "normal" });
}
