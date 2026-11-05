/** Local development servers mentioned in terminal output, surfaced by the thread details card.
 *  T3 reads provider/terminal output for the same purpose; FlipFlopper scans the xterm buffer it
 *  already owns, so nothing extra is spawned or read from disk. */
import { getCachedTerminal } from "./terminalCache";

export interface LocalServer {
  url: string;
  port: number;
}

const HOSTS = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])`;
/** Full URLs, plus the bare `host:port` form dev servers commonly print without a scheme. */
const PATTERNS = [
  new RegExp(String.raw`https?://${HOSTS}(?::\d{2,5})?(?:/[^\s'"<>()\]]*)?`, "gi"),
  new RegExp(String.raw`(?<![\w.])${HOSTS}:\d{2,5}(?:/[^\s'"<>()\]]*)?`, "gi"),
];
const TRAILING = /[),.;:!?]+$/;

/** Localhost URLs in a set of terminal lines, normalized to localhost, deduped, first-seen order. */
export function findLocalServers(lines: readonly string[], limit = 8): LocalServer[] {
  const seen = new Map<string, LocalServer>();
  for (const line of lines) {
    for (const [index, pattern] of PATTERNS.entries()) {
      for (const match of line.matchAll(pattern)) {
        const raw = match[0].replace(TRAILING, "");
        let parsed: URL;
        try {
          parsed = new URL((index === 1 ? "http://" : "") + raw.replace("0.0.0.0", "localhost").replace("[::1]", "localhost"));
        } catch {
          continue;
        }
        const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
        const path = parsed.pathname === "/" ? "" : parsed.pathname;
        const url = `${parsed.protocol}//localhost${parsed.port ? `:${parsed.port}` : ""}${path}`;
        if (!seen.has(url)) seen.set(url, { url, port });
        if (seen.size >= limit) return [...seen.values()];
      }
    }
  }
  return [...seen.values()];
}

/** Scan the newest `window` lines of a live terminal (empty when it is not mounted). */
export function terminalLocalServers(terminalId: string | null | undefined, window = 400): LocalServer[] {
  if (!terminalId) return [];
  const cached = getCachedTerminal(terminalId);
  if (!cached) return [];
  const buffer = cached.terminal.buffer.active;
  const lines: string[] = [];
  for (let index = Math.max(0, buffer.length - window); index < buffer.length; index += 1) {
    const text = buffer.getLine(index)?.translateToString(true);
    if (text) lines.push(text);
  }
  return findLocalServers(lines);
}
