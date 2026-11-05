// Conversation export: renders a reduced transcript as plain Markdown and saves it
// through the native "Save as" dialog. The renderer is pure; only
// `exportConversation` touches the app.
import { chat } from "./chat";
import { chatTranscriptPath, saveTextFile, type SessionMeta } from "./ipc";
import { writeClipboardText } from "./native";
import { maskForDisplay } from "./secrets";
import type { SessionView } from "./transcript";
import { agentLabel } from "../components/chat/agentLabel";
import { toast } from "../components/ui";

const fence = (text: string) => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
};

export function transcriptToMarkdown(
  meta: Pick<SessionMeta, "title" | "project_path" | "agent_id">,
  view: SessionView,
  label: (agentId: string) => string = (id) => id,
  sourcePath?: string,
): string {
  const out: string[] = [`# ${meta.title || "Conversation"}`, "", `- Project: \`${meta.project_path}\``, `- Agent: ${label(meta.agent_id)}`];
  if (sourcePath) out.push(`- Source: \`${sourcePath}\``);
  for (const m of view.messages) {
    if (m.role === "divider") {
      out.push("", `---`, `*Switched from ${label(m.from)} to ${label(m.to)}*`);
    } else if (m.role === "user") {
      out.push("", "## You", "", m.text.trim());
      if (m.attachments.length) out.push("", ...m.attachments.map((a) => `- 📎 ${a.name}`));
    } else {
      out.push("", `## ${label(m.agentId)}${m.model ? ` (${m.model})` : ""}`);
      for (const b of m.blocks) {
        if (b.kind === "text" && b.text.trim()) out.push("", b.text.trim());
        else if (b.kind === "tool" && !b.subagent) out.push("", `- 🔧 ${b.title} (${b.status})`);
        else if (b.kind === "notice") out.push("", `> **${b.title}**${b.description ? ` — ${b.description}` : ""}`);
        else if (b.kind === "subagent") out.push("", `- 🤖 Subagent: ${b.title} (${b.state})`);
        else if (b.kind === "compaction" && b.summary) out.push("", `> Context compacted: ${b.summary}`);
      }
      if (m.changedFiles.length) {
        out.push("", "**Changed files**", "", ...m.changedFiles.map((f) => `- \`${f.path}\``));
      }
      if (m.error) out.push("", fence(`Error: ${m.error}`));
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

const fileName = (title: string) => `${(title || "conversation").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "conversation"}.md`;

/** Save the active conversation as Markdown; falls back to the clipboard if saving fails. */
export async function exportConversation(id: string | null = chat.activeId): Promise<void> {
  const meta = id ? chat.sessions.find((s) => s.id === id) : undefined;
  const view = id ? chat.views[id] : undefined;
  if (!meta || !view?.loaded) { toast("Open a conversation to export it.", "info"); return; }
  // Exports follow the display setting, so a shared file doesn't leak what the screen hides.
  const source = await chatTranscriptPath(meta.id).catch(() => undefined);
  const markdown = maskForDisplay(transcriptToMarkdown(meta, view, agentLabel, source));
  try {
    const path = await saveTextFile(fileName(meta.title), markdown);
    if (path) toast(`Exported to ${path}`, "info");
  } catch (error) {
    await writeClipboardText(markdown).catch(() => {});
    toast(`Couldn't save the file (${String(error)}); copied the Markdown instead.`, "error");
  }
}
