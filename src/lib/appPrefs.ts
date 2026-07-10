import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("preferences.json", {
  autoSave: 100,
  defaults: {},
});

let initPromise: Promise<void> | null = null;

export function readLegacyString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readLegacyBool(key: string, fallback: boolean): boolean {
  const raw = readLegacyString(key);
  return raw === null ? fallback : raw === "true";
}

export function readLegacyNumber(key: string, fallback: number): number {
  const raw = readLegacyString(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function readLegacyJson<T>(key: string, fallback: T): T {
  const raw = readLegacyString(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function initAppPrefs(): Promise<void> {
  if (!initPromise) {
    initPromise = store.init().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
}

export async function readPref<T>(
  key: string,
  fallback: T,
  legacy?: () => T,
): Promise<T> {
  await initAppPrefs();
  const value = await store.get<T>(key);
  if (value !== undefined) return value;
  if (legacy) {
    const migrated = legacy();
    await store.set(key, migrated);
    return migrated;
  }
  return fallback;
}

export function writePref(key: string, value: unknown) {
  void initAppPrefs()
    .then(() => store.set(key, value))
    .catch((error) => console.error(`Failed to persist preference ${key}:`, error));
}
