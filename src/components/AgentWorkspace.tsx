import { Component, createSignal, For, lazy, onCleanup, onMount, Show } from "solid-js";
import { store, addTab, rankContinueCandidates, recordContinueAgentUse } from "../lib/store";
import { continueAgent, spawnAgent, type AgentInfo } from "../lib/ipc";
import { agentColor, AgentLogo } from "../lib/agentMeta";
import AgentBar from "./AgentBar";

// Lazy: keeps xterm out of the startup bundle; panes only mount once a tab
// exists, and PTY output is parked backend-side until the pane attaches.
const TerminalPane = lazy(() => import("./TerminalPane"));
import YoloButton from "./YoloButton";
import OrchestratorPanel from "./flow/OrchestratorPanel";
import { Menu, MenuLabel, MenuItem, Spinner, toast } from "./ui";

const LIQUID_DOT_COUNT = 6200;
/** FlipFlopper brand green/yellow, sampled from src-tauri/icons/icon.png. */
const DEFAULT_LIQUID_COLOR = "#028029";

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const int = parseInt(full, 16) || 0;
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

const NOISE_GLSL = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec3 fade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float pnoise(vec3 P, vec3 rep) {
  vec3 Pi0 = mod(floor(P), rep);
  vec3 Pi1 = mod(Pi0 + vec3(1.0), rep);
  Pi0 = mod289(Pi0);
  Pi1 = mod289(Pi1);
  vec3 Pf0 = fract(P);
  vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);
  vec4 gx0 = ixy0 * (1.0 / 7.0);
  vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  vec4 gx1 = ixy1 * (1.0 / 7.0);
  vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);
  vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
  vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
  vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
  vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
  vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
  vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
  vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
  vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;
  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  return 2.0 * mix(n_yz.x, n_yz.y, fade_xyz.x);
}
`;

const LIQUID_VERTEX_SHADER = `
precision mediump float;
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uProjection;
uniform mat4 uView;
uniform mat4 uModel;
uniform float uTime;
uniform float uMorph;
uniform float uPointSize;
varying vec3 vNormal;
${NOISE_GLSL}
void main() {
  float f = uMorph * pnoise(aNormal + vec3(uTime), vec3(10.0));
  vec3 displaced = aPosition + f * aNormal;
  vec4 worldPos = uModel * vec4(displaced, 1.0);
  vec4 viewPos = uView * worldPos;
  vNormal = normalize((uModel * vec4(aNormal, 0.0)).xyz);
  gl_Position = uProjection * viewPos;
  gl_PointSize = uPointSize * (115.0 / max(12.0, -viewPos.z));
}
`;

const LIQUID_FRAGMENT_SHADER = `
precision mediump float;
uniform vec3 uAccent;
uniform float uTime;
varying vec3 vNormal;
${NOISE_GLSL}
void main() {
  vec2 point = gl_PointCoord * 2.0 - 1.0;
  float radius = dot(point, point);
  if (radius > 1.0) discard;
  float r = pnoise(1.2 * (vNormal + vec3(uTime)), vec3(10.0));
  float g = pnoise(0.8 * (vNormal + vec3(uTime)), vec3(10.0));
  float b = pnoise(1.4 * (vNormal + vec3(uTime)), vec3(10.0));
  float n = 3.2 * pnoise(0.003 * vNormal, vec3(10.0)) * pnoise(vNormal + vec3(uTime), vec3(10.0));
  vec3 liquid = vec3(r + n, g + n, b + n);
  vec3 base = mix(vec3(0.008, 0.502, 0.169), uAccent, 0.58);
  vec3 hot = vec3(0.996, 0.808, 0.012);
  vec3 color = mix(base, hot, smoothstep(-1.0, 1.0, liquid.r - liquid.b));
  float alpha = smoothstep(1.0, 0.12, radius);
  gl_FragColor = vec4(color * (0.72 + 0.42 * liquid), alpha);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function createLiquidGeometry(count: number, radius: number) {
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const radial = Math.sqrt(1 - y * y);
    const theta = goldenAngle * i;
    const x = Math.cos(theta) * radial;
    const z = Math.sin(theta) * radial;
    const offset = i * 3;
    normals[offset] = x;
    normals[offset + 1] = y;
    normals[offset + 2] = z;
    positions[offset] = x * radius;
    positions[offset + 1] = y * radius;
    positions[offset + 2] = z * radius;
  }

  return { positions, normals };
}

function perspectiveMatrix(fovRadians: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovRadians / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function viewMatrix(cameraY: number, cameraZ: number) {
  const out = new Float32Array(16);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[13] = -cameraY;
  out[14] = -cameraZ;
  out[15] = 1;
  return out;
}

function rotationYZMatrix(rotationY: number, rotationZ: number) {
  const cy = Math.cos(rotationY);
  const sy = Math.sin(rotationY);
  const cz = Math.cos(rotationZ);
  const sz = Math.sin(rotationZ);
  const out = new Float32Array(16);
  out[0] = cz * cy;
  out[1] = sz * cy;
  out[2] = -sy;
  out[4] = -sz;
  out[5] = cz;
  out[8] = cz * sy;
  out[9] = sz * sy;
  out[10] = cy;
  out[15] = 1;
  return out;
}

const EmptyAgentLiquidDotsBackground: Component<{ targetColor: () => string }> = (props) => {
  let canvas: HTMLCanvasElement | undefined;
  let frame = 0;
  let resizeObserver: ResizeObserver | undefined;

  onMount(() => {
    if (!canvas) return;
    const context = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false });
    if (!context) return;
    const gl = context;
    const program = createProgram(gl, LIQUID_VERTEX_SHADER, LIQUID_FRAGMENT_SHADER);
    if (!program) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const geometry = createLiquidGeometry(LIQUID_DOT_COUNT, 20);
    const positionBuffer = gl.createBuffer();
    const normalBuffer = gl.createBuffer();
    if (!positionBuffer || !normalBuffer) return;
    const aPosition = gl.getAttribLocation(program, "aPosition");
    const aNormal = gl.getAttribLocation(program, "aNormal");
    const uniforms = {
      projection: gl.getUniformLocation(program, "uProjection"),
      view: gl.getUniformLocation(program, "uView"),
      model: gl.getUniformLocation(program, "uModel"),
      time: gl.getUniformLocation(program, "uTime"),
      morph: gl.getUniformLocation(program, "uMorph"),
      pointSize: gl.getUniformLocation(program, "uPointSize"),
      accent: gl.getUniformLocation(program, "uAccent"),
    };
    let projection = perspectiveMatrix((20 * Math.PI) / 180, 1, 1, 1000);
    const view = viewMatrix(4, 52);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.normals, gl.STATIC_DRAW);
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.uniformMatrix4fv(uniforms.view, false, view);
    gl.uniform1f(uniforms.morph, 11);
    gl.uniform1f(uniforms.pointSize, 3);

    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      projection = perspectiveMatrix((20 * Math.PI) / 180, Math.max(1, rect.width) / Math.max(1, rect.height), 1, 1000);
      if (reduceMotion) frame = requestAnimationFrame(() => render(performance.now()));
    }

    function render(time: number) {
      const seconds = time * 0.001;
      const rotation = reduceMotion ? 0.32 : seconds * 0.03;
      const [r, g, b] = hexToRgb(props.targetColor());
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniformMatrix4fv(uniforms.projection, false, projection);
      gl.uniformMatrix4fv(uniforms.model, false, rotationYZMatrix(rotation, rotation));
      gl.uniform1f(uniforms.time, seconds * 0.23);
      gl.uniform3f(uniforms.accent, r / 255, g / 255, b / 255);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.enableVertexAttribArray(aNormal);
      gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, LIQUID_DOT_COUNT);

      if (!reduceMotion) frame = requestAnimationFrame(render);
    }

    resize();
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    frame = requestAnimationFrame(render);
    onCleanup(() => {
      gl.deleteBuffer(positionBuffer);
      gl.deleteBuffer(normalBuffer);
      gl.deleteProgram(program);
    });
  });

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
  });

  return <canvas ref={canvas} class="empty-agent-liquid-canvas" aria-hidden="true" />;
};

/** The "agent" workspace mode: the agent tab strip, YOLO toggle, the
 *  "Continue on..." handoff menu, and the stacked agent terminals. */
const AgentWorkspace: Component = () => {
  const activeTab = () => store.tabs.find((t) => t.sessionId === store.activeTabId);
  const activeColor = () => agentColor(activeTab()?.agentId ?? "claude");
  const handoffTargets = () => {
    const tab = activeTab();
    const project = store.currentProject;
    if (!tab || !project) return [];
    return rankContinueCandidates(project.path, tab.agentId, store.agents)
      .filter((agent) => !store.yoloMode || agent.yolo_supported);
  };
  const [continueOpen, setContinueOpen] = createSignal(false);
  const [handoffBusy, setHandoffBusy] = createSignal(false);
  let continueToggleRef: HTMLButtonElement | undefined;

  const [emptySpawningId, setEmptySpawningId] = createSignal<string | null>(null);
  const [hoveredAgentColor, setHoveredAgentColor] = createSignal<string | null>(null);

  const emptyAgentBlockReason = (agent: AgentInfo) => {
    if (!store.currentProject) return "Open a project first";
    if (!agent.installed) return "Not installed";
    if (store.yoloMode && !agent.yolo_supported) return "YOLO unsupported";
    return null;
  };

  const emptyAgentStatus = (agent: AgentInfo) => {
    if (emptySpawningId() === agent.id) return "Launching...";
    return emptyAgentBlockReason(agent) ?? agent.version ?? "Ready";
  };

  async function launchEmptyAgent(agent: AgentInfo) {
    const project = store.currentProject;
    if (!project || emptyAgentBlockReason(agent) || emptySpawningId()) return;
    setEmptySpawningId(agent.id);
    try {
      const sessionId = await spawnAgent(agent.id, project.path, store.yoloMode);
      addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
    } catch (e) {
      console.error(e);
      toast(`Failed to start ${agent.name}: ${String(e)}`, "error");
    } finally {
      setEmptySpawningId(null);
    }
  }

  return (
    <div style={{
      height: "100%",
      display: "flex", "flex-direction": "column",
      "min-height": 0,
      background: "var(--surface-1)",
    }}>
      <div style={{
        height: "42px", flex: "0 0 42px",
        background: "var(--surface-2)",
        "border-bottom": "1px solid var(--border-muted)",
        display: "flex", "align-items": "stretch",
        padding: "0 10px 0 12px", gap: "4px",
      }}>
        <AgentBar />

        <div style={{ "margin-left": "auto", "align-self": "center", display: "flex", "align-items": "center", gap: "8px" }}>
          <YoloButton />

          <Show when={handoffTargets().length > 0}>
          <div style={{ "align-self": "center", position: "relative" }}>
            <button
              ref={continueToggleRef}
              onclick={() => setContinueOpen((o) => !o)}
              disabled={handoffBusy()}
              style={{
                display: "flex", "align-items": "center", gap: "8px",
                height: "30px", padding: "0 13px",
                "border-radius": "var(--radius-lg)",
                background: "var(--surface-4)",
                border: `1px solid ${activeColor()}99`,
                color: "var(--accent-soft)",
                "font-size": "12.5px", "font-weight": "500",
                "box-shadow": `0 0 0 1px ${activeColor()}22`,
                transition: "border-color .16s ease, box-shadow .16s ease, background .16s ease",
              }}
            >
              <Show when={handoffBusy()} fallback={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={activeColor()} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12h13M13 6l6 6-6 6" />
                </svg>
              }>
                <Spinner size={13} color={activeColor()} />
              </Show>
              Continue on...
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8b949e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            <Menu open={continueOpen()} onClose={() => setContinueOpen(false)} anchorRef={continueToggleRef} align="right">
              <MenuLabel>Hand off this session</MenuLabel>
              <For each={handoffTargets()}>
                {(agent) => (
                  <MenuItem
                    disabled={handoffBusy()}
                    onSelect={async () => {
                      setContinueOpen(false);
                      const from = activeTab()?.agentId ?? "";
                      const project = store.currentProject;
                      if (!project) return;
                      setHandoffBusy(true);
                      try {
                        const sessionId = await continueAgent(project.path, from, agent.id, store.yoloMode);
                        recordContinueAgentUse(project.path, agent.id);
                        addTab({ sessionId, label: agent.name, agentId: agent.id, agentIcon: agent.icon });
                      } catch (e) {
                        console.error(e);
                        toast(`Handoff to ${agent.name} failed: ${String(e)}`, "error");
                      } finally {
                        setHandoffBusy(false);
                      }
                    }}
                  >
                    <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} />
                    <div style={{ flex: "1" }}>
                      <div style={{ "font-size": "13px", color: "var(--fg-default)", "font-weight": "500" }}>
                        {agent.name}
                      </div>
                      <div style={{
                        "font-size": "10.5px", color: "var(--fg-subtle)",
                        "font-family": "var(--font-mono)",
                      }}>
                        {agent.version ?? ""}
                      </div>
                    </div>
                  </MenuItem>
                )}
              </For>
              <div style={{ height: "1px", background: "var(--border-muted)", margin: "7px 8px" }} />
              <div style={{
                display: "flex", "align-items": "flex-start", gap: "9px",
                padding: "5px 10px 9px",
              }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6e7681" stroke-width="2" style={{ "margin-top": "1px", flex: "0 0 auto" }}>
                  <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" stroke-linecap="round" />
                </svg>
                <div style={{ "font-size": "11px", color: "var(--fg-muted)", "line-height": "1.5" }}>
                  Carries full transcript &amp; context into a new tab.
                </div>
              </div>
            </Menu>
          </div>
          </Show>
        </div>
      </div>

      <div style={{
        flex: store.tabs.length > 0 && store.orchestratorMaximized ? "0 0 0px" : "1",
        position: "relative", overflow: "hidden", "min-height": 0,
      }}>
        <Show when={store.tabs.length === 0}>
          <div class="empty-agent-workspace">
            <EmptyAgentLiquidDotsBackground targetColor={() => hoveredAgentColor() ?? DEFAULT_LIQUID_COLOR} />

            <div class="empty-agent-content">
              <img class="empty-agent-icon" src="/flipflopper-icon.png" alt="FlipFlopper" width={56} height={56} />
              <h2>No agent running</h2>
              <p>
                {store.currentProject
                  ? "Launch an agent to get started."
                  : "Open a project, then launch an agent."}
              </p>

              <div class="empty-agent-grid" aria-label="Launch an agent">
                <Show
                  when={store.agents.length > 0}
                  fallback={
                    <div class="empty-agent-detecting">
                      <Spinner size={14} />
                      Detecting installed agents...
                    </div>
                  }
                >
                  <For each={store.agents}>
                    {(agent, index) => {
                      const blockedReason = () => emptyAgentBlockReason(agent);
                      const launching = () => emptySpawningId() === agent.id;
                      const disabled = () => Boolean(blockedReason()) || (emptySpawningId() !== null && !launching());
                      const color = () => agentColor(agent.id);

                      return (
                        <button
                          class="empty-agent-launch-button"
                          classList={{
                            "empty-agent-launch-button-disabled": disabled(),
                            "empty-agent-launch-button-active": launching(),
                          }}
                          disabled={disabled()}
                          title={`${agent.name}: ${emptyAgentStatus(agent)}`}
                          onclick={() => launchEmptyAgent(agent)}
                          onmouseenter={() => setHoveredAgentColor(color())}
                          onmouseleave={() => setHoveredAgentColor(null)}
                          style={`--agent-color: ${color()}; animation-delay: ${180 + index() * 58}ms;`}
                        >
                          <span class="empty-agent-launch-glow" />
                          <AgentLogo agentId={agent.id} icon={agent.icon} name={agent.name} size={28} radius={8} />
                          <span class="empty-agent-launch-copy">
                            <span class="empty-agent-launch-name">{agent.name}</span>
                            <span class="empty-agent-launch-status">{emptyAgentStatus(agent)}</span>
                          </span>
                          <Show when={launching()} fallback={
                            <svg class="empty-agent-launch-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color()} stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M5 12h13M13 6l6 6-6 6" />
                            </svg>
                          }>
                            <Spinner size={15} color={color()} />
                          </Show>
                        </button>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <For each={store.tabs}>
          {(tab) => (
            <TerminalPane
              sessionId={tab.sessionId}
              active={tab.sessionId === store.activeTabId && store.workspaceMode === "agent"}
            />
          )}
        </For>
      </div>

      {/* Orchestration panel: visible whenever at least one agent is open. */}
      <Show when={store.tabs.length > 0}>
        <OrchestratorPanel />
      </Show>
    </div>
  );
};

export default AgentWorkspace;
