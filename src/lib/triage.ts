// "Triage an issue": start a project-less conversation with the machine's app
// and agent state already in the prompt, so the agent can investigate before
// suggesting a change. Nothing is sent until the user reviews the draft.
import { getVersion } from "@tauri-apps/api/app";
import { startScratchSession, chat, projectName } from "./chat";
import { setStore, store } from "./store";

/** Plain-text diagnostics safe to put in a prompt (no credentials, paths only). */
export function triagePrompt(appVersion: string, now = new Date()): string {
  const agents = store.agents.length
    ? store.agents
        .filter((agent) => agent.installed)
        .map((agent) => `- ${agent.name}${agent.version ? ` (${agent.version})` : ""}${agent.chat_supported ? "" : " — terminal only"}`)
        .join("\n")
    : "- Agent detection has not finished yet.";
  const recent = chat.sessions
    .filter((session) => session.status === "error")
    .slice(0, 5)
    .map((session) => `- ${session.title || "Untitled"} · ${projectName(session.project_path)} · ${new Date(session.updated_at).toISOString()}`)
    .join("\n");
  return [
    "You are triaging a FlipFlopper issue. Investigate first, explain what you found, and ask before applying a fix or posting anything.",
    "",
    "Diagnostics:",
    `- FlipFlopper ${appVersion}`,
    `- Platform: ${navigator.platform || "unknown"}; ${navigator.userAgent}`,
    `- Local time: ${now.toString()}`,
    `- Open project: ${store.currentProject?.path ?? "none"}`,
    `- Recent failed conversations:\n${recent || "- None recorded"}`,
    "",
    "Installed agents:",
    agents,
    "",
    "What happened, and what did you expect instead?",
  ].join("\n");
}

/** Open a scratch draft with the triage brief ready to review and send. */
export async function startTriageSession() {
  const version = await getVersion().catch(() => "unknown");
  startScratchSession();
  setStore("pendingPromptSeed", { text: triagePrompt(version) });
}
