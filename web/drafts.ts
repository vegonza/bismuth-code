// Unsent prompts, one per session plus one per new session being written. The composer saves as you type
// and swaps them as you move between sessions, each with its caret; localStorage keeps them across reloads and
// restarts. The sidebar marks sessions holding one with a pencil, and lists new sessions holding one as rows of
// their own (t3code's draft threads).
import { forgetStaged, renameStaged, stagedCount } from "./attachments";
import { firstLine } from "./dom";
import { store, writeEntries } from "./store";

const KEY = "bismuth.drafts";
const CARETS = "bismuth.draftCarets";
// Strings only: the file viewer's unsaved edits once shared this key (panels.ts).
const drafts = new Map<string, string>(Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}")).filter((e): e is [string, string] => typeof e[1] === "string"));
const carets = new Map<string, number>(Object.entries(JSON.parse(localStorage.getItem(CARETS) ?? "{}") as Record<string, number>));

export const getDraft = (key: string) => drafts.get(key) ?? "";
export const hasDraft = (threadId: string) => !!drafts.get(threadId)?.trim();

export function setDraft(key: string, text: string) {
  if ((drafts.get(key) ?? "") === text) return;
  if (text) drafts.set(key, text);
  else {
    drafts.delete(key);
    if (carets.delete(key)) writeEntries(CARETS, { [key]: undefined });
  }
  writeEntries(KEY, { [key]: text || undefined });
  // A new-session draft emptied loses its row for good: typing into it again is a fresh start, not one left before.
  const d = newDrafts.get(key);
  if (d?.left && !draftHasContent(key)) (d.left = undefined), saveNew();
}

/** Where the caret was in a draft when its session was left (undefined: the end). */
export const getDraftCaret = (key: string) => carets.get(key);

export function setDraftCaret(key: string, caret: number) {
  if (!drafts.has(key) || carets.get(key) === caret) return;
  carets.set(key, caret);
  writeEntries(CARETS, { [key]: caret });
}

// ---------------- new-session drafts ----------------
// The new-session screen always shows one of these. Like t3code's, one gets a sidebar row only once it's been left
// holding something (another session opened, or a fresh new one); sending it, or emptying it, takes the row away.

/** `left`: moved away from with something in it, so it keeps its row when opened again. */
export type NewDraft = { id: string; projectId: string | null; createdAt: number; left?: boolean };

const NEW = "bismuth.newDrafts";
const OPEN = "bismuth.openDraft";
const PREFIX = "new:";
export const isNewDraft = (id: string) => id.startsWith(PREFIX);

const newDrafts = new Map<string, NewDraft>((JSON.parse(localStorage.getItem(NEW) ?? "[]") as NewDraft[]).map((d) => [d.id, d]));
const saveNew = () => localStorage.setItem(NEW, JSON.stringify([...newDrafts.values()]));

function mint(projectId: string | null): NewDraft {
  const d = { id: PREFIX + crypto.randomUUID(), projectId, createdAt: Date.now() };
  newDrafts.set(d.id, d);
  saveNew();
  return d;
}

let open = newDrafts.get(localStorage.getItem(OPEN) ?? "") ?? mint(store.currentProject);
localStorage.setItem(OPEN, open.id);
// The single new-session draft from before these (key "") becomes the open one.
if (drafts.has("")) {
  setDraft(open.id, getDraft(""));
  const caret = carets.get("");
  if (caret !== undefined) setDraftCaret(open.id, caret);
  setDraft("", "");
}
renameStaged("", open.id);
// Drafts emptied before emptying cleared `left` (setDraft) would show up as rows the moment they're typed in.
for (const d of newDrafts.values()) if (d.left && !draftHasContent(d.id)) d.left = undefined;
saveNew();

/** The draft the new-session screen shows. */
export const openNewDraft = () => open;
export const newDraft = (id: string) => newDrafts.get(id);

/** It holds something worth keeping: text, or images. */
export function draftHasContent(key: string) {
  return !!drafts.get(key)?.trim() || stagedCount(key) > 0;
}

/** The sidebar's line for a new-session draft: its first line, else what's attached. */
export function draftPreview(id: string) {
  const line = firstLine(getDraft(id));
  if (line) return line;
  const n = stagedCount(id);
  return `${n} image${n === 1 ? "" : "s"}`;
}

/** The composer moved off a draft: a new-session one holding something is listed from now on, and one left empty
 *  isn't any more (it's a blank new session again, not a draft to come back to). */
export function leaveDraft(key: string) {
  const d = newDrafts.get(key);
  const left = draftHasContent(key);
  if (!d || !!d.left === left) return;
  d.left = left || undefined;
  saveNew();
}

/** New-session drafts holding something, newest first. */
export const listedNewDrafts = () => [...newDrafts.values()].filter((d) => draftHasContent(d.id)).sort((a, b) => b.createdAt - a.createdAt);

/** Put a new-session draft on the screen (id null: a fresh one, in `projectId`); empty ones left behind are dropped. */
export function switchNewDraft(id: string | null, projectId: string | null = null): NewDraft {
  open = (id && newDrafts.get(id)) || mint(projectId);
  localStorage.setItem(OPEN, open.id);
  for (const d of newDrafts.values()) if (d !== open && !draftHasContent(d.id)) dropDraft(d.id);
  saveNew();
  return open;
}

export function setNewDraftProject(id: string, projectId: string | null) {
  const d = newDrafts.get(id);
  if (!d || d.projectId === projectId) return;
  d.projectId = projectId;
  saveNew();
}

function dropDraft(id: string) {
  newDrafts.delete(id);
  setDraft(id, "");
  forgetStaged(id);
}

/** Throw a new-session draft away, text and images (the open one gives way to a fresh one). */
export function discardNewDraft(id: string) {
  const d = newDrafts.get(id);
  if (!d) return;
  dropDraft(id);
  if (open.id === id) open = mint(d.projectId), localStorage.setItem(OPEN, open.id);
  saveNew();
}
