// The agent's questions (Zeron's question wizard, composer.rs `Wizard` + `render_wizard`): a panel that stands in
// for the composer, one question per page ("1/3"). Single-select auto-advances once picked, multi-select toggles;
// keys 1-9 pick, Enter goes on, Escape goes back. A typed answer over the hairline overrides the picks.
import type { RequestResponse, RuntimeRequest } from "../shared/model";
import { el } from "./dom";

/** Zeron's AUTO_ADVANCE_MS: a single pick lands, then the next page. */
const AUTO_ADVANCE_MS = 220;

export type QuestionPanel = { root: HTMLElement; requestId: string; focus(): void };

export function questionPanel(req: RuntimeRequest, respond: (response: RequestResponse) => void): QuestionPanel {
  const qs = req.questions;
  let page = 0;
  const picked: number[][] = qs.map(() => []);
  const typed: string[] = qs.map(() => "");
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const root = el("div", "question-panel");
  root.tabIndex = -1;
  const body = el("div", "qp-body");
  const footer = el("div", "qp-footer");
  root.append(body, footer);
  const input = el("textarea", "qp-input");
  input.rows = 1;
  input.spellcheck = true;

  const answers = (): RequestResponse => {
    const out: Record<string, string[]> = {};
    qs.forEach((q, i) => {
      const text = typed[i].trim();
      out[q.id] = text ? [text] : picked[i].map((ix) => q.options[ix].label);
    });
    return { answers: out };
  };

  function finish() {
    if (done) return;
    done = true;
    clearTimeout(advanceTimer);
    root.classList.add("sent");
    respond(answers());
  }

  function advance() {
    clearTimeout(advanceTimer);
    typed[page] = input.value;
    if (page + 1 < qs.length) {
      page++;
      render(true);
    } else finish();
  }

  function back() {
    clearTimeout(advanceTimer);
    typed[page] = input.value;
    if (page > 0) {
      page--;
      render(true);
    }
  }

  function select(ix: number) {
    const q = qs[page];
    if (done || ix >= q.options.length) return;
    const p = picked[page];
    if (q.multiSelect) {
      const at = p.indexOf(ix);
      if (at >= 0) p.splice(at, 1);
      else p.push(ix);
      render();
    } else {
      picked[page] = [ix];
      // A pick is the answer: a typed one would hide it.
      input.value = typed[page] = "";
      render();
      clearTimeout(advanceTimer);
      advanceTimer = setTimeout(advance, AUTO_ADVANCE_MS);
    }
  }

  function render(newPage = false) {
    const q = qs[page];
    const hasText = !!input.value.trim();
    const head = el("div", "qp-head");
    if (q.header) head.append(el("span", "qp-header", q.header));
    if (qs.length > 1) head.append(el("span", "qp-counter", `${page + 1}/${qs.length}`));
    const nodes: HTMLElement[] = [];
    if (head.childElementCount) nodes.push(head);
    nodes.push(el("div", "qp-question", q.question));
    if (q.multiSelect) nodes.push(el("div", "qp-hint", "Select one or more options."));
    if (q.options.length) {
      const list = el("div", "qp-options");
      q.options.forEach((o, ix) => {
        // Selection reads on the row only while no typed answer overrides it.
        const on = picked[page].includes(ix) && !hasText;
        const row = el("button", `qp-option${on ? " picked" : ""}`);
        row.tabIndex = -1;
        const text = el("span", "qp-text");
        text.append(el("span", "qp-label", o.label));
        if (o.description) text.append(el("span", "qp-desc", o.description));
        row.append(text);
        if (ix < 9) row.append(el("span", "qp-key", String(ix + 1)));
        row.onclick = () => select(ix);
        list.append(row);
      });
      nodes.push(list);
    }
    if (newPage) input.value = typed[page];
    input.placeholder = !q.options.length
      ? "Type your answer"
      : picked[page].length
        ? "Type your own answer, or leave this blank to use the selected option"
        : "Type your own answer, or pick an option above";
    const field = el("div", "qp-field");
    // A secret answer stays out of sight (Codex's isSecret).
    input.classList.toggle("secret", q.secret);
    field.append(input);
    nodes.push(field);
    body.replaceChildren(...nodes);
    fit();

    const last = page + 1 >= qs.length;
    const canAdvance = picked[page].length > 0 || hasText;
    const backBtn = el("button", "qp-back", "Back");
    backBtn.onclick = back;
    const next = el("button", `qp-next${canAdvance ? "" : " idle"}`, last ? "Submit" : "Next");
    next.onclick = advance;
    footer.replaceChildren(page > 0 ? backBtn : el("span"), next);
  }

  /** The answer grows with its text, up to the composer's cap. */
  const fit = () => {
    // Detached (the panel's first render) it has no height to measure: one line until it's on screen.
    if (!input.isConnected) return void (input.style.height = "");
    input.style.height = "auto";
    input.style.height = `${Math.min(260, input.scrollHeight)}px`;
  };

  input.addEventListener("input", () => {
    typed[page] = input.value;
    const hadText = root.classList.contains("typing");
    const hasText = !!input.value.trim();
    root.classList.toggle("typing", hasText);
    // Typing over a pick (or clearing it) flips the rows' selection and the button's state.
    if (hadText !== hasText) render();
    else fit();
  });

  root.addEventListener("keydown", (e) => {
    if (done) return;
    const inInput = e.target === input;
    const empty = !input.value;
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (bare && /^[1-9]$/.test(e.key) && (!inInput || empty)) {
      e.preventDefault();
      e.stopPropagation();
      select(Number(e.key) - 1);
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing && bare) {
      e.preventDefault();
      e.stopPropagation();
      advance();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (!inInput || empty) back();
    } else if (!inInput && bare && [...e.key].length === 1) {
      // Typing on the panel goes into the answer.
      input.focus();
    }
  });

  render(true);
  return {
    root,
    requestId: req.id,
    focus() {
      if (!root.contains(document.activeElement)) (qs[page].options.length ? root : input).focus();
    },
  };
}
