import { createStore } from "solid-js/store";
import { detectProjectIcon, type ProjectIconInfo } from "./ipc";

/** Cached detection per project path for this app run. A null result means the
 *  project has no usable default icon and the monogram should be shown. */
const [icons, setIcons] = createStore<Record<string, ProjectIconInfo | null>>({});
const pending = new Map<string, Promise<ProjectIconInfo | null>>();

/** undefined until detection finishes; null when the project has no icon. */
export function detectedProjectIcon(path: string): ProjectIconInfo | null | undefined {
  return icons[path];
}

/** Detect once per project; safe to call from every avatar render. */
export function ensureProjectIcon(path: string, refresh = false): Promise<ProjectIconInfo | null> {
  if (!path) return Promise.resolve(null);
  if (!refresh) {
    const running = pending.get(path);
    if (running) return running;
    if (icons[path] !== undefined) return Promise.resolve(icons[path]);
  }
  const request = detectProjectIcon(path)
    .then((info) => {
      setIcons(path, info);
      return info;
    })
    .catch(() => {
      setIcons(path, null);
      return null;
    })
    .finally(() => {
      pending.delete(path);
    });
  pending.set(path, request);
  return request;
}

/** Re-run detection after opening a project or from Project settings. */
export function refreshProjectIcon(path: string): Promise<ProjectIconInfo | null> {
  return ensureProjectIcon(path, true);
}
