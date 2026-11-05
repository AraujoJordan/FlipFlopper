// Markdown-aware rendering for the rich composer. The output keeps every
// character of the source (including the Markdown markers) so the editor's
// textContent round-trips exactly; only spans and classes are added.

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const mark = (text: string): string => `<span class="md-mark">${escape(text)}</span>`;

/** A bare link pasted or typed into the composer. Markdown emphasis inside a
 *  URL path (`flip_flopper_app`) must stay literal, and its slashes must never
 *  be mistaken for the slash command at the start of a line. */
const BARE_URL = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`*]+/i;

/** Keep prose punctuation outside the URL span: `See https://x.dev.` ends at
 *  the host, not at the sentence's full stop. Bracket depth is counted once so
 *  a very long pasted URL stays linear. */
function trimBareUrl(url: string): string {
  let end = url.length;
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = 0; i < end; i += 1) {
    const char = url[i];
    if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
  }
  while (end > 0) {
    const last = url[end - 1];
    if (/[.,;:!?]/.test(last)) end -= 1;
    else if (last === ")" && parens < 0) { parens += 1; end -= 1; }
    else if (last === "]" && brackets < 0) { brackets += 1; end -= 1; }
    else if (last === "}" && braces < 0) { braces += 1; end -= 1; }
    else break;
  }
  return url.slice(0, end);
}

/** Find a closing delimiter that is not escaped, starting at `from`. */
function closing(text: string, delimiter: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const found = text.indexOf(delimiter, at);
    if (found < 0) return -1;
    let slashes = 0;
    for (let i = found - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
    if (slashes % 2 === 0) return found;
    at = found + delimiter.length;
  }
  return -1;
}

function inline(text: string, lineStart = false): string {
  let html = "";
  let i = 0;
  const mention = /^@#?[A-Za-z0-9_./\\:-]+/;
  const command = /^\/[A-Za-z0-9_:-]+/;
  // A slash command only counts at the start of the line (leading indentation is
  // allowed), matching the composer's token parser. URL path segments and
  // absolute paths are not commands.
  const commandAt = lineStart ? (/^\s*/.exec(text)?.[0].length ?? 0) : -1;
  while (i < text.length) {
    const rest = text.slice(i);
    if (text[i] === "\\" && i + 1 < text.length) {
      html += escape(text.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (text[i] === "`") {
      const run = /^`+/.exec(rest)?.[0] ?? "`";
      const end = closing(text, run, i + run.length);
      if (end > i + run.length) {
        html += mark(run) + `<code class="md-rich-code">${escape(text.slice(i + run.length, end))}</code>` + mark(run);
        i = end + run.length;
        continue;
      }
    }

    const url = BARE_URL.exec(rest)?.[0];
    if (url) {
      const trimmed = trimBareUrl(url);
      if (trimmed.length > 0) {
        html += `<span class="md-rich-url">${escape(trimmed)}</span>`;
        i += trimmed.length;
        continue;
      }
    }

    let styled = false;
    for (const [delimiter, tag, className] of [
      ["**", "strong", "md-rich-strong"],
      ["__", "strong", "md-rich-strong"],
      ["~~", "del", "md-rich-del"],
      ["*", "em", "md-rich-em"],
      ["_", "em", "md-rich-em"],
    ] as const) {
      if (rest.startsWith(delimiter)) {
        const end = closing(text, delimiter, i + delimiter.length);
        if (end > i + delimiter.length) {
          html += mark(delimiter) + `<${tag} class="${className}">${inline(text.slice(i + delimiter.length, end))}</${tag}>` + mark(delimiter);
          i = end + delimiter.length;
          styled = true;
          break;
        }
      }
    }
    if (styled) continue;

    if (text[i] === "[") {
      const link = /^\[([^\]]*)\]\(([^)]*)\)/.exec(rest);
      if (link) {
        html += mark("[") + `<span class="md-rich-link">${inline(link[1])}</span>` + mark("](") + `<span class="md-rich-url">${escape(link[2])}</span>` + mark(")");
        i += link[0].length;
        continue;
      }
    }

    if (text[i] === "@" && (i === 0 || /[\s([{]/.test(text[i - 1]))) {
      const context = /^@ctx:(pr|terminal|review|preview):[A-Za-z0-9-]+/.exec(rest);
      if (context) {
        html += `<span class="md-rich-context" data-kind="${context[1]}">${escape(context[0])}</span>`;
        i += context[0].length;
        continue;
      }
      const token = mention.exec(rest)?.[0];
      if (token) {
        html += `<span class="md-rich-mention">${escape(token)}</span>`;
        i += token.length;
        continue;
      }
    }

    if (i === commandAt && text[i] === "/") {
      const token = command.exec(rest)?.[0];
      // `/Users/me` and `/api/v1` are absolute paths, not `/Users` commands.
      if (token && text[i + token.length] !== "/") {
        html += `<span class="md-rich-command">${escape(token)}</span>`;
        i += token.length;
        continue;
      }
    }

    html += escape(text[i]);
    i += 1;
  }
  return html;
}

function lineHtml(line: string): string {
  const heading = /^(#{1,6})(\s+)(.*)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    return mark(heading[1] + heading[2]) + `<span class="md-rich-h${level}">${inline(heading[3])}</span>`;
  }
  const quote = /^(\s*>\s?)(.*)$/.exec(line);
  if (quote) return mark(quote[1]) + `<span class="md-rich-quote">${inline(quote[2])}</span>`;
  const task = /^(\s*[-*+]\s+)(\[[ xX]\])(\s+)(.*)$/.exec(line);
  if (task) {
    const checked = task[2].toLowerCase() === "[x]";
    return mark(task[1] + task[2] + task[3]) + `<span class="md-rich-task" data-checked="${checked}">${inline(task[4])}</span>`;
  }
  const list = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/.exec(line);
  if (list) return mark(list[1] + list[2] + list[3]) + `<span class="md-rich-list">${inline(list[4])}</span>`;
  return inline(line, true);
}

/** Render Markdown-ish source for a contenteditable composer. Safe to assign to innerHTML. */
export function renderRichMarkdown(text: string): string {
  const lines = text.split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const fence = /^(\s*)```(.*)$/.exec(lines[i]);
    if (fence) {
      let end = i + 1;
      while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) end += 1;
      const body = lines.slice(i + 1, end).join("\n");
      html += mark(lines[i]) + "\n";
      html += `<span class="md-rich-codeblock">${escape(body)}</span>`;
      if (end < lines.length) html += "\n" + mark(lines[end]);
      i = end + 1;
      if (i < lines.length) html += "\n";
      continue;
    }
    html += lineHtml(lines[i]);
    i += 1;
    if (i < lines.length) html += "\n";
  }
  return html;
}

/** Plain text from rendered HTML, used by tests to prove round-tripping. */
export function richTextSource(html: string): string {
  return html
    .replace(/<span class="md-mark">([\s\S]*?)<\/span>/g, (_all, inner) => inner)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
