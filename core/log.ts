// The core's warnings and errors, kept in .bismuth/core.log as well: the desktop app starts the core with stderr
// going nowhere, so without this a failure (a harness's output lost mid-turn) leaves no trace. Imported first.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { format } from "node:util";

const dir = resolve(import.meta.dirname, "..", ".bismuth");
export const LOG = join(dir, "core.log");
/** Past this the log starts over (the last one kept as core.log.1). */
const MAX_BYTES = 4 * 1024 * 1024;

mkdirSync(dir, { recursive: true });
try {
  if (statSync(LOG).size > MAX_BYTES) renameSync(LOG, `${LOG}.1`);
} catch {}

function keep(level: string, args: unknown[]) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} ${level} [${process.pid}] ${format(...args)}\n`);
  } catch {}
}

for (const level of ["warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    keep(level, args);
    original(...args);
  };
}
keep("info", ["core starting"]);
