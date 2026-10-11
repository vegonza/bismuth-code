// Writes web/katex.css: KaTeX's stylesheet with its fonts as woff2 only (the UI bundle inlines every format a
// stylesheet names, which would triple them). Run again after updating katex: bun scripts/katex-css.ts
export {};
const dir = "node_modules/katex";
const { version } = await Bun.file(`${dir}/package.json`).json();
const css = (await Bun.file(`${dir}/dist/katex.min.css`).text()).replace(/@font-face\{[^}]*\}/g, (face) => {
  const woff2 = /url\(fonts\/([^)]+\.woff2)\)/.exec(face)![1];
  return face.replace(/src:[^;}]+/, `src:url(../${dir}/dist/fonts/${woff2}) format("woff2")`);
});
await Bun.write("web/katex.css", `/* KaTeX ${version}'s stylesheet, its fonts as woff2 only. Made by scripts/katex-css.ts: don't edit. */\n${css}\n`);
