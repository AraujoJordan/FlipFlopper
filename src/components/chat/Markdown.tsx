import { Component, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildPreviewDocument, mermaidSourceOf, renderMarkdownLite, visualSourceOf } from "../../lib/markdownLite";
import { openConversationFile } from "../../lib/attachments";
import { animateElement, toast } from "../ui";
import { writeClipboardText } from "../../lib/native";
import { maskForDisplay } from "../../lib/secrets";
import { renderMathEnabled, linkTarget } from "../../lib/settings";
import { openSide } from "../../lib/layout";
import { setStore } from "../../lib/store";
import { openHtmlPreview } from "../HtmlPreviewDialog";
import { openFileInViewer } from "../../lib/fileViewer";
import { runTerminalCommand } from "../../lib/scripts";

const currentScheme = (): "light" | "dark" => {
  const forced = document.documentElement.getAttribute("data-theme");
  return forced === "dark" || forced === "light" ? forced : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

// One listener for the whole app: every rendered message rebuilds its inline pages on a theme switch.
const [themeTick, setThemeTick] = createSignal(0);
let watchingTheme = false;
function watchTheme() {
  if (watchingTheme) return;
  watchingTheme = true;
  const bump = () => setThemeTick((tick) => tick + 1);
  window.addEventListener("flipflopper:theme-changed", bump);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", bump);
}

/** A full HTML document in a fence becomes a sandboxed page above its source. */
function buildVisualCard(source: string, scheme: "light" | "dark"): HTMLElement {
  const card = document.createElement("div");
  card.className = "md-visual-card";
  const head = document.createElement("div");
  head.className = "md-visual-head";
  const label = document.createElement("span");
  label.className = "md-visual-label";
  label.textContent = "Visual reply";
  const hint = document.createElement("span");
  hint.className = "md-visual-hint";
  hint.textContent = "Sandboxed · no network";
  const expand = document.createElement("button");
  expand.type = "button";
  expand.className = "md-visual-expand";
  expand.textContent = "Expand";
  expand.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openHtmlPreview(source); });
  head.append(label, hint, expand);
  const frame = document.createElement("iframe");
  frame.className = "md-visual-frame";
  frame.title = "Visual reply";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = buildPreviewDocument(source, scheme);
  card.append(head, frame);
  return card;
}

/** Mount missing cards and refresh existing ones after a theme change. */
function fillVisuals(root: HTMLDivElement | undefined) {
  if (!root) return;
  const scheme = currentScheme();
  for (const placeholder of root.querySelectorAll<HTMLElement>(".md-visual[data-md-visual]")) {
    const source = visualSourceOf(placeholder.dataset.mdVisual);
    if (!source) continue;
    const frame = placeholder.querySelector<HTMLIFrameElement>("iframe.md-visual-frame");
    if (frame) {
      const doc = buildPreviewDocument(source, scheme);
      if (frame.srcdoc !== doc) frame.srcdoc = doc;
      continue;
    }
    placeholder.replaceChildren(buildVisualCard(source, scheme));
  }
}

// ── Mermaid diagrams ────────────────────────────────────────────────────────
// The renderer is large, so it is imported only when a message actually has a
// diagram. Strict security mode rejects click directives and remote resources.
let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
let mermaidSeq = 0;

async function mermaidRenderer(scheme: "light" | "dark") {
  const mermaid = await (mermaidModule ??= import("mermaid").then((module) => module.default));
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: scheme === "dark" ? "dark" : "default",
    fontFamily: "inherit",
  });
  return mermaid;
}

async function renderMermaid(card: HTMLElement, scheme: "light" | "dark") {
  const source = mermaidSourceOf(card.dataset.mdMermaid);
  const body = card.querySelector<HTMLElement>(".md-mermaid-body");
  if (!source || !body || card.dataset.mdMermaidRendered === scheme) return;
  try {
    const mermaid = await mermaidRenderer(scheme);
    const { svg } = await mermaid.render(`md-mermaid-${++mermaidSeq}`, source);
    if (!body.isConnected) return;
    body.innerHTML = svg;
    card.dataset.mdMermaidRendered = scheme;
  } catch {
    if (!body.isConnected) return;
    const fallback = document.createElement("pre");
    fallback.className = "md-mermaid-error";
    fallback.textContent = source;
    body.replaceChildren(fallback);
    card.dataset.mdMermaidRendered = "error";
  } finally {
    body.removeAttribute("aria-busy");
  }
}

function fillMermaid(root: HTMLDivElement | undefined, scheme: "light" | "dark") {
  if (!root) return;
  for (const card of root.querySelectorAll<HTMLElement>(".md-mermaid-card[data-md-mermaid]")) {
    void renderMermaid(card, scheme);
  }
}

/** Renders assistant markdown, including places outside the transcript. */
const Markdown: Component<{ text: string }> = (props) => {
  const html = createMemo(() => { renderMathEnabled(); return renderMarkdownLite(maskForDisplay(props.text)); });
  const isMac = navigator.platform.toLowerCase().includes("mac");
  let root: HTMLDivElement | undefined;

  onMount(watchTheme);
  // Run after Solid has applied innerHTML for this update, so placeholders exist to fill.
  createEffect(() => {
    html();
    themeTick();
    queueMicrotask(() => { fillVisuals(root); fillMermaid(root, currentScheme()); });
  });

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const fileLink = target.closest<HTMLAnchorElement>("a[data-file-path]");
    if (fileLink) {
      e.preventDefault();
      e.stopPropagation();
      const path = fileLink.dataset.filePath;
      const line = Number(fileLink.dataset.fileLine) || null;
      if (path && !(isMac ? e.metaKey : e.ctrlKey)) { void openFileInViewer(path, line); return; }
      if (path) void openConversationFile(path, line).catch((error) => toast(`Couldn't open ${path}: ${String(error)}`, "error"));
      return;
    }
    const link = target.closest<HTMLAnchorElement>("a[data-md-link]");
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      if (linkTarget() === "preview" && /^https?:/i.test(link.href)) {
        setStore("previewRequest", { url: link.href, ts: Date.now() });
        openSide("preview");
      } else {
        void openUrl(link.href).catch((error) => toast(`Couldn't open link: ${String(error)}`, "error"));
      }
      return;
    }
    const htmlPreview = target.closest<HTMLButtonElement>("button[data-md-html-preview]");
    if (htmlPreview) {
      openHtmlPreview(htmlPreview.closest(".md-code")?.querySelector("code")?.textContent ?? "");
      return;
    }
    const mermaidCopy = target.closest<HTMLButtonElement>("button[data-md-mermaid-copy]");
    if (mermaidCopy) {
      const source = mermaidSourceOf(mermaidCopy.closest<HTMLElement>(".md-mermaid-card")?.dataset.mdMermaid);
      if (source) void writeClipboardText(source, "mermaid").then(() => {
        if (!mermaidCopy.isConnected) return;
        const previous = mermaidCopy.textContent;
        mermaidCopy.textContent = "Copied";
        void animateElement(mermaidCopy, [{ opacity: .4 }, { opacity: 1 }], 120);
        setTimeout(() => { if (mermaidCopy.isConnected) mermaidCopy.textContent = previous; }, 1200);
      }).catch((error) => toast(`Couldn't copy diagram source: ${String(error)}`, "error"));
      return;
    }
    const copy = target.closest<HTMLButtonElement>("button[data-md-copy]");
    if (copy) {
      const code = copy.closest(".md-code")?.querySelector("code")?.textContent ?? "";
      void writeClipboardText(code, "code").then(() => {
        if (!copy.isConnected) return;
        const prev = copy.textContent;
        copy.textContent = "Copied";
        void animateElement(copy, [{ opacity: .4 }, { opacity: 1 }], 120);
        setTimeout(() => { if (copy.isConnected) copy.textContent = prev; }, 1200);
      }).catch((error) => toast(`Couldn't copy code: ${String(error)}`, "error"));
      return;
    }
    const run = target.closest<HTMLButtonElement>("button[data-md-run]");
    if (run) {
      const code = run.closest(".md-code")?.querySelector("code")?.textContent ?? "";
      void runTerminalCommand(code, "Code block");
      return;
    }
    const tableCopy = target.closest<HTMLButtonElement>("button[data-md-copy-table]");
    if (tableCopy) {
      const table = tableCopy.closest(".md-table")?.querySelector("table");
      if (!table) return;
      const rows = [...table.rows].map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? "").join("\t")).join("\n");
      void writeClipboardText(rows, "table").then(() => {
        if (!tableCopy.isConnected) return;
        const previous = tableCopy.textContent;
        tableCopy.textContent = "Copied";
        setTimeout(() => { if (tableCopy.isConnected) tableCopy.textContent = previous; }, 1200);
      }).catch((error) => toast(`Couldn't copy table: ${String(error)}`, "error"));
    }
  };

  return <div ref={root} class="md" innerHTML={html()} onClick={onClick} />;
};

export default Markdown;
