// Preview element annotations: the small text block inserted into the composer
// after the native picker captures an element. Kept pure for tests.
export interface PreviewPickInfo {
  url: string;
  title: string;
  selector: string;
  text: string;
}

export function previewAnnotationText(pick: PreviewPickInfo, hasScreenshot: boolean): string {
  return [
    "## Preview annotation",
    `Page: ${pick.url}${pick.title ? ` — ${pick.title}` : ""}`,
    `Element: \`${pick.selector}\``,
    pick.text ? `Text: ${pick.text}` : "",
    hasScreenshot ? "A screenshot of the preview is attached." : "",
  ].filter(Boolean).join("\n");
}
