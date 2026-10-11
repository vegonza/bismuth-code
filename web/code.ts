// The file editor (CodeMirror 6, kept plain): typing, undo and redo, the usual selection and clipboard keys, the
// language's colours from the theme's syntax palette, and go to definition (Mod+click or F12). Each open file keeps
// its own state, so its undo history survives switching tabs.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { csharp, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { gitChanges, reviewDiff } from "./gitdiff";

/** Past this the editor shows the text without colours: parsing it would stall typing. */
const HIGHLIGHT_MAX = 300_000;
/** CodeMirror's editing keys, less Ctrl+M (its tab focus mode): that's the app's, source ⇄ preview. */
const editKeys = defaultKeymap.filter((b) => b.key !== "Ctrl-m");

export type CodeHooks = {
  /** The text changed (by typing, not by a reload from disk). */
  edited: () => void;
  /** Go to definition at a document offset. */
  definition: (pos: number) => void;
  /** Whether the text differs from git's copy, or its changes show, went one way or the other. */
  changes: () => void;
};

function languageFor(path: string): LanguageSupport | StreamLanguage<unknown> | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return StreamLanguage.define(dockerFile);
  if (/^(\.?(bash|zsh)rc|\.?profile|makefile|pkgbuild)$/.test(name)) return StreamLanguage.define(shell);
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
    case "json5":
      return json();
    case "py":
    case "pyi":
      return python();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return html();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "rs":
      return rust();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
      return cpp();
    case "go":
      return go();
    case "java":
      return java();
    case "yml":
    case "yaml":
      return yaml();
    case "xml":
    case "svg":
    case "plist":
      return xml();
    case "sql":
      return sql();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return StreamLanguage.define(shell);
    case "toml":
      return StreamLanguage.define(toml);
    case "ini":
    case "cfg":
    case "conf":
    case "properties":
    case "env":
      return StreamLanguage.define(properties);
    case "lua":
      return StreamLanguage.define(lua);
    case "rb":
      return StreamLanguage.define(ruby);
    case "swift":
      return StreamLanguage.define(swift);
    case "kt":
    case "kts":
      return StreamLanguage.define(kotlin);
    case "cs":
      return StreamLanguage.define(csharp);
    case "scala":
      return StreamLanguage.define(scala);
    case "diff":
    case "patch":
      return StreamLanguage.define(diff);
  }
  return null;
}

/** The viewer's syntax colours (style.css's .hljs rules), by Lezer tag. */
const colours = HighlightStyle.define([
  { tag: [t.comment, t.quote], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted, t.character], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: "var(--syn-number)" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "var(--syn-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.heading, t.macroName], color: "var(--syn-function)" },
  { tag: [t.tagName, t.deleted], color: "var(--syn-tag)" },
  { tag: [t.attributeName, t.propertyName, t.constant(t.variableName)], color: "var(--syn-attr)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--muted)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.link, textDecoration: "underline" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--code-size)", color: "var(--text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6", overflow: "auto" },
  // Clear of the fade under the host's tabs.
  ".cm-content": { padding: "12px 0 24px", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 24px 0 4px" },
  ".cm-gutters": { backgroundColor: "var(--main)", color: "rgba(var(--faint-rgb), 0.8)", border: "none", userSelect: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", minWidth: "0" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-activeLine": { backgroundColor: "rgba(var(--wash-rgb), 0.035)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)", borderLeftWidth: "1.5px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(var(--accent-rgb), 0.28) !important" },
  ".cm-def-link": { textDecoration: "underline", textUnderlineOffset: "2px", cursor: "pointer", color: "var(--accent)" },
});

const IDENT = /[\p{L}\p{N}_$]/u;
/** The word under an offset, as [from, to], or null. */
function wordRange(state: EditorState, pos: number): [number, number] | null {
  const line = state.doc.lineAt(pos);
  let a = pos - line.from;
  let b = a;
  const text = line.text;
  while (a > 0 && IDENT.test(text[a - 1])) a--;
  while (b < text.length && IDENT.test(text[b])) b++;
  return a < b ? [line.from + a, line.from + b] : null;
}

/** Holding Mod over a word underlines it as a link (VS Code's), which a click follows. */
function definitionLinks(hooks: CodeHooks): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      range: [number, number] | null = null;
      constructor(readonly view: EditorView) {}
      update(u: ViewUpdate) {
        // Typing under the link drops it (within this update: no new one asked for).
        if (u.docChanged && this.range) (this.range = null), (this.decorations = Decoration.none);
      }
      set(range: [number, number] | null) {
        if (range?.[0] === this.range?.[0] && range?.[1] === this.range?.[1]) return;
        this.range = range;
        const b = new RangeSetBuilder<Decoration>();
        if (range) b.add(range[0], range[1], Decoration.mark({ class: "cm-def-link" }));
        this.decorations = b.finish();
        // Outside an update: ask for one so the mark shows.
        this.view.dispatch({});
      }
    },
    { decorations: (v) => v.decorations },
  );
  const mod = (e: MouseEvent | KeyboardEvent) => (/Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey);
  const hover = (view: EditorView, e: MouseEvent) => {
    const p = view.plugin(plugin);
    if (!p) return;
    const pos = mod(e) ? view.posAtCoords({ x: e.clientX, y: e.clientY }, false) : null;
    p.set(pos === null ? null : wordRange(view.state, pos));
  };
  return [
    plugin,
    EditorView.domEventHandlers({
      mousemove: (e, view) => hover(view, e),
      mouseleave: (_e, view) => view.plugin(plugin)?.set(null),
      keyup: (e, view) => {
        if (e.key === "Control" || e.key === "Meta") view.plugin(plugin)?.set(null);
      },
      mousedown: (e, view) => {
        if (e.button !== 0 || !mod(e)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        if (pos === null || !wordRange(view.state, pos)) return false;
        e.preventDefault();
        view.dispatch({ selection: { anchor: pos } });
        hooks.definition(pos);
        return true;
      },
    }),
  ];
}

/** A file's editor state: its text (CRLF files keep their line breaks) with the language's colours. */
export function codeState(text: string, path: string, hooks: CodeHooks): EditorState {
  const lang = text.length <= HIGHLIGHT_MAX ? languageFor(path) : null;
  const tabs = /^\t/m.test(text) && !/^ {2,}\S/m.test(text);
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      gitChanges(hooks.changes),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(false),
      text.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
      indentUnit.of(tabs ? "\t" : "  "),
      EditorState.tabSize.of(4),
      lang ?? [],
      syntaxHighlighting(colours),
      theme,
      definitionLinks(hooks),
      keymap.of([
        { key: "F12", preventDefault: true, run: (v) => (hooks.definition(v.state.selection.main.head), true) },
        ...editKeys,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("undo") || tr.isUserEvent("redo") || tr.isUserEvent("move") || tr.isUserEvent("revert"))) hooks.edited();
      }),
    ],
  });
}

/** A notebook cell's language (its kernel's), as a file extension languageFor knows. */
const CELL_EXT: Record<string, string> = { python: "py", javascript: "js", typescript: "ts", markdown: "md", sql: "sql", rust: "rs", go: "go", java: "java", bash: "sh", sh: "sh", shell: "sh", scala: "scala", kotlin: "kt", ruby: "rb", lua: "lua", "c++": "cpp", cpp: "cpp", c: "c", "c#": "cs", csharp: "cs", swift: "swift", json: "json", yaml: "yaml", html: "html", css: "css" };

const cellTheme = EditorView.theme({
  "&": { fontSize: "var(--code-size)", color: "var(--text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6", overflow: "visible" },
  ".cm-content": { padding: "0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)", borderLeftWidth: "1.5px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(var(--accent-rgb), 0.28) !important" },
  ".cm-placeholder": { color: "var(--faint)" },
});

/** A notebook cell's editor in `parent`: the language's colours, undo, Tab indents, long lines wrap, and it grows
 *  with its text. Escape or Shift/Mod+Enter leaves it. */
export function cellEditor(parent: HTMLElement, text: string, language: string, on: { change(text: string): void; leave(): void }): EditorView {
  const ext = CELL_EXT[language.toLowerCase()];
  const lang = ext && text.length <= HIGHLIGHT_MAX ? languageFor(`cell.${ext}`) : null;
  const leave = () => (on.leave(), true);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        drawSelection(),
        highlightSpecialChars(),
        EditorState.allowMultipleSelections.of(false),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        EditorView.lineWrapping,
        lang ?? [],
        syntaxHighlighting(colours),
        cellTheme,
        keymap.of([{ key: "Escape", run: leave }, { key: "Shift-Enter", run: leave }, { key: "Mod-Enter", run: leave }, ...editKeys, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => u.docChanged && on.change(u.state.doc.toString())),
      ],
    }),
  });
}

/** A file's changes to review, read-only in `parent`: `after` against `before`, with the language's colours, as tall
 *  as it is (what holds it scrolls). */
export function diffView(parent: HTMLElement, before: string, after: string, path: string): EditorView {
  const lang = after.length <= HIGHLIGHT_MAX && before.length <= HIGHLIGHT_MAX ? languageFor(path) : null;
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: after,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        after.includes("\r\n") ? EditorState.lineSeparator.of("\r\n") : [],
        lang ?? [],
        syntaxHighlighting(colours),
        theme,
        reviewTheme,
        reviewDiff(before),
      ],
    }),
  });
}

const reviewTheme = EditorView.theme({
  "&": { height: "auto" },
  ".cm-scroller": { overflowY: "hidden" },
  ".cm-content": { padding: "4px 0" },
});

/** The editor for a state, in `parent`. */
export function codeView(state: EditorState, parent: HTMLElement): EditorView {
  return new EditorView({ state, parent });
}

export { EditorView, type EditorState };
