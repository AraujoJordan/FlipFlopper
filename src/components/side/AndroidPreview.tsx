import { Component, For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  androidListDevices,
  androidCliBegin, androidCliCancel, androidCliRun, prepareAttachmentPreview,
  type AndroidCliInfo, type AndroidCliResult, type AndroidPreviewFunction,
  bootAndroidEmulator,
  detectAndroidEnvironment,
  savePastedAttachment,
  startAndroidScrcpy,
  type AndroidDevice,
  type AndroidEnvironment,
} from "../../lib/ipc";
import {
  ANDROID_KEY,
  androidInspectionNodes,
  blobToBase64,
  canvasToBlob,
  createAutoReconnect,
  createMirror,
  startCanvasRecording,
} from "../../lib/androidMirror";
import { convertFileSrc } from "@tauri-apps/api/core";
import { chat } from "../../lib/chat";
import { addAttachments, attachments, MAX_ATTACHMENTS } from "../../lib/attachments";
import { layout } from "../../lib/layout";
import { addTerminal, effectiveRoot, readAndroidDevices, writeAndroidDevice } from "../../lib/store";
import { Icon } from "../shell/Icon";
import { Spinner, toast } from "../ui";

const POLL_MS = 2500;
/** Every Nth poll re-reads the full environment (scrcpy install, AVD list). */
const FULL_REFRESH_EVERY = 12;

const deviceLabel = (device: AndroidDevice) =>
  device.model ? `${device.model} (${device.serial})` : device.serial;

/** Live Android device/emulator inside the Preview tab: mirrors the screen,
 *  forwards touch/keyboard, and captures screenshots and video. */
const AndroidDevicePreview: Component<{ active: boolean; info: AndroidCliInfo | null }> = (props) => {
  const [env, setEnv] = createSignal<AndroidEnvironment | null>(null);
  const [serial, setSerial] = createSignal<string | null>(null);
  const [booting, setBooting] = createSignal<string | null>(null);
  const [recordSeconds, setRecordSeconds] = createSignal(0);
  let canvas: HTMLCanvasElement | undefined;
  let recording: ReturnType<typeof startCanvasRecording> | null = null;
  let recordTimer: ReturnType<typeof setInterval> | null = null;

  const mirror = createMirror(() => canvas);
  const projectPath = () => effectiveRoot() ?? "";
  const visible = () => props.active && layout.sideOpen && layout.sideTab === "preview";
  const onlineDevices = createMemo(() => (env()?.devices ?? []).filter((d) => d.status === "device"));

  async function refreshEnv() {
    const path = projectPath();
    if (!path) return;
    try {
      const next = await detectAndroidEnvironment(path);
      if (path === projectPath()) setEnv(next);
    } catch { /* keep the last good environment */ }
  }

  // `adb devices` only; the full probe (AVDs, scrcpy) is far heavier.
  async function refreshDevices() {
    try {
      const root = projectPath();
      const devices = await androidListDevices();
      if (root !== projectPath()) return;
      setEnv((prev) => (prev ? { ...prev, devices } : prev));
    } catch { /* adb missing or busy: keep the last list */ }
  }

  createEffect(on(projectPath, () => { setEnv(null); setSerial(null); void refreshEnv(); }));

  onMount(() => {
    // Poll so a plugged-in phone or a booting emulator shows up on its own;
    // slow down once a device is streaming.
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const tick = async () => {
      if (visible()) {
        if (!env() || ++polls % FULL_REFRESH_EVERY === 0) await refreshEnv();
        else await refreshDevices();
      }
      timer = setTimeout(tick, mirror.status() === "live" ? POLL_MS * 3 : POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    onCleanup(() => clearTimeout(timer));
  });

  // Pick the device: the saved one for this project if still online, else the
  // current choice, else the environment's preferred device.
  createEffect(() => {
    const online = onlineDevices();
    const current = serial();
    const saved = readAndroidDevices()[projectPath()];
    const next = online.find((d) => d.serial === saved)?.serial
      ?? online.find((d) => d.serial === current)?.serial
      ?? (env()?.selected_device && online.some((d) => d.serial === env()!.selected_device) ? env()!.selected_device : online[0]?.serial)
      ?? null;
    setSerial(next);
  });

  // Memo: only a real change (not every poll) may restart the mirror.
  const scrcpyAvailable = createMemo(() => !!env()?.scrcpy_path && !!env()?.scrcpy_server_path);

  function connect() {
    const current = serial();
    const path = projectPath();
    if (!current || !path) return;
    void mirror.start({ projectPath: path, serial: current, allowStream: scrcpyAvailable() });
  }

  // (Re)connect when the device, project or scrcpy availability changes.
  createEffect(on([serial, projectPath, scrcpyAvailable], () => {
    reconnect.reset();
    if (serial()) connect();
    else void mirror.stop();
  }));

  // A dropped stream is retried while its device is still online; a freshly
  // booted emulator is listed before it can serve one, so it gets more tries.
  const reconnect = createAutoReconnect({
    status: mirror.status,
    deviceOnline: () => onlineDevices().some((d) => d.serial === serial()),
    reconnect: connect,
    attempts: () => (booting() ? 6 : 3),
  });
  createEffect(() => { if (mirror.status() === "live") setBooting(null); });

  createEffect(() => mirror.setPaused(!visible()));

  onCleanup(() => {
    void stopRecording(false);
    void mirror.stop();
  });

  // ── recording / screenshots ────────────────────────────────────────────────

  async function saveAndOffer(blob: Blob | null, ext: string, label: string) {
    if (!blob) { toast(`${label} failed`, "error"); return; }
    try {
      const attachment = await savePastedAttachment(await blobToBase64(blob), ext);
      toast(`${label} saved`, "success", {
        actionLabel: "Attach to chat",
        onAction: () => addAttachments([attachment]),
      });
    } catch (e) {
      toast(`${label} failed: ${String(e)}`, "error");
    }
  }

  async function screenshot() {
    if (!canvas || mirror.status() !== "live") return;
    await saveAndOffer(await canvasToBlob(canvas), "png", "Screenshot");
  }

  async function stopRecording(save = true) {
    if (recordTimer) clearInterval(recordTimer);
    recordTimer = null;
    const active = recording;
    recording = null;
    setRecordSeconds(0);
    if (!active) return;
    const clip = await active.stop();
    if (save) await saveAndOffer(clip.blob, clip.ext, "Recording");
  }

  function toggleRecording() {
    if (recording) { void stopRecording(); return; }
    if (!canvas || mirror.status() !== "live") return;
    try {
      recording = startCanvasRecording(canvas);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "error");
      return;
    }
    setRecordSeconds(1);
    recordTimer = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
  }
  const recordingActive = () => recordSeconds() > 0;
  const clock = () => `${Math.floor(recordSeconds() / 60)}:${String(recordSeconds() % 60).padStart(2, "0")}`;

  // ── input ──────────────────────────────────────────────────────────────────

  const normalized = (event: PointerEvent | WheelEvent) => {
    const rect = canvas!.getBoundingClientRect();
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height] as const;
  };
  const live = () => mirror.status() === "live";

  const onPointerDown = (event: PointerEvent) => {
    if (!live() || !canvas) return;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = normalized(event);
    mirror.pointer("down", event.pointerId % 8, x, y);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!live() || !canvas?.hasPointerCapture(event.pointerId)) return;
    const [x, y] = normalized(event);
    mirror.pointer("move", event.pointerId % 8, x, y);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!live() || !canvas?.hasPointerCapture(event.pointerId)) return;
    const [x, y] = normalized(event);
    mirror.pointer("up", event.pointerId % 8, x, y);
    canvas.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent) => {
    if (!live()) return;
    event.preventDefault();
    const [x, y] = normalized(event);
    void mirror.wheel(x, y, event.deltaY);
  };

  const SPECIAL_KEYS: Record<string, number> = {
    Enter: ANDROID_KEY.enter,
    Backspace: ANDROID_KEY.del,
    Delete: ANDROID_KEY.forwardDel,
    Tab: ANDROID_KEY.tab,
    Escape: ANDROID_KEY.back,
    ArrowUp: ANDROID_KEY.up,
    ArrowDown: ANDROID_KEY.down,
    ArrowLeft: ANDROID_KEY.left,
    ArrowRight: ANDROID_KEY.right,
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!live() || event.metaKey || event.ctrlKey || event.altKey) return;
    const special = SPECIAL_KEYS[event.key];
    if (special !== undefined) mirror.key(special);
    else if (event.key.length === 1) mirror.text(event.key);
    else return;
    event.preventDefault();
  };

  const onPaste = (event: ClipboardEvent) => {
    const pasted = event.clipboardData?.getData("text");
    if (!live() || !pasted) return;
    event.preventDefault();
    mirror.text(pasted);
  };

  // ── devices & emulators ────────────────────────────────────────────────────

  function chooseDevice(value: string) {
    setSerial(value);
    writeAndroidDevice(projectPath(), value);
  }

  async function bootAvd(avd: string, headless: boolean) {
    const path = projectPath();
    if (!path || booting()) return;
    setBooting(avd);
    reconnect.reset();
    try {
      const sessionId = await bootAndroidEmulator(path, avd, { headless });
      addTerminal({ sessionId, label: `Android · Boot ${avd}`, kind: "run" });
    } catch (e) {
      setBooting(null);
      toast(`Boot emulator failed: ${String(e)}`, "error");
    }
  }

  async function openScrcpyWindow() {
    const path = projectPath();
    const current = serial();
    if (!path || !current) return;
    try {
      const sessionId = await startAndroidScrcpy(path, current);
      addTerminal({ sessionId, label: "Android · scrcpy", kind: "run" });
    } catch (e) {
      toast(`scrcpy failed: ${String(e)}`, "error");
    }
  }

  const IconButton: Component<{ icon: Parameters<typeof Icon>[0]["name"]; title: string; onClick: () => void; disabled?: boolean; active?: boolean }> = (props) => (
    <button
      class="icon-btn android-tool"
      classList={{ "is-recording": props.active }}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={15} />
    </button>
  );

  return (
    <div class="android-preview">
      <div class="android-bar">
        <select
          class="android-select"
          aria-label="Android device"
          disabled={onlineDevices().length === 0}
          value={serial() ?? ""}
          onChange={(e) => chooseDevice(e.currentTarget.value)}
        >
          <Show when={onlineDevices().length > 0} fallback={<option value="">No device online</option>}>
            <For each={onlineDevices()}>{(d) => <option value={d.serial}>{deviceLabel(d)}</option>}</For>
          </Show>
        </select>
        <IconButton icon="arrowLeft" title="Back" disabled={!live()} onClick={() => mirror.key(ANDROID_KEY.back)} />
        <IconButton icon="home" title="Home" disabled={!live()} onClick={() => mirror.key(ANDROID_KEY.home)} />
        <IconButton icon="square" title="Recent apps" disabled={!live()} onClick={() => mirror.key(ANDROID_KEY.recents)} />
        <IconButton icon="rotate" title="Rotate" disabled={!live() || mirror.mode() !== "stream"} onClick={() => mirror.rotate()} />
        <span class="android-bar-gap" />
        <IconButton icon="camera" title="Screenshot" disabled={!live()} onClick={() => void screenshot()} />
        <button
          class="icon-btn android-tool android-record"
          classList={{ "is-recording": recordingActive() }}
          title={recordingActive() ? "Stop recording" : "Record video"}
          aria-label={recordingActive() ? "Stop recording" : "Record video"}
          disabled={!live() && !recordingActive()}
          onClick={toggleRecording}
        >
          <Icon name={recordingActive() ? "stop" : "record"} size={15} />
          <Show when={recordingActive()}><span class="android-record-time">{clock()}</span></Show>
        </button>
        <IconButton icon="external" title="Open in scrcpy window" disabled={!serial() || !env()?.scrcpy_path} onClick={() => void openScrcpyWindow()} />
      </div>

      <AndroidCliPanel mode="inspect" info={props.info} serial={serial()} />
      <div class="android-stage">
        <Show
          when={serial()}
          fallback={
            <div class="pane-empty">
              <Icon name="device" size={28} />
              <p>{booting() ? `Booting ${booting()}…` : "No Android device is connected."}</p>
              <Show when={booting()}><Spinner size={16} /></Show>
              <Show when={!booting() && (env()?.avds.length ?? 0) > 0}>
                <p class="pane-empty-sub">Start an emulator and it will appear here.</p>
                <div class="android-avds">
                  <For each={env()!.avds}>
                    {(avd) => (
                      <div class="android-avd">
                        <span>{avd}</span>
                        <button class="android-avd-btn" onClick={() => void bootAvd(avd, true)}>Boot here</button>
                        <button class="link-btn" onClick={() => void bootAvd(avd, false)}>With window</button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={!booting() && env() && env()!.avds.length === 0}>
                <p class="pane-empty-sub">Plug in a phone with USB debugging, or create an AVD in Android Studio.</p>
              </Show>
              <For each={env()?.issues ?? []}>{(issue) => <p class="pane-empty-sub">{issue}</p>}</For>
            </div>
          }
        >
          <canvas
            ref={canvas}
            class="android-canvas"
            classList={{ "is-live": live() }}
            tabindex={0}
            aria-label="Android device screen"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onContextMenu={(e) => e.preventDefault()}
          />
          <Show when={mirror.status() === "connecting"}>
            <div class="android-overlay"><Spinner size={18} /><span>Connecting…</span></div>
          </Show>
          <Show when={mirror.status() === "error"}>
            <div class="android-overlay">
              <span class="android-error">{mirror.error() ?? "Connection lost."}</span>
              <button class="android-avd-btn" onClick={connect}>Retry</button>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={serial() && mirror.mode() === "snapshot" && mirror.status() !== "idle"}>
        <div class="android-note">
          Slow snapshot mode.{" "}
          {env() && !scrcpyAvailable()
            ? "Install scrcpy (brew install scrcpy) for a live stream."
            : mirror.error() ?? "Live streaming is unavailable on this device."}
        </div>
      </Show>
    </div>
  );
};


/** Retain both presentations; hiding Compose must not dispose the device mirror. */
const AndroidPreview: Component<{ active: boolean; info: AndroidCliInfo | null; refreshInfo: () => void }> = (props) => {
  const [mode, setMode] = createSignal<"device" | "compose">("device");
  const [visited, setVisited] = createSignal(false);
  createEffect(() => { if (mode() === "compose") setVisited(true); });
  return <div class="android-preview">
    <div class="android-bar" role="tablist" aria-label="Android preview mode">
      <button role="tab" aria-selected={mode() === "device"} class="android-avd-btn" onClick={() => setMode("device")}>Device</button>
      <button role="tab" aria-selected={mode() === "compose"} class="android-avd-btn" onClick={() => setMode("compose")}>Compose</button>
      <span class="android-bar-gap" />
      <button class="link-btn android-cli-version" title="Recheck Android CLI installation" onClick={props.refreshInfo}>{props.info?.version ? `Android CLI ${props.info.version}` : props.info ? "Android CLI unavailable · Retry" : "Checking Android CLI…"}</button>
    </div>
    <div class="android-retained" style={{ display: mode() === "device" ? "flex" : "none" }}>
      <AndroidDevicePreview active={props.active && mode() === "device"} info={props.info} />
    </div>
    <Show when={visited()}><div class="android-retained" style={{ display: mode() === "compose" ? "flex" : "none" }}>
      <AndroidCliPanel mode="compose" info={props.info} serial={null} />
    </div></Show>
  </div>;
};

const AndroidCliPanel: Component<{ mode: "compose" | "inspect"; info: AndroidCliInfo | null; serial: string | null }> = (props) => {
  const [target, setTarget] = createSignal(":app");
  const [previews, setPreviews] = createSignal<AndroidPreviewFunction[]>([]);
  const [fqn, setFqn] = createSignal("");
  const [result, setResult] = createSignal<AndroidCliResult | null>(null);
  const [imagePath, setImagePath] = createSignal("");
  const [selectedNode, setSelectedNode] = createSignal(-1);
  const [imageSize, setImageSize] = createSignal<[number, number]>([0, 0]);
  const nodes = createMemo(() => props.mode === "inspect" ? androidInspectionNodes(result()?.context?.data) : []);
  createEffect(on(result, () => { setSelectedNode(-1); setImageSize([0, 0]); }));
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal("");
  const [owner, setOwner] = createSignal("");
  let generation = 0;
  let job: string | null = null;
  const conversation = () => `${effectiveRoot() ?? ""}:${chat.activeId ?? `new:${chat.draftProject ?? ""}`}`;
  const supported = () => props.mode === "compose" ? props.info?.previews : props.info?.inspect;
  const images = () => result()?.artifacts?.filter(a => a.kind === "image") ?? [];
  const [source] = createResource(imagePath, async path => {
    if (!path) return null;
    try { return await prepareAttachmentPreview(path); }
    catch (e) { if (path === imagePath()) setError(String(e)); return null; }
  });
  function cancel() {
    generation++;
    if (job) void androidCliCancel(job).catch(e => toast(String(e), "error"));
    job = null;
    setBusy("");
  }
  function reset() {
    cancel(); setResult(null); setImagePath(""); setPreviews([]); setFqn(""); setError(""); setTarget(":app");
  }
  createEffect(on(() => [effectiveRoot(), props.serial] as const, reset));
  createEffect(on(() => props.info?.modules.join("|"), () => {
    if (props.info?.modules.length && target() === ":app" && !previews().length && !busy()) setTarget(props.info.modules.includes(":app") ? ":app" : props.info.modules[0]);
  }));
  onCleanup(cancel);
  async function run(action: "list" | "render" | "inspect") {
    if (busy()) return;
    const root = effectiveRoot();
    if (!root) return;
    const token = ++generation;
    const request = { target: target(), fqn: fqn(), serial: props.serial ?? "" };
    const destination = conversation();
    setBusy(action); setError("");
    try {
      const id = await androidCliBegin();
      if (token !== generation) await androidCliCancel(id);
      else job = id;
      // Always consume the reserved job, including cancellation during begin.
      const next = await androidCliRun(id, root, action, request.target, request.fqn, request.serial);
      if (token !== generation || root !== effectiveRoot()) return;
      if (action === "list") {
        const found = next.previews ?? [];
        setPreviews(found); setFqn(found[0]?.methodFqn ?? "");
        if (!found.length) setError("No Compose previews found in this target.");
      } else {
        setResult(next); setOwner(destination);
        setImagePath(next.artifacts?.find(a => a.kind === "image")?.path ?? "");
      }
    } catch (e) { if (token === generation) setError(String(e)); }
    finally { if (token === generation) { setBusy(""); job = null; } }
  }
  const [attaching, setAttaching] = createSignal(false);
  async function attach() {
    const all = result()?.artifacts ?? [];
    // MultiPreview may render many variants. Attach the selected image and its
    // component tree, with shared provenance, rather than overflowing the composer.
    const data = result()?.context?.data as { results?: { imagePath?: string; componentTreePath?: string }[] } | undefined;
    const selected = data?.results?.find(r => r.imagePath === imagePath());
    const items = all.filter(a => a.path === imagePath() || a.path === selected?.componentTreePath || a.name === "context.json");
    const node = nodes()[selectedNode()];
    const destination = owner();
    if (destination !== conversation()) { toast("Return to the conversation that requested this capture", "info"); return; }
    if (items.length + (node ? 1 : 0) + attachments().length > MAX_ATTACHMENTS) { setError(`This capture needs ${items.length} attachment slots. Remove attachments first.`); return; }
    setAttaching(true);
    try {
      if (node) {
        const content = new Blob([JSON.stringify({ selected_element: node.properties, capture: result()?.context?.capture_started_ms, device: result()?.context?.device }, null, 2)], { type: "application/json" });
        items.push(await savePastedAttachment(await blobToBase64(content), "json"));
      }
      // Recheck after saving metadata: the user may have changed conversations.
      if (destination === conversation() && items.length + attachments().length <= MAX_ATTACHMENTS) { addAttachments(items); toast("Capture attached to chat", "success"); }
    } catch (e) { setError(String(e)); } finally { setAttaching(false); }
  }
  return <section classList={{ "android-cli-panel": true, "android-inspect-panel": props.mode === "inspect" }} aria-label={props.mode === "compose" ? "Compose previews" : "Screen inspection"}>
    <Show when={supported()} fallback={props.mode === "compose" ? <div class="pane-empty">
      <p>Compose previews need Android CLI.</p><p class="pane-empty-sub">{props.info?.error ?? "Install or update Android CLI, then recheck using the status above."}</p>
      <a href="https://developer.android.com/tools/agents/android-cli" target="_blank" rel="noreferrer">Android CLI setup</a>
    </div> : null}>
      <div class="android-bar">
        <Show when={props.mode === "compose"}>
          <input class="android-select" aria-label="Gradle target" value={target()} list="android-compose-targets" disabled={!!busy()} onChange={e => { reset(); setTarget(e.currentTarget.value); }} />
          <datalist id="android-compose-targets"><For each={props.info?.modules ?? []}>{m => <option value={m} />}</For></datalist>
          <button class="android-avd-btn" disabled={!!busy()} onClick={() => void run("list")}>Discover</button>
        </Show>
        <Show when={props.mode === "inspect"}>
          <button class="android-avd-btn" disabled={!!busy() || !props.serial} onClick={() => void run("inspect")}>{result() ? "Refresh inspection" : "Inspect screen"}</button>
        </Show>
        <Show when={busy()}><Spinner size={14} /><span>{busy() === "list" ? "Discovering…" : busy() === "render" ? "Rendering…" : "Capturing…"}</span><button class="link-btn" onClick={cancel}>Cancel</button></Show>
        <Show when={result()}><button class="link-btn" onClick={() => { setResult(null); setImagePath(""); }}>Close</button></Show>
      </div>
      <Show when={props.mode === "compose" && previews().length}>
        <div class="android-bar">
          <select class="android-select" aria-label="Compose preview function" value={fqn()} disabled={!!busy()} onChange={e => setFqn(e.currentTarget.value)}>
            <For each={previews()}>{p => <option value={p.methodFqn}>{p.name ? `${p.name} · ` : ""}{p.methodFqn}</option>}</For>
          </select>
          <button class="android-avd-btn" disabled={!!busy() || !fqn()} onClick={() => void run("render")}>Render</button>
        </div>
      </Show>
      <Show when={error()}><p class="android-cli-error" role="alert">{error()}</p></Show>
      <Show when={result()}>
        <div class="android-cli-results">
          <Show when={images().length > 1}><select class="android-select" aria-label="Rendered image" value={imagePath()} onChange={e => setImagePath(e.currentTarget.value)}><For each={images()}>{a => <option value={a.path}>{a.name}</option>}</For></select></Show>
          <Show when={source()}>{src => <div class="android-inspection-image">
            <img class="android-cli-image" src={convertFileSrc(src().path)} alt={props.mode === "compose" ? "Rendered Compose preview" : "Captured Android screen"} onLoad={e => setImageSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} />
            <Show when={props.mode === "inspect" && imageSize()[0] > 0}>
              <svg class="android-inspection-overlay" viewBox={`0 0 ${imageSize()[0]} ${imageSize()[1]}`} aria-hidden="true">
                <For each={nodes()}>{(node, index) => <Show when={node.bounds}>{b => <rect x={b()[0]} y={b()[1]} width={b()[2] - b()[0]} height={b()[3] - b()[1]} classList={{ selected: selectedNode() === index() }} onClick={() => setSelectedNode(index())}><title>{node.label}</title></rect>}</Show>}</For>
              </svg>
            </Show>
          </div>}</Show>
          <Show when={nodes().length}>
            <select class="android-select" aria-label="Inspect UI element" value={selectedNode()} onChange={e => setSelectedNode(Number(e.currentTarget.value))}>
              <option value={-1}>Select an element</option><For each={nodes()}>{(node, i) => <option value={i()}>{i() + 1}. {node.label.slice(0, 100)}</option>}</For>
            </select>
            <Show when={nodes()[selectedNode()]}>{node => <pre class="android-cli-json">{JSON.stringify(node().properties, null, 2)}</pre>}</Show>
          </Show>
          <p class="android-note">Captured {new Date(result()!.context!.capture_started_ms).toLocaleTimeString()}{props.mode === "inspect" ? " · Screenshot and layout captured separately." : " · Refresh after code changes."}</p>
          <details><summary>{props.mode === "inspect" ? "Screen hierarchy" : "Preview context"}</summary><pre class="android-cli-json">{JSON.stringify(result()?.context, null, 2)}</pre></details>
          <button class="android-avd-btn" disabled={attaching() || owner() !== conversation()} onClick={() => void attach()}>Attach to chat</button>
          <Show when={owner() !== conversation()}><p class="android-note">Return to the original conversation to attach this capture.</p></Show>
        </div>
      </Show>
    </Show>
  </section>;
};

export default AndroidPreview;
