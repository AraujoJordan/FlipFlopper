import { Component, For, Show, createMemo, createResource } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { providerUsageLimits, usageLimitEvents, usageRows, type ProviderLimitWindow, type ProviderLimits } from "../lib/ipc";
import { usageTotals } from "../lib/usage";
import { agentLabel } from "./chat/agentLabel";
import { AgentLogo } from "../lib/agentMeta";
import { setPendingPromptSeed, store } from "../lib/store";
import { runAction } from "../lib/shortcuts";
import { chat, contextUsage, selectSession } from "../lib/chat";
import { Icon } from "./shell/Icon";
import { Spinner, toast } from "./ui";

const DASHBOARDS: Record<string, string> = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/codex/settings/usage",
  cursor: "https://cursor.com/dashboard?tab=usage",
};

const WINDOWS = [
  { label: "5 hours", ms: 5 * 3_600_000 },
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "30 days", ms: 30 * 86_400_000 },
];

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const money = (n: number | null) => (n == null ? null : `$${n.toFixed(n >= 100 ? 0 : 2)}`);
const ago = (ts: number) => {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

/** Provider usage limits: local rolling usage, context, provider dashboards and
 *  any rate/quota notices the CLIs recorded in conversations. Account quotas
 *  themselves stay with the provider; this makes the available data visible. */
const UsageLimits: Component<{ onClose: () => void }> = (props) => {
  const [rows] = createResource(() => usageRows(30).catch(() => []));
  const [events] = createResource(() => usageLimitEvents(30).catch(() => []));
  const [providerLimits, { refetch: refetchProviderLimits }] = createResource(
    () => {
      const installed = ["claude", "codex", "cursor"].filter((id) => store.agents.some((agent) => agent.id === id && agent.installed));
      return installed.length ? installed : null;
    },
    async (ids) => Promise.all(ids.map(async (id) => {
      try {
        return { id, value: await providerUsageLimits(id), error: null as string | null };
      } catch (error) {
        return { id, value: null as ProviderLimits | null, error: String(error) };
      }
    })),
  );
  const providerLimit = (id: string) => (providerLimits() ?? []).find((entry) => entry.id === id);
  const resetText = (window: ProviderLimitWindow) => window.reset
    ?? (window.reset_at ? new Date(window.reset_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null);

  /** Approximate window length from the provider's label, for an "even pace" marker. */
  const windowDuration = (label: string): number | null => {
    if (/5-hour|session/i.test(label)) return 5 * 3_600_000;
    if (/week/i.test(label)) return 7 * 86_400_000;
    if (/month|total|api|composer/i.test(label)) return 30 * 86_400_000;
    return null;
  };

  /** Where an even burn rate would put usage now, and how far the account is from it. */
  const paceFor = (window: ProviderLimitWindow, at = Date.now()) => {
    const duration = windowDuration(window.label);
    if (!duration || !window.reset_at) return null;
    const remaining = Math.max(0, window.reset_at - at);
    const fraction = Math.max(0, Math.min(1, (duration - remaining) / duration));
    const used = window.used_percent / 100;
    const difference = used - fraction;
    return {
      fraction,
      tone: difference > 0.08 ? "high" : difference < -0.08 ? "low" : "mid",
      label: difference > 0.08 ? "Ahead of pace" : difference < -0.08 ? "Under pace" : "On pace",
    };
  };
  const allRows = () => rows() ?? [];
  const now = () => Date.now();
  const activeAgent = () => chat.sessions.find((session) => session.id === chat.activeId)?.agent_id ?? null;
  const activeContext = createMemo(() => contextUsage());
  const providers = createMemo(() => {
    const seen = new Set<string>();
    return store.agents
      .filter((agent) => agent.installed || agent.chat_supported)
      .filter((agent) => seen.has(agent.id) ? false : (seen.add(agent.id), true))
      .sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
  });
  const windowsFor = (agentId: string) => WINDOWS.map((window) => {
    const totals = usageTotals(allRows().filter((row) => row.agent === agentId && row.ts >= now() - window.ms));
    return { ...window, totals, total: totals.input + totals.output };
  });
  const eventsFor = (agentId: string) => (events() ?? []).filter((event) => event.agent === agentId).slice(0, 2);

  function checkProvider(agentId: string) {
    const dashboard = DASHBOARDS[agentId];
    if (agentId === "claude" && chat.composer.agentId === "claude") {
      setPendingPromptSeed({ text: "/usage" });
      props.onClose();
      runAction("focus-prompt");
      return;
    }
    if (dashboard) {
      void openUrl(dashboard).catch((error) => toast(`Couldn't open the provider dashboard: ${String(error)}`, "error"));
      return;
    }
    toast("This CLI does not expose a usage command. Its plan limits stay in the provider's account settings.", "info");
  }

  return (
    <div class="usage-limits">
      <div class="usage-limits-note">
        <Icon name="shield" size={15} />
        <p>Provider quotas belong to your account. This dashboard shows the tokens and cost the CLIs reported locally in rolling windows, the active context window, and any rate-limit or quota notices recorded in conversations. Open the provider dashboard for account-level limits.</p>
      </div>

      <Show when={!rows.loading && providers().length === 0}>
        <div class="usage-limits-empty">No chat agents are installed yet.</div>
      </Show>

      <div class="usage-provider-grid">
        <For each={providers()}>
          {(agent) => {
            const windows = () => windowsFor(agent.id);
            const context = () => activeAgent() === agent.id ? activeContext() : undefined;
            const dashboard = () => DASHBOARDS[agent.id] ?? null;
            return (
              <article class="usage-provider-card" classList={{ "usage-provider-active": activeAgent() === agent.id }}>
                <header class="usage-provider-head">
                  <AgentLogo agentId={agent.id} icon={agent.icon} size={22} radius={6} />
                  <div class="usage-provider-name">
                    <strong>{agent.name ?? agentLabel(agent.id)}</strong>
                    <span>{agent.installed ? (agent.version ? `Installed · ${agent.version}` : "Installed") : "Not installed"}</span>
                  </div>
                  <Show when={activeAgent() === agent.id}><span class="usage-provider-current">Current</span></Show>
                </header>

                <Show when={["claude", "codex", "cursor"].includes(agent.id) && agent.installed}>
                  <div class="usage-provider-account">
                    <div class="usage-account-head">
                      <span>Account limits</span>
                      <button type="button" class="icon-btn" title={`Refresh ${agent.name} limits`} aria-label={`Refresh ${agent.name} limits`} onClick={() => void refetchProviderLimits?.()}><Icon name="refresh" size={11} /></button>
                    </div>
                    <Show when={providerLimit(agent.id)?.error} fallback={
                      <Show when={providerLimit(agent.id)?.value} fallback={<div class="usage-account-note"><Spinner size={11} /> Checking {agent.name}…</div>}>
                        {(limits) => (
                          <For each={limits().windows}>
                            {(window) => (
                              <div class="usage-account-window">
                                <div class="usage-account-window-head">
                                  <span>{window.label}</span>
                                  <strong>{window.used_percent}%</strong>
                                </div>
                                <div class="usage-context-track"><span style={{ width: `${window.used_percent}%` }} data-level={window.used_percent >= 90 ? "high" : window.used_percent >= 70 ? "mid" : "low"} />
                                  <Show when={paceFor(window)}>{(pace) => <i class="usage-pace-marker" style={{ left: `${pace().fraction * 100}%` }} title="Even pace" />}</Show>
                                </div>
                                <small>{resetText(window) ? `Resets ${resetText(window)}` : "No reset time reported"} · {limits().source}</small>
                                <Show when={paceFor(window)}>{(pace) => <small class="usage-pace" data-tone={pace().tone}>{pace().label}</small>}</Show>
                              </div>
                            )}
                          </For>
                        )}
                      </Show>
                    }>
                      {(error) => (
                        <button type="button" class="usage-account-error" onClick={() => void refetchProviderLimits?.()} title={error()}>
                          <Icon name="alert" size={11} /> Couldn't read {agent.name} limits. Retry.
                        </button>
                      )}
                    </Show>
                  </div>
                </Show>

                <div class="usage-provider-windows">
                  <For each={windows()}>
                    {(window) => (
                      <div class="usage-window">
                        <span>{window.label}</span>
                        <strong>{window.total ? tokens(window.total) : "—"}</strong>
                        <small>{window.total ? [money(window.totals.cost), `${window.totals.turns} turn${window.totals.turns === 1 ? "" : "s"}`].filter(Boolean).join(" · ") : "No local usage"}</small>
                      </div>
                    )}
                  </For>
                </div>

                <Show when={context()}>
                  {(usage) => {
                    const percent = () => Math.min(100, Math.round((usage().used / Math.max(1, usage().size)) * 100));
                    return (
                      <div class="usage-context">
                        <div class="usage-context-head"><span>Context window</span><strong>{percent()}%</strong></div>
                        <div class="usage-context-track"><span style={{ width: `${percent()}%` }} data-level={percent() >= 90 ? "high" : percent() >= 70 ? "mid" : "low"} /></div>
                        <small>{tokens(usage().used)} / {tokens(usage().size)} tokens{usage().cost != null ? ` · $${usage().cost!.toFixed(2)}` : ""}</small>
                      </div>
                    );
                  }}
                </Show>

                <Show when={eventsFor(agent.id).length > 0}>
                  <div class="usage-provider-events">
                    <For each={eventsFor(agent.id)}>
                      {(event) => (
                        <button type="button" class="usage-event-row" onClick={() => { props.onClose(); void selectSession(event.session); }} title={event.message}>
                          <Icon name="alert" size={12} />
                          <span>{event.title}</span>
                          <small>{ago(event.ts)}</small>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                <div class="usage-provider-actions">
                  <Show when={agent.id === "claude" && chat.composer.agentId === "claude"}>
                    <button type="button" class="ui-btn ui-btn-outline" onClick={() => checkProvider(agent.id)}><Icon name="message" size={12} /> Ask /usage</button>
                  </Show>
                  <Show when={dashboard()}>
                    {(url) => <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void openUrl(url()).catch((error) => toast(`Couldn't open the provider dashboard: ${String(error)}`, "error"))}><Icon name="external" size={12} /> Provider dashboard</button>}
                  </Show>
                  <Show when={!dashboard() && agent.id !== "claude"}>
                    <span class="usage-provider-note">No CLI usage command</span>
                  </Show>
                </div>
              </article>
            );
          }}
        </For>
      </div>

      <section class="usage-limit-log">
        <div class="usage-limit-log-head">
          <strong>Provider limit notices</strong>
          <span>Last 30 days from conversation events</span>
        </div>
        <Show when={events() && events()!.length > 0} fallback={<div class="usage-limits-empty">No rate-limit or quota notices recorded. When an agent reports one, it appears here.</div>}>
          <For each={events()!.slice(0, 20)}>
            {(event) => (
              <button type="button" class="usage-limit-row" onClick={() => { props.onClose(); void selectSession(event.session); }}>
                <span class="usage-limit-when">{new Date(event.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                <AgentLogo agentId={event.agent} icon={store.agents.find((agent) => agent.id === event.agent)?.icon} size={15} radius={4} />
                <span class="usage-limit-copy"><strong>{event.title}</strong><small>{event.session_title || "Session"} · {event.message}</small></span>
                <span class="pulls-ago">{ago(event.ts)}</span>
              </button>
            )}
          </For>
        </Show>
      </section>
    </div>
  );
};

export default UsageLimits;
