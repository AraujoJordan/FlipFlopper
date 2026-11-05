import { Component, For, Show, createResource, createSignal } from "solid-js";
import { Presence, Spinner, toast } from "./ui";
import { Icon } from "./shell/Icon";
import { usageRows } from "../lib/ipc";
import { modelPrices, normalizeModelId, parsePrice, priceForModel, resetModelPrices, setModelPrice } from "../lib/modelPrices";

const [modelPricesOpen, setModelPricesOpen] = createSignal(false);
export { modelPricesOpen };
/** Open T3's "Model prices" table (Usage → Model prices). */
export function openModelPrices() { setModelPricesOpen(true); }

const RATE_STYLE = { width: "76px" } as const;

/** One editable price row. Drafts save on blur; clearing both rates removes the price. */
const PriceRow: Component<{ model: string }> = (props) => {
  const saved = () => priceForModel(props.model);
  const [input, setInput] = createSignal(saved() ? String(saved()!.input) : "");
  const [output, setOutput] = createSignal(saved() ? String(saved()!.output) : "");
  const [error, setError] = createSignal<string | null>(null);

  function commit() {
    if (!input().trim() && !output().trim()) {
      if (saved()) setModelPrice(props.model, null);
      setError(null);
      return;
    }
    const price = parsePrice(input(), output());
    if (!price) { setError("Use a number for both rates."); return; }
    setError(null);
    if (setModelPrice(props.model, price) && input() !== String(price.input)) setInput(String(price.input));
    if (output() !== String(price.output)) setOutput(String(price.output));
  }

  return (
    <div class="model-price-row">
      <span class="model-price-id" title={props.model}>{props.model}</span>
      <input class="ui-field" style={RATE_STYLE} type="number" min="0" step="any" inputmode="decimal" aria-label={`${props.model} input price per million tokens`}
        placeholder="in" value={input()} onInput={(event) => { setInput(event.currentTarget.value); setError(null); }} onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (event.currentTarget as HTMLInputElement).blur(); } }} />
      <input class="ui-field" style={RATE_STYLE} type="number" min="0" step="any" inputmode="decimal" aria-label={`${props.model} output price per million tokens`}
        placeholder="out" value={output()} onInput={(event) => { setOutput(event.currentTarget.value); setError(null); }} onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); (event.currentTarget as HTMLInputElement).blur(); } }} />
      <Show when={saved()} fallback={<span class="model-price-unpriced">falls back to reported cost</span>}>
        <button type="button" class="icon-btn" title="Remove this price" aria-label={`Remove the price for ${props.model}`}
          onClick={() => { setInput(""); setOutput(""); void setModelPrice(props.model, null); }}>
          <Icon name="x" size={13} />
        </button>
      </Show>
      <Show when={error()}>{(message) => <span class="model-price-error" role="alert">{message()}</span>}</Show>
    </div>
  );
};

/** Model rates used by the Usage dashboard to estimate turns whose agent reported no cost. */
const ModelPricesDialog: Component = () => {
  const [newModel, setNewModel] = createSignal("");
  const [newInput, setNewInput] = createSignal("");
  const [newOutput, setNewOutput] = createSignal("");
  const [addError, setAddError] = createSignal<string | null>(null);
  const [models] = createResource(() => (modelPricesOpen() ? true : null), async () => {
    const rows = await usageRows(90).catch(() => []);
    return [...new Set(rows.map((row) => row.model))].sort();
  });
  const known = () => [...new Set([...(models() ?? []), ...Object.keys(modelPrices())])].sort();
  const close = () => setModelPricesOpen(false);

  function addModel() {
    const id = normalizeModelId(newModel());
    if (!id) { setAddError("Enter a model id."); return; }
    const price = parsePrice(newInput(), newOutput());
    if (!price) { setAddError("Enter both rates as numbers."); return; }
    if (!setModelPrice(id, price)) { setAddError("That model already has these rates."); return; }
    setNewModel(""); setNewInput(""); setNewOutput(""); setAddError(null);
  }

  return (
    <Presence when={modelPricesOpen()}>
      <div class="overlay-backdrop-in" onClick={close} style={{ position: "fixed", inset: 0, "z-index": "calc(var(--z-modal) + 2)", background: "rgba(0,0,0,.5)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <div class="overlay-pop-in" role="dialog" aria-modal="true" aria-label="Model prices" tabindex={-1}
          onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") close(); }}
          ref={(el) => queueMicrotask(() => el.focus())}
          style={{ width: "min(660px, 100%)", "max-height": "86vh", display: "flex", "flex-direction": "column", background: "var(--surface-3)", border: "1px solid var(--border-default)", "border-radius": "var(--radius-xl)", "box-shadow": "var(--shadow-menu)" }}>
          <header style={{ display: "flex", "align-items": "center", gap: "10px", padding: "14px 18px", "border-bottom": "1px solid var(--border-muted)" }}>
            <span style={{ "font-size": "13.5px", "font-weight": "600", color: "var(--fg-default)", flex: 1 }}>Model prices</span>
            <Show when={models.loading}><Spinner size={14} /></Show>
            <button class="icon-btn press" onClick={close} title="Close" aria-label="Close model prices"><Icon name="x" size={14} /></button>
          </header>
          <div style={{ padding: "14px 18px", overflow: "auto", display: "flex", "flex-direction": "column", gap: "10px" }}>
            <p style={{ margin: 0, "font-size": "12px", color: "var(--fg-muted)", "line-height": "1.5" }}>
              Rates are US dollars per million tokens. Usage estimates a turn only when the agent reported no cost; reported costs always win.
              Estimates appear with a ≈ prefix.
            </p>
            <div class="model-price-list">
              <For each={known()} fallback={<div style={{ "font-size": "12.5px", color: "var(--fg-subtle)" }}>No models yet. Run an agent turn or add a model id below.</div>}>
                {(model) => <PriceRow model={model} />}
              </For>
            </div>
            <div class="model-price-add">
              <input class="ui-field" style={{ flex: 1, "min-width": "180px" }} aria-label="Model id" placeholder="Model id (for example claude-sonnet-4)" value={newModel()}
                onInput={(event) => { setNewModel(event.currentTarget.value); setAddError(null); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel(); } }} />
              <input class="ui-field" style={RATE_STYLE} type="number" min="0" step="any" aria-label="New model input price per million tokens" placeholder="in" value={newInput()} onInput={(event) => { setNewInput(event.currentTarget.value); setAddError(null); }} />
              <input class="ui-field" style={RATE_STYLE} type="number" min="0" step="any" aria-label="New model output price per million tokens" placeholder="out" value={newOutput()} onInput={(event) => { setNewOutput(event.currentTarget.value); setAddError(null); }} />
              <button type="button" class="ui-btn ui-btn-outline" onClick={addModel}><Icon name="plus" size={13} /> Add</button>
            </div>
            <Show when={addError()}>{(message) => <span class="model-price-error" role="alert">{message()}</span>}</Show>
          </div>
          <footer style={{ display: "flex", "align-items": "center", gap: "8px", padding: "12px 18px", "border-top": "1px solid var(--border-muted)" }}>
            <button type="button" class="ui-btn ui-btn-ghost" onClick={() => { resetModelPrices(); toast("Model prices cleared.", "info"); }} disabled={Object.keys(modelPrices()).length === 0}>Reset all</button>
            <span style={{ flex: 1 }} />
            <button type="button" class="ui-btn ui-btn-solid" onClick={close}>Done</button>
          </footer>
        </div>
      </div>
    </Presence>
  );
};

export default ModelPricesDialog;
