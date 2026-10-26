import {
  Component, For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup,
} from "solid-js";
import {
  cancelTurn, retryLastTurn, setComposerAgent, chat,
  pendingInputCount, type InteractionBlock, type AssistantMessage, type Block, type CompactionBlock, type DividerMessage, type NoticeBlock, type SubagentBlock, type ThinkingBlock, type ToolBlock, type UserMessage,
} from "../../lib/chat";
import { openReview, store, setPendingPromptSeed } from "../../lib/store";
import { chatCancelSubagent } from "../../lib/ipc";
import { writeClipboardText } from "../../lib/native";
import { runAction } from "../../lib/shortcuts";
import { agentLabel } from "./agentLabel";
import { AgentLogo } from "../../lib/agentMeta";
import { openSide } from "../../lib/layout";
import { Menu, MenuItem, MenuLabel, Spinner, Disclosure, useValueMotion, toast } from "../ui";
import { Icon } from "../shell/Icon";
import Markdown from "./Markdown";
import { renderPlainTextWithFileRefs } from "../../lib/markdownLite";
import ToolCallRow from "./ToolCallRow";
import AttachmentChip from "./AttachmentChip";
import AgentInteraction from "./AgentInteraction";

const agentIcon = (id: string) => store.agents.find((a) => a.id === id)?.icon ?? null;

// ── Small pieces ─────────────────────────────────────────────────────────────

const ActionButton: Component<{ icon: Parameters<typeof Icon>[0]["name"]; label: string; onClick: () => void | Promise<unknown> }> = (props) => {
  const [copied, setCopied] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  useValueMotion(() => button, copied);
  onCleanup(() => { disposed = true; clearTimeout(timer); });
  const run = async () => {
    try {
      await props.onClick();
      if (props.icon === "copy" && !disposed) { setCopied(true); clearTimeout(timer); timer = setTimeout(() => setCopied(false), 1200); }
    } catch (error) { toast(`Couldn't ${props.label.toLowerCase()}: ${String(error)}`, "error"); }
  };
  return <button ref={button} type="button" class="msg-action" title={copied() ? "Copied" : props.label} aria-label={copied() ? "Copied" : props.label} onClick={() => void run()}><Icon name={copied() ? "check" : props.icon} size={14} /></button>;
};

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

// ── User / divider ───────────────────────────────────────────────────────────

export const UserBubble: Component<{ message: UserMessage }> = (props) => (
  <div class="msg-user" data-message-id={props.message.id}>
    <div class="msg-user-stack">
      <Show when={props.message.attachments.length > 0}>
        <div class="msg-attachments">
          <For each={props.message.attachments}>{(a) => <AttachmentChip attachment={a} />}</For>
        </div>
      </Show>
      <Show when={props.message.text}><div class="msg-user-body" innerHTML={renderPlainTextWithFileRefs(props.message.text)} /></Show>
    </div>
    <div class="msg-actions">
      <ActionButton icon="copy" label="Copy" onClick={() => writeClipboardText(props.message.text, "message")} />
      <ActionButton
        icon="pencil"
        label="Edit in composer"
        onClick={() => { setPendingPromptSeed({ text: props.message.text }); runAction("focus-prompt"); }}
      />
    </div>
  </div>
);

export const Divider: Component<{ message: DividerMessage }> = (props) => (
  <div class="msg-divider" data-message-id={props.message.id}>
    <span class="msg-divider-line" />
    <span class="msg-divider-label">
      <AgentLogo agentId={props.message.to} icon={agentIcon(props.message.to)} size={14} radius={4} />
      <span>{agentLabel(props.message.from)} → {agentLabel(props.message.to)} · agent changed</span>
      <span class="handoff-rail" aria-hidden="true"><span class="handoff-marker" /></span>
    </span>
    <span class="msg-divider-line" />
  </div>
);

// ── Assistant blocks ─────────────────────────────────────────────────────────

const Thinking: Component<{ block: ThinkingBlock; live: boolean }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const label = () => {
    if (props.live) return "Thinking…";
    const end = props.block.endedAt;
    return end ? `Thought for ${Math.max(1, Math.round((end - props.block.startedAt) / 1000))}s` : "Thought process";
  };
  let heading: HTMLSpanElement | undefined;
  useValueMotion(() => heading, label);
  return (
    <div class="thinking">
      <button type="button" class="thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open()}>
        <Icon name="sparkle" size={13} />
        <span ref={heading}>{label()}</span>
        <Icon name="chevronRight" size={12} style={{ transform: open() ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} />
      </button>
      <Disclosure open={open()} class="thinking-body">{props.block.text}</Disclosure>
    </div>
  );
};

const NoticeRow: Component<{ block: NoticeBlock }> = (props) => (
  <div class="notice-row" data-severity={props.block.severity}>
    <Icon name={props.block.severity === "info" ? "help" : "alert"} size={14} />
    <span class="notice-title">{props.block.title}</span>
    <Show when={props.block.description}><span class="notice-desc">{props.block.description}</span></Show>
  </div>
);

const CompactionRow: Component<{ block: CompactionBlock }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const working = () => props.block.status === "in_progress";
  const label = () => working() ? "Compacting context…" : props.block.status === "completed" ? "Context compacted" : props.block.status === "failed" ? "Compaction failed" : "Compaction cancelled";
  return (
    <div class="compaction-row" data-status={props.block.status}>
      <div class="msg-divider">
        <span class="msg-divider-line" />
        <button type="button" class="msg-divider-label compaction-label" disabled={!props.block.summary} onClick={() => setOpen((v) => !v)} aria-expanded={open()}>
          <Show when={working()} fallback={<Icon name="layers" size={13} />}><Spinner size={12} /></Show>
          {label()}
          <Show when={props.block.summary}><Icon name="chevronRight" size={11} style={{ transform: open() ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} /></Show>
        </button>
        <span class="msg-divider-line" />
      </div>
      <Show when={props.block.error}><div class="notice-row" data-severity="error"><Icon name="alert" size={14} /><span class="notice-desc">{props.block.error}</span></div></Show>
      <Disclosure open={open()} class="thinking-body"><Markdown text={props.block.summary} /></Disclosure>
    </div>
  );
};

const SubagentCard: Component<{ block: SubagentBlock; blocks: () => Block[]; sessionId: string }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const tools = createMemo(() => props.blocks().filter((b): b is ToolBlock => b.kind === "tool" && b.subagent === props.block.id));
  const own = () => tools().filter((t) => t.id !== props.block.launchedBy);
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!working()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const working = () => props.block.state === "running" || props.block.state === "requires_action";
  const failed = () => props.block.stopReason === "error";
  const label = () => props.block.state === "requires_action" ? "Needs input" : working() ? "Running" : failed() ? "Failed" : props.block.stopReason === "cancelled" ? "Stopped" : "Done";
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    chatCancelSubagent(props.sessionId, props.block.id).catch((error) => toast(`Couldn't stop the subagent: ${String(error)}`, "error"));
  };
  return (
    <div class="subagent-card" data-state={working() ? "running" : failed() ? "error" : "done"}>
      <button type="button" class="subagent-head" onClick={() => setOpen((v) => !v)} aria-expanded={open()}>
        <Show when={working()} fallback={<Icon name={failed() ? "alert" : "check"} size={14} />}><Spinner size={12} /></Show>
        <span class="subagent-title">{props.block.title || "Subagent"}</span>
        <Show when={props.block.description}><span class="subagent-desc">{props.block.description}</span></Show>
        <span class="subagent-meta">{own().length > 0 ? `${own().length} tool${own().length === 1 ? "" : "s"} · ` : ""}{label()}<Show when={working()}> · {formatElapsed(now() - props.block.startedAt)}</Show></span>
        <Show when={working()}>
          <span class="msg-live-stop" role="button" tabindex="0" title="Stop this subagent" onClick={stop} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); chatCancelSubagent(props.sessionId, props.block.id).catch(() => {}); } }}>
            <Icon name="stop" size={11} /> Stop
          </span>
        </Show>
        <Icon name="chevronRight" size={12} style={{ transform: open() ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} />
      </button>
      <Disclosure open={open()} class="subagent-body">
        <Show when={props.block.prompt}><div class="subagent-prompt">{props.block.prompt}</div></Show>
        <For each={tools()}>{(t) => <ToolCallRow block={t} />}</For>
        <Show when={props.block.error}><div class="notice-row" data-severity="error"><Icon name="alert" size={14} /><span class="notice-desc">{props.block.error}</span></div></Show>
      </Disclosure>
    </div>
  );
};

/** Four or more consecutive tool calls collapse into one expandable row. */
const GROUP_MIN = 4;
interface ToolGroup { isGroup: true; first: ToolBlock }
const groupCache = new WeakMap<object, ToolGroup>();
type Item = Block | ToolGroup;

function buildItems(blocks: Block[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.kind !== "tool") { out.push(b); i += 1; continue; }
    let j = i;
    while (j < blocks.length && blocks[j].kind === "tool") j += 1;
    if (j - i >= GROUP_MIN) {
      // Keyed by the run's first block so the group keeps its open state as it grows.
      let g = groupCache.get(b);
      if (!g) { g = { isGroup: true, first: b as ToolBlock }; groupCache.set(b, g); }
      out.push(g);
    } else {
      for (let k = i; k < j; k++) out.push(blocks[k]);
    }
    i = j;
  }
  return out;
}

const ToolGroupRow: Component<{ group: ToolGroup; blocks: () => Block[] }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const tools = createMemo(() => {
    const blocks = props.blocks();
    const start = blocks.findIndex((b) => b === props.group.first);
    const run: ToolBlock[] = [];
    for (let i = Math.max(0, start); i < blocks.length && blocks[i].kind === "tool"; i++) run.push(blocks[i] as ToolBlock);
    return run;
  });
  const running = () => tools().some((t) => t.status === "running");
  const failed = () => tools().filter((t) => t.status === "error").length;
  let previousFailures = 0;
  createEffect(() => {
    const count = failed();
    if (count > previousFailures) setOpen(true);
    previousFailures = count;
  });
  let count: HTMLSpanElement | undefined;
  useValueMotion(() => count, () => `${tools().length}:${running()}`);
  return (
    <div class="tool-group" classList={{ "tool-group-error": failed() > 0 }}>
      <button type="button" class="tool-group-head" onClick={() => setOpen((v) => !v)} aria-expanded={open()}>
        <Show when={running()} fallback={<Icon name="wrench" size={14} />}><Spinner size={12} /></Show>
        <span ref={count} class="tool-group-title">
          {running() ? "Working" : "Activity"} · {tools().length} tools
        </span>
        <Show when={failed() > 0}><span class="tool-group-failed">{failed()} failed</span></Show>
        <Show when={!open()}><span class="tool-group-last">{tools()[tools().length - 1]?.title}</span></Show>
        <Icon name="chevronRight" size={13} style={{ transform: open() ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} />
      </button>
      <Disclosure open={open()} class="tool-group-body">
          <For each={tools()}>{(t) => <ToolCallRow block={t} />}</For>
      </Disclosure>
    </div>
  );
};

// ── Assistant message ────────────────────────────────────────────────────────

export const AssistantBubble: Component<{ message: AssistantMessage; isLast: boolean; sessionId: string }> = (props) => {
  const running = () => props.message.status === "running";
  const lastBlock = (): Block | undefined => props.message.blocks[props.message.blocks.length - 1];
  const showPulse = () => running() && !pendingInputCount(props.sessionId) && lastBlock()?.kind !== "text";
  // A subagent's own tool calls render inside its card, not in the main flow.
  const visible = createMemo(() => props.message.blocks.filter((b) => !(b.kind === "tool" && b.subagent)));
  const items = createMemo(() => buildItems(visible()));

  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!running()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const activity = () => {
    if (pendingInputCount(props.sessionId)) return "Needs input";
    const b = lastBlock();
    if (!b) return "Starting";
    if (b.kind === "tool" && b.status === "running") return b.title;
    if (b.kind === "thinking") return "Thinking";
    return b.kind === "text" ? "Writing" : "Working";
  };

  let activityLabel: HTMLSpanElement | undefined;
  useValueMotion(() => activityLabel, activity);
  const fullText = () =>
    props.message.blocks.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text").map((b) => b.text).join("\n\n");

  const [flipOpen, setFlipOpen] = createSignal(false);
  let flipAnchor: HTMLButtonElement | undefined;
  const flipTargets = () =>
    store.agents.filter((a) => a.installed && a.chat_supported && a.id !== props.message.agentId);

  return (
    <div class="msg-assistant" data-message-id={props.message.id}>
      <div class="msg-assistant-head">
        <AgentLogo agentId={props.message.agentId} icon={agentIcon(props.message.agentId)} size={18} radius={5} />
        <span class="msg-assistant-name">{agentLabel(props.message.agentId)}</span>
        <Show when={props.message.model}>
          <span class="msg-assistant-model">{props.message.model}</span>
        </Show>
        <Show when={running()}>
          <span class="msg-live">
            <span class="msg-live-activity" ref={activityLabel}>{activity()}</span>
            <span class="msg-live-time">{formatElapsed(now() - props.message.startedAt)}</span>
            <Show when={chat.activeId}>
              <button type="button" class="msg-live-stop" onClick={cancelTurn} title="Stop (Esc)" aria-label="Stop">
                <Icon name="stop" size={11} />
                Stop
              </button>
            </Show>
          </span>
        </Show>
        <Show when={!running() && props.message.status === "done"}><span class="msg-done"><Icon name="check" size={12} /> Done</span></Show>
      </div>

      <For each={items()}>
        {(item) => (
          <Switch>
            <Match when={"isGroup" in item && (item as ToolGroup)}>
              {(g) => <ToolGroupRow group={g()} blocks={visible} />}
            </Match>
            <Match when={!("isGroup" in item) && (item as Block).kind === "text" && (item as Block)}>
              {(b) => <Markdown text={(b() as Extract<Block, { kind: "text" }>).text} />}
            </Match>
            <Match when={!("isGroup" in item) && (item as Block).kind === "thinking" && (item as Block)}>
              {(b) => (
                <Thinking
                  block={b() as ThinkingBlock}
                  live={running() && (b() as Block) === lastBlock()}
                />
              )}
            </Match>
            <Match when={!("isGroup" in item) && (item as Block).kind === "interaction" && (item as Block)}>
              {(b) => <AgentInteraction block={b() as InteractionBlock} sessionId={props.sessionId} />}
            </Match>
            <Match when={!("isGroup" in item) && (item as Block).kind === "subagent" && (item as Block)}>
              {(b) => <SubagentCard block={b() as SubagentBlock} blocks={() => props.message.blocks} sessionId={props.sessionId} />}
            </Match>
            <Match when={!("isGroup" in item) && (item as Block).kind === "notice" && (item as Block)}>
              {(b) => <NoticeRow block={b() as NoticeBlock} />}
            </Match>
            <Match when={!("isGroup" in item) && (item as Block).kind === "compaction" && (item as Block)}>
              {(b) => <CompactionRow block={b() as CompactionBlock} />}
            </Match>
            <Match when={!("isGroup" in item) && (item as Block).kind === "tool" && (item as Block)}>
              {(b) => <ToolCallRow block={b() as ToolBlock} />}
            </Match>
          </Switch>
        )}
      </For>

      <Show when={showPulse()}>
        <div class="typing-dots" aria-label="Working"><span /><span /><span /></div>
      </Show>

      <Show when={props.message.error}>
        <div class="msg-error">
          <Icon name="alert" size={15} />
          <span>{props.message.error}</span>
          <Show when={props.isLast && !running() && chat.activeId}>
            <button type="button" class="msg-error-retry" onClick={() => void retryLastTurn(chat.activeId!)}>Retry</button>
          </Show>
        </div>
      </Show>

      <Show when={props.message.status === "cancelled"}>
        <div class="msg-note">Stopped</div>
      </Show>

      <Show when={!running() && props.message.changedFiles.length > 0}>
        <div class="turn-changes">
          <button type="button" class="turn-changes-main" onClick={() => openSide("changes")}>
            <Icon name="diff" size={14} />
            <span>Review changes · {props.message.changedFiles.length} file{props.message.changedFiles.length === 1 ? "" : "s"}</span>
          </button>
          <span class="turn-changes-files">
            <For each={props.message.changedFiles.slice(0, 3)}>
              {(file) => <button type="button" class="turn-changes-file" title={`Review current diff for ${file.path}`} onClick={() => openReview(undefined, file.path.split(/[\\/]/).pop() || file.path, file.path)}>{file.path}</button>}
            </For>
            <Show when={props.message.changedFiles.length > 3}><span class="turn-changes-more">+{props.message.changedFiles.length - 3}</span></Show>
          </span>
          <button type="button" class="turn-changes-all" onClick={() => openSide("changes")} title="Open all changes" aria-label="Open all changes"><Icon name="chevronRight" size={16} /></button>
        </div>
      </Show>

      <Show when={!running()}>
        <div class="msg-footer">
          <div class="msg-actions msg-actions-inline">
            <ActionButton icon="copy" label="Copy response" onClick={() => writeClipboardText(fullText(), "response")} />
            <Show when={props.isLast && chat.activeId}>
              <ActionButton icon="refresh" label="Retry" onClick={() => void retryLastTurn(chat.activeId!)} />
            </Show>
            <Show when={props.isLast && flipTargets().length > 0}>
              <button
                ref={flipAnchor}
                type="button"
                class="msg-action msg-action-text"
                onClick={() => setFlipOpen((v) => !v)}
                title="Continue this conversation with another agent"
              >
                <Icon name="merge" size={14} />
                Continue with
                <Icon name="chevronDown" size={11} />
              </button>
              <Menu open={flipOpen()} onClose={() => setFlipOpen(false)} anchorRef={flipAnchor} width={240}>
                <MenuLabel>Continue with</MenuLabel>
                <For each={flipTargets()}>
                  {(a) => (
                    <MenuItem onSelect={() => { setFlipOpen(false); setComposerAgent(a.id); runAction("focus-prompt"); }}>
                      <AgentLogo agentId={a.id} icon={a.icon} size={18} radius={5} />
                      <span style={{ flex: 1 }}>{a.name}</span>
                    </MenuItem>
                  )}
                </For>
              </Menu>
            </Show>
          </div>
          <Show when={props.message.contextUsage || props.message.usage}>
            <details class="msg-usage">
              <summary>Usage</summary>
              <div class="msg-usage-detail">
                <Show when={props.message.contextUsage}>{(usage) => (
                  <span>{usage().used.toLocaleString()} / {usage().size.toLocaleString()} context tokens<Show when={usage().cost != null}> · ${usage().cost!.toFixed(3)}</Show></span>
                )}</Show>
                <Show when={props.message.usage}>{(usage) => (
                  <span>
                    {formatTokens(usage().input)} in · {formatTokens(usage().output)} out
                    <Show when={props.message.contextUsage?.cost == null && usage().cost != null && usage().cost! > 0}> · ${usage().cost!.toFixed(3)}</Show>
                  </span>
                )}</Show>
              </div>
            </details>
          </Show>
        </div>
      </Show>
    </div>
  );
};
