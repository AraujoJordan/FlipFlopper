import { Component, For, Show, createSignal } from "solid-js";
import { confirmDialog, toast } from "./ui";
import { Icon } from "./shell/Icon";
import {
  createBrowserProfile, deleteBrowserProfile, importBrowserCookies, importFirefoxCookies,
  type BrowserProfileInfo,
} from "../lib/ipc";
import {
  pickCookieFile, profiles, refreshBrowserProfiles, selectBrowserProfile, selectedId,
} from "../lib/browserProfiles";

/** Settings → Browser: cookie-backed profiles for the native preview. Cookie
 *  values stay in the backend; rows only show counts and domains. */
const BrowserProfilesSettings: Component = () => {
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function create(event: Event) {
    event.preventDefault();
    const trimmed = name().trim();
    if (!trimmed || busy()) return;
    setBusy("create");
    setError(null);
    try {
      const profile = await createBrowserProfile(trimmed);
      await refreshBrowserProfiles();
      selectBrowserProfile(profile.id);
      setName("");
      toast(`Browser profile “${profile.name}” created`, "success");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(null);
    }
  }

  async function importCookies(profile: BrowserProfileInfo) {
    if (busy()) return;
    const path = await pickCookieFile().catch(() => null);
    if (!path) return;
    setBusy(`import-${profile.id}`);
    setError(null);
    try {
      const count = await importBrowserCookies(profile.id, path);
      await refreshBrowserProfiles();
      toast(`Imported ${count} ${count === 1 ? "cookie" : "cookies"} into “${profile.name}”`, "success");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(null);
    }
  }

  async function importFirefox(profile: BrowserProfileInfo) {
    if (busy()) return;
    setBusy(`firefox-${profile.id}`);
    setError(null);
    try {
      const count = await importFirefoxCookies(profile.id);
      await refreshBrowserProfiles();
      toast(`Imported ${count} ${count === 1 ? "cookie" : "cookies"} from Firefox into “${profile.name}”`, "success");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(null);
    }
  }

  async function remove(profile: BrowserProfileInfo) {
    if (busy()) return;
    if (!(await confirmDialog(`Delete the “${profile.name}” browser profile and its ${profile.cookie_count} imported ${profile.cookie_count === 1 ? "cookie" : "cookies"}? This cannot be undone.`, "Delete profile"))) return;
    setBusy(`delete-${profile.id}`);
    setError(null);
    try {
      await deleteBrowserProfile(profile.id);
      await refreshBrowserProfiles();
      toast("Browser profile deleted", "info");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div class="browser-profiles-settings">
      <p class="settings-lead">
        Use a signed-in browser session in the native preview. Cookie values never leave the backend: the preview applies them to a child webview before the first page load.
      </p>
      <form class="scripts-form" onSubmit={create}>
        <div class="scripts-form-head">
          <Icon name="globe" size={15} />
          <strong>New browser profile</strong>
        </div>
        <div class="scripts-fields">
          <label class="scripts-field">
            <span>Name</span>
            <input class="ui-field" value={name()} placeholder="Work GitHub" maxlength={80}
              onInput={(event) => { setName(event.currentTarget.value); setError(null); }} />
          </label>
        </div>
        <div class="scripts-form-actions">
          <button type="submit" class="ui-btn ui-btn-outline" disabled={!name().trim() || busy() !== null}>
            <Icon name="plus" size={13} /> {busy() === "create" ? "Creating…" : "Create profile"}
          </button>
        </div>
      </form>
      <Show when={error()}>{(message) => <p class="scripts-error" role="alert">{message()}</p>}</Show>

      <Show when={profiles().length > 0} fallback={<div class="scripts-empty">No browser profiles yet. Create one above, then import cookies from a signed-in browser.</div>}>
        <div class="scripts-list">
          <For each={profiles()}>
            {(profile) => (
              <div class="browser-profile-row">
                <label class="browser-profile-main">
                  <input type="radio" name="browser-profile" checked={selectedId() === profile.id}
                    onChange={() => selectBrowserProfile(profile.id)} aria-label={`Use ${profile.name} in the preview`} />
                  <span class="browser-profile-copy">
                    <span class="scripts-row-name">{profile.name}</span>
                    <span class="settings-row-hint">
                      {profile.cookie_count === 0
                        ? "No cookies imported yet."
                        : `${profile.cookie_count} ${profile.cookie_count === 1 ? "cookie" : "cookies"}${profile.domains.length ? ` · ${profile.domains.slice(0, 3).join(", ")}${profile.domains.length > 3 ? ` +${profile.domains.length - 3}` : ""}` : ""}`}
                    </span>
                  </span>
                </label>
                <div class="browser-profile-actions">
                  <button type="button" class="ui-btn ui-btn-ghost" disabled={busy() !== null}
                    onClick={() => void importCookies(profile)} title="Import a Netscape cookies.txt or JSON cookie export">
                    <Icon name="download" size={12} /> {busy() === `import-${profile.id}` ? "Importing…" : "Cookies file"}
                  </button>
                  <button type="button" class="ui-btn ui-btn-ghost" disabled={busy() !== null}
                    onClick={() => void importFirefox(profile)} title="Import the newest Firefox cookies.sqlite on this machine">
                    <Icon name="download" size={12} /> {busy() === `firefox-${profile.id}` ? "Importing…" : "Firefox"}
                  </button>
                  <button type="button" class="icon-btn" aria-label={`Delete ${profile.name}`} title="Delete profile"
                    disabled={busy() !== null} onClick={() => void remove(profile)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <p class="settings-row-hint">
        Chrome and Edge encrypt their cookie databases, so export cookies with a browser extension (Netscape or JSON). Firefox imports directly and reads only this machine's newest profile.
      </p>
    </div>
  );
};

export default BrowserProfilesSettings;
