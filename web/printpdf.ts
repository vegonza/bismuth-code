// A LaTeX or Markdown preview saved as a PDF: the preview as it shows, in the light theme's colours on white A4
// pages, saved where the user picks. The desktop shell prints it (desktop/main.ts) with Chromium, so the text stays
// selectable and the maths sharp; a plain browser (`bun start`) can't make one without a print dialog, so there it
// isn't offered.
import { picturesIn } from "./dom";
import { lightVars } from "./theme";

const PAGE_CSS = `
@page { size: A4; margin: 18mm 16mm 20mm; }
html, body { height: auto; overflow: visible; background: #fff; }
/* The theme's color-scheme comes along in the root's style: a dark one paints the page margins black. */
html { color-scheme: light !important; }
body > .fv-latex, body > .fv-markdown { max-width: none; margin: 0; padding: 0; }
.code-action { display: none; }
:is(h1, h2, h3, h4, h5, h6) { break-after: avoid; }
:is(pre, .code-block, table, figure, img, blockquote, .katex-display) { break-inside: avoid; }
`;

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The page to print: the app's own stylesheets, the preview's copy, the light theme. */
function printable(preview: HTMLElement, title: string): string {
  const copy = preview.cloneNode(true) as HTMLElement;
  // What's drawn on a canvas (a PDF figure) doesn't come with the copy: it goes as a picture.
  const drawn = preview.querySelectorAll("canvas");
  copy.querySelectorAll("canvas").forEach((c, i) => {
    const img = document.createElement("img");
    img.src = drawn[i].toDataURL();
    img.className = c.className;
    img.style.cssText = c.style.cssText;
    c.replaceWith(img);
  });
  const sheets = [...document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')]
    .map((s) => (s instanceof HTMLLinkElement ? `<link rel="stylesheet" href="${attr(s.href)}">` : s.outerHTML))
    .join("");
  // The fonts picked stay (they're on the root too); the colours are the light theme's, the text its default size.
  const root = document.createElement("html");
  root.style.cssText = document.documentElement.style.cssText;
  for (const [k, v] of Object.entries({ ...lightVars(), "--fs": "1" })) root.style.setProperty(k, v);
  return `<!doctype html><html lang="en" data-appearance="light" style="${attr(root.style.cssText)}"><head><meta charset="utf-8"><title>${attr(title)}</title>${sheets}<style>${PAGE_CSS}</style></head><body>${copy.outerHTML}</body></html>`;
}

type Desktop = { savePdf(html: string, name: string): Promise<string | null> };
const desktop = (window as { bismuthDesktop?: Desktop }).bismuthDesktop;

/** Whether PDFs can be saved here: in the desktop app (once it's been reopened since the feature came in). */
export const canSavePdf = () => !!desktop;

/** `preview` saved as `name` (a .pdf) where the user picks; resolves to where, or null if they cancelled. A preview
 *  that isn't on screen (asked for from the source) is drawn out of sight first, its figures given time to arrive. */
export async function savePdf(preview: HTMLElement, name: string): Promise<string | null> {
  if (!desktop) throw new Error("Saving a PDF needs the desktop app");
  let stage: HTMLElement | null = null;
  if (!preview.isConnected) {
    stage = document.createElement("div");
    stage.style.cssText = "position: fixed; left: -10000px; top: 0; width: 860px; visibility: hidden; pointer-events: none";
    stage.append(preview);
    document.body.append(stage);
  }
  try {
    await picturesIn(preview, 8000);
    return await desktop.savePdf(printable(preview, name.replace(/\.pdf$/, "")), name);
  } finally {
    stage?.remove();
  }
}
