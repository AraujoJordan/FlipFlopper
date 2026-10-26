import { Component, For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  detectIosEnvironment,
  iosBootSimulator,
  iosRecordStart,
  iosRecordStop,
  openIosSimulator,
  savePastedAttachment,
  type Attachment,
  type IosEnvironment,
} from "../../lib/ipc";
import { blobToBase64, canvasToBlob } from "../../lib/androidMirror";
import { IOS_KEY, createIosMirror } from "../../lib/iosMirror";
import { addAttachments } from "../../lib/attachments";
import { layout } from "../../lib/layout";
import { addTerminal, effectiveRoot } from "../../lib/store";
import { Icon } from "../shell/Icon";
import { Spinner, toast } from "../ui";

const POLL_MS = 4000;
const SHOWN_SIMULATORS = 6;
const IDB_HINT = "brew install facebook/fb/idb-companion && pip3 install fb-idb";

/** Live iOS Simulator inside the Preview tab. Screenshots and video work with
 *  plain `simctl`; the live stream and touch/keyboard input need `idb`. */
const IosPreview: Component = () => {
  const [env, setEnv] = createSignal<IosEnvironment | null>(null);
  const [udid, setUdid] = createSignal<string | null>(null);
  const [booting, setBooting] = createSignal<string | null>(null);
  const [recordSeconds, setRecordSeconds] = createSignal(0);
  let canvas: HTMLCanvasElement | undefined;
  let recordTimer: ReturnType<typeof setInterval> | null = null;
  let recordingUdid: string | null = null;

  const mirror = createIosMirror(() => canvas);
  const projectPath = () => effectiveRoot() ?? "";
  const visible = () => layout.sideOpen && layout.sideTab === "preview";
  const booted = createMemo(() => (env()?.simulators ?? []).filter((s) => s.state === "Booted"));
  const bootable = createMemo(() =>
    (env()?.simulators ?? []).filter((s) => s.state !== "Booted" && s.name.includes("iPhone")).slice(0, SHOWN_SIMULATORS));
  const hasIdb = createMemo(() => !!env()?.idb_path);
  const live = () => mirror.status() === "live";

  async function refreshEnv() {
    const path = projectPath();
    if (!path) return;
    try {
      const next = await detectIosEnvironment(path);
      if (path === projectPath()) setEnv(next);
    } catch { /* keep the last good environment */ }
  }

  onMount(() => {
    void refreshEnv();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (visible() && !booting()) await refreshEnv();
      timer = setTimeout(tick, live() ? POLL_MS * 4 : POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    onCleanup(() => clearTimeout(timer));
  });

  // Keep the selection on a booted simulator (preferring the current one).
  createEffect(() => {
    const list = booted();
    const current = udid();
    if (current && list.some((s) => s.udid === current)) return;
    const preferred = env()?.selected_simulator;
    setUdid(list.find((s) => s.udid === preferred)?.udid ?? list[0]?.udid ?? null);
  });

  function connect() {
    const target = udid();
    if (target) void mirror.start({ udid: target, allowStream: hasIdb() });
  }
  // Memoized so a poll that changes nothing does not restart the mirror.
  createEffect(on([udid, hasIdb], () => { if (udid()) connect(); else void mirror.stop(); }));
  createEffect(() => mirror.setPaused(!visible()));

  onCleanup(() => {
    if (recordTimer) clearInterval(recordTimer);
    if (recordingUdid) void iosRecordStop(recordingUdid).catch(() => {});
    void mirror.stop();
  });

  // ── capture ────────────────────────────────────────────────────────────────

  function offerAttachment(attachment: Attachment, label: string) {
    toast(`${label} saved`, "success", {
      actionLabel: "Attach to chat",
      onAction: () => addAttachments([attachment]),
    });
  }

  async function screenshot() {
    if (!canvas || !live()) return;
    const blob = await canvasToBlob(canvas);
    if (!blob) { toast("Screenshot failed", "error"); return; }
    try {
      offerAttachment(await savePastedAttachment(await blobToBase64(blob), "png"), "Screenshot");
    } catch (e) {
      toast(`Screenshot failed: ${String(e)}`, "error");
    }
  }

  async function toggleRecording() {
    if (recordingUdid) {
      const target = recordingUdid;
      recordingUdid = null;
      if (recordTimer) clearInterval(recordTimer);
      recordTimer = null;
      setRecordSeconds(0);
      try {
        offerAttachment(await iosRecordStop(target), "Recording");
      } catch (e) {
        toast(`Recording failed: ${String(e)}`, "error");
      }
      return;
    }
    const target = udid();
    if (!target) return;
    try {
      await iosRecordStart(target);
    } catch (e) {
      toast(`Recording failed: ${String(e)}`, "error");
      return;
    }
    recordingUdid = target;
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
  const canTouch = () => live() && mirror.interactive();

  const onPointerDown = (event: PointerEvent) => {
    if (!canvas) return;
    canvas.focus();
    if (!canTouch()) return;
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = normalized(event);
    mirror.pointer("down", x, y);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!canTouch() || !canvas?.hasPointerCapture(event.pointerId)) return;
    const [x, y] = normalized(event);
    mirror.pointer("up", x, y);
    canvas.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent) => {
    if (!canTouch()) return;
    event.preventDefault();
    const [x, y] = normalized(event);
    mirror.wheel(x, y, event.deltaY);
  };

  const SPECIAL_KEYS: Record<string, number> = {
    Enter: IOS_KEY.enter,
    Backspace: IOS_KEY.backspace,
    Tab: IOS_KEY.tab,
    Escape: IOS_KEY.escape,
    ArrowUp: IOS_KEY.up,
    ArrowDown: IOS_KEY.down,
    ArrowLeft: IOS_KEY.left,
    ArrowRight: IOS_KEY.right,
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!canTouch() || event.metaKey || event.ctrlKey || event.altKey) return;
    const special = SPECIAL_KEYS[event.key];
    if (special !== undefined) mirror.key(special);
    else if (event.key.length === 1) mirror.text(event.key);
    else return;
    event.preventDefault();
  };

  // ── simulators ─────────────────────────────────────────────────────────────

  async function bootHere(target: string, name: string) {
    if (booting()) return;
    setBooting(name);
    try {
      await iosBootSimulator(target);
      await refreshEnv();
      setUdid(target);
    } catch (e) {
      toast(`Boot simulator failed: ${String(e)}`, "error");
    } finally {
      setBooting(null);
    }
  }

  async function openWindow(target?: string) {
    const path = projectPath();
    if (!path) return;
    try {
      const sessionId = await openIosSimulator(path, target);
      addTerminal({ sessionId, label: "iOS · Simulator", kind: "run" });
    } catch (e) {
      toast(`Open Simulator failed: ${String(e)}`, "error");
    }
  }

  const ToolButton: Component<{ icon: Parameters<typeof Icon>[0]["name"]; title: string; onClick: () => void; disabled?: boolean }> = (props) => (
    <button class="icon-btn android-tool" title={props.title} aria-label={props.title} disabled={props.disabled} onClick={props.onClick}>
      <Icon name={props.icon} size={15} />
    </button>
  );

  return (
    <div class="android-preview">
      <div class="android-bar">
        <select
          class="android-select"
          aria-label="iOS simulator"
          disabled={booted().length === 0}
          value={udid() ?? ""}
          onChange={(e) => setUdid(e.currentTarget.value)}
        >
          <Show when={booted().length > 0} fallback={<option value="">No simulator booted</option>}>
            <For each={booted()}>{(s) => <option value={s.udid}>{s.name}</option>}</For>
          </Show>
        </select>
        <ToolButton icon="home" title="Home" disabled={!canTouch()} onClick={() => mirror.button("HOME")} />
        <ToolButton icon="lock" title="Lock" disabled={!canTouch()} onClick={() => mirror.button("LOCK")} />
        <span class="android-bar-gap" />
        <ToolButton icon="camera" title="Screenshot" disabled={!live()} onClick={() => void screenshot()} />
        <button
          class="icon-btn android-tool android-record"
          classList={{ "is-recording": recordingActive() }}
          title={recordingActive() ? "Stop recording" : "Record video"}
          aria-label={recordingActive() ? "Stop recording" : "Record video"}
          disabled={!udid()}
          onClick={() => void toggleRecording()}
        >
          <Icon name={recordingActive() ? "stop" : "record"} size={15} />
          <Show when={recordingActive()}><span class="android-record-time">{clock()}</span></Show>
        </button>
        <ToolButton icon="external" title="Open in Simulator" disabled={!udid()} onClick={() => void openWindow(udid() ?? undefined)} />
      </div>

      <div class="android-stage">
        <Show
          when={udid()}
          fallback={
            <div class="pane-empty">
              <Icon name="device" size={28} />
              <p>{booting() ? `Booting ${booting()}…` : "No iOS simulator is running."}</p>
              <Show when={booting()}><Spinner size={16} /></Show>
              <Show when={!booting() && bootable().length > 0}>
                <p class="pane-empty-sub">Boot a simulator and it will appear here.</p>
                <div class="android-avds">
                  <For each={bootable()}>
                    {(sim) => (
                      <div class="android-avd">
                        <span>{sim.name}</span>
                        <button class="android-avd-btn" onClick={() => void bootHere(sim.udid, sim.name)}>Boot here</button>
                        <button class="link-btn" onClick={() => void openWindow(sim.udid)}>With window</button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <For each={env()?.issues ?? []}>{(issue) => <p class="pane-empty-sub">{issue}</p>}</For>
            </div>
          }
        >
          <canvas
            ref={canvas}
            class="android-canvas"
            classList={{ "is-live": canTouch() }}
            tabindex={0}
            aria-label="iOS simulator screen"
            onPointerDown={onPointerDown}
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

      <Show when={udid() && mirror.status() !== "idle" && !mirror.interactive()}>
        <div class="android-note">
          View-only snapshots.{" "}
          {env() && !hasIdb()
            ? <>Install idb for a live stream and touch input: <code>{IDB_HINT}</code></>
            : mirror.error() ?? "The idb stream is unavailable."}
        </div>
      </Show>
      <Show when={(env()?.physical_devices.length ?? 0) > 0 && !udid()}>
        <div class="android-note">Physical iPhones can't be mirrored here; run on a simulator to preview.</div>
      </Show>
    </div>
  );
};

export default IosPreview;
