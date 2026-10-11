# bismuth

Desktop UI (Electron) for coding-agent harnesses — Codex and Claude Code. You may be running *inside* this app while editing it.

## Layout

| Path | Layer | Picked up by |
| --- | --- | --- |
| `web/` | UI (bundled from `web/index.html`) | `bun run apply` — hot, no restart |
| `assets/` | icons (`bun run icon` regenerates from `scripts/icon.ts`) | `bun run apply` |
| `core/` | the core: owns harness processes (`codex app-server`, the `claude` CLI per turn), projects and thread state, serves the UI. Harnesses only, never presentation: see `core/AGENTS.md` | app restart only |
| `shared/` | core⇄UI protocol types | app restart only |
| `desktop/` | Electron shell: spawns the core; native integration for the UI (saving previews as PDFs) via `desktop/preload.cjs` | app quit and reopen |
| `view-templates/` | starting points for a project's `.bismuth/view/build` (views agents render: `core/views.ts`), read by agents setting a project up | — (read on use) |
| `codex-protocol/` | generated Codex types (`bun run gen:protocol`) | — |
| `refs/` | reference projects (Zeron, t3code, …), each its own git clone, ignored by git; not part of the app | — |

The core is never reloaded, so conversations survive UI changes. Prefer putting features in `web/`; touch `core/` or `shared/` only when the UI genuinely can't do it, and say that a restart is needed.

## Reuse before you build

Before adding UI behaviour, look for where the app already does it and use that, generalising it if it's shaped for one caller. Don't solve the same problem twice: a second copy drifts and loses the details the first one got right. If the existing piece is close but not quite it, change the existing piece so both callers share it. Examples of shared pieces:

- Hover actions that would cover text (copy buttons, etc.) go out in the gutter beside it, sticking below the titlebar as you scroll: `gutterAction` in `web/markdown.ts` (`.gutter-rail` in `web/style.css`).
- Copy to clipboard with the copied feedback: `copyText` (`web/markdown.ts`), `copyAction` (`web/widgets.ts`).
- Motion: `web/motion.ts`, `web/listmotion.ts`. Popovers and menus: `web/popover.ts`. Icons: `web/icons.ts`.

## Applying changes

Edits to files do **not** affect the running app. At the end of a turn that changed the app, run:

```
bun run apply
```

It typechecks, bundles the UI, and boots the new UI in headless Chromium against the live core (with a thread the core already has loaded open). Only if all of that passes does the running app switch to the new build and reload its window. Exit codes: `0` applied or up to date · `1` rejected, fix the errors it prints and rerun · `3` core or `shared/` changed: ask the user to run **Restart bismuth** from the command palette (Ctrl+K). It typechecks and bundles the core first and refuses if that fails, offers to wait for running sessions, and restarts the core without closing the window. Changes to `desktop/` still need the app quit and reopened.

Contract the UI must keep: set `window.__bismuthReady = true` once the first screen has rendered from core data (see `markReady` in `web/app.ts`). Reloading itself is handled by a script the core injects (`core/live.ts`), not by `web/`.

## Commands

- `bun run app [dir]` — launch the desktop app (one instance for every project; `dir` adds that folder as a project and opens on it)
- `bun start [dir]` — core only, open the printed URL in a browser
- `bun run typecheck`
