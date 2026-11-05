// Prompt and thread links. FlipFlopper has no hosted web app, so links use the
// app's own `flipflopper://` scheme: copy one, paste it into "Open prompt link…",
// or pass it to a new app process. Opening a link creates a draft; it never sends
// anything or changes permissions by itself.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";
import { gitRemoteUrl } from "./ipc";
import { chat, selectSession, setComposer, startNewSession, startScratchSession } from "./chat";
import { openProjectPath } from "./projects";
import { effectiveRoot, setPendingPromptSeed, store } from "./store";
import { writeClipboardText } from "./native";
import { toast } from "../components/ui";

export const MAX_PROMPT_LINK_CHARS = 8000;
const PENDING_KEY = "pendingPromptLink";
const PENDING_TTL_MS = 7 * 86_400_000;

export type PromptLinkPayload = {
  kind: "new" | "thread";
  prompt: string;
  repo: string | null;
  provider: string | null;
  model: string | null;
  threadId: string | null;
  title: string | null;
  /** The link contained invisible instruction-hiding characters that were removed. */
  hiddenCharacters: boolean;
};

const [promptLinkOpen, setPromptLinkOpen] = createSignal(false);
export { promptLinkOpen, setPromptLinkOpen };

/** Strip zero-width, bidi-override and Unicode tag characters that can hide prompt text. */
export function stripHiddenLinkCharacters(text: string): { text: string; removed: boolean } {
  const clean = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu, "");
  return { text: clean, removed: clean !== text };
}

const cleanValue = (value: string | null, max: number): string | null => {
  if (value === null) return null;
  const trimmed = stripHiddenLinkCharacters(value).text.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

const validRepo = (repo: string | null): string | null => {
  if (!repo) return null;
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  return match ? `${match[1]}/${match[2]}` : null;
};

/** Parse `flipflopper://new?...` and `flipflopper://thread/<id>?...` links. */
export function parsePromptLink(raw: string): PromptLinkPayload {
  const cleaned = stripHiddenLinkCharacters(raw.trim()).text.trim();
  if (!cleaned) throw new Error("Paste a prompt or thread link first.");
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error("That is not a valid FlipFlopper link.");
  }
  if (parsed.protocol !== "flipflopper:") throw new Error("Only flipflopper:// prompt and thread links are supported.");
  const host = parsed.hostname.toLowerCase();
  const params = parsed.searchParams;
  const hidden = stripHiddenLinkCharacters(raw).removed;
  const queryPrompt = params.get("prompt") ?? "";
  const promptInfo = stripHiddenLinkCharacters(queryPrompt);
  const prompt = promptInfo.text.replace(/\u0000/g, "").trim();

  if (host === "thread") {
    const fromPath = parsed.pathname.replace(/^\/+/, "");
    let decodedPath = fromPath;
    try { decodedPath = decodeURIComponent(fromPath); } catch { /* keep the raw id */ }
    const threadId = cleanValue(decodedPath || params.get("id"), 200);
    if (!threadId) throw new Error("This thread link is missing its session id.");
    if (prompt.length > MAX_PROMPT_LINK_CHARS) throw new Error(`Prompt links can carry at most ${MAX_PROMPT_LINK_CHARS.toLocaleString()} characters.`);
    return {
      kind: "thread",
      prompt,
      repo: validRepo(cleanValue(params.get("repo"), 200)),
      provider: cleanValue(params.get("provider"), 80),
      model: cleanValue(params.get("model"), 120),
      threadId,
      title: cleanValue(params.get("title"), 200),
      hiddenCharacters: hidden || promptInfo.removed,
    };
  }

  if (host !== "new" && host !== "prompt" && host !== "") throw new Error("Unknown FlipFlopper link target.");
  if (!prompt) throw new Error("This prompt link has no prompt.");
  if (prompt.length > MAX_PROMPT_LINK_CHARS) throw new Error(`Prompt links can carry at most ${MAX_PROMPT_LINK_CHARS.toLocaleString()} characters.`);
  return {
    kind: "new",
    prompt,
    repo: validRepo(cleanValue(params.get("repo"), 200)),
    provider: cleanValue(params.get("provider"), 80),
    model: cleanValue(params.get("model"), 120),
    threadId: null,
    title: cleanValue(params.get("title"), 200),
    hiddenCharacters: hidden || promptInfo.removed,
  };
}

export interface PromptLinkInput {
  prompt: string;
  repo?: string | null;
  provider?: string | null;
  model?: string | null;
  title?: string | null;
}

export function buildPromptLink(input: PromptLinkInput): string {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Write a prompt before copying a link.");
  if (prompt.length > MAX_PROMPT_LINK_CHARS) throw new Error(`Prompt links can carry at most ${MAX_PROMPT_LINK_CHARS.toLocaleString()} characters.`);
  const params = new URLSearchParams({ prompt });
  if (input.repo) params.set("repo", input.repo);
  if (input.provider) params.set("provider", input.provider);
  if (input.model) params.set("model", input.model);
  if (input.title) params.set("title", input.title.slice(0, 200));
  return `flipflopper://new?${params.toString()}`;
}

export function buildThreadLink(input: { id: string; title?: string | null; prompt?: string | null; repo?: string | null; provider?: string | null; model?: string | null }): string {
  const params = new URLSearchParams();
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length > MAX_PROMPT_LINK_CHARS) throw new Error(`Prompt links can carry at most ${MAX_PROMPT_LINK_CHARS.toLocaleString()} characters.`);
  if (input.title) params.set("title", input.title.slice(0, 200));
  if (prompt) params.set("prompt", prompt);
  if (input.repo) params.set("repo", input.repo);
  if (input.provider) params.set("provider", input.provider);
  if (input.model) params.set("model", input.model);
  const query = params.toString();
  return `flipflopper://thread/${encodeURIComponent(input.id)}${query ? `?${query}` : ""}`;
}

/** `owner/repo` from an HTTPS, SSH or scp-style git remote. */
export function repoSlugFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const cleaned = stripHiddenLinkCharacters(url).text.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) return validRepo(cleaned);
  const match = /(?:[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(cleaned);
  return match ? validRepo(`${match[1]}/${match[2]}`) : null;
}

async function projectRepo(path: string): Promise<string | null> {
  try {
    return repoSlugFromUrl(await gitRemoteUrl(path));
  } catch {
    return null;
  }
}

/** Match a link's repo against open and recent projects, checking remotes when names are ambiguous. */
export async function findProjectForRepo(repo: string | null): Promise<string | null> {
  if (!repo) return chat.draftProject ?? store.currentProject?.path ?? null;
  const wanted = repo.toLowerCase();
  const candidates = new Map<string, string>();
  if (store.currentProject) candidates.set(store.currentProject.path, store.currentProject.name);
  for (const project of store.recentProjects ?? []) if (!candidates.has(project.path)) candidates.set(project.path, project.name);
  for (const session of chat.sessions) if (!candidates.has(session.project_path)) candidates.set(session.project_path, session.project_path.split(/[\\/]/).pop() ?? "");
  const repoName = repo.split("/")[1]?.toLowerCase();
  for (const [path, name] of candidates) {
    if (name.toLowerCase() === repoName || path.split(/[\\/]/).pop()?.toLowerCase() === repoName) return path;
  }
  for (const [path] of [...candidates].slice(0, 12)) {
    if ((await projectRepo(path))?.toLowerCase() === wanted) return path;
  }
  return null;
}

async function applyPayload(payload: PromptLinkPayload): Promise<void> {
  if (payload.kind === "thread") {
    if (!payload.threadId || !chat.sessions.some((session) => session.id === payload.threadId)) {
      throw new Error("That thread is not in this FlipFlopper installation.");
    }
    await selectSession(payload.threadId);
    if (payload.prompt) setPendingPromptSeed({ text: payload.prompt });
    return;
  }

  const projectPath = await findProjectForRepo(payload.repo);
  if (projectPath) {
    await openProjectPath(projectPath).catch(() => null);
    startNewSession(projectPath);
  } else {
    startScratchSession();
    if (payload.repo) toast(`${payload.repo} is not open here; started without a project.`, "info");
  }
  const provider = payload.provider && store.agents.find((agent) => agent.id === payload.provider && agent.installed && agent.chat_supported);
  if (provider) setComposer({ agentId: provider.id, model: payload.model ?? null, effort: null });
  setPendingPromptSeed({ text: payload.prompt, projectPath: projectPath ?? undefined });
}

/** Save a link so a crash/restart before sending can still reopen its draft. */
export async function savePendingPromptLink(raw: string) {
  await writePref(PENDING_KEY, { link: raw, at: Date.now() });
}

export async function clearPendingPromptLink() {
  await writePref(PENDING_KEY, null);
}

/** Read and clear a pending link left by a previous launch. */
export async function consumeSavedPromptLink(): Promise<string | null> {
  const saved = await readPref<{ link?: string; at?: number } | null>(PENDING_KEY, null, () => null);
  if (!saved?.link || !saved.at || Date.now() - saved.at > PENDING_TTL_MS) return null;
  await clearPendingPromptLink();
  return saved.link;
}

/** Open a pasted/launched link as a draft. Returns the parsed payload. */
export async function openPromptLink(raw: string, options: { persist?: boolean } = {}): Promise<PromptLinkPayload> {
  const payload = parsePromptLink(raw);
  if (options.persist !== false) await savePendingPromptLink(raw);
  try {
    await applyPayload(payload);
  } catch (error) {
    await clearPendingPromptLink();
    throw error;
  }
  if (payload.hiddenCharacters) toast("Removed invisible characters from the link before opening it.", "info");
  toast(payload.kind === "thread" ? "Opened shared thread" : "Opened shared prompt draft", "info");
  return payload;
}

export async function copyPromptLink(input: PromptLinkInput): Promise<void> {
  try {
    const root = store.currentProject?.path ?? effectiveRoot();
    const repo = root ? await projectRepo(root) : null;
    const link = buildPromptLink({ ...input, repo: input.repo ?? repo });
    await writeClipboardText(link, "prompt link");
    toast("Prompt link copied", "success");
  } catch (error) {
    toast(`Couldn't copy the prompt link: ${String(error)}`, "error");
  }
}

export async function copyThreadLink(session: { id: string; title?: string; project_path?: string; agent_id?: string; model?: string | null }): Promise<void> {
  try {
    const root = session.project_path ?? store.currentProject?.path ?? effectiveRoot();
    const repo = root ? await projectRepo(root) : null;
    const link = buildThreadLink({ id: session.id, title: session.title, repo, provider: session.agent_id, model: session.model });
    await writeClipboardText(link, "thread link");
    toast("Thread link copied", "success");
  } catch (error) {
    toast(`Couldn't copy the thread link: ${String(error)}`, "error");
  }
}
