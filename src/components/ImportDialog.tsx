import { Presence } from "./ui";
import { Component, For, Show, createMemo, createSignal } from "solid-js";
import { candidates, importSessions, importing, importOpen, setImportOpen } from "../lib/importer";
import { projectName } from "../lib/chat";
import { store } from "../lib/store";
import { AgentLogo } from "../lib/agentMeta";
import { Checkbox, Spinner, useValueMotion } from "./ui";
import { Icon } from "./shell/Icon";

function ago(ts: number): string {
  const d = Math.max(0, Math.round((Date.now() - ts) / 86_400_000));
  return d === 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : `${Math.round(d / 30)} mo ago`;
}

function size(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(bytes >= 10_485_760 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Checklist of CLI sessions available to import, grouped by project. */
const ImportDialog: Component = () => {
  const [picked, setPicked] = createSignal<Set<string>>(new Set());

  const groups = createMemo(() => {
    const byProject = new Map<string, ReturnType<typeof candidates>>();
    for (const c of candidates()) {
      const list = byProject.get(c.cwd) ?? [];
      list.push(c);
      byProject.set(c.cwd, list);
    }
    return [...byProject].map(([cwd, items]) => ({ cwd, items }));
  });
  const chosen = () => candidates().filter((c) => picked().has(c.native_id));
  const toggle = (id: string) =>
    setPicked((s) => { const n = new Set<string>(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = () => candidates().length > 0 && picked().size === candidates().length;
  const toggleAll = () => setPicked(allSelected() ? new Set<string>() : new Set<string>(candidates().map((c) => c.native_id)));
  const agentIcon = (id: string) => store.agents.find((a) => a.id === id)?.icon ?? null;

  let list: HTMLDivElement | undefined;
  useValueMotion(() => list, () => candidates().map((candidate) => candidate.path).join());
  return (
    <Presence when={importOpen()}>
      <div class="overlay-backdrop-in settings-backdrop" onClick={() => !importing() && setImportOpen(false)}>
        <div
          class="overlay-pop-in import-dialog"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" && !importing()) setImportOpen(false); }}
          tabIndex={-1}
        >
          <div class="import-head">
            <div>
              <h2>Import CLI sessions</h2>
              <p>
                Bring your Claude Code and Codex terminal sessions into FlipFlopper. Continuing one resumes the original CLI
                session, and you can flip it to another agent at any time.
              </p>
            </div>
            <button class="icon-btn" onClick={() => setImportOpen(false)} aria-label="Close" disabled={importing()}>
              <Icon name="x" size={16} />
            </button>
          </div>

          <div ref={list} class="import-list">
            <Show when={candidates().length > 0} fallback={<div class="pane-empty">No importable sessions found.</div>}>
              <For each={groups()}>
                {(g) => (
                  <section class="import-group">
                    <div class="import-group-title"><Icon name="folder" size={13} /> {projectName(g.cwd)}</div>
                    <For each={g.items}>
                      {(c) => (
                        <label class="import-row">
                          <input type="checkbox" checked={picked().has(c.native_id)} onChange={() => toggle(c.native_id)} />
                          <AgentLogo agentId={c.agent_id} icon={agentIcon(c.agent_id)} size={18} radius={5} />
                          <span class="import-title">{c.title}</span>
                          <span class="import-meta">{ago(c.updated_at)} · {size(c.size)}</span>
                        </label>
                      )}
                    </For>
                  </section>
                )}
              </For>
            </Show>
          </div>

          <div class="import-foot">
            <Checkbox checked={allSelected()} onChange={toggleAll} label={`Select all (${candidates().length})`} />
            <button
              class="ui-btn ui-btn-solid settings-btn import-go"
              disabled={chosen().length === 0 || importing()}
              onClick={() => void importSessions(chosen())}
            >
              <Show when={importing()}><Spinner size={12} /></Show>
              {importing() ? "Importing…" : `Import ${chosen().length || ""}`.trim()}
            </button>
          </div>
        </div>
      </div>
    </Presence>
  );
};

export default ImportDialog;
