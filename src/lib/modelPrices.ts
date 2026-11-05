/** User-supplied model prices (USD per million tokens), used by the Usage dashboard to
 *  estimate turns whose agent reported no cost. T3 exposes the same table under Usage →
 *  Model prices; FlipFlopper keeps it in preferences. */
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

export interface ModelPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

const KEY = "flipflopper:model-prices";
const MAX_MODELS = 200;
const MAX_RATE = 1_000_000;

const [prices, setPrices] = createSignal<Record<string, ModelPrice>>({});
/** Saved prices by model id. */
export const modelPrices = prices;

export const normalizeModelId = (model: string): string => model.trim().slice(0, 200);

/** A finite, non-negative rate, or `null`. */
export function cleanRate(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  if (value === null || value === undefined) return null;
  const number = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  return Number.isFinite(number) && number >= 0 && number <= MAX_RATE ? Math.round(number * 1000) / 1000 : null;
}

/** A price pair from two inputs; both rates are required and must be valid. */
export function parsePrice(input: unknown, output: unknown): ModelPrice | null {
  const inputRate = cleanRate(input);
  const outputRate = cleanRate(output);
  return inputRate === null || outputRate === null ? null : { input: inputRate, output: outputRate };
}

/** Exact match first, then a case-insensitive one (model ids are conventionally lowercase). */
export function priceForModel(model: string): ModelPrice | null {
  const id = normalizeModelId(model);
  if (!id) return null;
  const saved = prices();
  if (Object.prototype.hasOwnProperty.call(saved, id)) return saved[id];
  const lower = id.toLowerCase();
  const key = Object.keys(saved).find((candidate) => candidate.toLowerCase() === lower);
  return key ? saved[key] : null;
}

function persist(next: Record<string, ModelPrice>) {
  setPrices(next);
  writePref(KEY, next);
}

/** Save a model's rates, or remove it with `null`. Returns false for an invalid id/price. */
export function setModelPrice(model: string, price: ModelPrice | null): boolean {
  const id = normalizeModelId(model);
  if (!id) return false;
  const next = { ...prices() };
  if (price === null) {
    if (!Object.prototype.hasOwnProperty.call(next, id)) return false;
    delete next[id];
  } else {
    const clean = parsePrice(price.input, price.output);
    if (!clean) return false;
    if (Object.keys(next).length >= MAX_MODELS && !Object.prototype.hasOwnProperty.call(next, id)) return false;
    if (next[id]?.input === clean.input && next[id]?.output === clean.output) return false;
    next[id] = clean;
  }
  persist(next);
  return true;
}

export function resetModelPrices() {
  if (Object.keys(prices()).length === 0) return;
  persist({});
}

export async function hydrateModelPrices(): Promise<void> {
  const saved = await readPref<unknown>(KEY, {}).catch(() => ({}));
  const clean: Record<string, ModelPrice> = {};
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [model, value] of Object.entries(saved as Record<string, unknown>).slice(0, MAX_MODELS)) {
      const id = normalizeModelId(model);
      if (!id || !value || typeof value !== "object") continue;
      const entry = value as Partial<ModelPrice>;
      const price = parsePrice(entry.input, entry.output);
      if (price) clean[id] = price;
    }
  }
  setPrices(clean);
}
