// The file viewer's LaTeX preview: an approximation of the typeset document in HTML, nothing compiled. The title,
// numbered sections and contents, lists, tables, figures (PNG, JPEG and PDF ones), theorems and proofs, footnotes,
// cross-references, citations and a thebibliography, user macros (\newcommand, \def, \newenvironment) and Beamer
// frames; the maths by KaTeX. What it doesn't know it passes over, keeping the text of its arguments, rather than
// failing. \input'ed files and .bib bibliographies aren't read; TikZ pictures show as a placeholder.
import katex from "katex";
import "./katex.css";
import { pdfFigure } from "./pdfview";
import "./viewers.css";

/** `image`: the URL of a file the document names (a figure), relative to the document's folder. */
export type LatexOptions = { image: (path: string) => string };

export function renderLatex(text: string, into: HTMLElement, opts: LatexOptions) {
  const st = state();
  const begin = /\\begin\s*\{document\}/.exec(text);
  let body = text;
  if (begin) {
    // The preamble only defines things (macros, the title, theorems): what it would show is dropped.
    run(st, text.slice(0, begin.index), true);
    body = text.slice(begin.index + begin[0].length);
    const end = /\\end\s*\{document\}/.exec(body);
    if (end) body = body.slice(0, end.index);
  }
  st.chapters = /\\chapter\b/.test(body);
  let html = run(st, body, true);
  if (st.footnotes.length)
    html += `<ol class="tex-footnotes">${st.footnotes.map((f, i) => `<li id="tex-fn-${i + 1}">${f} <span class="tex-back" data-to="tex-fnref-${i + 1}">↩</span></li>`).join("")}</ol>`;
  into.innerHTML = resolve(st, html);
  into.onclick = (e) => {
    const to = (e.target as Element).closest<HTMLElement>("[data-to]")?.dataset.to;
    if (to) into.querySelector(`#${CSS.escape(to)}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  into.querySelectorAll<HTMLElement>("[data-tex-src]").forEach((ph) => figure(ph, opts, st.graphicsPath));
  into.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => ((a.target = "_blank"), (a.rel = "noreferrer")));
}

// ---------------- state ----------------

type Macro = { n: number; opt: string | null; body: string };
type Env = { n: number; opt: string | null; begin: string; end: string };
type Thm = { title: string; counter: string | null; style: "plain" | "definition" | "remark" };
type Label = { num: string; id: string; kind: string };

type State = ReturnType<typeof state>;
function state() {
  return {
    /** For KaTeX: the document's maths macros (and a few common packages' commands it lacks). */
    macros: { ...MATH_MACROS } as Record<string, string>,
    commands: new Map<string, Macro>(),
    envs: new Map<string, Env>(),
    theorems: new Map<string, Thm>(),
    thmStyle: "plain" as Thm["style"],
    counters: new Map<string, number>(),
    title: "",
    authors: [] as string[],
    date: null as string | null,
    chapters: false,
    appendix: false,
    /** chapter, section, subsection, subsubsection. */
    sec: [0, 0, 0, 0],
    headings: [] as { level: number; num: string; text: string; id: string }[],
    labels: new Map<string, Label>(),
    /** What a \label now names. */
    current: null as Label | null,
    anchors: 0,
    footnotes: [] as string[],
    bib: new Map<string, string>(),
    /** The floats the text is in (the innermost last): "figure", "table", "sub". */
    floats: [] as string[],
    sub: 0,
    listDepth: 0,
    graphicsPath: [] as string[],
    expansions: 0,
    lang: "en",
    names: { ...NAMES.en },
  };
}

type Names = typeof NAMES.en;
const NAMES = {
  en: { figure: "Figure", table: "Table", algorithm: "Algorithm", contents: "Contents", abstract: "Abstract", references: "References", proof: "Proof", chapter: "Chapter", appendix: "Appendix", part: "Part", section: "Section", equation: "Equation" },
  es: { figure: "Figura", table: "Cuadro", algorithm: "Algoritmo", contents: "Índice", abstract: "Resumen", references: "Referencias", proof: "Demostración", chapter: "Capítulo", appendix: "Apéndice", part: "Parte", section: "Sección", equation: "Ecuación" },
  fr: { figure: "Figure", table: "Table", algorithm: "Algorithme", contents: "Table des matières", abstract: "Résumé", references: "Références", proof: "Démonstration", chapter: "Chapitre", appendix: "Annexe", part: "Partie", section: "Section", equation: "Équation" },
  de: { figure: "Abbildung", table: "Tabelle", algorithm: "Algorithmus", contents: "Inhaltsverzeichnis", abstract: "Zusammenfassung", references: "Literatur", proof: "Beweis", chapter: "Kapitel", appendix: "Anhang", part: "Teil", section: "Abschnitt", equation: "Gleichung" },
  it: { figure: "Figura", table: "Tabella", algorithm: "Algoritmo", contents: "Indice", abstract: "Sommario", references: "Riferimenti bibliografici", proof: "Dimostrazione", chapter: "Capitolo", appendix: "Appendice", part: "Parte", section: "Sezione", equation: "Equazione" },
  pt: { figure: "Figura", table: "Tabela", algorithm: "Algoritmo", contents: "Conteúdo", abstract: "Resumo", references: "Referências", proof: "Demonstração", chapter: "Capítulo", appendix: "Apêndice", part: "Parte", section: "Seção", equation: "Equação" },
};
const LOCALES: Record<string, string> = { en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT", pt: "pt-PT" };
const NAME_COMMANDS: Record<string, keyof Names> = {
  figurename: "figure", tablename: "table", algorithmname: "algorithm", contentsname: "contents", abstractname: "abstract",
  refname: "references", bibname: "references", proofname: "proof", chaptername: "chapter", appendixname: "appendix", partname: "part",
};

/** babel's (or polyglossia's) language, the last named: its words for captions and headings, its dates. */
function language(st: State, options: string) {
  const langs: [RegExp, keyof typeof NAMES][] = [[/^(spanish|español|castilian)$/, "es"], [/^(french|francais|français)$/, "fr"], [/^n?german|ngerman|austrian$/, "de"], [/^italian$/, "it"], [/^(portuguese|portuges|brazil|brazilian)$/, "pt"], [/^(english|american|british|USenglish|UKenglish)$/, "en"]];
  let lang: keyof typeof NAMES | null = null;
  for (const o of options.split(",").map((x) => x.trim()))
    for (const [re, l] of langs) if (re.test(o)) lang = l;
  if (!lang) return;
  st.lang = lang;
  st.names = { ...NAMES[lang] };
  // Spanish says "Cuadro" for a table unless es-tabla asks for "Tabla".
  if (lang === "es" && /es-tabla/.test(options)) st.names.table = "Tabla";
}
const today = (st: State) => new Date().toLocaleDateString(LOCALES[st.lang] ?? undefined, { year: "numeric", month: "long", day: "numeric" });

const MATH_MACROS: Record<string, string> = {
  "\\argmin": "\\operatorname*{arg\\,min}",
  "\\argmax": "\\operatorname*{arg\\,max}",
  "\\mathbbm": "\\mathbb{#1}",
  "\\SI": "#1\\,\\mathrm{#2}",
  "\\si": "\\mathrm{#1}",
  "\\num": "#1",
  "\\qty": "#1\\,\\mathrm{#2}",
  "\\bm": "\\boldsymbol{#1}",
  "\\ensuremath": "#1",
  "\\textup": "\\textrm{#1}",
};

const anchor = (st: State) => `tex-a${++st.anchors}`;
const count = (st: State, name: string) => {
  const n = (st.counters.get(name) ?? 0) + 1;
  st.counters.set(name, n);
  return n;
};
/** A float's or equation's number: per chapter where there are chapters. */
const numbered = (st: State, name: string) => (st.chapters && st.sec[0] ? `${chapterNum(st)}.${count(st, name)}` : String(count(st, name)));
const chapterNum = (st: State) => (st.appendix ? letter(st.sec[0]) : String(st.sec[0]));
const letter = (n: number) => String.fromCharCode(64 + Math.max(1, Math.min(26, n)));
function name(st: State, kind: string, num: string) {
  const id = anchor(st);
  st.current = { num, id, kind };
  return id;
}

// ---------------- reading ----------------

/** The source being read, at `i`; `s` grows where a macro is expanded in place. */
class Reader {
  constructor(
    public s: string,
    public i = 0,
  ) {}
  get done() {
    return this.i >= this.s.length;
  }
  peek(k = 0) {
    return this.s[this.i + k];
  }
  /** Spaces, line ends (not a blank line) and comments. */
  ws() {
    for (;;) {
      const m = /[ \t]*(?:%[^\n]*)?(?:\n(?![ \t]*\n))?/y;
      m.lastIndex = this.i;
      const hit = m.exec(this.s);
      if (!hit || !hit[0]) return;
      this.i += hit[0].length;
    }
  }
  /** A `{…}` group's inside (braces balanced, escapes and comments skipped), or the next token. */
  arg(): string {
    this.ws();
    if (this.peek() === "{") return this.group("{", "}");
    if (this.peek() === "\\") {
      const m = /\\(?:[a-zA-Z@]+|.)/y;
      m.lastIndex = this.i;
      const hit = m.exec(this.s);
      if (hit) return (this.i += hit[0].length), hit[0];
    }
    return this.done ? "" : this.s[this.i++];
  }
  /** An optional `[…]` argument, or null. */
  opt(): string | null {
    const at = this.i;
    this.ws();
    if (this.peek() !== "[") return (this.i = at), null;
    return this.group("[", "]");
  }
  group(open: string, close: string): string {
    const start = ++this.i;
    let depth = 0;
    while (!this.done) {
      const c = this.s[this.i];
      if (c === "\\") this.i += 2;
      else if (c === "%") this.skipComment();
      else if (c === "{") depth++, this.i++;
      else if (c === "}" && depth > 0) depth--, this.i++;
      else if (c === close && depth === 0) return this.s.slice(start, this.i++);
      else this.i++;
    }
    return this.s.slice(start);
  }
  skipComment() {
    const nl = this.s.indexOf("\n", this.i);
    this.i = nl < 0 ? this.s.length : nl;
  }
  /** Arguments by a pattern: "m" mandatory, "o" optional. */
  args(pattern: string): (string | null)[] {
    return [...pattern].map((p) => (p === "o" ? this.opt() : this.arg()));
  }
  /** Up to the `\end{name}` matching where it stands (nested ones of the same name skipped). */
  env(name: string, verbatim = false): string {
    const start = this.i;
    const begin = `\\begin{${name}}`;
    const end = `\\end{${name}}`;
    let depth = 0;
    while (!this.done) {
      const c = this.s[this.i];
      if (c === "%" && !verbatim) this.skipComment();
      else if (c === "\\") {
        if (this.s.startsWith(end, this.i)) {
          if (depth === 0) {
            const inner = this.s.slice(start, this.i);
            this.i += end.length;
            return inner;
          }
          depth--;
        } else if (!verbatim && this.s.startsWith(begin, this.i)) depth++;
        this.i += verbatim ? 1 : 2;
      } else this.i++;
    }
    return this.s.slice(start);
  }
}

/** `src` cut wherever `sep` matches outside braces and environments (`sep` gives the length it matched, or 0). */
function splitTop(src: string, sep: (s: string, i: number) => number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let envs = 0;
  let from = 0;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (depth === 0 && envs === 0) {
      const n = sep(src, i);
      if (n) {
        parts.push(src.slice(from, i));
        i += n;
        from = i;
        continue;
      }
    }
    if (c === "%") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if (c === "\\") {
      if (src.startsWith("\\begin", i) && !/[a-zA-Z]/.test(src[i + 6] ?? "")) envs++;
      else if (src.startsWith("\\end", i) && !/[a-zA-Z]/.test(src[i + 4] ?? "")) envs = Math.max(0, envs - 1);
      i += 2;
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      i++;
    }
  }
  parts.push(src.slice(from));
  return parts;
}

const stripComments = (s: string) => s.replace(/(^|[^\\])%[^\n]*/g, "$1");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** TeX's ligatures and quotes, in text. */
const typo = (s: string) =>
  esc(s)
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/``/g, "“")
    .replace(/''/g, "”")
    .replace(/`/g, "‘")
    .replace(/'/g, "’")
    .replace(/&lt;&lt;/g, "«")
    .replace(/&gt;&gt;/g, "»")
    .replace(/!‘/g, "¡")
    .replace(/\?‘/g, "¿");

// ---------------- text ----------------

/** The source as HTML: as blocks (paragraphs and the like) or inline (an argument's text). `lead` opens the first
 *  paragraph (a theorem's head, a run-in heading). */
function run(st: State, src: string, block: boolean, lead = ""): string {
  const r = new Reader(src);
  const out: string[] = [];
  let para = lead;
  const flush = () => {
    if (block) {
      if (para.replace(/&nbsp;|<br>/g, "").trim()) out.push(`<p>${para.trim()}</p>`);
      para = "";
    }
  };
  const emit = (html: string) => {
    if (!block) return void (para += html);
    flush();
    out.push(html);
  };
  const space = () => {
    if (para && !para.endsWith(" ")) para += " ";
  };
  while (!r.done) {
    const c = r.peek();
    if (c === "%") {
      r.skipComment();
      // The comment takes the line's end with it, and the next line's indent.
      if (r.peek() === "\n" && !/^\n[ \t]*\n/.test(r.s.slice(r.i, r.i + 64))) {
        r.i++;
        while (r.peek() === " " || r.peek() === "\t") r.i++;
      }
    } else if (c === "\n" || c === " " || c === "\t" || c === "\r") {
      const m = /[ \t\r]*\n[ \t\r]*\n\s*/y;
      m.lastIndex = r.i;
      const blank = m.exec(r.s);
      if (blank) {
        r.i += blank[0].length;
        if (block) flush();
        else space();
      } else {
        r.i++;
        space();
      }
    } else if (c === "$") {
      const display = r.peek(1) === "$";
      r.i += display ? 2 : 1;
      const end = findDollar(r.s, r.i, display);
      const tex = r.s.slice(r.i, end);
      r.i = end + (display ? 2 : 1);
      if (display) emit(displayMath(st, tex, false));
      else para += math(st, tex, false);
    } else if (c === "{") {
      // A group holding blocks (a table, a \par) stays a block at the paragraph level.
      const g = r.group("{", "}");
      if (block && /\\(begin|par|section|subsection|chapter|includegraphics|\[)\b|\n[ \t]*\n/.test(g)) emit(run(st, g, true));
      else para += run(st, g, false);
    } else if (c === "}") r.i++;
    else if (c === "~") (para += "&nbsp;"), r.i++;
    else if (c === "&") space(), r.i++;
    else if (c === "\\") {
      const before = r.i;
      const res = command(st, r, block);
      if (res === STOP) {
        // A declaration (\bfseries, \small…): it holds to the end of the group.
        break;
      }
      if (typeof res === "string") para += res;
      else if (res) {
        if (res.par) flush();
        if (res.block !== undefined) emit(res.block);
        if (res.lead !== undefined) block ? (flush(), (para = res.lead)) : (para += res.lead);
        if (res.rest !== undefined) {
          para += res.rest;
          break;
        }
      }
      if (r.i === before) r.i++;
    } else {
      const m = /[^\\{}$%~&\s]+/y;
      m.lastIndex = r.i;
      const hit = m.exec(r.s)!;
      para += typo(hit[0]);
      r.i += hit[0].length;
    }
  }
  if (!block) return para;
  flush();
  return out.join("");
}

/** Where a `$…$` (or `$$…$$`) closes. */
function findDollar(s: string, from: number, display: boolean): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "$" && (!display || s[i + 1] === "$")) return i;
  }
  return s.length;
}

const STOP = Symbol("stop");
/** What a command gave: inline HTML; or a block (`par`: it ends the paragraph first), a lead for the next paragraph,
 *  or the rest of the group wrapped (`rest`, the reading done). */
type Result = string | null | typeof STOP | { block?: string; par?: boolean; lead?: string; rest?: string };

const SYMBOLS: Record<string, string> = {
  ldots: "…", dots: "…", textellipsis: "…", S: "§", P: "¶", copyright: "©", textcopyright: "©", textregistered: "®",
  texttrademark: "™", dag: "†", ddag: "‡", textdagger: "†", textbackslash: "\\", textasciitilde: "~", textasciicircum: "^",
  textbar: "|", textless: "&lt;", textgreater: "&gt;", textbullet: "•", textperiodcentered: "·", textdegree: "°",
  degree: "°", euro: "€", texteuro: "€", pounds: "£", ss: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", o: "ø", O: "Ø",
  aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", j: "ȷ", quad: "\u2003", qquad: "\u2003\u2003", enspace: "\u2002",
  thinspace: "\u2009", enskip: "\u2002", space: " ", textquotedblleft: "“", textquotedblright: "”", textquoteleft: "‘",
  textquoteright: "’", guillemotleft: "«", guillemotright: "»", guillemetleft: "«", guillemetright: "»",
  textendash: "–", textemdash: "—", checkmark: "✓", textunderscore: "_", textasciigrave: "`", textexclamdown: "¡",
  textquestiondown: "¿", hfill: " ", hfil: " ", dotfill: " … ", slash: "/", textsection: "§",
  textpm: "±", texttimes: "×", textdiv: "÷", textmu: "µ", textonehalf: "½", textrightarrow: "→", textleftarrow: "←",
  ordm: "º", ordf: "ª", textordmasculine: "º", textordfeminine: "ª", nobreakspace: "&nbsp;", textvisiblespace: "␣",
};
const LOGOS: Record<string, string> = {
  LaTeX: `<span class="tex-logo">L<sup>a</sup>T<sub>e</sub>X</span>`,
  TeX: `<span class="tex-logo">T<sub>e</sub>X</span>`,
  LaTeXe: `<span class="tex-logo">L<sup>a</sup>T<sub>e</sub>X 2<sub>ε</sub></span>`,
  BibTeX: `<span class="tex-logo">BibT<sub>e</sub>X</span>`,
  XeLaTeX: `<span class="tex-logo">XeL<sup>a</sup>T<sub>e</sub>X</span>`,
  LuaLaTeX: `<span class="tex-logo">LuaL<sup>a</sup>T<sub>e</sub>X</span>`,
};
const ACCENTS: Record<string, string> = {
  "'": "\u0301", "`": "\u0300", "^": "\u0302", '"': "\u0308", "~": "\u0303", "=": "\u0304", ".": "\u0307",
  u: "\u0306", v: "\u030C", H: "\u030B", c: "\u0327", k: "\u0328", r: "\u030A", d: "\u0323", b: "\u0331",
};
/** Commands that change nothing shown. */
const NOOPS = new Set(
  "noindent indent centering raggedright raggedleft flushbottom raggedbottom protect relax nobreak frenchspacing nonfrenchspacing sloppy fussy smallskip medskip bigskip vfill vfil null strut newpage clearpage cleardoublepage pagebreak nopagebreak allowbreak hline toprule midrule bottomrule makeatletter makeatother selectfont normalfont rmfamily upshape mdseries normalsize onecolumn twocolumn tightlist pause centerline displaystyle textstyle ignorespaces unskip break hrulefill phantomsection FloatBarrier listoffigures listoftables printindex makeindex frontmatter mainmatter backmatter justifying".split(" "),
);
/** Commands whose arguments show nothing: their pattern ("m" a mandatory argument, "o" an optional one). */
const DROP: Record<string, string> = {
  documentclass: "om", RequirePackage: "om", vspace: "m", hspace: "m", setlength: "mm",
  addtolength: "mm", setcounter: "mm", addtocounter: "mm", stepcounter: "m", refstepcounter: "m", pagestyle: "m",
  thispagestyle: "m", pagenumbering: "m", bibliographystyle: "m", geometry: "m", hypersetup: "m", definecolor: "mmm",
  colorlet: "mm", newcounter: "mo", numberwithin: "mm", captionsetup: "om", lstset: "m", tikzset: "m",
  usetikzlibrary: "m", pgfplotsset: "m", sisetup: "m", DeclareGraphicsExtensions: "m", index: "m", glossary: "m",
  nocite: "m", addcontentsline: "mmm", markboth: "mm", markright: "m", linespread: "m", fontsize: "mm",
  hyphenation: "m", includeonly: "m", phantom: "m", hphantom: "m", vphantom: "m", titleformat: "momm" + "mmo",
  titlespacing: "mmmmo", setmainfont: "om", setsansfont: "om", setmonofont: "om", usefont: "mmmm", fontfamily: "m",
  newgeometry: "m", restoregeometry: "", setbeamertemplate: "mom", usetheme: "om", usecolortheme: "om",
  setbeamercolor: "mm", setbeamerfont: "mm", usefonttheme: "om", useinnertheme: "om", useoutertheme: "om",
  addbibresource: "om", lstdefinestyle: "mm", lstdefinelanguage: "omom", newlength: "m",
  settowidth: "mm", raisebox: "moo", hypertarget: "m", newcolumntype: "mom",
  enlargethispage: "m", setstretch: "m", doublespacing: "", onehalfspacing: "",
  singlespacing: "", pdfbookmark: "omm", fancyhf: "m", fancyhead: "om", fancyfoot: "om",
  lhead: "m", chead: "m", rhead: "m", lfoot: "m", cfoot: "m", rfoot: "m", headrulewidth: "", DeclareUnicodeCharacter: "mm",
  tcbuselibrary: "m", newtcolorbox: "momm", newmdenv: "om", ExecuteBibliographyOptions: "m", urlstyle: "m",
  setlist: "om", newlist: "mmm", setlistdepth: "m", mdfsetup: "m", AtBeginDocument: "m", AtEndDocument: "m",
  institute: "om", logo: "m", titlegraphic: "m", subject: "m", keywords: "m",
};
/** Font switches by argument: their element. */
const STYLED: Record<string, [string, string?]> = {
  textbf: ["strong"], textit: ["em"], emph: ["em"], textsl: ["em"], texttt: ["code", "tex-tt"], textsc: ["span", "tex-sc"],
  textsf: ["span", "tex-sf"], textrm: ["span"], textup: ["span"], textmd: ["span"], textnormal: ["span"], mbox: ["span"],
  makebox: ["span"], hbox: ["span"], text: ["span"], underline: ["u"], uline: ["u"], sout: ["s"], st: ["s"],
  textsuperscript: ["sup"], textsubscript: ["sub"], fbox: ["span", "tex-box"], framebox: ["span", "tex-box"],
  alert: ["strong", "tex-alert"], structure: ["strong"], textlf: ["span"], nolinkurl: ["code", "tex-tt"],
  path: ["code", "tex-tt"], keyword: ["strong"], enquote: ["q"],
};
/** Declarations: they style the rest of their group. */
const DECLS: Record<string, string> = {
  bfseries: "tex-bf", bf: "tex-bf", itshape: "tex-it", it: "tex-it", em: "tex-it", slshape: "tex-it", sl: "tex-it",
  ttfamily: "tex-tt", tt: "tex-tt", scshape: "tex-sc", sc: "tex-sc", sffamily: "tex-sf", sf: "tex-sf",
  tiny: "tex-tiny", scriptsize: "tex-scriptsize", footnotesize: "tex-footnotesize", small: "tex-small",
  large: "tex-large", Large: "tex-Large", LARGE: "tex-LARGE", huge: "tex-huge", Huge: "tex-Huge",
};
const SECTIONS: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const UNITS: Record<string, string> = {
  meter: "m", metre: "m", second: "s", kilogram: "kg", gram: "g", kilo: "k", mega: "M", giga: "G", tera: "T", milli: "m",
  micro: "µ", nano: "n", pico: "p", centi: "c", hertz: "Hz", newton: "N", joule: "J", watt: "W", volt: "V", ampere: "A",
  ohm: "Ω", kelvin: "K", celsius: "°C", degreeCelsius: "°C", percent: "%", per: "/", squared: "²", cubed: "³", byte: "B",
  bit: "bit", decibel: "dB", hour: "h", minute: "min", liter: "L", litre: "L", mole: "mol", pascal: "Pa", degree: "°",
};
const unit = (u: string) => u.replace(/\\([a-zA-Z]+)/g, (_, n: string) => UNITS[n] ?? n).replace(/[{}~]/g, "");

function command(st: State, r: Reader, block: boolean): Result {
  r.i++; // the backslash
  const sym = r.peek();
  if (sym === undefined) return null;
  if (!/[a-zA-Z@]/.test(sym)) {
    r.i++;
    if (sym === "\\") {
      r.opt();
      if (r.peek() === "*") r.i++;
      return "<br>";
    }
    if (sym === "[" || sym === "(") {
      const end = r.s.indexOf(sym === "[" ? "\\]" : "\\)", r.i);
      const tex = r.s.slice(r.i, end < 0 ? r.s.length : end);
      r.i = end < 0 ? r.s.length : end + 2;
      return sym === "[" ? { block: displayMath(st, tex, false), par: true } : math(st, tex, false);
    }
    if (ACCENTS[sym]) return accent(st, r, sym);
    if (sym === " " || sym === "\n") return " ";
    if (sym === "," || sym === ";" || sym === ":") return "\u2009";
    if (sym === "-" || sym === "/" || sym === "@" || sym === ")" || sym === "]") return "";
    return esc(sym);
  }
  const m = /[a-zA-Z@]+/y;
  m.lastIndex = r.i;
  const name = m.exec(r.s)![0];
  r.i += name.length;
  const star = r.peek() === "*";
  if (star) r.i++;
  // A control word eats the spaces after it (\LaTeX{} keeps one).
  const eatSpace = () => {
    const sp = /[ \t]*(?:\n(?![ \t]*\n))?[ \t]*/y;
    sp.lastIndex = r.i;
    r.i += sp.exec(r.s)![0].length;
  };
  // Beamer's overlay specifications (\item<2->, \only<1>{…}).
  if (r.peek() === "<" && /^(item|only|onslide|uncover|visible|invisible|alt|alert|pause|textbf|textit|includegraphics|action)$/.test(name)) {
    const close = r.s.indexOf(">", r.i);
    if (close > 0 && close - r.i < 16) r.i = close + 1;
  }

  if (name in SECTIONS) return section(st, r, name, star);
  if (STYLED[name]) {
    const [tag, cls] = STYLED[name];
    if (name === "makebox" || name === "framebox") r.opt(), r.opt();
    const inner = run(st, r.arg(), false);
    return `<${tag}${cls ? ` class="${cls}"` : ""}>${inner}</${tag}>`;
  }
  if (DECLS[name]) return rest(st, r, block, `class="${DECLS[name]}"`);
  if (SYMBOLS[name] !== undefined) return eatSpace(), SYMBOLS[name];
  if (LOGOS[name]) return eatSpace(), LOGOS[name];
  if (NOOPS.has(name)) return eatSpace(), "";
  if (DROP[name] !== undefined) return r.args(DROP[name]), "";
  if (ACCENTS[name] && /^[uvHckrdb]$/.test(name) && /^\s*[{a-zA-Z\\]/.test(r.s.slice(r.i, r.i + 3))) return accent(st, r, name);

  switch (name) {
    case "usepackage": {
      const o = r.opt();
      if (/\b(babel|polyglossia)\b/.test(r.arg()) && o) language(st, o);
      return "";
    }
    case "setdefaultlanguage":
    case "setmainlanguage":
    case "selectlanguage":
      r.opt();
      language(st, r.arg());
      return "";
    case "begin":
      return environment(st, r, r.arg().trim());
    case "end":
      r.arg();
      return "";
    case "par":
      return block ? { par: true } : " ";
    case "newline":
    case "linebreak":
    case "break":
      r.opt();
      return "<br>";
    case "today":
      return eatSpace(), today(st);
    case "item":
      r.opt();
      return "";
    case "title":
      r.opt();
      st.title = r.arg();
      return "";
    case "author":
      r.opt();
      st.authors.push(...splitTop(r.arg(), (s, i) => (s.startsWith("\\and", i) && !/[a-zA-Z]/.test(s[i + 4] ?? "") ? 4 : 0)));
      return "";
    case "affil":
    case "address":
    case "email":
      r.opt();
      st.authors.push(r.arg());
      return "";
    case "date":
      st.date = r.arg();
      return "";
    case "maketitle":
    case "titlepage":
      return { block: titleBlock(st), par: true };
    case "thanks":
    case "footnote":
    case "footnotetext":
      r.opt();
      return footnote(st, r.arg());
    case "footnotemark":
      r.opt();
      return "";
    case "label": {
      const key = r.arg().trim();
      if (st.current) st.labels.set(key, st.current);
      return `<span id="tex-l-${esc(key)}"></span>`;
    }
    case "ref":
    case "pageref":
    case "nameref":
    case "vref":
      return `\u0001R:${r.arg().trim()}\u0002`;
    case "eqref":
      return `\u0001E:${r.arg().trim()}\u0002`;
    case "cref":
    case "Cref":
    case "autoref":
    case "Autoref":
    case "cpageref":
      return `\u0001N:${r.arg().trim()}\u0002`;
    case "cite":
    case "citep":
    case "citet":
    case "parencite":
    case "textcite":
    case "autocite":
    case "footcite":
    case "citealp":
    case "citealt":
    case "supercite":
    case "Cite":
    case "Textcite":
    case "Parencite": {
      const pre = r.opt();
      const post = r.opt();
      const note = post ?? pre;
      return `\u0001C:${r.arg().trim()}|${note ? run(st, note, false) : ""}\u0002`;
    }
    case "citeauthor":
    case "citeyear":
    case "citetitle":
      return `<span class="tex-cite">${esc(r.arg().trim())}</span>`;
    case "url":
    case "href": {
      const url = r.arg().trim();
      const text = name === "href" ? run(st, r.arg(), false) : esc(url);
      return /^(https?:|mailto:)/i.test(url) ? `<a href="${esc(url)}">${text}</a>` : text;
    }
    case "verb":
    case "lstinline":
    case "mintinline": {
      if (name === "mintinline") r.opt(), r.arg();
      else if (name === "lstinline") r.opt();
      const d = r.s[r.i++];
      const close = d === "{" ? "}" : d;
      const end = r.s.indexOf(close, r.i);
      const code = r.s.slice(r.i, end < 0 ? r.s.length : end);
      r.i = end < 0 ? r.s.length : end + 1;
      return `<code class="tex-tt">${esc(code)}</code>`;
    }
    case "ensuremath":
      return math(st, r.arg(), false);
    case "textcolor":
    case "color":
    case "colorbox":
    case "highlight":
    case "hl": {
      const model = r.opt();
      const color = name === "hl" || name === "highlight" ? "yellow" : r.arg().trim();
      const css = !model && /^[a-zA-Z]+$/.test(color) ? color : "";
      const prop = name === "colorbox" || name === "hl" || name === "highlight" ? "background-color" : "color";
      const style = css ? ` style="${prop}: ${css}"` : "";
      if (name === "color") return rest(st, r, block, style.trim());
      return `<span class="${prop === "color" ? "tex-color" : "tex-mark"}"${style}>${run(st, r.arg(), false)}</span>`;
    }
    case "caption":
    case "captionof":
    case "subcaption": {
      const kind = name === "captionof" ? r.arg().trim() : null;
      r.opt();
      return { block: caption(st, r.arg(), kind), par: true };
    }
    case "includegraphics": {
      const o = r.opt();
      return image(r.arg().trim(), o);
    }
    case "graphicspath":
      st.graphicsPath = [...r.arg().matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
      return "";
    case "subfloat": {
      const cap = r.opt();
      const content = r.arg();
      st.floats.push("sub");
      const html = `<div class="tex-sub">${run(st, content, false)}${cap !== null ? caption(st, cap, null) : ""}</div>`;
      st.floats.pop();
      return html;
    }
    case "subcaptionbox": {
      const cap = r.arg();
      const content = r.arg();
      st.floats.push("sub");
      const html = `<div class="tex-sub">${run(st, content, false)}${caption(st, cap, null)}</div>`;
      st.floats.pop();
      return html;
    }
    case "rule": {
      r.opt();
      r.arg();
      r.arg();
      return { block: "<hr>", par: true };
    }
    case "tableofcontents":
      return { block: "\u0001T:\u0002", par: true };
    case "appendix":
      st.appendix = true;
      st.sec = [0, 0, 0, 0];
      return "";
    case "input":
    case "include":
    case "subfile":
    case "import": {
      if (name === "import") r.arg();
      return { block: `<div class="tex-note">${esc(r.arg().trim())} is included here; its text isn't shown</div>`, par: true };
    }
    case "bibliography":
    case "printbibliography":
      if (name === "bibliography") r.arg();
      else r.opt();
      return { block: `<h2 class="tex-unnumbered">${st.names.references}</h2><div class="tex-note">The references come from a BibTeX file, which isn't read</div>`, par: true };
    case "bibitem":
      r.opt();
      r.arg();
      return "";
    case "newcommand":
    case "renewcommand":
    case "providecommand":
    case "DeclareRobustCommand": {
      const cmd = r.arg().trim();
      const n = Number(r.opt() ?? 0) || 0;
      const opt = r.opt();
      define(st, cmd, n, opt, r.arg());
      return "";
    }
    case "def":
    case "gdef":
    case "edef":
    case "xdef": {
      const cm = /\\([a-zA-Z@]+|.)((?:#\d)*)/y;
      cm.lastIndex = r.i;
      const hit = cm.exec(r.s);
      if (!hit) return "";
      r.i += hit[0].length;
      define(st, `\\${hit[1]}`, (hit[2].length / 2) | 0, null, r.arg());
      return "";
    }
    case "let": {
      r.ws();
      const a = r.arg();
      r.ws();
      if (r.peek() === "=") r.i++;
      const b = r.arg();
      if (a.startsWith("\\") && b.startsWith("\\")) st.macros[a] = b;
      return "";
    }
    case "DeclareMathOperator": {
      const cmd = r.arg().trim();
      st.macros[cmd] = `\\operatorname${star ? "*" : ""}{${r.arg()}}`;
      return "";
    }
    case "newenvironment":
    case "renewenvironment": {
      const env = r.arg().trim();
      const n = Number(r.opt() ?? 0) || 0;
      const opt = r.opt();
      const begin = r.arg();
      st.envs.set(env, { n, opt, begin, end: r.arg() });
      return "";
    }
    case "newtheorem": {
      const env = r.arg().trim();
      const shared = r.opt();
      const title = r.arg();
      r.opt();
      st.theorems.set(env, { title: run(st, title, false), counter: star ? null : (shared?.trim() ?? env), style: st.thmStyle });
      return "";
    }
    case "theoremstyle": {
      const s = r.arg().trim();
      st.thmStyle = s === "definition" ? "definition" : s === "remark" ? "remark" : "plain";
      return "";
    }
    case "SI":
    case "qty": {
      r.opt();
      const n = r.arg();
      return `${esc(n)}&nbsp;${esc(unit(r.arg()))}`;
    }
    case "si":
    case "unit":
      r.opt();
      return esc(unit(r.arg()));
    case "num":
      r.opt();
      return esc(r.arg());
    case "frametitle":
      r.opt();
      return { block: `<h3 class="tex-frametitle">${run(st, r.arg(), false)}</h3>`, par: true };
    case "framesubtitle":
      return { block: `<div class="tex-framesub">${run(st, r.arg(), false)}</div>`, par: true };
    case "only":
    case "onslide":
    case "uncover":
    case "visible":
    case "mode":
      return run(st, r.arg(), false);
    case "multicolumn": {
      r.arg();
      r.arg();
      return run(st, r.arg(), false);
    }
    case "multirow": {
      r.opt();
      r.arg();
      r.opt();
      r.arg();
      r.opt();
      return run(st, r.arg(), false);
    }
    case "parbox":
    case "minibox":
      r.opt(), r.opt(), r.opt();
      if (name === "parbox") r.arg();
      return run(st, r.arg(), false);
    case "resizebox":
    case "scalebox":
    case "rotatebox":
    case "adjustbox":
      if (name === "resizebox") r.arg(), r.arg();
      else if (name === "adjustbox") r.arg();
      else r.opt(), r.arg();
      return run(st, r.arg(), false);
  }

  // The document's own commands, expanded where they stand.
  const own = st.commands.get(name);
  if (own && st.expansions++ < 20000) {
    const args: string[] = [];
    for (let k = 0; k < own.n; k++) args.push(k === 0 && own.opt !== null ? (r.opt() ?? own.opt) : r.arg());
    const body = own.body.replace(/#(\d)/g, (_, d: string) => args[+d - 1] ?? "");
    r.s = r.s.slice(0, r.i) + body + r.s.slice(r.i);
    return null;
  }
  // Unknown: its name goes, its arguments read on as text.
  if (r.peek() === "[") r.opt();
  return eatSpace(), null;
}

/** A declaration: the rest of its group styled (`attrs`); at the paragraph level, as a block with its paragraphs. */
function rest(st: State, r: Reader, block: boolean, attrs: string): Result {
  const html = run(st, r.s.slice(r.i), block);
  r.i = r.s.length;
  const a = attrs ? ` ${attrs}` : "";
  return block ? { block: `<div${a}>${html}</div>`, par: true } : { rest: `<span${a}>${html}</span>` };
}

function accent(st: State, r: Reader, which: string): string {
  let base = r.arg();
  // An accent over a dotless i or j is the letter with it (\'{\i} is í).
  if (base === "\\i") base = "i";
  else if (base === "\\j") base = "j";
  else if (base.startsWith("\\")) base = run(st, base, false);
  return esc((base + ACCENTS[which]).normalize("NFC"));
}

function define(st: State, cmd: string, n: number, opt: string | null, body: string) {
  if (!cmd.startsWith("\\")) return;
  // The document's own words for its captions and headings (\renewcommand{\figurename}{…}).
  const word = NAME_COMMANDS[cmd.slice(1)];
  if (word) return void (st.names[word] = run(st, body, false));
  // Maths sees every definition (KaTeX counts the #s itself).
  st.macros[cmd] = body;
  st.commands.set(cmd.slice(1), { n, opt, body });
}

function section(st: State, r: Reader, cmd: string, star: boolean): Result {
  const level = SECTIONS[cmd];
  r.opt();
  const text = run(st, r.arg(), false);
  if (level >= 4) return { lead: `<strong class="tex-runin">${text}</strong> ` };
  if (level < 0) {
    const n = star ? "" : roman(count(st, "part"));
    return { block: `<h1 class="tex-part" id="${anchor(st)}">${n ? `${st.names.part} ${n}<br>` : ""}${text}</h1>`, par: true };
  }
  let num = "";
  if (!star) {
    st.sec[level]++;
    for (let k = level + 1; k < st.sec.length; k++) st.sec[k] = 0;
    if (level === 0) for (const c of ["figure", "table", "equation"]) st.counters.delete(c);
    const parts = st.sec.slice(st.chapters ? 0 : 1, level + 1).map(String);
    if (st.appendix && parts.length) parts[0] = letter(+parts[0]);
    num = parts.join(".");
  }
  const id = star ? anchor(st) : name(st, "sec", num);
  if (level <= 2 && num) st.headings.push({ level, num, text, id });
  const tag = `h${level + 1}`;
  const head = level === 0 ? `<div class="tex-chapnum">${num ? `${st.appendix ? st.names.appendix : st.names.chapter} ${num}` : ""}</div>${text}` : `${num ? `<span class="tex-num">${num}</span>` : ""}${text}`;
  return { block: `<${tag} class="tex-h${level}" id="${id}">${head}</${tag}>`, par: true };
}

const roman = (n: number) => ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n] ?? String(n);

function titleBlock(st: State): string {
  if (!st.title && !st.authors.length) return "";
  const authors = st.authors.map((a) => `<div class="tex-author">${run(st, a, false)}</div>`).join("");
  const date = st.date === null ? today(st) : run(st, st.date, false);
  return `<header class="tex-titleblock">${st.title ? `<h1 class="tex-title">${run(st, st.title, false)}</h1>` : ""}${authors ? `<div class="tex-authors">${authors}</div>` : ""}${date.trim() ? `<div class="tex-date">${date}</div>` : ""}</header>`;
}

function footnote(st: State, text: string): string {
  const n = st.footnotes.push("");
  st.footnotes[n - 1] = run(st, text, false);
  return `<sup class="tex-fn" id="tex-fnref-${n}" data-to="tex-fn-${n}">${n}</sup>`;
}

function caption(st: State, text: string, kind: string | null): string {
  const float = kind ?? st.floats.at(-1) ?? "figure";
  const inner = run(st, text, false);
  if (float === "sub") {
    const n = String.fromCharCode(97 + st.sub++);
    const id = name(st, "fig", `${(st.counters.get("figure") ?? 0) + 1}${n}`);
    return `<div class="tex-caption" id="${id}">(${n}) ${inner}</div>`;
  }
  const which = float === "table" || float === "algorithm" ? float : "figure";
  const label = st.names[which];
  const num = numbered(st, which);
  const id = name(st, which === "table" ? "tab" : "fig", num);
  return `<div class="tex-caption" id="${id}"><span class="tex-caplabel">${label} ${num}:</span> ${inner}</div>`;
}

/** A figure's placeholder: the image is found and drawn once in the page (figure()). */
function image(path: string, options: string | null): string {
  const style = imageStyle(options);
  return `<span class="tex-img" data-tex-src="${esc(path)}"${style ? ` style="${style}"` : ""}></span>`;
}
function imageStyle(options: string | null): string {
  if (!options) return "";
  const w = /(?:^|,)\s*width\s*=\s*([^,]+)/.exec(options)?.[1];
  const scale = /(?:^|,)\s*scale\s*=\s*([\d.]+)/.exec(options)?.[1];
  const css = w ? length(w) : null;
  if (css) return `width: ${css}`;
  if (scale) return `--tex-scale: ${scale}`;
  return "";
}
/** A TeX length as CSS: fractions of the text's width as percentages, absolute units as pixels. */
function length(v: string): string | null {
  const m = /^\s*([\d.]*)\s*(\\(?:textwidth|linewidth|columnwidth|hsize|paperwidth)|cm|mm|in|pt|em|ex|px)\s*$/.exec(v);
  if (!m) return null;
  const k = m[1] === "" ? 1 : parseFloat(m[1]);
  if (m[2].startsWith("\\")) return `${Math.min(100, k * 100).toFixed(1)}%`;
  const px: Record<string, number> = { cm: 37.8, mm: 3.78, in: 96, pt: 1.333, em: 16, ex: 8, px: 1 };
  return `${Math.round(k * px[m[2]])}px`;
}

// ---------------- environments ----------------

const THEOREMS: Record<string, [string, Thm["style"]]> = {
  theorem: ["Theorem", "plain"], lemma: ["Lemma", "plain"], proposition: ["Proposition", "plain"], corollary: ["Corollary", "plain"],
  conjecture: ["Conjecture", "plain"], claim: ["Claim", "plain"], definition: ["Definition", "definition"],
  example: ["Example", "definition"], exercise: ["Exercise", "definition"], problem: ["Problem", "definition"],
  assumption: ["Assumption", "definition"], remark: ["Remark", "remark"], note: ["Note", "remark"],
  observation: ["Observation", "remark"], notation: ["Notation", "remark"],
};
const MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "flalign", "flalign*", "alignat", "alignat*", "eqnarray", "eqnarray*", "displaymath", "math", "dmath", "dmath*"]);
const VERBATIM = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "alltt", "BVerbatim", "LVerbatim", "spverbatim", "code", "comment", "filecontents", "filecontents*"]);
const TABULAR = new Set(["tabular", "tabular*", "tabularx", "tabulary", "longtable", "tblr", "longtblr", "array"]);
const PICTURES = new Set(["tikzpicture", "pgfpicture", "circuitikz", "forest", "picture", "pspicture", "axis", "tikzcd", "dot2tex"]);

function environment(st: State, r: Reader, env: string): Result {
  if (MATH_ENVS.has(env)) {
    if (env === "alignat" || env === "alignat*") r.arg();
    return { block: displayMath(st, r.env(env), true, env), par: true };
  }
  if (VERBATIM.has(env)) {
    const inner = r.env(env, true);
    if (env === "comment") return "";
    // Options and a language after the \begin (lstlisting[…], minted{python}).
    const code = inner.replace(/^(?:\[[^\]\n]*\]|\{[^}\n]*\})*[ \t]*\n?/, "").replace(/\n\s*$/, "");
    return { block: `<pre class="tex-verb">${esc(code)}</pre>`, par: true };
  }
  if (TABULAR.has(env)) return { block: tabular(st, r, env), par: true };
  if (PICTURES.has(env)) {
    r.env(env);
    return { block: `<div class="tex-note">A ${env === "tikzpicture" ? "TikZ" : env} picture, which isn't drawn here</div>`, par: true };
  }
  const user = st.envs.get(env);
  if (user && st.expansions++ < 20000) {
    const args: string[] = [];
    for (let k = 0; k < user.n; k++) args.push(k === 0 && user.opt !== null ? (r.opt() ?? user.opt) : r.arg());
    const body = r.env(env);
    const begin = user.begin.replace(/#(\d)/g, (_, d: string) => args[+d - 1] ?? "");
    // In place: \begin{…} and \end{…} of other environments in its definition pair up across the body.
    r.s = r.s.slice(0, r.i) + `${begin}${body}${user.end}` + r.s.slice(r.i);
    return null;
  }
  const thm = st.theorems.get(env) ?? (THEOREMS[env] ? { title: THEOREMS[env][0], counter: env, style: THEOREMS[env][1] } : null);
  if (thm) {
    const note = r.opt();
    const body = r.env(env);
    let num = "";
    let id = anchor(st);
    if (thm.counter) {
      num = String(count(st, `thm:${thm.counter}`));
      id = name(st, "thm", num);
    }
    const head = `<span class="tex-thmhead" id="${id}">${thm.title}${num ? ` ${num}` : ""}${note ? ` <span class="tex-thmnote">(${run(st, note, false)})</span>` : ""}.</span> `;
    return { block: `<div class="tex-thm tex-thm-${thm.style}">${run(st, body, true, head)}</div>`, par: true };
  }
  switch (env) {
    case "itemize":
    case "enumerate":
    case "description":
    case "compactitem":
    case "compactenum":
    case "inparaenum":
    case "asparaenum":
      r.opt();
      return { block: list(st, r.env(env), env), par: true };
    case "abstract":
      return { block: `<div class="tex-abstract"><div class="tex-abstract-title">${st.names.abstract}</div>${run(st, r.env(env), true)}</div>`, par: true };
    case "quote":
    case "quotation":
    case "verse":
      return { block: `<blockquote class="tex-${env}">${run(st, r.env(env), true)}</blockquote>`, par: true };
    case "center":
    case "flushleft":
    case "flushright":
      return { block: `<div class="tex-${env}">${run(st, r.env(env), true)}</div>`, par: true };
    case "figure":
    case "figure*":
    case "wrapfigure":
    case "SCfigure":
    case "table":
    case "table*":
    case "wraptable":
    case "sidewaystable":
    case "sidewaysfigure":
    case "listing": {
      if (env.startsWith("wrap")) r.opt(), r.arg(), r.opt(), r.arg();
      else r.opt();
      st.floats.push(env.includes("table") ? "table" : "figure");
      st.sub = 0;
      const html = `<figure class="tex-figure">${run(st, r.env(env), true)}</figure>`;
      st.floats.pop();
      return { block: html, par: true };
    }
    case "subfigure":
    case "subtable": {
      r.opt();
      const w = length(r.arg());
      st.floats.push("sub");
      const html = `<div class="tex-sub"${w ? ` style="width: ${w}"` : ""}>${run(st, r.env(env), true)}</div>`;
      st.floats.pop();
      return html;
    }
    case "minipage": {
      r.opt();
      r.opt();
      r.opt();
      const w = length(r.arg());
      return `<div class="tex-minipage"${w ? ` style="width: ${w}"` : ""}>${run(st, r.env(env), true)}</div>`;
    }
    case "proof": {
      const title = r.opt();
      const body = run(st, r.env(env), true, `<em class="tex-proofhead">${title !== null ? run(st, title, false) : st.names.proof}.</em> `);
      const qed = `<span class="tex-qed">∎</span>`;
      return { block: `<div class="tex-proof">${body.endsWith("</p>") ? body.slice(0, -4) + qed + "</p>" : body + qed}</div>`, par: true };
    }
    case "thebibliography": {
      r.arg();
      return { block: bibliography(st, r.env(env)), par: true };
    }
    case "frame": {
      r.opt();
      let title = "";
      r.ws();
      if (r.peek() === "{") title = run(st, r.arg(), false);
      return { block: `<section class="tex-frame">${title ? `<h3 class="tex-frametitle">${title}</h3>` : ""}${run(st, r.env(env), true)}</section>`, par: true };
    }
    case "multicols":
    case "multicols*":
      r.arg();
      return { block: `<div class="tex-multicols">${run(st, r.env(env), true)}</div>`, par: true };
    case "columns":
      r.opt();
      return { block: `<div class="tex-columns">${run(st, r.env(env), true)}</div>`, par: true };
    case "column": {
      r.opt();
      const w = length(r.arg());
      return { block: `<div class="tex-column"${w ? ` style="width: ${w}"` : ""}>${run(st, r.env(env), true)}</div>`, par: true };
    }
    case "algorithm":
    case "algorithm*":
      r.opt();
      st.floats.push("algorithm");
      try {
        return { block: `<figure class="tex-figure tex-algorithm">${run(st, r.env(env), true)}</figure>`, par: true };
      } finally {
        st.floats.pop();
      }
    case "algorithmic":
    case "algorithmic*":
    case "algorithm2e": {
      r.opt();
      const code = r.env(env).replace(/^\s*\n/, "").replace(/\n\s*$/, "");
      return { block: `<pre class="tex-verb">${esc(code)}</pre>`, par: true };
    }
    case "tcolorbox":
    case "mdframed":
    case "framed":
    case "shaded":
    case "boxedminipage":
    case "block":
    case "alertblock":
    case "exampleblock": {
      const o = r.opt();
      let title = "";
      if (env.endsWith("block")) title = run(st, r.arg(), false);
      else if (o && /title\s*=/.test(o)) title = run(st, /title\s*=\s*\{?([^},]*)/.exec(o)?.[1] ?? "", false);
      return { block: `<div class="tex-boxed">${title ? `<div class="tex-boxtitle">${title}</div>` : ""}${run(st, r.env(env), true)}</div>`, par: true };
    }
  }
  // Unknown: its body shows as it is.
  r.opt();
  return { block: run(st, r.env(env), true), par: true };
}

function list(st: State, body: string, env: string): string {
  const items = splitTop(body, (s, i) => (s.startsWith("\\item", i) && !/[a-zA-Z]/.test(s[i + 5] ?? "") ? 5 : 0)).slice(1);
  st.listDepth++;
  const kind = env === "description" ? "dl" : env.includes("enum") ? "ol" : "ul";
  const depth = st.listDepth;
  const html = items.map((raw, n) => {
    const r = new Reader(raw.replace(/^<[^>]*>/, ""));
    const label = r.opt();
    const content = r.s.slice(r.i);
    if (kind === "ol") {
      const id = name(st, "item", String(n + 1));
      return `<li id="${id}"${label !== null ? ` class="tex-labeled" data-label="${esc(run(st, label, false).replace(/<[^>]*>/g, ""))}"` : ""}>${run(st, content, true)}</li>`;
    }
    if (kind === "dl") return `<dt>${label !== null ? run(st, label, false) : ""}</dt><dd>${run(st, content, true)}</dd>`;
    return `<li${label !== null ? ` class="tex-labeled" data-label="${esc(run(st, label, false).replace(/<[^>]*>/g, ""))}"` : ""}>${run(st, content, true)}</li>`;
  });
  st.listDepth--;
  const type = kind === "ol" ? ` type="${["1", "a", "i", "A"][(depth - 1) % 4]}"` : "";
  return `<${kind} class="tex-list"${type}>${html.join("")}</${kind}>`;
}

function bibliography(st: State, body: string): string {
  const items = splitTop(body, (s, i) => (s.startsWith("\\bibitem", i) && !/[a-zA-Z]/.test(s[i + 8] ?? "") ? 8 : 0)).slice(1);
  const html = items.map((raw, n) => {
    const r = new Reader(raw);
    const label = r.opt();
    const key = r.arg().trim();
    const mark = label !== null ? run(st, label, false) : String(n + 1);
    st.bib.set(key, mark);
    return `<li id="tex-bib-${esc(key)}"><span class="tex-bibmark">[${mark}]</span> ${run(st, r.s.slice(r.i), false)}</li>`;
  });
  return `<h2 class="tex-unnumbered">${st.names.references}</h2><ol class="tex-bib">${html.join("")}</ol>`;
}

// ---------------- tables ----------------

function tabular(st: State, r: Reader, env: string): string {
  if (env === "tabular*" || env === "tabularx" || env === "tabulary") r.arg();
  r.opt();
  const aligns = columns(r.arg());
  if (env === "longtable" || env === "longtblr") st.floats.push("table");
  const body = stripComments(r.env(env));
  const rows = splitTop(body, (s, i) => (s.startsWith("\\\\", i) ? 2 : s.startsWith("\\tabularnewline", i) ? 15 : 0));
  const RULE = /^\s*(?:\\(hline|toprule|midrule|bottomrule|cline|cmidrule|addlinespace|specialrule|rowcolor|endhead|endfirsthead|endfoot|endlastfoot|hdashline|Xhline|svhline|noalign)\b(?:\([^)]*\))?(?:\[[^\]]*\])?(?:\{[^}]*\})*|\[[^\]]*\]|\*)\s*/;
  const out: string[] = [];
  let ruleAbove = "";
  for (const row of rows) {
    let rest = row;
    for (let m: RegExpExecArray | null; (m = RULE.exec(rest)); ) {
      if (m[1] === "toprule" || m[1] === "bottomrule" || m[1] === "Xhline") ruleAbove = "thick";
      else if ((m[1] === "hline" || m[1] === "midrule" || m[1] === "cline" || m[1] === "cmidrule") && ruleAbove !== "thick") ruleAbove = "thin";
      rest = rest.slice(m[0].length);
    }
    if (!rest.trim()) {
      // Only rules: under the row before.
      if (ruleAbove && out.length) out[out.length - 1] = out[out.length - 1].replace(/^<tr class="([^"]*)"/, `<tr class="$1 rule-below-${ruleAbove}"`);
      ruleAbove = ruleAbove && !out.length ? ruleAbove : "";
      continue;
    }
    const cells = splitTop(rest, (s, i) => (s[i] === "&" ? 1 : 0));
    let col = 0;
    const tds = cells.map((cell) => {
      let span = 1;
      let align = aligns[col] ?? "l";
      const mc = /^\s*\\multicolumn\s*\{\s*(\d+)\s*\}\s*\{([^}]*)\}/.exec(cell);
      if (mc) {
        span = +mc[1];
        align = columns(mc[2])[0] ?? align;
        const cr = new Reader(cell, mc[0].length);
        cell = cr.arg();
      }
      col += span;
      const a = align === "c" ? "center" : align === "r" ? "right" : "left";
      return `<td${span > 1 ? ` colspan="${span}"` : ""} style="text-align: ${a}">${run(st, cell.trim(), false)}</td>`;
    });
    out.push(`<tr class="${ruleAbove ? `rule-above-${ruleAbove}` : ""}">${tds.join("")}</tr>`);
    ruleAbove = "";
  }
  if (env === "longtable" || env === "longtblr") st.floats.pop();
  return `<div class="tex-table"><table>${out.join("")}</table></div>`;
}

/** A column spec's alignments, one per column ("l", "c" or "r"). */
function columns(spec: string): string[] {
  const out: string[] = [];
  const r = new Reader(spec);
  while (!r.done) {
    const c = r.s[r.i++];
    if (c === "l" || c === "c" || c === "r") out.push(c);
    else if (c === "p" || c === "m" || c === "b" || c === "w" || c === "W") {
      if (c === "w" || c === "W") r.arg();
      r.arg();
      out.push("l");
    } else if (c === "X" || c === "L" || c === "J") out.push("l");
    else if (c === "C" || c === "S") out.push("c");
    else if (c === "R") out.push("r");
    else if (c === "*") {
      const n = Number(r.arg()) || 0;
      const inner = columns(r.arg());
      for (let k = 0; k < Math.min(n, 64); k++) out.push(...inner);
    } else if (c === "@" || c === "!" || c === ">" || c === "<") r.arg();
    else if (c === "{") {
      // A tblr spec (colspec = {…}) or the like: its letters.
      r.i--;
      out.push(...columns(r.arg()));
    }
  }
  return out;
}

// ---------------- maths ----------------

function math(st: State, tex: string, display: boolean): string {
  try {
    return katex.renderToString(stripComments(tex).replace(/\\label\s*\{[^}]*\}/g, ""), { displayMode: display, throwOnError: false, strict: "ignore", macros: st.macros, trust: false });
  } catch {
    return `<code class="tex-tt">${esc(tex)}</code>`;
  }
}

/** Display maths; a numbering environment's equations (or rows) numbered, as \label and \tag say. */
function displayMath(st: State, tex: string, isEnv: boolean, env = "equation*"): string {
  tex = stripComments(tex);
  const numbers = isEnv && !env.endsWith("*") && env !== "displaymath" && env !== "math";
  const ids: string[] = [];
  let body: string;
  const tagRow = (row: string): string => {
    const label = /\\label\s*\{([^}]*)\}/.exec(row)?.[1];
    row = row.replace(/\\label\s*\{[^}]*\}/g, "");
    if (/\\(nonumber|notag)\b/.test(row)) return row.replace(/\\(nonumber|notag)\b/g, "");
    if (/\\tag\*?\s*\{/.test(row)) {
      if (label) st.labels.set(label, { num: /\\tag\*?\s*\{([^}]*)\}/.exec(row)![1], id: anchor(st), kind: "eq" });
      return row;
    }
    if (!numbers || !row.trim()) return row;
    const n = numbered(st, "equation");
    const id = anchor(st);
    ids.push(id);
    if (label) st.labels.set(label, { num: n, id, kind: "eq" });
    return `${row}\\tag{${n}}`;
  };
  const base = env.replace(/\*$/, "");
  if (base === "equation" || base === "displaymath" || base === "math" || base === "dmath" || !isEnv) body = `\\begin{equation*}${tagRow(tex)}\\end{equation*}`;
  else {
    const rows = splitTop(tex, (s, i) => (s.startsWith("\\\\", i) ? 2 : 0)).map(tagRow);
    const joined = rows.join("\\\\");
    if (base === "eqnarray") body = `\\begin{align*}${rows.map((row) => row.replace(/&([^&]*)&/, "&$1")).join("\\\\")}\\end{align*}`;
    else if (base === "multline") body = `\\begin{gather*}${joined}\\end{gather*}`;
    else if (base === "flalign") body = `\\begin{align*}${joined}\\end{align*}`;
    else if (base === "alignat") body = `\\begin{align*}${joined}\\end{align*}`;
    else body = `\\begin{${base}*}${joined}\\end{${base}*}`;
  }
  const idAttr = ids.length ? ` id="${ids[0]}"` : "";
  return `<div class="tex-display"${idAttr}>${ids.slice(1).map((id) => `<span id="${id}"></span>`).join("")}${math(st, body, true)}</div>`;
}

// ---------------- after ----------------

/** The references, citations and contents, now that every label is known. */
function resolve(st: State, html: string): string {
  return html.replace(/\u0001([A-Z]):([^\u0002]*)\u0002/g, (_, kind: string, arg: string) => {
    if (kind === "T") {
      if (!st.headings.length) return "";
      const rows = st.headings.map((h) => `<div class="tex-toc-row tex-toc-${h.level}" data-to="${h.id}">${h.num ? `<span class="tex-num">${h.num}</span>` : ""}${h.text}</div>`).join("");
      return `<nav class="tex-toc"><div class="tex-toc-title">${st.names.contents}</div>${rows}</nav>`;
    }
    if (kind === "C") {
      const [keys, note] = arg.split("|");
      const marks = keys.split(",").map((k) => {
        const key = k.trim();
        const n = st.bib.get(key);
        return n ? `<span class="tex-cite" data-to="tex-bib-${esc(key)}">${n}</span>` : `<span class="tex-cite">${esc(key)}</span>`;
      });
      return `[${marks.join(", ")}${note ? `, ${note}` : ""}]`;
    }
    const keys = arg.split(",").map((k) => k.trim());
    return keys
      .map((key) => {
        const l = st.labels.get(key);
        if (!l) return `<span class="tex-ref missing">??</span>`;
        const num = kind === "E" || (kind === "N" && l.kind === "eq") ? `(${l.num})` : l.num;
        const word = kind === "N" ? `${{ sec: st.names.section, fig: st.names.figure, tab: st.names.table, eq: st.names.equation }[l.kind] ?? ""} `.trimStart() : "";
        return `<span class="tex-ref" data-to="${l.id}">${word}${num}</span>`;
      })
      .join(", ");
  });
}

const GRAPHIC_EXTS = [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"];

/** A figure's placeholder filled: the file as named, or with the extensions LaTeX would try, in the folders
 *  \graphicspath gives; a PDF's first page drawn. */
function figure(ph: HTMLElement, opts: LatexOptions, dirs: string[]) {
  const path = ph.dataset.texSrc!;
  const hasExt = /\.[a-z0-9]{2,4}$/i.test(path);
  const tries = ["", ...dirs].flatMap((d) => (hasExt ? [d + path] : GRAPHIC_EXTS.map((e) => d + path + e)));
  const scale = parseFloat(ph.style.getPropertyValue("--tex-scale")) || 0;
  const fit = (node: HTMLElement, w: number) => {
    if (scale && w) node.style.width = `${w * scale}px`;
  };
  const next = (k: number) => {
    if (k >= tries.length) return void ph.replaceChildren(Object.assign(document.createElement("span"), { className: "tex-note", textContent: `${path} not found` }));
    const url = opts.image(tries[k]);
    if (/\.pdf$/i.test(tries[k])) {
      pdfFigure(url).then(
        (canvas) => {
          ph.replaceChildren(canvas);
          fit(canvas, parseFloat(canvas.style.width));
        },
        () => next(k + 1),
      );
      return;
    }
    const img = document.createElement("img");
    img.alt = path;
    img.onload = () => {
      ph.replaceChildren(img);
      fit(img, img.naturalWidth);
    };
    img.onerror = () => next(k + 1);
    img.src = url;
  };
  next(0);
}
