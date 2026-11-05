// Inline composer context chips. Each chip has a short token in the editor
// (`@ctx:<kind>:<id>`) and a detail block that is prepended to the outgoing
// prompt. Chips are scoped to the draft (a session id or "new") and persisted
// with that draft.
import { createSignal } from "solid-js";
import { chat } from "./chat";

export type ComposerContextKind = "pr" | "terminal" | "review" | "preview" | "snapshot";

export interface ComposerContext {
  id: string;
  kind: ComposerContextKind;
  label: string;
  detail: string;
  draftKey: string;
  created_at: number;
}

const [contexts, setContexts] = createSignal<ComposerContext[]>([]);
export const composerContexts = contexts;

export const currentComposerDraftKey = () => chat.activeId ?? "new";

export const composerContextsForDraft = (key = currentComposerDraftKey()) =>
  contexts().filter((context) => context.draftKey === key);

export const contextToken = (context: Pick<ComposerContext, "kind" | "id">) => `@ctx:${context.kind}:${context.id}`;

export function addComposerContext(input: { kind: ComposerContextKind; label: string; detail: string; draftKey?: string }): ComposerContext {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const context: ComposerContext = {
    id: random.replace(/-/g, "").slice(0, 10),
    kind: input.kind,
    label: input.label.trim().slice(0, 160) || input.kind,
    detail: input.detail.trim().slice(0, 8000),
    draftKey: input.draftKey ?? currentComposerDraftKey(),
    created_at: Date.now(),
  };
  setContexts((list) => [...list, context]);
  return context;
}

export function removeComposerContext(id: string) {
  setContexts((list) => list.filter((context) => context.id !== id));
}

export function clearComposerContexts(draftKey = currentComposerDraftKey()) {
  setContexts((list) => list.filter((context) => context.draftKey !== draftKey));
}

/** Replace one draft's contexts, used when restoring a persisted draft. */
export function restoreComposerContexts(draftKey: string, list: readonly ComposerContext[]) {
  const valid = list.filter((context) => context && typeof context.id === "string" && context.draftKey === draftKey).slice(-40);
  setContexts((current) => [...current.filter((context) => context.draftKey !== draftKey), ...valid]);
}

const TITLE: Record<ComposerContextKind, string> = {
  pr: "Pull request",
  terminal: "Terminal excerpt",
  review: "Review comments",
  preview: "Preview annotation",
  snapshot: "SnapShot",
};

export function contextBlock(context: ComposerContext): string {
  return `### ${TITLE[context.kind]}\n${context.detail}`;
}

/** Split the editor text into the clean user text and the outgoing prompt with
 *  the referenced context blocks prepended. Tokens whose chip was removed are
 *  stripped as well so old drafts cannot leak internal tokens to the agent. */
export function resolveComposerContexts(text: string, list: readonly ComposerContext[]): { clean: string; prompt: string } {
  const present = list.filter((context) => text.includes(contextToken(context)));
  let clean = text;
  for (const context of present) clean = clean.split(contextToken(context)).join("");
  clean = clean
    .replace(/@ctx:[a-z]+:[A-Za-z0-9-]+/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const prefix = present.length ? ["## Referenced context", ...present.map(contextBlock)].join("\n\n") : "";
  return { clean, prompt: [prefix, clean].filter(Boolean).join("\n\n") };
}
