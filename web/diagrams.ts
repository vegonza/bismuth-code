// Mermaid diagrams in Markdown: a ```mermaid block is drawn in the theme's colours once mermaid has loaded (its own
// chunk, fetched the first time a diagram shows). Until then, and when the source doesn't parse (a block still
// streaming in, a typo), the block stays code.
import { el, middleCopy } from "./dom";
import { loadMermaid } from "./lazy";
import { activeTheme, css, flatten, onTheme, type Color } from "./theme";

type Mermaid = typeof import("./lazy/mermaid").default;
let loading: Promise<Mermaid> | null = null;
/** The palette the diagrams were configured with: a new one draws them again. */
let configured = "";
/** Drawings by palette and source, so a re-render (a streamed message, a file reloaded) doesn't redraw. */
const drawn = new Map<string, string | null>();
/** One drawing at a time: mermaid's layout measures in shared scratch elements. */
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

function palette() {
  const t = activeTheme();
  const on = (c: Color) => css(flatten(c, t.shell));
  const style = getComputedStyle(document.documentElement);
  return {
    darkMode: t.appearance === "dark",
    background: css(t.shell),
    fontFamily: style.getPropertyValue("--sans").trim() || "sans-serif",
    fontSize: "14px",
    primaryColor: on(t.accentWash),
    primaryBorderColor: css(t.accent),
    primaryTextColor: css(t.text),
    secondaryColor: on(t.hover),
    secondaryBorderColor: on(t.borderStrong),
    secondaryTextColor: css(t.text),
    tertiaryColor: on(t.border),
    tertiaryBorderColor: on(t.borderStrong),
    tertiaryTextColor: css(t.text),
    lineColor: css(t.muted),
    textColor: css(t.text),
    noteBkgColor: on(t.hover),
    noteBorderColor: on(t.borderStrong),
    noteTextColor: css(t.text),
    edgeLabelBackground: css(t.shell),
    clusterBkg: on(t.border),
    clusterBorder: on(t.borderStrong),
    // Flat, as the rest of the window is.
    dropShadow: "none",
  };
}

async function draw(source: string): Promise<string | null> {
  const vars = palette();
  const key = JSON.stringify(vars);
  const known = drawn.get(key + source);
  if (known !== undefined) return known;
  loading ??= loadMermaid().then((m) => m.default);
  const mermaid = await loading;
  const job = queue.then(async () => {
    if (configured !== key) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base", look: "classic", themeVariables: vars, fontFamily: vars.fontFamily });
      configured = key;
    }
    try {
      if (!(await mermaid.parse(source, { suppressErrors: true }))) return null;
      return (await mermaid.render(`mermaid-${++seq}`, source)).svg;
    } catch {
      return null;
    } finally {
      // A failed render leaves its scratch element behind.
      document.getElementById(`dmermaid-${seq}`)?.remove();
    }
  });
  queue = job;
  const svg = await job;
  drawn.set(key + source, svg);
  if (drawn.size > 200) drawn.delete(drawn.keys().next().value!);
  return svg;
}

/** The drawing at its own size (mermaid fits it to the column, which shrinks a wide one's text past reading): the
 *  view scrolls sideways instead. */
function show(view: HTMLElement, svg: string, vars: string) {
  const copy = view.querySelector(":scope > .code-action");
  view.innerHTML = svg;
  view.dataset.palette = vars;
  if (copy) view.append(copy);
  const drawing = view.querySelector("svg");
  if (drawing?.style.maxWidth) {
    drawing.style.width = drawing.style.maxWidth;
    drawing.style.maxWidth = "none";
  }
}

/** The ```mermaid blocks under `root` (code frames, see markdown.ts) drawn as diagrams; and diagrams there drawn in
 *  an earlier palette (a preview kept off screen while the theme changed) drawn again. */
export function diagrams(root: HTMLElement) {
  const frames = root.querySelectorAll<HTMLElement>(".code-block[data-mermaid]");
  const views = root.querySelectorAll<HTMLElement>(".mermaid-view");
  if (!frames.length && !views.length) return;
  const vars = JSON.stringify(palette());
  frames.forEach((frame) => {
    const source = frame.querySelector("code")?.textContent ?? "";
    const view = el("div", "mermaid-view");
    view.dataset.source = source;
    // The source stays at hand: the frame's copy button moves onto the drawing.
    const copy = frame.querySelector<HTMLElement>(".code-action");
    if (copy) {
      view.append(copy);
      middleCopy(view, copy);
    }
    const into = () => frame.replaceWith(view);
    // Drawn before (a file shown again): in at once, so what's laid out (and scrolled to) is the drawing.
    if (!redraw(view, vars, into)) void draw(source).then((svg) => svg && frame.isConnected && (show(view, svg, vars), into()));
  });
  views.forEach((view) => {
    if (view.dataset.palette === vars || redraw(view, vars)) return;
    void draw(view.dataset.source ?? "").then((svg) => svg && show(view, svg, vars));
  });
}

/** `view` drawn from what's known in the palette `vars`, if it is: whether it was. */
function redraw(view: HTMLElement, vars: string, then?: () => void): boolean {
  const known = drawn.get(vars + (view.dataset.source ?? ""));
  if (!known) return false;
  show(view, known, vars);
  then?.();
  return true;
}

// A new palette draws every diagram on screen again.
onTheme(() => {
  const vars = JSON.stringify(palette());
  document.querySelectorAll<HTMLElement>(".mermaid-view").forEach((view) => {
    void draw(view.dataset.source ?? "").then((svg) => {
      if (svg && view.isConnected) show(view, svg, vars);
    });
  });
});
