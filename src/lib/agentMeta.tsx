import { Component, createSignal, Show } from "solid-js";

// ── Model / effort options ────────────────────────────────────────────────────
// Offered in the composer's agent menu and orchestrator steps. Ids are passed
// to each CLI's own `--model` (and effort) flag by the chat engine.


export interface AgentTuningOption {
  id: string;
  label: string;
}

export interface AgentTuning {
  models: AgentTuningOption[];
  /** empty when the agent has no effort-style setting */
  efforts: AgentTuningOption[];
}

const GEMINI_FAMILY_MODELS: AgentTuningOption[] = [
  { id: "gemini-3-pro-preview", label: "3 Pro" },
  { id: "gemini-3-flash-preview", label: "3 Flash" },
  { id: "gemini-2.5-pro", label: "2.5 Pro" },
  { id: "gemini-2.5-flash", label: "2.5 Flash" },
];

export const AGENT_TUNING: Record<string, AgentTuning> = {
  agy: {
    models: GEMINI_FAMILY_MODELS,
    efforts: [],
  },
  qwen: {
    models: [
      { id: "qwen3-coder-plus", label: "Coder Plus" },
      { id: "qwen3-coder-flash", label: "Coder Flash" },
      ...GEMINI_FAMILY_MODELS,
    ],
    efforts: [],
  },
  aider: {
    models: [
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" },
      { id: "flash", label: "Gemini Flash" },
      { id: "deepseek", label: "DeepSeek" },
    ],
    efforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
  },
  codex: {
    models: [
      { id: "gpt-5.3-codex", label: "Codex 5.3" },
      { id: "gpt-5.2-codex", label: "Codex 5.2" },
      { id: "gpt-5.2", label: "GPT-5.2" },
      { id: "gpt-5.1-codex-mini", label: "Codex Mini" },
    ],
    efforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ],
  },
  opencode: {
    models: [
      { id: "opencode/claude-sonnet-5", label: "Sonnet 5" },
      { id: "opencode/claude-opus-4-8", label: "Opus 4.8" },
      { id: "opencode/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "opencode/glm-5.1", label: "GLM 5.1" },
      { id: "opencode/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
    efforts: [],
  },
  grok: {
    models: [
      { id: "grok-build-0.1", label: "Build 0.1" },
      { id: "grok-4.3", label: "Grok 4.3" },
      { id: "grok-4", label: "Grok 4" },
    ],
    efforts: [],
  },
  kimi: {
    // Kimi's `/model` is a picker-only TUI panel (no inline arg), so live
    // sessions can't be driven — fresh step sessions get `-m` instead.
    // Model aliases are the managed kimi-code defaults from `kimi provider list`.
    models: [
      { id: "kimi-code/k3", label: "K3" },
      { id: "kimi-code/k3-256k", label: "K3 256K" },
      { id: "kimi-code/kimi-for-coding", label: "For Coding" },
      { id: "kimi-code/kimi-for-coding-highspeed", label: "For Coding HS" },
    ],
    efforts: [],
  },
};

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
  const [imageLoaded, setImageLoaded] = createSignal(false);
  const size = () => props.size ?? 24;
  const radius = () => props.radius ?? 7;

  return (
    <span style={{
      width: `${size()}px`, height: `${size()}px`,
      "border-radius": `${radius()}px`,
      background: `${agentColor(props.agentId)}22`,
      border: "1px solid rgba(255,255,255,.08)",
      display: "flex", "align-items": "center", "justify-content": "center",
      overflow: "hidden",
      flex: "0 0 auto",
    }}>
      <Show when={props.icon && !imageFailed()} fallback={
        <span style={{
          color: "#f0f6fc",
          "font-family": "'JetBrains Mono', monospace",
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
          onLoad={() => setImageLoaded(true)}
          style={{
            width: "100%", height: "100%",
            "object-fit": "contain",
            display: "block",
            opacity: imageLoaded() ? "1" : "0",
            transition: "opacity var(--dur-base) var(--ease-standard)",
          }}
        />
      </Show>
    </span>
  );
};
