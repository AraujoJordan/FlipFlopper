import { Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { mcpCallTool, type McpAppData } from "../../lib/ipc";
import type { ToolBlock } from "../../lib/chat";
import {
  MCP_APP_DEFAULT_HEIGHT, clampMcpAppHeight, injectMcpAppDocument, mcpAppAllowAttribute,
  mcpAppHostContext, readMcpAppCsp, readMcpAppPermissions, type McpAppHostContext,
} from "../../lib/mcpApp";
import { layout } from "../../lib/layout";
import { effectiveRoot, setPendingPromptSeed, store } from "../../lib/store";
import { runAction } from "../../lib/shortcuts";
import { confirmDialog } from "../ui";
import { Icon } from "../shell/Icon";

const currentTheme = (): "light" | "dark" =>
  layout.theme === "light" ? "light"
    : layout.theme === "dark" ? "dark"
      : typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function textFromContext(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? (block as { text?: unknown }).text : undefined)
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();
}

/** Sandboxed MCP Apps surface. The app gets a strict CSP and opaque origin; server
 *  tools, messages and links require an explicit host confirmation. */
const McpAppCard: Component<{ app: McpAppData; block: ToolBlock }> = (props) => {
  const [height, setHeight] = createSignal(MCP_APP_DEFAULT_HEIGHT);
  const [fullscreen, setFullscreen] = createSignal(false);
  let frame: HTMLIFrameElement | undefined;
  let modelContext = "";
  let initialized = false;

  const csp = () => readMcpAppCsp(props.app.csp);
  const permissions = () => readMcpAppPermissions(props.app.permissions);
  const documentHtml = () => injectMcpAppDocument(props.app.html, csp());
  const hostContext = (): McpAppHostContext =>
    mcpAppHostContext(currentTheme(), frame?.clientWidth || 480, fullscreen() ? "fullscreen" : "inline");

  const post = (message: unknown) => frame?.contentWindow?.postMessage(message, "*");
  const respond = (id: unknown, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, message: string) => post({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });

  function sendToolState() {
    notify("ui/notifications/tool-input", { arguments: objectInput(props.block.input) });
    notify("ui/notifications/tool-result", {
      content: [{ type: "text", text: props.block.output ?? "" }],
      ...(props.app.structured_content != null ? { structuredContent: props.app.structured_content } : {}),
      ...(props.block.status === "error" ? { isError: true } : {}),
    });
  }

  function sendContext() {
    if (!initialized) return;
    notify("ui/notifications/host-context-changed", hostContext());
  }

  async function handleRequest(id: unknown, method: string, params: Record<string, unknown>) {
    if (method === "ping") { respond(id, {}); return; }
    if (method === "ui/initialize") {
      initialized = true;
      respond(id, {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "FlipFlopper", version: "0.24.0" },
        hostCapabilities: {
          openLinks: {}, serverTools: {}, serverResources: {}, logging: {},
          message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} },
          sandbox: {
            ...(csp() ? { csp: csp() } : {}),
            ...(permissions() ? { permissions: permissions() } : {}),
          },
        },
        hostContext: hostContext(),
      });
      return;
    }
    if (method === "ui/notifications/initialized") {
      initialized = true;
      sendToolState();
      sendContext();
      return;
    }
    if (method === "ui/notifications/size-changed") {
      if (typeof params.height === "number") setHeight(clampMcpAppHeight(params.height));
      return;
    }
    if (method === "ui/request-display-mode") {
      const mode = params.mode === "fullscreen" ? "fullscreen" : "inline";
      setFullscreen(mode === "fullscreen");
      respond(id, { mode });
      queueMicrotask(sendContext);
      return;
    }
    if (method === "ui/update-model-context") {
      const text = textFromContext(params.content);
      if (text) modelContext = text;
      respond(id, {});
      return;
    }
    if (method === "ui/message") {
      const text = textFromContext(params.content);
      if (!text) { fail(id, "Only text messages are supported."); return; }
      const allowed = await confirmDialog(`${props.app.title} wants to add a message to this conversation:\n\n${text}\n\nAllow it?`, { confirmLabel: "Allow message" });
      if (!allowed) { fail(id, "The message was not approved."); return; }
      setPendingPromptSeed({ text: modelContext ? `${modelContext}\n\n${text}` : text });
      runAction("focus-prompt");
      respond(id, {});
      return;
    }
    if (method === "ui/open-link") {
      const url = params.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) { fail(id, "Only http(s) links can be opened."); return; }
      const allowed = await confirmDialog(`${props.app.title} wants to open:\n${url}`, { confirmLabel: "Open link" });
      if (!allowed) { fail(id, "The link was not approved."); return; }
      try {
        await openUrl(url);
        respond(id, {});
      } catch (error) {
        fail(id, String(error));
      }
      return;
    }
    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) { fail(id, "The app did not name a tool."); return; }
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      const project = store.currentProject?.path ?? effectiveRoot();
      if (!project) { fail(id, "Open a project before an MCP app can call a server tool."); return; }
      const allowed = await confirmDialog(`${props.app.title} wants to call “${name}” on the ${props.app.server} MCP server.\n\nThis starts a short-lived, isolated stdio session and may read or change data outside this conversation. Allow this call?`, { confirmLabel: "Allow once" });
      if (!allowed) { fail(id, "The tool call was not approved."); return; }
      try {
        const result = await mcpCallTool(project, props.app.server, name, args);
        respond(id, result);
      } catch (error) {
        fail(id, String(error));
      }
      return;
    }
    if (method === "resources/read") {
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (uri === props.app.resource_uri) {
        respond(id, { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: props.app.html }] });
      } else {
        fail(id, "This app can only read its own bundled resource.");
      }
      return;
    }
    if (method === "ui/download-file") {
      fail(id, "Downloads from MCP apps are not available in this build.");
      return;
    }
    fail(id, `Unsupported MCP app request: ${method}`);
  }

  function onMessage(event: MessageEvent) {
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.jsonrpc !== "2.0" || typeof data.method !== "string") return;
    if (typeof data.id !== "undefined") {
      void handleRequest(data.id, data.method, data.params && typeof data.params === "object" ? data.params : {});
    } else if (data.method === "ui/notifications/initialized") {
      void handleRequest(undefined, data.method, {});
    } else if (data.method === "ui/notifications/size-changed") {
      void handleRequest(undefined, data.method, data.params && typeof data.params === "object" ? data.params : {});
    } else if (data.method === "ui/notifications/request-teardown") {
      // The frame remains visible until the thread changes; no local state to save.
    }
  }

  onMount(() => {
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });

  createEffect(() => {
    // Re-send host context when the app's theme or viewport changes.
    void currentTheme();
    void fullscreen();
    void height();
    sendContext();
  });

  createEffect(() => {
    if (!fullscreen()) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setFullscreen(false); } };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  return (
    <div class="mcp-app-card" classList={{ "mcp-app-fullscreen": fullscreen(), "mcp-app-border": props.app.prefers_border }}>
      <header class="mcp-app-head">
        <span class="mcp-app-badge"><Icon name="layers" size={12} /> MCP app</span>
        <strong class="mcp-app-title" title={props.app.resource_uri}>{props.app.title}</strong>
        <span class="mcp-app-source">{props.app.server} · {props.app.tool}</span>
        <button type="button" class="icon-btn" title={fullscreen() ? "Exit full screen" : "Full screen"} aria-label={fullscreen() ? "Exit full screen" : "Full screen"} onClick={() => setFullscreen((value) => !value)}>
          <Icon name={fullscreen() ? "remove" : "fit"} size={13} />
        </button>
      </header>
      <iframe
        ref={frame}
        class="mcp-app-frame"
        title={props.app.title}
        srcdoc={documentHtml()}
        sandbox="allow-scripts allow-forms"
        allow={mcpAppAllowAttribute(permissions()) || undefined}
        referrerpolicy="no-referrer"
        style={{ height: `${fullscreen() ? "calc(100vh - 56px)" : `${height()}px`}` }}
        onLoad={() => { initialized = false; sendContext(); }}
      />
      <footer class="mcp-app-foot">
        <span>Messages, server tools and links require your approval.</span>
        <Show when={props.app.prefers_border}><span class="mcp-app-border-note">App border requested</span></Show>
      </footer>
    </div>
  );
};

export default McpAppCard;
