// Debug client. Examples:
//   bun scripts/probe.ts                                   # hello: models + threads
//   bun scripts/probe.ts --open <threadId>                 # print a thread's history
//   bun scripts/probe.ts --prompt "..." [--harness claude] [--project <id>] [--thread <id>] [--interrupt-after 3000] [--steer-after 2000 --steer "..."] [--wait 60000]
import type { ClientMessage, ServerMessage, Thread } from "../shared/model";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const wait = Number(opt("--wait") ?? 60000);
const host = `127.0.0.1:${process.env.PORT ?? 7421}`;
// The core only takes its own pages' origin.
const ws = new WebSocket(`ws://${host}/ws`, { headers: { origin: `http://${host}` } } as any);
const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
let projectId: string | null = null;
let thread: Thread | null = null;
let done = false;

const finish = () => {
  if (done) return;
  done = true;
  if (thread) {
    console.log(`\n=== thread ${thread.id} "${thread.title}" status=${thread.status} model=${thread.model} effort=${thread.effort}`);
    for (const t of thread.turns) {
      console.log(`--- turn ${t.id} ${t.status}${t.error ? ` (${t.error})` : ""} ${t.durationMs ?? ""}ms`);
      for (const i of t.items) console.log("   ", i.kind, JSON.stringify(i).slice(0, 220));
    }
  }
  process.exit(0);
};

ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data)) as ServerMessage;
  if (m.type === "hello") {
    console.log(`hello ready=${m.ready} error=${m.error}`);
    console.log(`projects: ${m.projects.map((p) => `${p.id} ${p.name} (${p.path})`).join(" | ")}`);
    projectId = opt("--project") ?? m.launch ?? m.projects[0]?.id ?? null;
    console.log(`harnesses: ${m.harnesses.map((h) => `${h.id}=${h.available ? "ok" : `down (${h.error})`}`).join(", ")}`);
    console.log(`models: ${m.models.map((x) => `${x.harness}:${x.id}[${x.efforts.join("/")}]${x.isDefault ? "*" : ""}${x.fastTier ? "⚡" : ""}`).join(", ")}`);
    console.log(`threads: ${m.threads.map((t) => `${t.harness}:${t.id.slice(0, 8)} ${t.status} "${t.title}"`).join(" | ")}`);
    const open = opt("--open");
    const prompt = opt("--prompt");
    if (open || opt("--thread")) send({ type: "open", threadId: (open ?? opt("--thread"))! });
    else if (prompt)
      send({
        type: "send",
        threadId: opt("--thread") ?? null,
        projectId,
        text: prompt,
        settings: { harness: (opt("--harness") ?? "codex") as "codex" | "claude", model: opt("--model") ?? null, effort: opt("--effort") ?? "low", serviceTier: null },
      });
    else finish();
  } else if (m.type === "thread") {
    thread = m.thread;
    console.log(`[thread] ${thread.id} turns=${thread.turns.length}`);
    if (opt("--open")) finish();
    else if (opt("--thread") && opt("--prompt") && !thread.activeTurnId)
      send({ type: "send", threadId: thread.id, projectId: null, text: opt("--prompt")!, settings: { harness: thread.harness, model: opt("--model") ?? thread.model, effort: opt("--effort") ?? "low", serviceTier: null } });
  } else if (m.type === "event") {
    const e = m.event;
    if (!thread || m.threadId !== thread.id) return;
    switch (e.type) {
      case "thread.upsert":
        Object.assign(thread, e.thread);
        console.log(`[thread.upsert] status=${e.thread.status} active=${e.thread.activeTurnId} notice=${e.thread.notice}`);
        break;
      case "turn.upsert": {
        let t = thread.turns.find((x) => x.id === e.turn.id);
        if (!t) thread.turns.push((t = { ...e.turn, items: [] }));
        Object.assign(t, e.turn);
        console.log(`[turn] ${e.turn.id} ${e.turn.status}`);
        if (e.turn.status !== "inProgress") setTimeout(finish, 1500);
        break;
      }
      case "item.upsert": {
        let t = thread.turns.find((x) => x.id === e.turnId)!;
        if (!t) thread.turns.push((t = { id: e.turnId, status: "inProgress", error: null, durationMs: null, startedAt: null, completedAt: null, items: [] }));
        const idx = t.items.findIndex((i) => i.id === e.item.id);
        if (idx >= 0) t.items[idx] = e.item;
        else t.items.push(e.item);
        console.log(`[item] ${e.item.kind} ${JSON.stringify(e.item).slice(0, 140)}`);
        break;
      }
      case "item.delta":
        process.stdout.write(".");
        break;
      case "request.upsert": {
        const r = e.request;
        console.log(`[request] ${JSON.stringify(r).slice(0, 400)}`);
        setTimeout(() => {
          send({ type: "respond", threadId: thread!.id, requestId: r.id, response: { answers: Object.fromEntries(r.questions.map((q) => [q.id, [q.options[0]?.label ?? "ok"]])) } });
        }, 500);
        break;
      }
      case "request.remove":
        console.log(`[request.remove] ${e.requestId}`);
        break;
    }
  } else if (m.type === "error") console.log(`[error] ${m.message}`);
};

const ia = opt("--interrupt-after");
if (ia)
  setTimeout(() => {
    console.log("[interrupting]");
    if (thread) send({ type: "interrupt", threadId: thread.id });
  }, Number(ia));
setTimeout(finish, wait);

const sa = opt("--steer-after");
if (sa)
  setTimeout(() => {
    console.log("[steering]");
    if (thread) send({ type: "send", threadId: thread.id, projectId: null, text: opt("--steer") ?? "continue", settings: { harness: thread.harness, model: null, effort: "low", serviceTier: null } });
  }, Number(sa));
