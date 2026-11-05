/** Syntax highlighting on demand.
 *
 * highlight.js core stays in the main bundle, but each language grammar is a
 * separate chunk imported the first time a message (or diff) uses it. Rendering
 * falls back to escaped plain text for one frame, then re-renders when the
 * grammar arrives (components read `highlightVersion`). */
import hljs from "highlight.js/lib/core";
import { createSignal } from "solid-js";

const loaders: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  json: () => import("highlight.js/lib/languages/json"),
  bash: () => import("highlight.js/lib/languages/bash"),
  shell: () => import("highlight.js/lib/languages/shell"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  go: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  sql: () => import("highlight.js/lib/languages/sql"),
  diff: () => import("highlight.js/lib/languages/diff"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  php: () => import("highlight.js/lib/languages/php"),
  dart: () => import("highlight.js/lib/languages/dart"),
  ini: () => import("highlight.js/lib/languages/ini"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  groovy: () => import("highlight.js/lib/languages/groovy"),
  gradle: () => import("highlight.js/lib/languages/gradle"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  scala: () => import("highlight.js/lib/languages/scala"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
};

/** Common fence labels that aren't highlight.js language names. */
const aliases: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", sh: "bash", zsh: "bash",
  py: "python", rs: "rust", golang: "go", kt: "kotlin", cs: "csharp", html: "xml", yml: "yaml",
  md: "markdown", rb: "ruby", toml: "ini", docker: "dockerfile", "objective-c": "objectivec", ps1: "powershell", text: "plaintext",
};

const loading = new Set<string>();
const registered = new Set<string>();
// One version signal per grammar: a loaded grammar only re-renders content that
// actually uses it, instead of every message/diff row in the app.
const versions = new Map<string, { read: () => number; write: (value: number) => void }>();
function versionFor(canonical: string) {
  let entry = versions.get(canonical);
  if (!entry) {
    const [read, write] = createSignal(0);
    entry = { read, write };
    versions.set(canonical, entry);
  }
  return entry;
}
/** Reactive read: call inside a memo that renders this language. */
export function languageVersion(language: string | null | undefined): number {
  const canonical = canonicalLanguage(language);
  return canonical ? versionFor(canonical).read() : 0;
}

export function canonicalLanguage(language: string | null | undefined): string | null {
  if (!language) return null;
  const clean = language.trim().toLowerCase();
  const canonical = aliases[clean] ?? clean;
  return canonical in loaders ? canonical : null;
}

/** Start loading a grammar; no-op when it is already present or unknown. */
export function preloadLanguage(language: string | null | undefined): void {
  const canonical = canonicalLanguage(language);
  if (!canonical || registered.has(canonical) || loading.has(canonical)) return;
  loading.add(canonical);
  void loaders[canonical]().then((module) => {
    hljs.registerLanguage(canonical, module.default as never);
    for (const [alias, target] of Object.entries(aliases)) {
      if (target === canonical) hljs.registerAliases(alias, { languageName: canonical });
    }
    registered.add(canonical);
    const entry = versionFor(canonical);
    entry.write(entry.read() + 1);
  }).catch(() => {
    /* an unavailable grammar simply stays plain text */
  }).finally(() => loading.delete(canonical));
}

/** Canonical fence languages mentioned in Markdown, deduped. */
export function codeLanguages(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(/^\s*(?:```|~~~)\s*([\w+#.-]+)/gm)) {
    const canonical = canonicalLanguage(match[1]);
    if (canonical) found.add(canonical);
  }
  return [...found];
}

/** Start loading every grammar a Markdown block uses. */
export function preloadCodeLanguages(markdown: string): void {
  for (const language of codeLanguages(markdown)) preloadLanguage(language);
}

/** Highlighted HTML, or null while the grammar is missing (caller escapes). */
export function highlight(code: string, language: string | null | undefined): string | null {
  const canonical = canonicalLanguage(language);
  if (!canonical) return null;
  if (!registered.has(canonical)) { preloadLanguage(canonical); return null; }
  try {
    return hljs.highlight(code, { language: canonical }).value;
  } catch {
    return null;
  }
}
