// The view page's half of web/views.ts: the core puts this first in every view page as it serves it (core/views.ts),
// read from disk each time, so a change here reaches views already in threads without a restart or a rebuild.
// It follows the theme the window passes (?theme=, then messages) as class="dark"/"light" and data-theme on <html>,
// and reports the page's size: its height at the frame's width, and the width it would take on its own
// (max-content), so the frame is only as wide as the view needs.
// A plain HTML view (<html data-bismuth-plain>: a project without a view build of its own) is styled as bismuth:
// base styles here, and the window's theme variables and fonts, which it sends when the page says hello.
// A local image the core inlined (its data: URL ends #bismuth-file=<path>) opens in the window's file panel when
// clicked, kept open on a double click, as file links do there. The pointer's moves are passed on too: the frame keeps
// them to itself, and the window's edge peek follows them.
(() => {
  const d = document.documentElement;
  const plain = d.hasAttribute("data-bismuth-plain");
  // A page focusing a field or scrolling something into view as it loads (React's autoFocus, a chat scrolled to its
  // last message) would scroll the transcript to the frame, wherever the view is, and take the focus from the
  // composer: the window's scroller is the frame's too. Until the user acts on the view, both are left undone.
  const acting = () => document.hasFocus() || navigator.userActivation?.isActive;
  for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
    const focus = proto.focus;
    proto.focus = function (...args) {
      if (acting()) focus.apply(this, args);
    };
  }
  for (const name of ["scrollIntoView", "scrollIntoViewIfNeeded"]) {
    const scroll = Element.prototype[name];
    if (scroll)
      Element.prototype[name] = function (...args) {
        if (acting()) scroll.apply(this, args);
      };
  }
  if (plain) {
    const base = document.createElement("style");
    // bismuth's default theme, until the window sends the user's (and in a screenshot, which has no window).
    base.textContent = `:root.dark { --main: #1e2027; --text: #d5ced9; --muted: #a6a0aa; --faint: #746f77; --accent: #8b7cf6; --accent-strong: #8b7cf6; --accent-wash: rgba(139, 124, 246, 0.22); --danger: #ee5d43; --warning: #ff9f2e; --success: #96e072; --border: rgba(255, 255, 255, 0.1); --border-strong: rgba(255, 255, 255, 0.18); --hover: rgba(255, 255, 255, 0.11); --bubble: hsla(0, 0%, 92%, 0.08); --card-bg: #2a2e37; }
:root.light { --main: #ffffff; --text: #1f2328; --muted: #59636e; --faint: #8c959f; --accent: #7c6cf0; --accent-strong: #6b5ce7; --accent-wash: rgba(124, 108, 240, 0.14); --danger: #d1242f; --warning: #bf8700; --success: #1a7f37; --border: rgba(0, 0, 0, 0.1); --border-strong: rgba(0, 0, 0, 0.18); --hover: rgba(0, 0, 0, 0.06); --bubble: hsla(0, 0%, 10%, 0.04); --card-bg: #f6f6f8; }
:root { --sans: "Geist", system-ui, sans-serif; --mono: "Geist Mono", ui-monospace, monospace; --fs: 1; --code-size: 12.5px; }
html { color: var(--text); font: calc(13px * var(--fs, 1))/1.5 var(--sans, system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
body { margin: 0; }
a { color: var(--accent); }
code, kbd, pre, samp { font-family: var(--mono, ui-monospace, monospace); font-size: var(--code-size, 12px); }
table { border-collapse: collapse; }
th, td { padding: 4px 10px; border-bottom: 1px solid var(--border); text-align: left; }
th { color: var(--muted); font-weight: 500; }
hr { border: 0; border-top: 1px solid var(--border); }`;
    (document.head || d).prepend(base);
  }
  const loaded = new Set();
  const fonts = (list) => {
    for (const f of list || []) {
      const key = `${f.family}/${f.weight}/${f.style}`;
      if (loaded.has(key)) continue;
      loaded.add(key);
      try {
        document.fonts.add(new FontFace(f.family, f.data, { weight: f.weight, style: f.style }));
      } catch {}
    }
  };
  const set = (t) => {
    d.classList.toggle("dark", t === "dark");
    d.classList.toggle("light", t !== "dark");
    d.dataset.theme = t;
    d.style.colorScheme = t;
  };
  set(new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light");
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.bismuthView !== "theme") return;
    set(e.data.theme === "dark" ? "dark" : "light");
    if (!plain) return;
    for (const [k, v] of Object.entries(e.data.vars || {})) d.style.setProperty(k, v);
    fonts(e.data.fonts);
  });
  parent.postMessage({ bismuthView: "hello", plain }, "*");
  // The pointer's moves, which the frame keeps to itself: the window's edge peek follows them (web/panels.ts).
  addEventListener("pointermove", (e) => e.pointerType === "mouse" && parent.postMessage({ bismuthPointer: [e.clientX, e.buttons] }, "*"), { capture: true, passive: true });

  const MARK = "#bismuth-file=";
  const fileOf = (url) => {
    const at = url ? url.indexOf(MARK) : -1;
    if (at < 0) return null;
    try {
      return decodeURIComponent(url.slice(at + MARK.length).split(/["')]/)[0]);
    } catch {
      return null;
    }
  };
  /** The inlined image under a click: an <img>, or a CSS background, on the target or what holds it (but not in a
   *  control of the view's own). */
  const clicked = (target) => {
    for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
      if (n.closest("a, button, label, input, select, textarea, [onclick], [role=button]")) return null;
      const file = n.tagName === "IMG" ? fileOf(n.currentSrc || n.src) : fileOf(getComputedStyle(n).backgroundImage);
      if (file) return file;
    }
    return null;
  };
  // On the window, so the view's own handlers come first: a click one of them handled is left to it.
  for (const [type, keep] of [["click", false], ["dblclick", true]]) {
    addEventListener(type, (e) => {
      if (e.defaultPrevented) return;
      const path = clicked(e.target);
      if (path) parent.postMessage({ bismuthView: "open", path, keep }, "*");
    });
  }
  const cursor = document.createElement("style");
  cursor.textContent = `img[src*="${MARK}"] { cursor: pointer; }`;
  (document.head || d).append(cursor);

  const start = () => {
    const b = document.body;
    let last = "";
    let queued = false;
    const post = () => {
      queued = false;
      const s = getComputedStyle(b);
      const height = Math.ceil(b.getBoundingClientRect().height + parseFloat(s.marginTop) + parseFloat(s.marginBottom));
      // Laid out at max-content and put back in the same task: nothing is painted in between.
      const before = b.style.width;
      b.style.width = "max-content";
      const width = Math.ceil(b.getBoundingClientRect().width + parseFloat(s.marginLeft) + parseFloat(s.marginRight));
      b.style.width = before;
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      parent.postMessage({ bismuthView: "size", width, height }, "*");
    };
    const soon = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(post);
    };
    // The body's box follows the frame, not what's in it: content changes are watched too.
    new ResizeObserver(soon).observe(b);
    new MutationObserver(soon).observe(b, { childList: true, subtree: true, attributes: true, characterData: true });
    void document.fonts.ready.then(soon);
    post();
  };
  if (document.body) start();
  else addEventListener("DOMContentLoaded", start);
})();
