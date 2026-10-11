# core/

The core is bismuth's long-lived backend. Its job is to run the coding-agent harnesses and keep their state. It
starts and drives `codex app-server`, the `claude` CLI and Cursor's runtime, turns their output into the shared
model (`shared/model.ts`), and holds what has to outlive a UI reload: threads, projects, the message queue,
settlement. It is never hot-reloaded, so every change here costs the user a **Restart bismuth**. Keep it small.

## What belongs here

- Harness adapters and their processes: `*-adapter.ts`, `harness.ts`, `jsonrpc.ts`, `compact.ts`.
- Session state: threads, `projects.ts`, `queue.ts`, `settled.ts`, `accounts.ts`, provider CLI `updates.ts`, usage.
- Machine access that sessions need and a page can't get on its own: a project's files and git status (`files.ts`,
  `watch.ts`), terminals, go-to-definition (`lsp.ts`), composer attachments (`uploads.ts`).
- Serving the UI and swapping its builds (`ui.ts`, `live.ts`).
