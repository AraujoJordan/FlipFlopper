import hljs from "highlight.js";

const FENCE_RE = /```(\w*)\n([\s\S]*?)```/g;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightCode(code: string, lang: string | undefined): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      /* fall through to escaped plain text */
    }
  }
  return escapeHtml(code);
}

function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_m, code) => `<code style="background:var(--surface-3);padding:1px 4px;border-radius:4px;">${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`);
}

function renderParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p style="margin:4px 0;">${renderInline(para).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

/** Minimal Markdown-to-HTML for LSP hover/documentation text: fenced code
 *  blocks (highlighted via highlight.js), inline code, bold, and paragraphs. */
export function renderMarkdownLite(text: string): string {
  let html = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const [full, lang, code] = match;
    html += renderParagraphs(text.slice(lastIndex, match.index));
    html += `<pre style="margin:6px 0;padding:8px;border-radius:6px;background:var(--surface-2);overflow:auto;"><code class="hljs">${highlightCode(code.replace(/\n$/, ""), lang || undefined)}</code></pre>`;
    lastIndex = match.index + full.length;
  }
  html += renderParagraphs(text.slice(lastIndex));
  return html;
}
