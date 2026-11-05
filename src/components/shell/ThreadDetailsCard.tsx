import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Menu, confirmDialog, toast } from "../ui";
import { Icon } from "./Icon";
import { AgentLogo } from "../../lib/agentMeta";
import {
  activeSession, activeView, chat, contextUsage, deleteSession, isRunning, keepSideChat, pendingInputCount, projectName, selectSession, startSessionInWorktree,
} from "../../lib/chat";
import { clearGoal, pauseGoal, resumeGoal, sessionGoal } from "../../lib/goals";
import { formatUsage, sessionUsage } from "../../lib/usage";
import { effectiveRoot, openReview, setStore, store } from "../../lib/store";
import { prChip, prStatusFor } from "../../lib/prStatus";
import { isPrWatched, togglePrWatch } from "../../lib/prWatch";
import { openIn, quickEditor } from "../../lib/openIn";
import { writeClipboardText } from "../../lib/native";
import { schedules, setSchedulesOpen } from "../../lib/schedule";
import { openWorktreeDialog } from "../git/WorktreeCloseDialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { agentLabel } from "../chat/agentLabel";
import { threadDetailsVisibility } from "../../lib/threadDetails";
import { linkedPrsFor, linkPr, unlinkPr, pullRequestNumber } from "../../lib/linkedPrs";
import { parentOf, childrenOf } from "../../lib/forkLineage";
import { addComposerContext } from "../../lib/composerContexts";
import { runAction } from "../../lib/shortcuts";
import { copyThreadLink } from "../../lib/promptLinks";
import { findLocalServers, terminalLocalServers } from "../../lib/localServers";
import { requestPreview } from "../../lib/previewRequests";
import { openSide } from "../../lib/layout";
import { setUsageOpen } from "../UsageDialog";
import { chatCancelSubagent, chatTranscriptPath, pullRequestDetail, type PermissionMode } from "../../lib/ipc";

const MODE_LABEL: Record<PermissionMode, string> = {
  manual: "Manual", auto_edit: "Auto-edit", plan: "Plan", ask: "Ask",
};

const shortPath = (path: string, keep = 3) => {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
};

/** T3-style thread details: workspace, branch/PR, session metadata, activity and usage
 *  for the conversation in the header. Opens from the header's info button. */
const ThreadDetailsCard: Component<{ open: boolean; onClose: () => void; anchorRef?: HTMLElement; changeCount: number }> = (props) => {
  const session = () => activeSession();
  const usage = createMemo(() => formatUsage(sessionUsage(activeView())));
  const context = createMemo(() => contextUsage());
  const percent = createMemo(() => {
    const value = context();
    return value && value.size > 0 ? Math.min(100, Math.round((value.used / value.size) * 100)) : null;
  });
  const queued = () => (chat.activeId ? chat.queued[chat.activeId]?.length ?? 0 : 0);
  const scheduled = () => schedules.filter((schedule) =>
    !schedule.paused && !schedule.ended && "session_id" in schedule.target && schedule.target.session_id === chat.activeId).length;
  const worktree = () => session()?.worktree ?? null;
  // Live terminals only exist while mounted; refresh the scan while the card is open.
  const [serverTick, setServerTick] = createSignal(0);
  const [linkedDraft, setLinkedDraft] = createSignal("");
  const [linkedBusy, setLinkedBusy] = createSignal(false);
  createEffect(() => {
    if (!props.open) return;
    const timer = setInterval(() => setServerTick((tick) => tick + 1), 4000);
    onCleanup(() => clearInterval(timer));
  });
  const servers = createMemo(() => {
    serverTick();
    const meta = session();
    if (!meta) return [];
    const fromTerminal = terminalLocalServers(chat.views[meta.id]?.runtime?.terminal_id ?? chat.terminalViews[meta.id]);
    // Agents often print the dev-server URL in a reply before a terminal is attached.
    const lines = (activeView()?.messages ?? []).flatMap((message) => message.role !== "assistant" ? [] :
      message.blocks.flatMap((block) => block.kind === "text" ? block.text.split("\n") : []));
    const fromReplies = findLocalServers(lines.slice(-400));
    const seen = new Set<string>();
    return [...fromTerminal, ...fromReplies].filter((server) => {
      if (seen.has(server.url)) return false;
      seen.add(server.url);
      return true;
    }).slice(0, 8);
  });
  /** Subagents delegated from this conversation's turns, newest last. */
  const subagents = () => {
    const list: { id: string; title: string; state: string }[] = [];
    for (const message of activeView()?.messages ?? []) {
      if (message.role !== "assistant") continue;
      for (const block of message.blocks) {
        if (block.kind === "subagent") list.push({ id: block.id, title: block.title || block.description || "Delegated agent", state: block.state });
      }
    }
    return list;
  };
  const subagentLabel = (state: string) => state === "requires_action" ? "Needs input" : state === "running" ? "Running" : state === "error" ? "Failed" : "Done";

  /** Hidden branches asked about this conversation (/btw); hidden forks record it as their parent. */
  const sideChats = () => {
    const parent = session();
    return parent ? chat.sessions.filter((candidate) => candidate.hidden && candidate.parent_id === parent.id) : [];
  };
  const parentThread = () => {
    const id = parentOf(session()?.id);
    return id ? chat.sessions.find((candidate) => candidate.id === id) : undefined;
  };
  const childThreads = () => {
    const ids = new Set(childrenOf(session()?.id));
    return chat.sessions.filter((candidate) => ids.has(candidate.id) && !candidate.hidden);
  };
  const pr = () => (store.currentProject?.is_git ? prStatusFor(effectiveRoot()) : undefined);
  const visible = () => threadDetailsVisibility();
  const copy = (text: string, what: string) => { void writeClipboardText(text, what).catch((error) => toast(String(error), "error")); };
  const linkPullRequest = async (event: Event) => {
    event.preventDefault();
    const current = session();
    const number = pullRequestNumber(linkedDraft());
    if (!current || !number || linkedBusy()) {
      if (!number) toast("Enter a pull request number or URL.", "info");
      return;
    }
    setLinkedBusy(true);
    try {
      const detail = await pullRequestDetail(current.project_path, number);
      linkPr(current.id, {
        number: detail.summary.number,
        title: detail.summary.title,
        url: detail.summary.url,
        state: detail.summary.state,
        is_draft: detail.summary.is_draft,
        head_ref_name: detail.summary.head_ref_name,
        base_ref_name: detail.summary.base_ref_name,
      });
      setLinkedDraft("");
      toast(`Linked pull request #${detail.summary.number}`, "success");
    } catch (error) {
      toast(`Couldn't link the pull request: ${String(error)}`, "error");
    } finally {
      setLinkedBusy(false);
    }
  };

  return (
    <Menu open={props.open} onClose={props.onClose} anchorRef={props.anchorRef} align="right" width={360} style={{ padding: "12px" }}>
      <Show when={session()} fallback={<div class="td-empty">Open a session to see its details.</div>}>
        {(meta) => (
          <div class="thread-details">
            <div class="td-title">
              <span>Thread details</span>
              <button type="button" class="icon-btn" title="Close" aria-label="Close thread details" onClick={props.onClose}><Icon name="x" size={13} /></button>
            </div>

            <Show when={visible().workspace}>
            <section class="td-section" aria-label="Workspace">
              <div class="td-section-head">Workspace</div>
              <div class="td-row">
                <Icon name="folder" size={14} />
                <span class="td-value" title={meta().project_path}>{projectName(meta().project_path)}</span>
                <button type="button" class="td-link" onClick={() => copy(meta().project_path, "project path")}>Copy</button>
                <button type="button" class="td-link" onClick={() => void revealItemInDir(meta().project_path).catch((error) => toast(`Couldn't reveal the project: ${String(error)}`, "error"))}>Reveal</button>
              </div>
              <div class="td-row td-row-sub" title={meta().cwd}>
                <Icon name="document" size={14} />
                <span class="td-value">{shortPath(meta().cwd)}</span>
                <button type="button" class="td-link" onClick={() => copy(meta().cwd, "working directory")}>Copy</button>
                <Show when={quickEditor()}>
                  {(editor) => <button type="button" class="td-link" onClick={() => void openIn(editor().id, meta().cwd)}>{editor().name}</button>}
                </Show>
              </div>
              <Show when={worktree()}>
                {(tree) => (
                  <div class="td-block">
                    <div class="td-row">
                      <Icon name="gitBranch" size={14} />
                      <span class="td-value" title={`${tree().branch} from ${tree().source_branch}`}>{tree().branch}</span>
                    </div>
                    <div class="td-hint">Isolated worktree from {tree().source_branch}</div>
                    <div class="td-actions">
                      <button type="button" class="ui-btn ui-btn-outline td-action" onClick={() => { props.onClose(); void startSessionInWorktree(meta().id); }}>New session here</button>
                      <button type="button" class="ui-btn ui-btn-outline td-action" onClick={() => { props.onClose(); void openWorktreeDialog(meta().id); }}>Merge back or discard…</button>
                      <button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => copy(tree().branch, "branch name")}>Copy branch</button>
                      <button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => copy(tree().path, "worktree path")}>Copy path</button>
                      <button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => void revealItemInDir(tree().path).catch((error) => toast(`Couldn't reveal the worktree: ${String(error)}`, "error"))}>Reveal</button>
                      <Show when={quickEditor()}>
                        {(editor) => <button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => void openIn(editor().id, tree().path)}>Open in {editor().name}</button>}
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            </section>
            </Show>

            <Show when={visible().branch && store.currentProject?.is_git}>
              <section class="td-section" aria-label="Branch and pull request">
                <div class="td-section-head">Branch</div>
                <div class="td-row">
                  <Icon name="gitBranch" size={14} />
                  <span class="td-value">{store.currentBranch || "Detached"}</span>
                  <Show when={store.currentBranch}>
                    {(branch) => <button type="button" class="td-link" onClick={() => copy(branch(), "branch name")}>Copy</button>}
                  </Show>
                  <Show when={pr()}>
                    {(status) => {
                      const chip = () => prChip(status());
                      return (
                        <>
                          <button type="button" class="pr-chip" data-tone={chip().tone} title={chip().title} onClick={() => void openUrl(status().url).catch(() => {})}>
                            <span class="pr-chip-dot" aria-hidden="true" />{chip().label}
                          </button>
                          <button type="button" class="td-link" onClick={() => copy(status().url, "pull request link")}>Copy link</button>
                          <button type="button" class="td-link" onClick={() => togglePrWatch(effectiveRoot(), !isPrWatched(effectiveRoot()))}>
                            {isPrWatched(effectiveRoot()) ? "Watching" : "Watch"}
                          </button>
                        </>
                      );
                    }}
                  </Show>
                </div>
                <div class="td-row td-row-sub">
                  <Icon name="diff" size={14} />
                  <span class="td-value">{props.changeCount === 0 ? "No changed files" : `${props.changeCount} changed file${props.changeCount === 1 ? "" : "s"}`}</span>
                  <Show when={props.changeCount > 0}>
                    <button type="button" class="td-link" onClick={() => { props.onClose(); openReview(undefined, "Working changes"); }}>Review</button>
                  </Show>
                </div>
              </section>
            </Show>

            <Show when={visible().linkedPrs}>
              <section class="td-section" aria-label="Linked pull requests">
                <div class="td-section-head">Linked pull requests{linkedPrsFor(meta().id).length ? ` · ${linkedPrsFor(meta().id).length}` : ""}</div>
                <For each={linkedPrsFor(meta().id)}>
                  {(link) => (
                    <div class="td-row td-row-sub">
                      <Icon name="merge" size={14} />
                      <span class="td-value" title={link.title}>#{link.number} {link.title}</span>
                      <span class="td-meta">{link.state.toLowerCase()}</span>
                      <button type="button" class="td-link" onClick={() => void openUrl(link.url).catch((error) => toast(String(error), "error"))}>Open</button>
                      <button type="button" class="td-link" onClick={() => {
                        addComposerContext({ kind: "pr", label: `PR #${link.number} · ${link.title}`, detail: [link.title, link.url, `State: ${link.state}`, `Branch: ${link.head_ref_name} → ${link.base_ref_name}`].join("\n") });
                        runAction("focus-prompt");
                        toast("Pull request added to the composer", "info");
                      }}>Cite</button>
                      <button type="button" class="td-link" onClick={() => unlinkPr(meta().id, link.number, link.url)}>Unlink</button>
                    </div>
                  )}
                </For>
                <form class="td-row td-row-sub" onSubmit={(event) => void linkPullRequest(event)}>
                  <Icon name="link" size={14} />
                  <input class="ui-field" style={{ flex: 1, "min-width": 0 }} aria-label="Link pull request" placeholder="PR number or URL" value={linkedDraft()} onInput={(event) => setLinkedDraft(event.currentTarget.value)} />
                  <button type="submit" class="td-link" disabled={linkedBusy() || !linkedDraft().trim()}>{linkedBusy() ? "Linking…" : "Link"}</button>
                </form>
              </section>
            </Show>

            <Show when={visible().lineage && (parentThread() || childThreads().length > 0)}>
              <section class="td-section" aria-label="Lineage">
                <div class="td-section-head">Lineage</div>
                <Show when={parentThread()}>
                  {(parent) => (
                    <div class="td-row td-row-sub">
                      <Icon name="layers" size={14} />
                      <span class="td-value" title={parent().title}>Forked from {parent().title || "another thread"}</span>
                      <button type="button" class="td-link" onClick={() => { props.onClose(); void selectSession(parent().id); }}>Open</button>
                    </div>
                  )}
                </Show>
                <For each={childThreads()}>
                  {(child) => (
                    <div class="td-row td-row-sub">
                      <Icon name="layers" size={14} />
                      <span class="td-value" title={child.title}>Fork · {child.title || "Untitled thread"}</span>
                      <span class="td-meta">{isRunning(child.id) ? "Working" : "Idle"}</span>
                      <button type="button" class="td-link" onClick={() => { props.onClose(); void selectSession(child.id); }}>Open</button>
                    </div>
                  )}
                </For>
              </section>
            </Show>

            <Show when={visible().session}>
            <section class="td-section" aria-label="Session">
              <div class="td-section-head">Session</div>
              <div class="td-row">
                <AgentLogo agentId={meta().agent_id} icon={store.agents.find((agent) => agent.id === meta().agent_id)?.icon} size={16} radius={4} />
                <span class="td-value">{agentLabel(meta().agent_id)}</span>
                <span class="td-meta">{[meta().model, meta().effort].filter(Boolean).join(" · ")}</span>
              </div>
              <div class="td-row td-row-sub">
                <Icon name="shield" size={14} />
                <span class="td-value">{MODE_LABEL[meta().mode] ?? meta().mode}{meta().yolo ? " · YOLO" : ""}</span>
                <span class="td-meta">
                  {isRunning(meta().id) ? "Working" : pendingInputCount(meta().id) > 0 ? "Needs your answer" : queued() > 0 ? `${queued()} queued` : "Idle"}
                </span>
              </div>
            </section>
            </Show>

            <Show when={visible().activity}>
            <section class="td-section" aria-label="Goal and scheduled prompts">
              <div class="td-section-head">Activity</div>
              <Show when={sessionGoal(meta().id)} fallback={<div class="td-hint">No goal set. Use <code>/goal</code> to keep working until a condition is met.
                <button type="button" class="td-link" style={{ "margin-left": "6px" }} onClick={() => { props.onClose(); setStore("pendingPromptSeed", { text: "/goal " }); runAction("focus-prompt"); }}>Set a goal</button>
              </div>}>
                {(goal) => (
                  <div class="td-block">
                    <div class="td-row"><Icon name="list" size={14} /><span class="td-value">{goal().status === "active" ? `Goal · turn ${goal().rounds + 1}/${goal().max_rounds}` : `Goal · ${goal().status}`}</span></div>
                    <div class="td-hint" title={goal().text}>{goal().text}</div>
                    <div class="td-actions">
                      <Show when={goal().status === "active"} fallback={<button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => resumeGoal(meta().id)}>Resume</button>}>
                        <button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => pauseGoal(meta().id)}>Pause</button>
                      </Show>
                      <button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => clearGoal(meta().id)}>Clear</button>
                    </div>
                  </div>
                )}
              </Show>
              <div class="td-row td-row-sub">
                <Icon name="history" size={14} />
                <span class="td-value">{scheduled() === 0 ? "No scheduled prompts" : `${scheduled()} scheduled prompt${scheduled() === 1 ? "" : "s"}`}</span>
                <button type="button" class="td-link" onClick={() => { props.onClose(); setSchedulesOpen(true); }}>Manage</button>
              </div>
            </section>
            </Show>

            <Show when={subagents().length > 0}>
            <section class="td-section" aria-label="Agents">
              <div class="td-section-head">Agents · {subagents().length}</div>
              <For each={subagents()}>
                {(agent) => (
                  <div class="td-row td-row-sub">
                    <Icon name="layers" size={14} />
                    <span class="td-value" title={agent.title}>{agent.title}</span>
                    <span class="td-meta">{subagentLabel(agent.state)}</span>
                    <Show when={agent.state === "running" || agent.state === "requires_action"}>
                      <button type="button" class="td-link" onClick={() => void chatCancelSubagent(meta().id, agent.id).catch((error) => toast(`Couldn't stop the agent: ${String(error)}`, "error"))}>Stop</button>
                    </Show>
                  </div>
                )}
              </For>
            </section>
            </Show>

            <Show when={visible().sideChats && sideChats().length > 0}>
            <section class="td-section" aria-label="Side chats">
              <div class="td-section-head">Side chats</div>
              <For each={sideChats()}>
                {(side) => (
                  <div class="td-block">
                    <div class="td-row">
                      <Icon name="help" size={14} />
                      <span class="td-value" title={side.title}>{side.title || "Side chat"}</span>
                      <span class="td-meta">{isRunning(side.id) ? "Working" : "Idle"}</span>
                    </div>
                    <div class="td-actions">
                      <button type="button" class="ui-btn ui-btn-outline td-action" onClick={() => { props.onClose(); void selectSession(side.id); }}>Open</button>
                      <button type="button" class="ui-btn ui-btn-ghost td-action" onClick={() => void keepSideChat(side.id)}>Keep</button>
                      <button type="button" class="ui-btn ui-btn-ghost td-action" style={{ color: "var(--status-del)" }}
                        onClick={async () => {
                          if (!(await confirmDialog("Delete this side chat? Its branch and answer are discarded; the conversation you asked about is not changed.", "Delete"))) return;
                          void deleteSession(side.id);
                        }}>Delete</button>
                    </div>
                  </div>
                )}
              </For>
            </section>
            </Show>

            <Show when={servers().length > 0}>
            <section class="td-section" aria-label="Local servers">
              <div class="td-section-head">Servers</div>
              <For each={servers()}>
                {(server) => (
                  <div class="td-row td-row-sub">
                    <Icon name="globe" size={14} />
                    <span class="td-value" title={server.url}>{server.url}</span>
                    <button type="button" class="td-link" onClick={() => { requestPreview(server.url); openSide("preview"); }}>Preview</button>
                    <button type="button" class="td-link" onClick={() => void openUrl(server.url).catch((error) => toast(`Couldn't open the server: ${String(error)}`, "error"))}>Browser</button>
                    <button type="button" class="td-link" onClick={() => copy(server.url, "server URL")}>Copy</button>
                  </div>
                )}
              </For>
            </section>
            </Show>

            <Show when={visible().usage}>
            <section class="td-section" aria-label="Usage">
              <div class="td-section-head">Usage</div>
              <div class="td-row td-row-sub">
                <Icon name="table" size={14} />
                <span class="td-value">{usage() ?? "No usage reported yet"}</span>
                <button type="button" class="td-link" onClick={() => { props.onClose(); setUsageOpen(true); }}>All usage</button>
              </div>
              <Show when={context() && percent() !== null}>
                <div class="td-context">
                  <div class="td-context-head"><span>Context window</span><span>{percent()}%</span></div>
                  <div class="td-context-bar" role="progressbar" aria-label="Context window used" aria-valuenow={percent() ?? 0} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${percent()}%` }} data-high={percent()! >= 80 ? "true" : undefined} />
                  </div>
                  <div class="td-hint">{(context()!.used / 1000).toFixed(1)}k of {(context()!.size / 1000).toFixed(0)}k tokens{context()!.cost != null ? ` · $${context()!.cost!.toFixed(2)}` : ""}</div>
                </div>
              </Show>
            </section>
            </Show>

            <div class="td-footer">
              <button type="button" class="td-link" onClick={() => copy(meta().id, "session ID")}>Copy session ID</button>
              <button type="button" class="td-link" onClick={() => void copyThreadLink(meta())}>Copy thread link</button>
              <button type="button" class="td-link" onClick={() => {
                void chatTranscriptPath(meta().id)
                  .then((path) => copy(path, "transcript path"))
                  .catch((error) => toast(`Couldn't find the transcript: ${String(error)}`, "error"));
              }}>Copy transcript path</button>
              <button type="button" class="td-link" onClick={() => {
                void chatTranscriptPath(meta().id)
                  .then((path) => revealItemInDir(path))
                  .catch((error) => toast(`Couldn't reveal the transcript: ${String(error)}`, "error"));
              }}>Reveal transcript</button>
            </div>
          </div>
        )}
      </Show>
    </Menu>
  );
};

export default ThreadDetailsCard;
