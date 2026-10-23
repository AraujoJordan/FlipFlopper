import { createStore } from "solid-js/store";
import { locale } from "@tauri-apps/plugin-os";
import { chatExplain, listOllamaModels, type ExplainProvider } from "./ipc";
import { chat } from "./chat";
import { store } from "./store";
import { readPref, writePref } from "./appPrefs";

/** Where explanations come from. `auto` = the cheapest model of the session's agent. */
export type ExplainChoice =
  | { kind: "auto" }
  | { kind: "agent"; agent_id: string; model: string | null }
  | { kind: "ollama"; model: string };

interface Explanation {
  text?: string;
  source?: string;
  error?: string;
  loading: boolean;
  /** Inputs of the last request, so unchanged sessions are not explained twice. */
  key?: string;
  at?: number;
}

const PREF_KEY = "explainProvider";
const [state, setState] = createStore<{ choice: ExplainChoice; byId: Record<string, Explanation>; ollama: string[]; ollamaLoaded: boolean }>({
  choice: { kind: "auto" },
  byId: {},
  ollama: [],
  ollamaLoaded: false,
});

export const explainChoice = () => state.choice;
export const explanationFor = (id: string): Explanation | undefined => state.byId[id];
export const ollamaModels = () => state.ollama;

void readPref<ExplainChoice>(PREF_KEY, { kind: "auto" }).then((saved) => {
  if (saved && typeof saved === "object" && ["auto", "agent", "ollama"].includes(saved.kind)) setState("choice", saved);
}).catch(() => {});

export function setExplainChoice(choice: ExplainChoice) {
  setState("choice", choice);
  writePref(PREF_KEY, choice);
}

export async function refreshOllamaModels() {
  setState({ ollama: await listOllamaModels().catch(() => []), ollamaLoaded: true });
}

/** True when the saved Ollama model is no longer installed (only known once the list loaded). */
export const ollamaChoiceMissing = () =>
  state.choice.kind === "ollama" && state.ollamaLoaded && !state.ollama.includes(state.choice.model);

/** The choice that actually runs: a saved agent that is gone falls back to Auto. */
export function effectiveChoice(): ExplainChoice {
  const choice = state.choice;
  if (choice.kind === "agent" && !headlessAgents().some((a) => a.id === choice.agent_id)) return { kind: "auto" };
  return choice;
}

/** Agents that can answer a one-shot prompt. */
export const headlessAgents = () => store.agents.filter((a) => a.installed && a.headless_supported);

/** The provider that will run, plus whether `auto` had to fall back to another agent. */
export function resolveProvider(sessionAgentId: string): { provider: ExplainProvider | null; fallback: boolean } {
  const choice = effectiveChoice();
  if (choice.kind === "ollama") return { provider: { kind: "ollama", model: choice.model }, fallback: false };
  if (choice.kind === "agent") return { provider: { kind: "agent", agent_id: choice.agent_id, model: choice.model }, fallback: false };
  const ready = headlessAgents();
  const own = ready.find((a) => a.id === sessionAgentId);
  const agent = own ?? ready[0];
  return { provider: agent ? { kind: "agent", agent_id: agent.id, model: null } : null, fallback: !own && !!agent };
}

/** Language as "Brazilian Portuguese (pt-BR)": small local models follow a name better than a tag. */
async function userLanguage(): Promise<string> {
  const tag = (await locale().catch(() => null)) || navigator.language || "en";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    return name && name !== tag ? `${name} (${tag})` : tag;
  } catch {
    return tag;
  }
}

/** Inputs that change what an explanation should say. */
function requestKey(id: string, provider: ExplainProvider): string {
  const view = chat.views[id];
  const last = view?.messages[view.messages.length - 1];
  const pending = view?.runtime?.pending.map((p) => p.id).join(",") ?? "";
  return `${view?.messages.length ?? 0}|${last?.role === "assistant" ? last.status : ""}|${pending}|${JSON.stringify(provider)}`;
}

/** Ask the chosen model to explain session `id`. Skips unchanged sessions unless `force`. */
export async function explain(id: string, force = false) {
  const session = chat.sessions.find((s) => s.id === id);
  if (!session || state.byId[id]?.loading) return;
  const { provider } = resolveProvider(session.agent_id);
  if (!provider) {
    setState("byId", id, { loading: false, error: "No installed agent can run a short prompt. Install one or pick an Ollama model." });
    return;
  }
  if (provider.kind === "ollama" && ollamaChoiceMissing()) {
    setState("byId", id, { ...state.byId[id], loading: false, error: `Model ${provider.model} is not installed in Ollama. Pick another model.` });
    return;
  }
  const key = requestKey(id, provider);
  const previous = state.byId[id];
  if (!force && previous?.key === key) return;
  setState("byId", id, { ...previous, loading: true, error: undefined, key });
  try {
    const result = await chatExplain(id, provider, await userLanguage());
    setState("byId", id, { text: result.text, source: result.source, loading: false, at: Date.now(), error: undefined, key });
  } catch (e) {
    // Keep the key: a failed request is retried by Refresh only, never in a loop.
    setState("byId", id, { ...previous, loading: false, error: String(e), key });
  }
}

/** True when a new explanation should be requested for the session. */
export function explainIsStale(id: string): boolean {
  const session = chat.sessions.find((s) => s.id === id);
  const view = chat.views[id];
  if (!session || !view?.loaded) return false;
  // While the agent is working, wait for the turn to end — unless it is waiting on the user.
  if (view.running && !(view.runtime?.pending.length)) return false;
  const { provider } = resolveProvider(session.agent_id);
  if (!provider) return false;
  const current = state.byId[id];
  return !current?.loading && current?.key !== requestKey(id, provider);
}
