// The UI's settings every window shares (Settings, the sidebar's view, session names…). The UI keeps them in
// localStorage, which a browser keeps per address: the app's window (127.0.0.1) and a phone over remote access (the
// tailnet name) would each have their own. So the core holds them too: it writes them into each page's localStorage
// before the page's own scripts run, and passes a change one window makes on to the others (web/uisync.ts). Opaque
// here: keys and values as the UI stores them.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class SharedUiState {
  private file: string;
  private values: Record<string, string>;

  constructor(stateDir: string) {
    this.file = join(stateDir, "ui-state.json");
    try {
      this.values = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    } catch {
      this.values = {};
    }
  }

  has(key: string): boolean {
    return key in this.values;
  }

  all(): Record<string, string> {
    return { ...this.values };
  }

  /** null removes it. False when nothing changed. */
  set(key: string, value: string | null): boolean {
    if ((this.values[key] ?? null) === value) return false;
    if (value === null) delete this.values[key];
    else this.values[key] = value;
    writeFileSync(this.file, JSON.stringify(this.values));
    return true;
  }

  /** The page with the values written into its localStorage first thing, before its head's own scripts read any. */
  inject(html: string): string {
    const data = JSON.stringify(this.values).replace(/</g, "\\u003c");
    const tag = `<script>try{const v=${data};for(const k in v)localStorage.setItem(k,v[k])}catch{}</script>`;
    return html.includes("<head>") ? html.replace("<head>", `<head>${tag}`) : tag + html;
  }
}
