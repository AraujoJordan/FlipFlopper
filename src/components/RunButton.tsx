import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  bootAndroidEmulator,
  detectAndroidEnvironment,
  detectIosEnvironment,
  detectRunTargets,
  onPtyExit,
  openIosSimulator,
  ptyKill,
  runAndroidDeviceAction,
  runProject,
  sendAndroidDeeplink,
  startAndroidLogcat,
  startAndroidScrcpy,
  type AndroidDeviceAction,
  type AndroidEnvironment,
  type IosEnvironment,
  type RunTarget,
  triggerHaptic,
} from "../lib/ipc";
import {
  addTerminal,
  readAndroidDevices,
  readRunTargets,
  setRunSessionId,
  store,
  writeAndroidDevice,
  writeRunTarget,
} from "../lib/store";
import { Menu, MenuItem, MenuLabel, Spinner, toast } from "./ui";

const PlayIcon: Component<{ color?: string }> = (props) => (
  <svg width="13" height="13" viewBox="0 0 24 24" style={{ color: props.color ?? "currentColor", flex: "0 0 auto" }}>
    <path d="M8 5v14l11-7z" fill="currentColor" />
  </svg>
);

const StopIcon: Component<{ pulse?: boolean }> = (props) => (
  <svg
    class={props.pulse ? "running-pulse" : undefined}
    width="12" height="12" viewBox="0 0 24 24" style={{ color: "var(--status-del)", flex: "0 0 auto" }}
  >
    <path d="M7 7h10v10H7z" fill="currentColor" />
  </svg>
);

const ChevronIcon: Component<{ open?: boolean }> = (props) => (
  <svg
    width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"
    style={{
      flex: "0 0 auto",
      transform: props.open ? "rotate(180deg)" : "rotate(0deg)",
      transition: "transform var(--dur-base) var(--ease-standard)",
    }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const shortLabel = (target: RunTarget) => target.label.split(" - ")[0] || target.id;

const emulatorHint = (target: RunTarget) => {
  if (target.needs_emulator === "android") return "Android device/emulator";
  if (target.needs_emulator === "ios") return "iOS device/simulator";
  return "";
};

const actionChipStyle = (enabled: boolean) => ({
  padding: "3px 8px",
  "border-radius": "6px",
  border: "1px solid var(--border-muted)",
  color: enabled ? "var(--fg-muted)" : "var(--fg-faint)",
  background: "transparent",
  "font-size": "10.5px",
  cursor: enabled ? "pointer" : "default",
  "flex-shrink": 0,
} as const);

const isAndroidTarget = (target: RunTarget) =>
  target.needs_emulator === "android" || target.kind === "android";
const isIosTarget = (target: RunTarget) =>
  target.needs_emulator === "ios" || target.kind === "ios";

const RunButton: Component = () => {
  const [targets, setTargets] = createSignal<RunTarget[]>([]);
  const [androidEnv, setAndroidEnv] = createSignal<AndroidEnvironment | null>(null);
  const [androidEnvLoading, setAndroidEnvLoading] = createSignal(false);
  const [startingScrcpy, setStartingScrcpy] = createSignal(false);
  const [selectedSerial, setSelectedSerial] = createSignal<string | null>(null);
  const [bootingAvd, setBootingAvd] = createSignal(false);
  const [startingLogcat, setStartingLogcat] = createSignal(false);
  const [deviceActionBusy, setDeviceActionBusy] = createSignal<AndroidDeviceAction | null>(null);
  const [deeplinkUri, setDeeplinkUri] = createSignal("");
  const [sendingDeeplink, setSendingDeeplink] = createSignal(false);
  const [iosEnv, setIosEnv] = createSignal<IosEnvironment | null>(null);
  const [iosEnvLoading, setIosEnvLoading] = createSignal(false);
  const [openingSimulator, setOpeningSimulator] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [detecting, setDetecting] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  let toggleRef: HTMLDivElement | undefined;
  let runExitUnlisten: (() => void) | null = null;
  let loadSeq = 0;
  let androidEnvSeq = 0;
  let iosEnvSeq = 0;

  const projectPath = () => store.currentProject?.path ?? "";
  const running = () => store.runSessionId !== null;
  const busy = () => detecting() || starting();
  // Memoize platform presence so a target refresh with the same platforms does
  // not launch duplicate adb/xcrun probes. Android and iOS still load in
  // parallel and update their sections independently.
  const hasAndroidTargets = createMemo(() => targets().some(isAndroidTarget));
  const hasIosTargets = createMemo(() => targets().some(isIosTarget));

  const preferredTarget = () => {
    const list = targets();
    if (list.length === 0) return null;
    const path = projectPath();
    const savedId = path ? readRunTargets()[path] : undefined;
    return list.find((target) => target.id === savedId) ?? list[0];
  };

  async function loadTargets(path: string) {
    const seq = ++loadSeq;
    setDetecting(true);
    try {
      const next = await detectRunTargets(path);
      if (seq === loadSeq) setTargets(next);
    } catch (e) {
      if (seq === loadSeq) {
        setTargets([]);
        toast(`Run detection failed: ${String(e)}`, "error");
      }
    } finally {
      if (seq === loadSeq) setDetecting(false);
    }
  }

  async function loadAndroidEnvironment(path: string) {
    const seq = ++androidEnvSeq;
    setAndroidEnvLoading(true);
    try {
      const env = await detectAndroidEnvironment(path);
      if (seq === androidEnvSeq) setAndroidEnv(env);
    } catch {
      if (seq === androidEnvSeq) setAndroidEnv(null);
    } finally {
      if (seq === androidEnvSeq) setAndroidEnvLoading(false);
    }
  }

  async function loadIosEnvironment(path: string) {
    const seq = ++iosEnvSeq;
    setIosEnvLoading(true);
    try {
      const env = await detectIosEnvironment(path);
      if (seq === iosEnvSeq) setIosEnv(env);
    } catch {
      if (seq === iosEnvSeq) setIosEnv(null);
    } finally {
      if (seq === iosEnvSeq) setIosEnvLoading(false);
    }
  }

  createEffect(() => {
    const path = projectPath();
    runExitUnlisten?.();
    runExitUnlisten = null;
    setRunSessionId(null);
    setMenuOpen(false);
    setTargets([]);
    setAndroidEnv(null);
    setIosEnv(null);
    if (path) void loadTargets(path);
  });

  createEffect(() => {
    const path = projectPath();
    const hasIos = hasIosTargets();
    if (path && menuOpen() && hasIos) {
      void loadIosEnvironment(path);
    } else if (!path || !hasIos) {
      setIosEnv(null);
    }
  });

  createEffect(() => {
    const path = projectPath();
    const hasAndroid = hasAndroidTargets();
    if (path && menuOpen() && hasAndroid) {
      void loadAndroidEnvironment(path);
    } else if (!path || !hasAndroid) {
      setAndroidEnv(null);
    }
  });

  // Keep the picked device in sync with the loaded environment: prefer the
  // project's persisted choice if it's still online, else the auto-selected
  // device.
  createEffect(() => {
    const env = androidEnv();
    const path = projectPath();
    if (!env || !path) {
      setSelectedSerial(null);
      return;
    }
    const saved = readAndroidDevices()[path];
    const savedIsOnline = env.devices.some((d) => d.serial === saved && d.status === "device");
    setSelectedSerial(savedIsOnline ? saved : env.selected_device);
  });

  onCleanup(() => {
    runExitUnlisten?.();
    runExitUnlisten = null;
  });

  async function startTarget(target: RunTarget) {
    const path = projectPath();
    if (!path || starting()) return;
    setMenuOpen(false);
    setStarting(true);
    void triggerHaptic("generic");
    try {
      const sessionId = await runProject(path, target.id, selectedSerial() ?? undefined);
      writeRunTarget(path, target.id);
      addTerminal({
        sessionId,
        label: `Run · ${shortLabel(target)}`,
        kind: "run",
      });
      setRunSessionId(sessionId);
      runExitUnlisten?.();
      runExitUnlisten = await onPtyExit(sessionId, () => {
        if (store.runSessionId === sessionId) {
          setRunSessionId(null);
          void triggerHaptic("alignment");
        }
        runExitUnlisten?.();
        runExitUnlisten = null;
      });
    } catch (e) {
      toast(`Run failed: ${String(e)}`, "error");
    } finally {
      setStarting(false);
    }
  }

  async function stopRun() {
    const sessionId = store.runSessionId;
    if (!sessionId) return;
    void triggerHaptic("levelChange");
    try {
      await ptyKill(sessionId);
    } catch (e) {
      toast(`Stop failed: ${String(e)}`, "error");
      setRunSessionId(null);
      runExitUnlisten?.();
      runExitUnlisten = null;
    }
  }

  async function startScrcpy() {
    const path = projectPath();
    const serial = selectedSerial();
    if (!path || !serial || startingScrcpy()) return;
    setStartingScrcpy(true);
    try {
      const sessionId = await startAndroidScrcpy(path, serial);
      addTerminal({
        sessionId,
        label: `Android · scrcpy`,
        kind: "run",
      });
    } catch (e) {
      toast(`scrcpy failed: ${String(e)}`, "error");
    } finally {
      setStartingScrcpy(false);
    }
  }

  async function selectDeviceOrAvd(value: string) {
    const path = projectPath();
    if (!path || !value) return;
    if (value.startsWith("device:")) {
      const serial = value.slice("device:".length);
      setSelectedSerial(serial);
      writeAndroidDevice(path, serial);
      return;
    }
    if (value.startsWith("avd:")) {
      const avd = value.slice("avd:".length);
      if (bootingAvd()) return;
      setBootingAvd(true);
      try {
        const sessionId = await bootAndroidEmulator(path, avd);
        addTerminal({ sessionId, label: `Android · Boot ${avd}`, kind: "run" });
      } catch (e) {
        toast(`Boot emulator failed: ${String(e)}`, "error");
      } finally {
        setBootingAvd(false);
      }
    }
  }

  async function startLogcat() {
    const path = projectPath();
    const serial = selectedSerial();
    if (!path || !serial || startingLogcat()) return;
    setStartingLogcat(true);
    try {
      const sessionId = await startAndroidLogcat(path, serial);
      addTerminal({ sessionId, label: "Android · Logcat", kind: "run" });
    } catch (e) {
      toast(`Logcat failed: ${String(e)}`, "error");
    } finally {
      setStartingLogcat(false);
    }
  }

  const deviceActionLabel = (action: AndroidDeviceAction) => {
    switch (action) {
      case "force-stop": return "Force-stop";
      case "clear-data": return "Clear data";
      case "uninstall": return "Uninstall";
      case "restart": return "Restart";
      case "screenshot": return "Screenshot";
      case "screenrecord": return "Screen record";
    }
  };

  async function runDeviceAction(action: AndroidDeviceAction) {
    const path = projectPath();
    const serial = selectedSerial();
    if (!path || !serial || deviceActionBusy() !== null) return;
    setDeviceActionBusy(action);
    try {
      const sessionId = await runAndroidDeviceAction(path, action, serial);
      addTerminal({ sessionId, label: `Android · ${deviceActionLabel(action)}`, kind: "run" });
    } catch (e) {
      toast(`${deviceActionLabel(action)} failed: ${String(e)}`, "error");
    } finally {
      setDeviceActionBusy(null);
    }
  }

  async function openDeeplink() {
    const path = projectPath();
    const serial = selectedSerial();
    const uri = deeplinkUri().trim();
    if (!path || !serial || !uri || sendingDeeplink()) return;
    setSendingDeeplink(true);
    try {
      const sessionId = await sendAndroidDeeplink(path, uri, serial);
      addTerminal({ sessionId, label: "Android · Deep link", kind: "run" });
      setDeeplinkUri("");
    } catch (e) {
      toast(`Deep link failed: ${String(e)}`, "error");
    } finally {
      setSendingDeeplink(false);
    }
  }

  async function openSimulator() {
    const path = projectPath();
    const env = iosEnv();
    if (!path || !env?.selected_simulator || openingSimulator()) return;
    setOpeningSimulator(true);
    try {
      const sessionId = await openIosSimulator(path, env.selected_simulator);
      addTerminal({
        sessionId,
        label: "iOS · Simulator",
        kind: "run",
      });
    } catch (e) {
      toast(`Simulator failed: ${String(e)}`, "error");
    } finally {
      setOpeningSimulator(false);
    }
  }

  async function handleMainClick() {
    if (running()) {
      await stopRun();
      return;
    }
    const target = preferredTarget();
    if (!target) return;
    await startTarget(target);
  }

  const mainTitle = () => {
    if (!projectPath()) return "Open a project to run";
    if (running()) {
      const target = preferredTarget();
      return target ? `Stop ${shortLabel(target)}` : "Stop run";
    }
    if (detecting()) return "Detecting runnable targets";
    return preferredTarget()?.label ?? "No runnable target detected";
  };

  const androidStatus = () => {
    if (androidEnvLoading()) {
      return { tone: "muted", title: "Checking Android devices", detail: "" };
    }
    const env = androidEnv();
    if (!env) return null;
    if (env.selected_device) {
      const device = env.devices.find((d) => d.serial === env.selected_device);
      const label = device?.kind === "physical" ? "Physical device" : "Emulator";
      return { tone: "ready", title: `${label} ready`, detail: env.selected_device };
    }
    if (env.issues.length > 0) {
      return { tone: "error", title: "Android not ready", detail: env.issues[0] };
    }
    if (env.selected_avd) {
      return { tone: "ready", title: "Will boot emulator", detail: env.selected_avd };
    }
    return { tone: "muted", title: "No Android device found", detail: "Connect a device or create an emulator." };
  };

  const iosStatus = () => {
    if (iosEnvLoading()) {
      return { tone: "muted", title: "Checking iOS devices", detail: "" };
    }
    const env = iosEnv();
    if (!env) return null;
    if (env.selected_device) {
      const device = env.physical_devices.find((d) => d.udid === env.selected_device);
      return { tone: "ready", title: "Physical device ready", detail: device?.name ?? env.selected_device };
    }
    if (env.selected_simulator) {
      const simulator = env.simulators.find((d) => d.udid === env.selected_simulator);
      const state = simulator?.state === "Booted" ? "ready" : "will boot";
      return { tone: "ready", title: `Simulator ${state}`, detail: simulator?.name ?? env.selected_simulator };
    }
    if (env.issues.length > 0) {
      return { tone: "error", title: "iOS not ready", detail: env.issues[0] };
    }
    return { tone: "muted", title: "No iOS simulator found", detail: "Install a simulator in Xcode." };
  };

  return (
    <div ref={toggleRef} style={{ position: "relative", display: "flex", "align-items": "center" }}>
      <div style={{
        display: "flex",
        "align-items": "center",
        height: "25px",
        background: "var(--surface-3)",
        border: "1px solid var(--border-muted)",
        "border-radius": "var(--radius-md)",
        overflow: "hidden",
      }}>
        <button
          class="hover-tint press"
          onclick={handleMainClick}
          disabled={!projectPath() || (!running() && targets().length === 0) || busy()}
          title={mainTitle()}
          aria-label={mainTitle()}
          style={{
            height: "23px",
            width: "29px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            color: running()
              ? "var(--status-del)"
              : targets().length > 0
                ? "var(--status-add)"
                : "var(--fg-faint)",
            cursor: !projectPath() || (!running() && targets().length === 0) || busy() ? "default" : "pointer",
          }}
        >
          <div style={{ position: "relative", width: "13px", height: "13px", display: "flex", "align-items": "center", "justify-content": "center" }}>
            <span class="icon-fade" classList={{ "icon-fade-visible": busy() }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <Spinner size={12} color="var(--status-add)" />
            </span>
            <span class="icon-fade" classList={{ "icon-fade-visible": !busy() && !running() }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <PlayIcon />
            </span>
            <span class="icon-fade" classList={{ "icon-fade-visible": !busy() && running() }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <StopIcon pulse />
            </span>
          </div>
        </button>
        <button
          class="hover-tint press"
          onclick={(e) => {
            e.stopPropagation();
            const path = projectPath();
            if (!path || running()) return;
            const open = !menuOpen();
            setMenuOpen(open);
            // Refresh on open, unless project discovery is already in flight.
            // Device sections begin loading from the current target set and do
            // not wait for this refresh to finish.
            if (open && !detecting()) void loadTargets(path);
          }}
          disabled={!projectPath() || running() || starting()}
          title="Run target"
          aria-label="Choose run target"
          style={{
            height: "23px",
            width: "20px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            color: projectPath() && !running() ? "var(--fg-subtle)" : "var(--fg-faint)",
            border: "0",
            "border-left": "1px solid var(--border-muted)",
            cursor: projectPath() && !running() && !starting() ? "pointer" : "default",
          }}
        >
          <ChevronIcon open={menuOpen()} />
        </button>
      </div>

      <Menu open={menuOpen()} onClose={() => setMenuOpen(false)} anchorRef={toggleRef} align="right" width={360}>
        <MenuLabel>Run project</MenuLabel>
        <Show when={hasAndroidTargets() && androidStatus()}>
          {(status) => (
            <>
              <div style={{
                display: "flex",
                "align-items": "flex-start",
                gap: "8px",
                padding: "8px 10px",
                "border-bottom": (androidEnv()?.devices.length ?? 0) > 0 || (androidEnv()?.avds.length ?? 0) > 0
                  ? "none"
                  : "1px solid var(--border-muted)",
              }}>
                <Show
                  when={!androidEnvLoading()}
                  fallback={<Spinner size={11} color="var(--fg-subtle)" />}
                >
                  <span style={{
                    width: "7px",
                    height: "7px",
                    "border-radius": "50%",
                    "margin-top": "5px",
                    background: status().tone === "ready"
                      ? "var(--status-add)"
                      : status().tone === "error"
                        ? "var(--status-del)"
                        : "var(--fg-faint)",
                    flex: "0 0 auto",
                  }} />
                </Show>
                <div style={{ "min-width": 0, flex: "1" }}>
                  <div style={{ "font-size": "11.5px", color: "var(--fg-default)", "font-weight": "500" }}>
                    {status().title}
                  </div>
                  <Show when={status().detail}>
                    <div style={{
                      "font-size": "10.5px",
                      color: "var(--fg-subtle)",
                      "margin-top": "2px",
                      "line-height": "1.35",
                    }}>
                      {status().detail}
                    </div>
                  </Show>
                </div>
                <button
                  class="hover-tint press"
                  onclick={(e) => {
                    e.stopPropagation();
                    void startScrcpy();
                  }}
                  disabled={!selectedSerial() || !androidEnv()?.scrcpy_path || startingScrcpy()}
                  title={
                    !androidEnv()?.scrcpy_path
                      ? "scrcpy is not installed"
                      : selectedSerial()
                        ? "Mirror Android device with scrcpy"
                        : "No online Android device"
                  }
                  style={actionChipStyle(!!selectedSerial() && !!androidEnv()?.scrcpy_path && !startingScrcpy())}
                >
                  {startingScrcpy() ? "Opening…" : "Mirror"}
                </button>
              </div>

              <Show when={(androidEnv()?.devices.length ?? 0) > 0 || (androidEnv()?.avds.length ?? 0) > 0}>
                <div style={{
                  display: "flex",
                  "flex-direction": "column",
                  gap: "8px",
                  padding: "8px 10px",
                  "border-bottom": "1px solid var(--border-muted)",
                }}>
                  <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                    <span style={{ "font-size": "10.5px", color: "var(--fg-subtle)", "flex-shrink": 0 }}>
                      Device
                    </span>
                    <select
                      value={selectedSerial() ? `device:${selectedSerial()}` : ""}
                      onclick={(e) => e.stopPropagation()}
                      onchange={(e) => {
                        e.stopPropagation();
                        void selectDeviceOrAvd(e.currentTarget.value);
                      }}
                      disabled={bootingAvd()}
                      style={{
                        flex: "1", "min-width": 0, "font-size": "10.5px", padding: "3px 6px",
                        "border-radius": "6px", border: "1px solid var(--border-muted)",
                        background: "var(--surface-2)", color: "var(--fg-default)",
                      }}
                    >
                      <For each={androidEnv()?.devices ?? []}>
                        {(device) => (
                          <option value={`device:${device.serial}`} disabled={device.status !== "device"}>
                            {device.model ?? device.serial} · {device.kind}
                            {device.status !== "device" ? ` (${device.status})` : ""}
                          </option>
                        )}
                      </For>
                      <For each={androidEnv()?.avds ?? []}>
                        {(avd) => <option value={`avd:${avd}`}>Boot {avd}</option>}
                      </For>
                    </select>
                  </div>

                  <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px" }}>
                    <button
                      class="hover-tint press"
                      onclick={(e) => { e.stopPropagation(); void startLogcat(); }}
                      disabled={!selectedSerial() || startingLogcat()}
                      title={selectedSerial() ? "Tail adb logcat" : "No online Android device"}
                      style={actionChipStyle(!!selectedSerial() && !startingLogcat())}
                    >
                      {startingLogcat() ? "Opening…" : "Logcat"}
                    </button>
                    <For each={(["screenshot", "screenrecord", "clear-data", "force-stop", "restart", "uninstall"] as AndroidDeviceAction[])}>
                      {(action) => (
                        <button
                          class="hover-tint press"
                          onclick={(e) => { e.stopPropagation(); void runDeviceAction(action); }}
                          disabled={!selectedSerial() || deviceActionBusy() !== null}
                          title={selectedSerial() ? deviceActionLabel(action) : "No online Android device"}
                          style={actionChipStyle(!!selectedSerial() && deviceActionBusy() === null)}
                        >
                          {deviceActionBusy() === action ? "Working…" : deviceActionLabel(action)}
                        </button>
                      )}
                    </For>
                  </div>

                  <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                    <input
                      type="text"
                      placeholder="Deep link URI (e.g. myapp://…)"
                      value={deeplinkUri()}
                      onclick={(e) => e.stopPropagation()}
                      oninput={(e) => setDeeplinkUri(e.currentTarget.value)}
                      onkeydown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          void openDeeplink();
                        }
                      }}
                      style={{
                        flex: "1", "min-width": 0, "font-size": "10.5px", padding: "3px 6px",
                        "border-radius": "6px", border: "1px solid var(--border-muted)",
                        background: "var(--surface-2)", color: "var(--fg-default)",
                      }}
                    />
                    <button
                      class="hover-tint press"
                      onclick={(e) => { e.stopPropagation(); void openDeeplink(); }}
                      disabled={!selectedSerial() || !deeplinkUri().trim() || sendingDeeplink()}
                      title="Send a VIEW intent to the selected device"
                      style={actionChipStyle(!!selectedSerial() && !!deeplinkUri().trim() && !sendingDeeplink())}
                    >
                      {sendingDeeplink() ? "Opening…" : "Open"}
                    </button>
                  </div>
                </div>
              </Show>
            </>
          )}
        </Show>
        <Show when={hasIosTargets() && iosStatus()}>
          {(status) => (
            <div style={{
              display: "flex",
              "align-items": "flex-start",
              gap: "8px",
              padding: "8px 10px",
              "border-bottom": "1px solid var(--border-muted)",
            }}>
              <Show
                when={!iosEnvLoading()}
                fallback={<Spinner size={11} color="var(--fg-subtle)" />}
              >
                <span style={{
                  width: "7px",
                  height: "7px",
                  "border-radius": "50%",
                  "margin-top": "5px",
                  background: status().tone === "ready"
                    ? "var(--status-add)"
                    : status().tone === "error"
                      ? "var(--status-del)"
                      : "var(--fg-faint)",
                  flex: "0 0 auto",
                }} />
              </Show>
              <div style={{ "min-width": 0, flex: "1" }}>
                <div style={{ "font-size": "11.5px", color: "var(--fg-default)", "font-weight": "500" }}>
                  {status().title}
                </div>
                <Show when={status().detail}>
                  <div style={{
                    "font-size": "10.5px",
                    color: "var(--fg-subtle)",
                    "margin-top": "2px",
                    "line-height": "1.35",
                  }}>
                    {status().detail}
                  </div>
                </Show>
              </div>
              <button
                class="hover-tint press"
                onclick={(e) => {
                  e.stopPropagation();
                  void openSimulator();
                }}
                disabled={!iosEnv()?.selected_simulator || openingSimulator()}
                title={iosEnv()?.selected_simulator ? "Open iOS Simulator" : "No available iOS simulator"}
                style={{
                  padding: "3px 8px",
                  "border-radius": "6px",
                  border: "1px solid var(--border-muted)",
                  color: iosEnv()?.selected_simulator ? "var(--fg-muted)" : "var(--fg-faint)",
                  background: "transparent",
                  "font-size": "10.5px",
                  cursor: iosEnv()?.selected_simulator && !openingSimulator() ? "pointer" : "default",
                  "flex-shrink": 0,
                }}
              >
                {openingSimulator() ? "Opening…" : "Open"}
              </button>
            </div>
          )}
        </Show>
        <For each={targets()}>
          {(target) => {
            const selected = () => preferredTarget()?.id === target.id;
            return (
              <MenuItem
                disabled={starting()}
                onSelect={() => startTarget(target)}
                style={{
                  "align-items": "flex-start",
                  background: selected() ? "var(--surface-4)" : undefined,
                }}
              >
                <PlayIcon color={selected() ? "var(--status-add)" : "var(--fg-muted)"} />
                <div style={{ flex: "1", "min-width": 0 }}>
                  <div style={{
                    display: "flex",
                    "align-items": "center",
                    gap: "8px",
                    "font-size": "12.5px",
                    color: "var(--fg-default)",
                    "font-weight": "500",
                  }}>
                    <span>{shortLabel(target)}</span>
                    <Show when={emulatorHint(target)}>
                      {(hint) => (
                        <span style={{
                          "font-size": "10px",
                          color: "var(--fg-subtle)",
                          border: "1px solid var(--border-muted)",
                          "border-radius": "var(--radius-sm)",
                          padding: "1px 5px",
                        }}>
                          {hint()}
                        </span>
                      )}
                    </Show>
                  </div>
                  <div style={{
                    "font-size": "10.5px",
                    color: "var(--fg-subtle)",
                    "font-family": "var(--font-mono)",
                    "margin-top": "3px",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}>
                    {target.command}
                  </div>
                </div>
                <Show when={selected()}>
                  <span style={{ color: "var(--status-add)", "font-size": "12px" }}>•</span>
                </Show>
              </MenuItem>
            );
          }}
        </For>
        <Show when={detecting()}>
          <div style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "8px 10px",
            color: "var(--fg-subtle)",
            "font-size": "11px",
          }}>
            <Spinner size={12} />
            {targets().length > 0 ? "Refreshing run targets…" : "Discovering run targets…"}
          </div>
        </Show>
      </Menu>
    </div>
  );
};

export default RunButton;
