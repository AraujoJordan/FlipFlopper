import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import shell from "highlight.js/lib/languages/shell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import dart from "highlight.js/lib/languages/dart";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import groovy from "highlight.js/lib/languages/groovy";
import gradle from "highlight.js/lib/languages/gradle";
import powershell from "highlight.js/lib/languages/powershell";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import graphql from "highlight.js/lib/languages/graphql";
import objectivec from "highlight.js/lib/languages/objectivec";
import scala from "highlight.js/lib/languages/scala";
import plaintext from "highlight.js/lib/languages/plaintext";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("dart", dart);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("groovy", groovy);
hljs.registerLanguage("gradle", gradle);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("objectivec", objectivec);
hljs.registerLanguage("scala", scala);
hljs.registerLanguage("plaintext", plaintext);

// Common fence labels that aren't highlight.js language names.
for (const [alias, target] of Object.entries({
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", sh: "bash", zsh: "bash",
  py: "python", rs: "rust", golang: "go", kt: "kotlin", cs: "csharp", html: "xml", yml: "yaml",
  md: "markdown", rb: "ruby", toml: "ini", docker: "dockerfile", "objective-c": "objectivec", ps1: "powershell", text: "plaintext",
})) {
  hljs.registerAliases(alias, { languageName: target });
}


// Small, dependency-free Markdown → HTML for assistant messages. All input is
// HTML-escaped before any markup is added, so the output is safe to assign to
// innerHTML. Styling lives in App.css under `.md`.

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function highlightCode(code: string, lang: string | null | undefined): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      /* fall through to escaped plain text */
    }
  }
  return escapeHtml(code);
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

const fileOpenModifier = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";

function fileLink(label: string, path: string): string {
  return `<a href="#" data-file-path="${escapeHtml(path)}" title="${fileOpenModifier}-click to open in default app">${label}</a>`;
}

function linkWebUrls(text: string, links: string[]): string {
  return text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_m, before: string, url: string) => {
    links.push(`<a href="${escapeHtml(url.replace(/&amp;/g, "&"))}" data-md-link>${url}</a>`);
    return `${before}\u0001${links.length - 1}\u0001`;
  });
}

/** Link paths in already-escaped text. Generated links are held as tokens so
 * later Markdown formatting cannot change their attributes or labels. */
function linkFileReferences(text: string, links: string[]): string {
  return text.replace(FILE_REF, (match, before: string, candidate: string) => {
    const label = candidate.replace(/\.+$/, "");
    const path = filePath(label);
    if (!path) return match;
    links.push(fileLink(label, path));
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
function renderInline(text: string): string {
  const codes: string[] = [];
  let out = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const path = filePath(escapeHtml(code));
    const label = `<code>${escapeHtml(code)}</code>`;
    codes.push(path ? fileLink(label, path) : label);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links: string[] = [];
  out = escapeHtml(out)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
      const decoded = url.replace(/&amp;/g, "&");
      const href = safeHref(decoded);
      const path = href ? null : filePath(url);
      if (!href && !path) return m;
      links.push(href ? `<a href="${escapeHtml(href)}" data-md-link>${label}</a>` : fileLink(label, path!));
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
      html.push(`<blockquote>${renderBlocks(quote.join("\n"))}</blockquote>`);
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
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
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
    parts.push(
      `<div class="md-code"><div class="md-code-head"><span>${escapeHtml(lang ?? "text")}</span>` +
        `<button type="button" data-md-copy>Copy</button></div>` +
        `<pre><code class="hljs">${highlightCode(code, lang)}</code></pre></div>`,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) fence.lastIndex += 1;
  }
  parts.push(renderBlocks(text.slice(last)));
  return parts.join("");
}
