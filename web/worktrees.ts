// Worktrees in the window: Preview (the project folder shows a worktree session's files, core/preview.ts) and
// Settings → Worktrees (where new ones go, the cleanup rules, every project's worktrees with a way to remove one).
import type { PreviewResult, Project, WorktreeSettings, WorktreeStatus } from "../shared/model";
import { el, timeAgo } from "./dom";
import { refresh, settingsSection } from "./settings";
import { call, projectOf, store, tildePath, worktreeOf } from "./store";
import { showToast } from "./toast";
import { action, card, dialog, errorStrip, pageColumn, pageHeader, pageSubtitle, row, section, select, toggle } from "./widgets";

/** Files the folder had changed itself, left as they were: said after the name. */
const keptNote = (r: PreviewResult) => (r.kept.length ? `· ${r.kept.length} kept` : undefined);

/** Preview this session: from a worktree's session, the project folder shows its files (the app running there reloads
 *  as its own watchers do); from a session in the project folder, the folder gets its own files back. */
export async function previewSession() {
  const t = store.thread;
  const project = t && projectOf(t.cwd);
  if (!t || !project) return;
  const tree = worktreeOf(t.cwd);
  if (!tree && !project.preview) return void showToast("No worktree to preview", { pill: true, icon: "monitorPlay", ms: 1500 });
  await switchPreview(project, tree?.path ?? null);
}

/** The project folder shows the worktree at `path`'s files, or its own again (null). Said as a small pill with the
 *  worktree's name (or the project's, back to its own); a spinner only when the switch takes a moment. */
export async function switchPreview(project: Project, path: string | null) {
  const name = path ? (project.worktrees.find((w) => w.path === path)?.name ?? "worktree") : project.name;
  const pill = { pill: true, icon: path ? "monitorPlay" : "house" } as const;
  let hide = () => {};
  const slow = setTimeout(() => (hide = showToast(name, { ...pill, busy: true })), 250);
  try {
    const r = await call("preview.set", { projectId: project.id, path });
    clearTimeout(slow);
    showToast(name, { ...pill, note: keptNote(r), ms: r.kept.length ? 2500 : 900 });
  } catch (err: any) {
    clearTimeout(slow);
    hide();
    showToast(String(err?.message ?? err), { tone: "error", ms: 5000 });
  }
}

const warned = new Set<string>();
/** A prompt to a session in a project folder that's showing a worktree: its edits mix with the preview's files (the
 *  preview leaves them as they are). Said once per session and preview. */
export function warnIfPreviewing(cwd: string) {
  const project = projectOf(cwd);
  if (!project?.preview || project.path !== cwd) return;
  const key = `${store.thread?.id}:${project.preview}`;
  if (warned.has(key)) return;
  warned.add(key);
  const shown = project.worktrees.find((w) => w.path === project.preview);
  showToast(`${project.name} is showing ${shown?.name ?? "a worktree"}`, { pill: true, icon: "monitorPlay", note: "· edits stay over it", ms: 3000 });
}

// ---------------- Settings → Worktrees ----------------

let settings: WorktreeSettings | null = null;
let status: WorktreeStatus[] | null = null;
let loadError: string | null = null;
let loading = false;
let loadedAt = 0;

/** The settings and every worktree's state, asked for again each time the page opens. */
async function load() {
  if (loading) return;
  loading = true;
  try {
    [settings, status] = await Promise.all([call("worktrees.settings", {}), call("worktrees.status", {})]);
    loadError = null;
    loadedAt = Date.now();
  } catch (err: any) {
    loadError = String(err?.message ?? err);
  } finally {
    loading = false;
  }
  if (settingsSection() === "worktrees") refresh();
}

async function save(patch: Parameters<typeof call<"worktrees.setSettings">>[1]) {
  try {
    settings = await call("worktrees.setSettings", patch);
  } catch (err: any) {
    loadError = String(err?.message ?? err);
  }
  refresh();
}

/** Where new worktrees go: saved on Enter or leaving the field; empty is the default folder. */
function location(s: WorktreeSettings): HTMLElement {
  const input = el("input", "compact-input folder-input");
  input.spellcheck = false;
  input.placeholder = tildePath(s.defaultRoot);
  input.value = s.root ?? "";
  input.setAttribute("aria-label", "Worktree folder");
  const commit = () => input.value.trim() !== (s.root ?? "") && void save({ root: input.value.trim() || null });
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape" && input.value !== (s.root ?? "")) {
      e.stopPropagation();
      input.value = s.root ?? "";
    }
  };
  input.onblur = commit;
  return row("Folder", ["New worktrees go in a folder per repository here", "Ones already made stay where they are"], input);
}

const IDLE = [null, 3, 7, 14, 30] as const;

function cleanup(s: WorktreeSettings): HTMLElement[] {
  const idle = select({
    options: IDLE.map((d) => ({ label: d == null ? "Never" : `After ${d} days` })),
    selected: Math.max(0, IDLE.indexOf(s.idleDays as (typeof IDLE)[number])),
    width: 140,
    onSelect: (i) => void save({ idleDays: IDLE[i] }),
  });
  const now = action("Clean up now", "filled", () => void cleanNow());
  return [
    row("Remove merged worktrees", ["Once their branch is in the default branch"], toggle(s.whenMerged, "Remove merged worktrees", (on) => void save({ whenMerged: on }))),
    row("Remove idle worktrees", ["When nothing has happened in them for this long"], idle),
    row("Clean up", ["Never one with uncommitted changes, a running session, an open terminal, or shown in its project folder", "A branch goes only when it's merged"], now),
  ];
}

async function cleanNow() {
  try {
    const r = await call("worktrees.cleanup", {});
    showToast(r.removed.length ? `Removed ${r.removed.length} worktree${r.removed.length === 1 ? "" : "s"}` : "Nothing to clean up", { ms: 2000 });
  } catch (err: any) {
    showToast(String(err?.message ?? err), { tone: "error", ms: 5000 });
  }
  void load();
}

/** One worktree's row: its name, branch, sessions, state and when it was last used, with Preview and Remove. */
function worktreeRow(w: WorktreeStatus, project: Project): HTMLElement {
  const sessions = [...store.summaries.values()].filter((t) => t.cwd === w.path && !t.parent).length;
  const meta: string[] = [w.from ? `${w.branch ?? "detached"} off ${w.from}` : (w.branch ?? "detached"), `${sessions} session${sessions === 1 ? "" : "s"}`];
  if (w.changed) meta.push(`${w.changed} uncommitted change${w.changed === 1 ? "" : "s"}`);
  else if (w.merged) meta.push("Merged");
  if (w.lastUsedAt) meta.push(`used ${timeAgo(w.lastUsedAt)} ago`);
  const shown = project.preview === w.path;
  const preview = action(shown ? "Stop preview" : "Preview", "filled", () => void switchPreview(project, shown ? null : w.path).then(() => void load()), "monitorPlay");
  const remove = action("Remove", "danger", () => confirmRemove(w));
  const r = row(w.name, meta, preview, remove);
  r.title = tildePath(w.path);
  return r;
}

function confirmRemove(w: WorktreeStatus) {
  const lost = [
    w.changed ? `its ${w.changed} uncommitted change${w.changed === 1 ? "" : "s"}` : null,
    "its ignored files (dependencies, build output)",
  ].filter(Boolean);
  const body = `${tildePath(w.path)} goes, with ${lost.join(" and ")}. Its terminals close. ${w.branch ? `The branch ${w.branch} stays unless it's merged.` : ""}`;
  dialog(`Remove ${w.name}?`, body, [
    ["Cancel", "filled", () => {}],
    [
      "Remove",
      "danger",
      () =>
        void call("worktrees.remove", { path: w.path })
          .then(() => showToast(`Removed ${w.name}`, { ms: 1500 }))
          .catch((err) => showToast(String(err?.message ?? err), { tone: "error", ms: 5000 }))
          .finally(() => void load()),
    ],
  ]);
}

export function renderWorktrees(): HTMLElement {
  const page = pageColumn();
  page.append(pageHeader("Worktrees"), pageSubtitle("More checkouts of a project's repository, each on its own branch, so sessions work side by side. Pick New worktree under a new session's prompt."));
  // Asked again as the page opens (sessions run and change things meanwhile); the answer draws it again.
  if (!loading && Date.now() - loadedAt > 2_000) void load();
  if (!settings || !status) {
    if (loadError) page.append(errorStrip(loadError));
    return page;
  }
  const where = section("Location", card(location(settings)));
  where.classList.add("first");
  page.append(where, section("Cleanup", card(...cleanup(settings))));
  if (loadError) page.append(errorStrip(loadError));
  for (const p of store.projects) {
    const rows = status.filter((w) => w.projectId === p.id);
    if (rows.length) page.append(section(p.name, card(...rows.map((w) => worktreeRow(w, p)))));
  }
  if (!status.length) page.append(section("Worktrees", card(row("None yet", ["New ones show here"]))));
  return page;
}
