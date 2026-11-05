// MCP Apps rendering helpers: validate the declared CSP/permissions, wrap the
// self-contained HTML with a restrictive CSP, and teach it the host theme.
import type { McpAppData } from "./ipc";

export interface McpAppCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

const DOMAIN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;
const MAX_DOMAINS = 32;

function domains(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((entry): entry is string => typeof entry === "string" && entry.length <= 256 && DOMAIN.test(entry)).slice(0, MAX_DOMAINS);
  return list.length ? [...new Set(list)] : undefined;
}

export function readMcpAppCsp(value: unknown): McpAppCsp | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const csp: McpAppCsp = {};
  for (const key of ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const) {
    const list = domains(source[key]);
    if (list) csp[key] = list;
  }
  return Object.keys(csp).length ? csp : undefined;
}

const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const;
export type McpAppPermissions = Partial<Record<(typeof PERMISSION_KEYS)[number], true>>;

export function readMcpAppPermissions(value: unknown): McpAppPermissions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const permissions: McpAppPermissions = {};
  for (const key of PERMISSION_KEYS) if (source[key] && typeof source[key] === "object") permissions[key] = true;
  return Object.keys(permissions).length ? permissions : undefined;
}

export function mcpAppAllowAttribute(permissions: McpAppPermissions | undefined): string {
  const allow: string[] = [];
  if (permissions?.camera) allow.push("camera");
  if (permissions?.microphone) allow.push("microphone");
  if (permissions?.geolocation) allow.push("geolocation");
  if (permissions?.clipboardWrite) allow.push("clipboard-write");
  return allow.join("; ");
}

export function mcpAppContentSecurityPolicy(csp: McpAppCsp | undefined): string {
  const resources = csp?.resourceDomains?.join(" ") ?? "";
  const list = (values: string[] | undefined, fallback: string) => values?.length ? values.join(" ") : fallback;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`.trim(),
    `style-src 'unsafe-inline' ${resources}`.trim(),
    `img-src data: blob: ${resources}`.trim(),
    `font-src data: ${resources}`.trim(),
    `media-src data: blob: ${resources}`.trim(),
    `connect-src ${list(csp?.connectDomains, "'none'")}`,
    `frame-src ${list(csp?.frameDomains, "'none'")}`,
    "object-src 'none'",
    `base-uri ${list(csp?.baseUriDomains, "'none'")}`,
    "form-action 'none'",
  ].join("; ");
}

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Insert a CSP and the theme bridge immediately after the doctype. */
export function injectMcpAppDocument(html: string, csp: McpAppCsp | undefined): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(mcpAppContentSecurityPolicy(csp))}">`;
  const theme = `<script>(function(){
    function apply(theme){ if(theme==="light"||theme==="dark"){ document.documentElement.style.colorScheme=theme; document.documentElement.dataset.theme=theme; } }
    window.addEventListener("message", function(event){
      if(event.source!==window.parent) return;
      var data=event.data; if(!data||data.jsonrpc!=="2.0") return;
      if(data.method==="ui/notifications/host-context-changed") apply(data.params&&data.params.theme);
      else if(data.id!==undefined && data.result&&data.result.hostContext) apply(data.result.hostContext.theme);
    });
  })();</script>`;
  const prefix = /^\uFEFF?\s*<!doctype[^>]*>/i.exec(html);
  const head = policy + theme;
  if (prefix) return `${prefix[0]}${head}${html.slice(prefix[0].length)}`;
  return `<!doctype html>${head}${html}`;
}

export function mcpAppFileName(app: Pick<McpAppData, "tool">): string {
  const base = app.tool.replace(/[^\w.-]+/g, "-").slice(0, 80) || "app";
  return `${base}.html`;
}

export const MCP_APP_MIN_HEIGHT = 80;
export const MCP_APP_DEFAULT_HEIGHT = 320;
export const MCP_APP_MAX_HEIGHT = 2000;

export function clampMcpAppHeight(value: number): number {
  if (!Number.isFinite(value)) return MCP_APP_DEFAULT_HEIGHT;
  return Math.round(Math.min(MCP_APP_MAX_HEIGHT, Math.max(MCP_APP_MIN_HEIGHT, value)));
}

export interface McpAppHostContext {
  theme: "light" | "dark";
  displayMode: "inline" | "fullscreen";
  availableDisplayModes: ("inline" | "fullscreen")[];
  containerDimensions: { width: number; maxHeight: number };
  platform: "desktop";
  locale: string;
  styles: { variables: Record<string, string> };
}

export function mcpAppHostContext(theme: "light" | "dark", width: number, displayMode: "inline" | "fullscreen"): McpAppHostContext {
  const computed = typeof getComputedStyle !== "undefined" ? getComputedStyle(document.documentElement) : undefined;
  const read = (name: string) => computed?.getPropertyValue(name).trim() || "";
  return {
    theme,
    displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { width: Math.max(240, Math.round(width)), maxHeight: MCP_APP_MAX_HEIGHT },
    platform: "desktop",
    locale: navigator.language || "en",
    styles: {
      variables: {
        "--background": read("--surface-1"),
        "--foreground": read("--fg-default"),
        "--card": read("--surface-2"),
        "--border": read("--border-default"),
        "--accent": read("--accent"),
        "--accent-foreground": read("--fg-on-accent"),
        "--muted": read("--fg-muted"),
        "--muted-foreground": read("--fg-subtle"),
      },
    },
  };
}
