import { highlight } from "./highlight";
import { INLINE_MATH, renderMath } from "./math";

// Small, dependency-free Markdown → HTML for assistant messages. All input is
// HTML-escaped before any markup is added, so the output is safe to assign to
// innerHTML. Styling lives in App.css under `.md`.

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function highlightCode(code: string, lang: string | null | undefined): string {
  return highlight(code, lang) ?? escapeHtml(code);
}

/** Split highlighted HTML into lines, closing spans that cross a line break and re-opening them on the next. */
export function splitHighlighted(html: string, endsWithNewline = false): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  for (const token of html.match(/<span[^>]*>|<\/span>|\n|[^<\n]+/g) ?? []) {
    if (token === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else {
      if (token.startsWith("<span")) open.push(token);
      else if (token === "</span>") open.pop();
      current += token;
    }
  }
  lines.push(current + "</span>".repeat(open.length));
  // A trailing newline does not start another line.
  if (endsWithNewline && lines.length > 1 && lines[lines.length - 1].replace(/<[^>]*>/g, "") === "") lines.pop();
  return lines;
}

/** Syntax-highlight `code` and return one HTML string per line. */
export function highlightLines(code: string, lang: string | null | undefined): string[] {
  return splitHighlighted(highlightCode(code, lang), code.endsWith("\n"));
}

function safeHref(url: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

// Only paths with a directory component are linked. Bare filenames are too
// easy to mistake for ordinary prose; prefix one with ./ to make it explicit.
const FILE_START = /^(?:@?(?:\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+[\\/]))/;
const FILE_REF = /(^|[\s([{"'`])((?:@?(?:\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9_.-]+[\\/]))[^\s<>"'`()\[\]{}]+?)(?=$|[\s)\]}> ,"'`!?]|(?<!&amp);)/g;

function filePath(value: string): string | null {
  const path = value.replace(/&amp;/g, "&").replace(/\.$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/^@/, "");
  return FILE_START.test(path) && !/[\\/]$/.test(path) && !path.includes("://") ? path : null;
}

/** `:line` of a `path:line[:col]` reference, if any. */
function fileLine(value: string): number | null {
  const match = /:(\d+)(?::\d+)?\.?$/.exec(value.replace(/&amp;/g, "&"));
  const line = match ? Number(match[1]) : 0;
  return line > 0 ? line : null;
}

const fileOpenModifier = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";

function fileLink(label: string, path: string, line: number | null = null): string {
  const at = line ? ` data-file-line="${line}"` : "";
  return `<a href="#" data-file-path="${escapeHtml(path)}"${at} title="Click to preview · ${fileOpenModifier}-click to open in your editor">${label}</a>`;
}

function linkWebUrls(text: string, links: string[]): string {
  return text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_m, before: string, url: string) => {
    links.push(`<a href="${escapeHtml(url.replace(/&amp;/g, "&"))}" data-md-link>${url}</a>`);
    return `${before}\u0001${links.length - 1}\u0001`;
  });
}

/** File references (`src/a.ts:42`, `./x`, `C:\\dir\\f`) in plain text, with their `:line`; used for terminal links. */
export function findFileReferences(text: string): { start: number; end: number; path: string; line: number | null }[] {
  const found: { start: number; end: number; path: string; line: number | null }[] = [];
  const pattern = new RegExp(FILE_REF.source, "g");
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const candidate = match[2].replace(/\.+$/, "");
    const path = filePath(candidate);
    if (!path) continue;
    const start = match.index + match[1].length;
    found.push({ start, end: start + candidate.length, path, line: fileLine(candidate) });
  }
  return found;
}

/** Link paths in already-escaped text. Generated links are held as tokens so
 * later Markdown formatting cannot change their attributes or labels. */
function linkFileReferences(text: string, links: string[]): string {
  return text.replace(FILE_REF, (match, before: string, candidate: string) => {
    const label = candidate.replace(/\.+$/, "");
    const path = filePath(label);
    if (!path) return match;
    links.push(fileLink(label, path, fileLine(label)));
    return `${before}\u0001${links.length - 1}\u0001${candidate.slice(label.length)}`;
  });
}

/** Preserve plain-text whitespace while linking file references and web URLs. */
export function renderPlainTextWithFileRefs(text: string): string {
  const links: string[] = [];
  return linkFileReferences(linkWebUrls(escapeHtml(text), links), links)
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)]);
}

/** Inline spans. Code spans are lifted out first so their contents are never
 *  interpreted as emphasis or links. */
let mathEnabled = true;
/** Turn math rendering on or off (Settings → Appearance → Render math). */
export function setMathRendering(enabled: boolean) { mathEnabled = enabled; }

function renderInline(text: string): string {
  const codes: string[] = [];
  let out = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const path = filePath(escapeHtml(code));
    const label = `<code>${escapeHtml(code)}</code>`;
    codes.push(path ? fileLink(label, path, fileLine(escapeHtml(code))) : label);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Math is lifted out before escaping and emphasis, so `_`, `*` and `<` inside formulas survive.
  if (mathEnabled) {
    out = out.replace(INLINE_MATH, (_m, parens: string | undefined, dollars: string | undefined) => {
      codes.push(renderMath(parens ?? dollars ?? "", false));
      return `\u0000${codes.length - 1}\u0000`;
    });
  }
  const links: string[] = [];
  out = escapeHtml(out)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
      const decoded = url.replace(/&amp;/g, "&");
      const href = safeHref(decoded);
      const path = href ? null : filePath(url);
      if (!href && !path) return m;
      links.push(href ? `<a href="${escapeHtml(href)}" data-md-link>${label}</a>` : fileLink(label, path!, fileLine(url)));
      return `\u0001${links.length - 1}\u0001`;
    });
  out = linkWebUrls(out, links);
  out = linkFileReferences(out, links)
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return out
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

function renderBlocks(src: string): string {
  const lines = src.split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Display math: `$$ … $$` or `\[ … \]`, on one line or spanning several.
    const display = mathEnabled ? /^\s*(\$\$|\\\[)(.*)$/.exec(line) : null;
    if (display) {
      const close = display[1] === "$$" ? "$$" : "\\]";
      let body = display[2];
      let j = i;
      while (!body.includes(close) && j + 1 < lines.length && j - i < 60) { j += 1; body += `\n${lines[j]}`; }
      const end = body.indexOf(close);
      if (end >= 0 && body.slice(end + close.length).trim() === "") {
        html.push(`<div class="md-math-block">${renderMath(body.slice(0, end), true)}</div>`);
        i = j + 1;
        continue;
      }
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push("<hr/>");
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(quote[0] ?? "");
      if (alert) {
        const kind = alert[1].toLowerCase();
        html.push(`<div class="md-alert md-alert-${kind}" role="note"><div class="md-alert-title">${kind[0].toUpperCase()}${kind.slice(1)}</div>${renderBlocks(quote.slice(1).join("\n"))}</div>`);
      } else {
        html.push(`<blockquote>${renderBlocks(quote.join("\n"))}</blockquote>`);
      }
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      html.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` +
          `<button type="button" class="md-table-copy" data-md-copy-table>Copy table</button></div>`,
      );
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const tag = ordered ? "ol" : "ul";
      const baseIndent = item[1].length;
      const items: string[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || m[1].length < baseIndent) break;
        if (m[1].length > baseIndent) {
          // Nested list: gather the deeper block and attach to the previous item.
          const nested: string[] = [];
          while (i < lines.length) {
            const n = LIST_ITEM.exec(lines[i]);
            if (!n || n[1].length <= baseIndent) break;
            nested.push(lines[i]);
            i += 1;
          }
          if (items.length) items[items.length - 1] += renderBlocks(nested.join("\n"));
          continue;
        }
        let body = renderInline(m[3]);
        i += 1;
        // Continuation lines (indented, not a new item) belong to this item.
        while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && /^\s+/.test(lines[i])) {
          body += "<br/>" + renderInline(lines[i].trim());
          i += 1;
        }
        items.push(body);
      }
      html.push(`<${tag}>${items.map((b) => `<li>${b}</li>`).join("")}</${tag}>`);
      continue;
    }

    // Paragraph: consume until a blank line or a block starter.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    html.push(`<p>${renderInline(para.join("\n")).replace(/\n/g, "<br/>")}</p>`);
  }
  return html.join("");
}

/** Markdown → HTML. Fenced code blocks are highlighted; an unterminated fence
 *  (a message still streaming) renders as code too. */
/** A fence carrying a whole page (not a snippet) can render as an inline visual reply. */
function looksLikePage(source: string): boolean {
  return /<!doctype\s+html|<\/html\s*>/i.test(source);
}

/** Read the page source carried on a visual-reply placeholder; JSON keeps quotes and markup safe in the attribute. */
export function visualSourceOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    return null;
  }
}

/** Read a Mermaid fence carried on a diagram placeholder. */
export function mermaidSourceOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    return null;
  }
}

/** Policy for previews of agent-written HTML: scripts and inline styles run, nothing loads from the network. */
export const PREVIEW_CSP = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

/** A standalone document for the sandboxed preview frame: our CSP and theme come first, the agent's HTML after. */
export function buildPreviewDocument(source: string, scheme: "light" | "dark"): string {
  const dark = scheme === "dark";
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="color-scheme" content="${scheme}">` +
    `<style>:root{color-scheme:${scheme}}html{background:${dark ? "#16181d" : "#ffffff"};color:${dark ? "#e6e8ee" : "#1c1e24"};font:14px/1.5 system-ui,sans-serif}body{margin:12px}</style>`;
  if (/<head[\s>]/i.test(source)) return source.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  if (/<html[\s>]/i.test(source)) return source.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${source}</body></html>`;
}

export function renderMarkdownLite(text: string): string {
  const parts: string[] = [];
  // `(?![\s\S])` is end-of-input: with the `m` flag a bare `$` would match at every line end.
  const fence = /^[ \t]*```([\w+-]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|(?![\s\S]))|(?![\s\S]))/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    parts.push(renderBlocks(text.slice(last, m.index)));
    const lang = m[1] || undefined;
    const code = m[2];
    if (mathEnabled && lang && /^(math|latex|tex)$/i.test(lang)) {
      parts.push(`<div class="md-math-block">${renderMath(code, true)}</div>`);
      last = m.index + m[0].length;
      if (m[0].length === 0) fence.lastIndex += 1;
      continue;
    }
    const preview = lang && /^html?$/i.test(lang) ? `<button type="button" data-md-html-preview>Preview</button>` : "";
    const runnable = lang && /^(bash|sh|shell|zsh|fish|console|terminal|powershell|ps1|cmd|bat)$/i.test(lang)
      ? `<button type="button" data-md-run>Run</button>`
      : "";
    if (lang && /^mermaid$/i.test(lang)) {
      parts.push(
        `<div class="md-mermaid-card" data-md-mermaid="${escapeHtml(JSON.stringify(code))}">` +
          `<div class="md-mermaid-body" aria-busy="true"></div>` +
          `<div class="md-mermaid-actions"><span>mermaid</span><button type="button" data-md-mermaid-copy>Copy source</button></div>` +
        `</div>`,
      );
      last = m.index + m[0].length;
      if (m[0].length === 0) fence.lastIndex += 1;
      continue;
    }
    // A full page answers visually first, with its source kept below for reference.
    const visual = lang && /^html?$/i.test(lang) && looksLikePage(code)
      ? `<div class="md-visual" data-md-visual="${escapeHtml(JSON.stringify(code))}"></div>`
      : "";
    parts.push(
      visual +
      `<div class="md-code"><div class="md-code-head"><span>${escapeHtml(lang ?? "text")}</span>` +
        `${preview}${runnable}<button type="button" data-md-copy>Copy</button></div>` +
        `<pre><code class="hljs">${highlightCode(code, lang)}</code></pre></div>`,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) fence.lastIndex += 1;
  }
  parts.push(renderBlocks(text.slice(last)));
  return parts.join("");
}
