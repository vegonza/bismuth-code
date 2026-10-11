// Maths in Markdown, as GitHub and Jupyter write it: $…$ and \(…\) inline, $$…$$ and \[…\] displayed, typeset by
// KaTeX. A $ only opens maths before a non-space and closes after one, never just before a digit, and the next $ must
// close it ("$5 and $10" stays prose); code spans and blocks are left alone, and inline maths KaTeX can't read stays
// the text it was.
import katex from "katex";
import type { MarkedExtension, Tokens } from "marked";
import "./katex.css";

const typeset = (tex: string, display: boolean, strict = false) =>
  katex.renderToString(tex, { displayMode: display, throwOnError: strict, strict: "ignore", trust: false, output: "html" });

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The end of inline $…$ maths opened at 0, or -1. */
function closing(src: string): number {
  if (!src[1] || /\s/.test(src[1])) return -1;
  for (let i = 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "`" || (c === "\n" && src[i + 1] === "\n")) return -1;
    else if (c === "$") return !/\s/.test(src[i - 1]) && !/\d/.test(src[i + 1] ?? "") ? i : -1;
  }
  return -1;
}

type Math = Tokens.Generic & { text: string; display: boolean };

export const mathExtension: MarkedExtension = {
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start: (src) => src.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
      tokenizer(src) {
        const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(src);
        if (m) return { type: "mathBlock", raw: m[0], text: (m[1] ?? m[2]).trim(), display: true } satisfies Math;
      },
      renderer: (t) => `<div class="math-display">${typeset((t as Math).text, true)}</div>\n`,
    },
    {
      name: "math",
      level: "inline",
      start: (src) => src.match(/\$|\\\(|\\\[/)?.index,
      tokenizer(src) {
        let m = /^\$\$([^$]+?)\$\$/.exec(src) ?? /^\\\[([\s\S]+?)\\\]/.exec(src);
        if (m) return { type: "math", raw: m[0], text: m[1].trim(), display: true } satisfies Math;
        m = /^\\\(([\s\S]+?)\\\)/.exec(src);
        if (m) return { type: "math", raw: m[0], text: m[1].trim(), display: false } satisfies Math;
        if (src[0] !== "$" || src[1] === "$") return;
        const end = closing(src);
        if (end > 0) return { type: "math", raw: src.slice(0, end + 1), text: src.slice(1, end), display: false } satisfies Math;
      },
      renderer(t) {
        const m = t as Math;
        try {
          const html = typeset(m.text, m.display, true);
          return m.display ? `<span class="math-display">${html}</span>` : html;
        } catch {
          return escHtml(m.raw);
        }
      },
    },
  ],
};
