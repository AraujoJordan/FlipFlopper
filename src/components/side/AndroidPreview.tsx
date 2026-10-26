import { Component, For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  bootAndroidEmulator,
  detectAndroidEnvironment,
  savePastedAttachment,
  startAndroidScrcpy,
  type AndroidDevice,
  type AndroidEnvironment,
} from "../../lib/ipc";
import {
  ANDROID_KEY,
  blobToBase64,
  canvasToBlob,
  createMirror,
  startCanvasRecording,
} from "../../lib/androidMirror";
import { addAttachments } from "../../lib/attachments";
import { layout } from "../../lib/layout";
import { addTerminal, effectiveRoot, readAndroidDevices, writeAndroidDevice } from "../../lib/store";
import { Icon } from "../shell/Icon";
import { Spinner, toast } from "../ui";

const POLL_MS = 2500;
const MAX_BOOT_RETRIES = 6;

const deviceLabel = (device: AndroidDevice) =>
  device.model ? `${device.model} (${device.serial})` : device.serial;

/** Live Android device/emulator inside the Preview tab: mirrors the screen,
 *  forwards touch/keyboard, and captures screenshots and video. */
const AndroidPreview: Component = () => {
  const [env, setEnv] = createSignal<AndroidEnvironment | null>(null);
  const [serial, setSerial] = createSignal<string | null>(null);
  const [booting, setBooting] = createSignal<string | null>(null);
  const [recordSeconds, setRecordSeconds] = createSignal(0);
  let canvas: HTMLCanvasElement | undefined;
  let recording: ReturnType<typeof startCanvasRecording> | null = null;
  let recordTimer: ReturnType<typeof setInterval> | null = null;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const mirror = createMirror(() => canvas);
  const projectPath = () => effectiveRoot() ?? "";
  const visible = () => layout.sideOpen && layout.sideTab === "preview";
  const onlineDevices = createMemo(() => (env()?.devices ?? []).filter((d) => d.status === "device"));

  async function refreshEnv() {
    const path = projectPath();
    if (!path) return;
    try {
      const next = await detectAndroidEnvironment(path);
      if (path === projectPath()) setEnv(next);
    } catch { /* keep the last good environment */ }
  }

  onMount(() => {
    void refreshEnv();
    // Poll so a plugged-in phone or a booting emulator shows up on its own;
    // slow down once a device is streaming.
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (visible()) await refreshEnv();
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
    if (current && online.some((d) => d.serial === current)) return;
    const saved = readAndroidDevices()[projectPath()];
    const next = online.find((d) => d.serial === saved)?.serial
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
    retries = 0;
    if (serial()) connect();
    else void mirror.stop();
  }));

  // A freshly booted emulator is listed before it can serve a stream: retry.
  createEffect(() => {
    if (mirror.status() !== "error" || !booting() || retries >= MAX_BOOT_RETRIES) return;
    retries++;
    retryTimer = setTimeout(connect, 3000);
  });
  createEffect(() => { if (mirror.status() === "live") setBooting(null); });

  createEffect(() => mirror.setPaused(!visible()));

  onCleanup(() => {
    if (retryTimer) clearTimeout(retryTimer);
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

  // ── devices & emulators ────────────────────────────────────────────────────

  function chooseDevice(value: string) {
    setSerial(value);
    writeAndroidDevice(projectPath(), value);
  }

  async function bootAvd(avd: string, headless: boolean) {
    const path = projectPath();
    if (!path || booting()) return;
    setBooting(avd);
    retries = 0;
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

export default AndroidPreview;
