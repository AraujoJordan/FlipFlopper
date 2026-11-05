// Describes a SnapShot's accessible app context for the composer. Kept pure so
// the formatting can be tested without a screen-capture permission prompt.
export interface SnapshotContext {
  app_name?: string | null;
  window_title?: string | null;
  app_text?: string | null;
}

export function snapshotAnnotation(info: SnapshotContext): string {
  return [
    info.app_name ? `App: ${info.app_name}` : "",
    info.window_title ? `Window: ${info.window_title}` : "",
    info.app_text ? `Visible text:\n${info.app_text}` : "",
  ].filter(Boolean).join("\n");
}
