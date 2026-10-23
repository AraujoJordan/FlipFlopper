import { Component, createMemo } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdownLite } from "../../lib/markdownLite";
import { animateElement, toast } from "../ui";
import { writeClipboardText } from "../../lib/native";

/** Renders assistant markdown. Links open in the system browser and code
 *  blocks get a copy button (both wired by event delegation on the container). */
const Markdown: Component<{ text: string }> = (props) => {
  const html = createMemo(() => renderMarkdownLite(props.text));

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>("a[data-md-link]");
    if (link) {
      e.preventDefault();
      void openUrl(link.href).catch(() => {});
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
