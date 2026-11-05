import { Component, For, Show, createSignal } from "solid-js";
import { store } from "../lib/store";
import { addProjectScript, projectScripts, removeProjectScript, runProjectScript, setProjectScriptSettleHook, setProjectScriptWorktreeHook, updateProjectScript, type ProjectScript } from "../lib/scripts";
import { confirmDialog, toast } from "./ui";
import { Icon } from "./shell/Icon";

/** Settings → Scripts: named commands for the open checkout, available from the
 *  palette and the composer's + menu. Stored locally in preferences.json. */
const ProjectScriptsSettings: Component = () => {
  const [name, setName] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [editing, setEditing] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const project = () => store.currentProject;
  const scripts = () => projectScripts(project()?.path);

  function reset() {
    setEditing(null);
    setName("");
    setCommand("");
    setError(null);
  }

  function startEdit(script: ProjectScript) {
    setEditing(script.id);
    setName(script.name);
    setCommand(script.command);
    setError(null);
  }

  function submit(event: Event) {
    event.preventDefault();
    const path = project()?.path;
    if (!path) return;
    const problem = editing()
      ? updateProjectScript(path, editing()!, name(), command())
      : addProjectScript(path, name(), command());
    if (problem) { setError(problem); return; }
    toast(editing() ? "Script updated" : "Script added", "success");
    reset();
  }

  async function remove(script: ProjectScript) {
    if (!project()) return;
    if (!(await confirmDialog(`Remove the “${script.name}” script? The command itself is not run or changed.`, "Remove"))) return;
    removeProjectScript(project()!.path, script.id);
    if (editing() === script.id) reset();
    toast("Script removed", "info");
  }

  return (
    <div class="scripts-settings">
      <p class="scripts-intro">
        Named commands for <strong>{project()?.name ?? "the open project"}</strong>. They open a terminal in the checkout and are also listed in the command palette and the composer's + menu.
      </p>
      <Show when={project()} fallback={<div class="scripts-empty">Open a project to add scripts.</div>}>
        <form class="scripts-form" onSubmit={submit}>
          <div class="scripts-form-head">
            <Icon name="terminal" size={15} />
            <strong>{editing() ? "Edit script" : "Add a script"}</strong>
            <Show when={editing()}><button type="button" class="link-btn" onClick={reset}>Cancel edit</button></Show>
          </div>
          <div class="scripts-fields">
            <label class="scripts-field scripts-field-name">
              <span>Name</span>
              <input class="ui-field" value={name()} onInput={(event) => { setName(event.currentTarget.value); setError(null); }} placeholder="Test suite" />
            </label>
            <label class="scripts-field">
              <span>Command</span>
              <input class="ui-field scripts-command" value={command()} onInput={(event) => { setCommand(event.currentTarget.value); setError(null); }} placeholder="npm test" spellcheck={false} />
            </label>
          </div>
          <Show when={error()}>{(message) => <p class="scripts-error" role="alert">{message()}</p>}</Show>
          <div class="scripts-form-actions">
            <button type="submit" class="ui-btn ui-btn-outline" disabled={!name().trim() || !command().trim()}>
              <Icon name={editing() ? "check" : "plus"} size={13} /> {editing() ? "Save changes" : "Add script"}
            </button>
          </div>
        </form>

        <Show when={scripts().length > 0} fallback={<div class="scripts-empty">No scripts yet. Add one above, then run it from the palette or the composer.</div>}>
          <div class="scripts-list">
            <For each={scripts()}>
              {(script) => (
                <div class="scripts-row">
                  <div class="scripts-row-main">
                    <span class="scripts-row-name">{script.name}</span>
                    <code class="scripts-row-command" title={script.command}>{script.command}</code>
                  </div>
                  <label class="scripts-hook" title="Run this command in a fresh worktree before the agent starts">
                    <input type="checkbox" checked={!!script.runOnWorktreeCreate}
                      onChange={(event) => setProjectScriptWorktreeHook(project()!.path, script.id, event.currentTarget.checked)} />
                    Setup
                  </label>
                  <label class="scripts-hook" title="Run this command in the thread's worktree when it settles">
                    <input type="checkbox" checked={!!script.runOnSettle}
                      onChange={(event) => setProjectScriptSettleHook(project()!.path, script.id, event.currentTarget.checked)} />
                    Settle
                  </label>
                  <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void runProjectScript(script, project()!.path)} title={`Run ${script.name}`}>
                    <Icon name="play" size={12} /> Run
                  </button>
                  <button type="button" class="icon-btn" aria-label={`Edit ${script.name}`} title="Edit" onClick={() => startEdit(script)}><Icon name="pencil" size={13} /></button>
                  <button type="button" class="icon-btn" aria-label={`Remove ${script.name}`} title="Remove" onClick={() => void remove(script)}><Icon name="trash" size={13} /></button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
};

export default ProjectScriptsSettings;
