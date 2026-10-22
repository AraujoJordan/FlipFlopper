import { createSignal } from "solid-js";
import { chatImport, chatImportScan, type ImportCandidate } from "./ipc";
import { refreshSessions, selectSession } from "./chat";
import { readPref, writePref } from "./appPrefs";
import { store } from "./store";
import { toast } from "../components/ui";

// Importing brings existing Claude Code / Codex CLI sessions for your projects
// into the sidebar. Continuing one resumes the original CLI session.

const DISMISSED_KEY = "flipflopper:import-dismissed";

const [candidates, setCandidates] = createSignal<ImportCandidate[]>([]);
const [scanning, setScanning] = createSignal(false);
const [importing, setImporting] = createSignal(false);
const [importOpen, setImportOpen] = createSignal(false);
const [dismissed, setDismissed] = createSignal<Set<string>>(new Set());

export { candidates, scanning, importing, importOpen, setImportOpen };

/** Candidates the user hasn't dismissed. */
export const pendingCandidates = () => candidates().filter((c) => !dismissed().has(c.native_id));

export async function hydrateImporter() {
  const saved = await readPref<string[]>(DISMISSED_KEY, [], () => []);
  setDismissed(new Set(saved));
}

/** Look for importable sessions in the open and recent projects. */
export async function scanImportable() {
  const paths = [...new Set([store.currentProject?.path, ...store.recentProjects.map((p) => p.path)].filter((p): p is string => !!p))];
  if (paths.length === 0) return;
  setScanning(true);
  try {
    setCandidates(await chatImportScan(paths));
  } catch (e) {
    console.error("Import scan failed:", e);
  } finally {
    setScanning(false);
  }
}

/** Hide the banner for the sessions currently on offer. */
export function dismissBanner() {
  const next = new Set(dismissed());
  for (const c of candidates()) next.add(c.native_id);
  setDismissed(next);
  writePref(DISMISSED_KEY, [...next]);
}

export async function importSessions(selected: ImportCandidate[]) {
  if (selected.length === 0 || importing()) return;
  setImporting(true);
  try {
    const imported = await chatImport(selected.map(({ size: _size, ...req }) => req));
    await refreshSessions();
    setCandidates((all) => all.filter((c) => !selected.some((s) => s.native_id === c.native_id)));
    setImportOpen(false);
    toast(
      imported.length === selected.length
        ? `Imported ${imported.length} session${imported.length === 1 ? "" : "s"}`
        : `Imported ${imported.length} of ${selected.length} sessions`,
      imported.length > 0 ? "success" : "error",
    );
    if (imported.length === 1) void selectSession(imported[0].id);
  } catch (e) {
    toast(`Import failed: ${String(e)}`, "error");
  } finally {
    setImporting(false);
  }
}
