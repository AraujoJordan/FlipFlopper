import { Component, createSignal, Show } from "solid-js";
import { listAgentModels, type AgentModelChoice } from "./ipc";
import { readPref, writePref } from "./appPrefs";

// ── Model / effort catalog ────────────────────────────────────────────────────
// Nothing is bundled: each CLI is asked which models it offers (`list_agent_models`)
// when the model picker opens. The last answer is persisted in preferences.json so
// the picker shows it instantly next time and stays usable offline. Claude and
// Cursor use their native ACP catalogs instead (see `agentTuning` in chat.ts).

export interface AgentTuningOption {
  id: string;
  label: string;
}

export interface AgentTuning {
  models: AgentTuningOption[];
  /** empty when the agent has no effort-style setting */
  efforts: AgentTuningOption[];
}

interface CachedModels { models: AgentModelChoice[]; fetchedAt: number }

const PREF_KEY = "agentModelCatalog";
const [catalog, setCatalog] = createSignal<Record<string, CachedModels>>({});
const [loading, setLoading] = createSignal<Record<string, boolean>>({});
const [errors, setErrors] = createSignal<Record<string, string>>({});
let hydration: Promise<void> | undefined;

/** Load the persisted catalog once; safe to call from several components. */
export function hydrateAgentModels(): Promise<void> {
  hydration ??= readPref<Record<string, CachedModels>>(PREF_KEY, {})
    .then((saved) => { setCatalog((fresh) => ({ ...saved, ...fresh })); })
    .catch(() => undefined);
  return hydration;
}

/** Ask the installed CLI for its current models, then persist the answer. */
export async function refreshAgentModels(agentId: string): Promise<void> {
  await hydrateAgentModels();
  if (loading()[agentId]) return;
  setLoading((l) => ({ ...l, [agentId]: true }));
  try {
    const models = await listAgentModels(agentId);
    setErrors((e) => ({ ...e, [agentId]: "" }));
    // An empty answer (CLI without a listing command, or logged out) keeps the last good list.
    if (models.length > 0) {
      setCatalog((c) => ({ ...c, [agentId]: { models, fetchedAt: Date.now() } }));
      writePref(PREF_KEY, catalog());
    }
  } catch (error) {
    setErrors((e) => ({ ...e, [agentId]: String(error) }));
  } finally {
    setLoading((l) => ({ ...l, [agentId]: false }));
  }
}

export const agentModelsLoading = (agentId: string) => !!loading()[agentId];
export const agentModelsError = (agentId: string) => errors()[agentId] || null;

const titleCase = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

/** Models and efforts last reported by the agent's CLI. `model` selects whose efforts to offer. */
export function discoveredTuning(agentId: string, model?: string | null): AgentTuning {
  const models = catalog()[agentId]?.models ?? [];
  const efforts = (models.find((m) => m.id === model) ?? models[0])?.efforts ?? [];
  return {
    models: models.map((m) => ({ id: m.id, label: m.label })),
    efforts: efforts.map((id) => ({ id, label: titleCase(id) })),
  };
}

// ── Agent visual identity (colors, letters, logo) ────────────────────────────
// Single source of truth for how an agent is represented in the UI. Consumed
// by the sidebar, transcript, composer, settings and flow views.

const AGENT_COLORS: Record<string, string> = {
  claude: "#D97756",
  qwen: "#a371f7",
  gemini: "#1A73E8",
  codex: "#10A37F",
  cursor: "#8b949e", // Cursor's mark is monochrome black/white; #0A0A0A was
                     // near-invisible on the app's dark surfaces, so this uses
                     // a neutral light gray for legible contrast instead.
  agy: "#1A73E8",
  aider: "#f0883e",
  opencode: "#0052CC",
  cline: "#39c5cf",
  goose: "#56d364",
  plandex: "#a5d6ff",
  droid: "#f778ba",
  grok: "#ffffff",
  kimi: "#6E56CF",
  run: "#3fb950",
  validate: "#58a6ff",
};

export function agentColor(agentId: string): string {
  return AGENT_COLORS[agentId] ?? "#8b949e";
}

export function agentLetter(agentId: string): string {
  const map: Record<string, string> = {
    claude: "C", qwen: "Q", gemini: "G", codex: "X", cursor: "C",
    agy: "A", aider: "D", opencode: "O", cline: "L", goose: "S", plandex: "P", droid: "R", grok: "G", kimi: "K",
    run: "▶",
    validate: "✓",
  };
  return map[agentId] ?? agentId[0]?.toUpperCase() ?? "?";
}

export const AgentLogo: Component<{
  agentId: string;
  icon?: string | null;
  name?: string;
  size?: number;
  radius?: number;
}> = (props) => {
  const [imageFailed, setImageFailed] = createSignal(false);
  const size = () => props.size ?? 24;
  const radius = () => props.radius ?? 7;

  return (
    <span style={{
      width: `${size()}px`, height: `${size()}px`,
      "border-radius": `${radius()}px`,
      background: `${agentColor(props.agentId)}22`,
      border: "1px solid var(--border-default)",
      display: "flex", "align-items": "center", "justify-content": "center",
      overflow: "hidden",
      flex: "0 0 auto",
    }}>
      <Show when={props.icon && !imageFailed()} fallback={
        <span style={{
          color: "var(--fg-default)",
          "font-family": "var(--font-mono)",
          "font-weight": "700", "font-size": `${Math.max(10, Math.round(size() * 0.52))}px`,
          "line-height": "1",
        }}>
          {agentLetter(props.agentId)}
        </span>
      }>
        <img
          src={props.icon ?? ""}
          alt={props.name ? `${props.name} logo` : ""}
          onError={() => setImageFailed(true)}
          style={{
            width: "100%", height: "100%",
            "object-fit": "contain",
            display: "block",
          }}
        />
      </Show>
    </span>
  );
};
