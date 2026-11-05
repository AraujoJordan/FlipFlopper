import { Component, For, Show, createEffect, onCleanup } from "solid-js";
import { dismissWorktreeSetup, worktreeSetups, type WorktreeSetupState, type WorktreeSetupStep } from "../../lib/worktreeSetup";
import { Icon } from "../shell/Icon";
import { Spinner } from "../ui";

const basename = (path: string) => path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;

const duration = (step: WorktreeSetupStep): string => {
  if (!step.startedAt || !step.endedAt) return "";
  return `${Math.max(0, Math.round((step.endedAt - step.startedAt) / 100) / 10)}s`;
};

const StepIcon: Component<{ status: WorktreeSetupStep["status"] }> = (props) => (
  <Show when={props.status === "running"} fallback={
    <Show when={props.status === "done"} fallback={
      <Show when={props.status === "failed"} fallback={<span class="worktree-setup-dot" />}>
        <Icon name="x" size={11} />
      </Show>
    }>
      <Icon name="check" size={11} />
    </Show>
  }>
    <Spinner size={11} />
  </Show>
);

const WorktreeSetupCard: Component<{ setup: WorktreeSetupState }> = (props) => {
  const active = () => !props.setup.finishedAt;
  const state = () => props.setup.error ? "error" : active() ? "running" : "done";
  createEffect(() => {
    if (!props.setup.finishedAt || props.setup.error) return;
    const timer = setTimeout(() => dismissWorktreeSetup(props.setup.id), 10_000);
    onCleanup(() => clearTimeout(timer));
  });

  return (
    <div class="worktree-setup-card" data-state={state()} role="status" aria-live="polite">
      <div class="worktree-setup-head">
        <Icon name={props.setup.error ? "alert" : active() ? "gitBranch" : "check"} size={14} />
        <strong>{props.setup.error ? "Worktree setup failed" : active() ? "Setting up worktree…" : "Worktree ready"}</strong>
        <span class="worktree-setup-path" title={props.setup.worktreePath}>{basename(props.setup.worktreePath)}</span>
        <button type="button" class="icon-btn" title="Dismiss" aria-label="Dismiss worktree setup" onClick={() => dismissWorktreeSetup(props.setup.id)}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div class="worktree-setup-steps">
        <For each={props.setup.steps}>
          {(step) => (
            <>
              <div class="worktree-setup-step" data-status={step.status}>
                <span class="worktree-setup-state"><StepIcon status={step.status} /></span>
                <span class="worktree-setup-name">{step.name}</span>
                <span class="worktree-setup-time">{duration(step)}</span>
              </div>
              <Show when={step.output}>
                {(output) => (
                  <details class="worktree-setup-output">
                    <summary>Output</summary>
                    <pre>{output()}</pre>
                  </details>
                )}
              </Show>
            </>
          )}
        </For>
      </div>
      <Show when={props.setup.error}>{(error) => <div class="worktree-setup-error">{error()}</div>}</Show>
    </div>
  );
};

/** Stack of setup cards above the transcript. */
const WorktreeSetupCards: Component = () => (
  <Show when={worktreeSetups().length > 0}>
    <div class="worktree-setup-list" aria-label="Worktree setup">
      <For each={worktreeSetups()}>{(setup) => <WorktreeSetupCard setup={setup} />}</For>
    </div>
  </Show>
);

export default WorktreeSetupCards;
