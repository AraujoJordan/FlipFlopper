import { Component, createMemo } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdownLite } from "../../lib/markdownLite";
import { openConversationFile } from "../../lib/attachments";
import { animateElement, toast } from "../ui";
import { writeClipboardText } from "../../lib/native";

/** Renders assistant markdown, including places outside the transcript. */
const Markdown: Component<{ text: string }> = (props) => {
  const html = createMemo(() => renderMarkdownLite(props.text));
  const isMac = navigator.platform.toLowerCase().includes("mac");

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const fileLink = target.closest<HTMLAnchorElement>("a[data-file-path]");
    if (fileLink) {
      e.preventDefault();
      e.stopPropagation();
      if (!(isMac ? e.metaKey : e.ctrlKey) && e.detail !== 0) return;
      const path = fileLink.dataset.filePath;
      if (path) void openConversationFile(path).catch((error) => toast(`Couldn't open ${path}: ${String(error)}`, "error"));
      return;
    }
    const link = target.closest<HTMLAnchorElement>("a[data-md-link]");
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      void openUrl(link.href).catch((error) => toast(`Couldn't open link: ${String(error)}`, "error"));
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
    }
  };

  return <div class="md" innerHTML={html()} onClick={onClick} />;
};

export default Markdown;
