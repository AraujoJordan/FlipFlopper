import { Component, Show, createSignal } from "solid-js";
import { homeDir } from "@tauri-apps/api/path";
import { Presence, Spinner, toast } from "./ui";
import { Icon } from "./shell/Icon";
import { cloneRepository, pickCloneDestination } from "../lib/ipc";
import { openProjectPath } from "../lib/projects";
import { looksLikeCloneUrl, repositoryNameFromUrl } from "../lib/repoUrl";
import { cloneDestination, setCloneDestination } from "../lib/settings";

const [openSignal, setOpenSignal] = createSignal(false);
export { openSignal as cloneRepositoryOpen };
/** Open the Clone repository dialog (project picker, palette). */
export function openCloneRepository() { setOpenSignal(true); }

/** T3's "Add project → clone": paste a Git URL, choose where it goes, clone, then open it. */
const CloneRepositoryDialog: Component = () => {
  const [url, setUrl] = createSignal("");
  const [parent, setParent] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const close = () => { if (!busy()) setOpenSignal(false); };

  // A fresh dialog starts from the user's home folder unless they already chose one.
  function prepare() {
    setError(null);
    if (parent()) return;
    if (cloneDestination()) { setParent(cloneDestination()); return; }
    void homeDir().then((home) => { if (!parent()) setParent(home); }).catch(() => {});
  }

  async function chooseParent() {
    try {
      const chosen = await pickCloneDestination();
      if (chosen) { setParent(chosen); setCloneDestination(chosen); }
    } catch (e) { setError(String(e)); }
  }

  async function clone(event?: Event) {
    event?.preventDefault();
    if (busy()) return;
    const target = url().trim();
    if (!looksLikeCloneUrl(target)) { setError("Paste an https:// or ssh:// Git URL, a git@host:owner/repo address, or an absolute path."); return; }
    if (!parent()) { setError("Choose a folder to clone into."); return; }
    setBusy(true);
    setError(null);
    try {
      const info = await cloneRepository(target, parent());
      await openProjectPath(info.path);
      setOpenSignal(false);
      setUrl("");
      toast(`Cloned ${info.name}.`, "success");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const name = () => repositoryNameFromUrl(url());
  const destination = () => (parent() && name() ? `${parent().replace(/\/+$/, "")}/${name()}` : "");

  return (
    <Presence when={openSignal()}>
      <div class="overlay-backdrop-in" onClick={close} onKeyDown={(event) => { if (event.key === "Escape") close(); }}
        style={{ position: "fixed", inset: 0, "z-index": "var(--z-modal)", background: "rgba(0,0,0,.48)", display: "flex", "align-items": "center", "justify-content": "center", padding: "24px" }}>
        <form class="overlay-pop-in clone-dialog" role="dialog" aria-modal="true" aria-label="Clone repository"
          ref={(el) => { prepare(); queueMicrotask(() => el.querySelector<HTMLInputElement>("input")?.focus()); }}
          onClick={(event) => event.stopPropagation()} onSubmit={clone}>
          <header class="clone-dialog-head">
            <Icon name="download" size={16} />
            <strong>Clone repository</strong>
            <button type="button" class="icon-btn" onClick={close} disabled={busy()} title="Close" aria-label="Close clone dialog"><Icon name="x" size={14} /></button>
          </header>
          <div class="clone-dialog-body">
            <label class="clone-field">
              <span>Repository URL</span>
              <input class="ui-field" type="text" spellcheck={false} autofocus placeholder="https://github.com/owner/repo.git" value={url()}
                onInput={(event) => { setUrl(event.currentTarget.value); setError(null); }} />
            </label>
            <label class="clone-field">
              <span>Clone into</span>
              <div class="clone-destination">
                <input class="ui-field" type="text" spellcheck={false} aria-label="Parent folder" placeholder="Choose a folder…" value={parent()} readOnly />
                <button type="button" class="ui-btn ui-btn-outline" onClick={() => void chooseParent()} disabled={busy()}>Choose…</button>
              </div>
            </label>
            <Show when={destination()}>
              <div class="clone-preview"><Icon name="folder" size={13} /><span title={destination()}>{destination()}</span></div>
            </Show>
            <Show when={error()}>{(message) => <p class="clone-error" role="alert">{message()}</p>}</Show>
            <p class="clone-hint">Uses your system Git: its credentials, SSH keys and the app's network proxy settings. Environment setup stays opt-in under Settings.</p>
          </div>
          <footer class="clone-dialog-foot">
            <button type="button" class="ui-btn ui-btn-ghost" onClick={close} disabled={busy()}>Cancel</button>
            <button type="submit" class="ui-btn ui-btn-solid" disabled={busy() || !url().trim() || !parent()}>
              <Show when={busy()} fallback={<Icon name="download" size={13} />}><Spinner size={12} /></Show>
              {busy() ? "Cloning…" : "Clone"}
            </button>
          </footer>
        </form>
      </div>
    </Presence>
  );
};

export default CloneRepositoryDialog;
