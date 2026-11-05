import { Component, Show, createEffect, createSignal } from "solid-js";
import { Presence, Spinner, toast } from "./ui";
import { Icon } from "./shell/Icon";
import { openPromptLink, promptLinkOpen, setPromptLinkOpen } from "../lib/promptLinks";

/** Opens a copied prompt/thread link as a draft. It never sends or changes permissions. */
const PromptLinkDialog: Component = () => {
  const [link, setLink] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [opening, setOpening] = createSignal(false);
  let input: HTMLTextAreaElement | undefined;

  createEffect(() => {
    if (!promptLinkOpen()) return;
    setLink("");
    setError(null);
    setOpening(false);
    queueMicrotask(() => input?.focus());
  });

  const close = () => { if (!opening()) setPromptLinkOpen(false); };

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast("The clipboard is empty.", "info"); return; }
      setLink(text.trim());
      setError(null);
      input?.focus();
    } catch (error) {
      toast(`Couldn't read the clipboard: ${String(error)}`, "error");
    }
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (!link().trim() || opening()) return;
    setOpening(true);
    setError(null);
    try {
      await openPromptLink(link());
      setPromptLinkOpen(false);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setOpening(false);
    }
  }

  return (
    <Presence when={promptLinkOpen()} label="Open prompt link">
      <div class="overlay-backdrop-in prompt-link-backdrop" onClick={close}>
        <form class="overlay-pop-in prompt-link-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-link-title"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") close(); }}
          onSubmit={submit}>
          <header class="prompt-link-head">
            <div class="prompt-link-heading">
              <Icon name="link" size={17} />
              <div>
                <strong id="prompt-link-title">Open prompt link</strong>
                <span>Paste a shared prompt or thread link. It opens as a draft; nothing is sent.</span>
              </div>
            </div>
            <button type="button" class="icon-btn" title="Close" aria-label="Close prompt link" onClick={close}><Icon name="x" size={14} /></button>
          </header>

          <div class="prompt-link-body">
            <label class="prompt-link-field">
              <span>Link</span>
              <textarea ref={input} class="ui-field" rows={5} value={link()} spellcheck={false}
                placeholder="flipflopper://new?prompt=Fix%20the%20build&repo=owner/name&provider=claude"
                onInput={(event) => { setLink(event.currentTarget.value); setError(null); }} />
            </label>
            <div class="prompt-link-examples">
              <span>Prompt: <code>flipflopper://new?prompt=…&amp;repo=owner/name&amp;provider=claude&amp;model=…</code></span>
              <span>Thread: <code>flipflopper://thread/&lt;session-id&gt;?prompt=…</code></span>
            </div>
            <Show when={error()}>{(message) => <p class="prompt-link-error" role="alert">{message()}</p>}</Show>
            <p class="prompt-link-note">
              Links can also be passed on the command line or opened from the app's single-instance handler.
              Invisible zero-width and tag characters are removed before opening. The repository is matched against
              open/recent projects; if it is not open, the draft starts without a project.
            </p>
          </div>

          <footer class="prompt-link-actions">
            <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void paste()}><Icon name="clipboard" size={13} /> Paste from clipboard</button>
            <span style={{ flex: 1 }} />
            <button type="button" class="ui-btn ui-btn-ghost" disabled={opening()} onClick={close}>Cancel</button>
            <button type="submit" class="ui-btn ui-btn-solid" disabled={!link().trim() || opening()}>
              <Show when={opening()} fallback={<><Icon name="arrowRight" size={13} /> Open draft</>}><Spinner size={12} /> Opening…</Show>
            </button>
          </footer>
        </form>
      </div>
    </Presence>
  );
};

export default PromptLinkDialog;
