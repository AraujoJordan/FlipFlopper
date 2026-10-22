import { createSignal } from "solid-js";
import { homeDir } from "@tauri-apps/api/path";
import { getAgents, getToolCatalog, installTool, onPtyExit } from "./ipc";
import { openSide } from "./layout";
import { addTerminal, setStore, store } from "./store";
import { toast } from "../components/ui";

// Installing a coding agent runs the tool catalog's install command in a
// terminal tab (so the user sees and can answer the installer), then re-detects
// agents when it exits. Agent ids match tool-catalog ids.

const [installable, setInstallable] = createSignal<Set<string>>(new Set());
const [installing, setInstalling] = createSignal<Set<string>>(new Set());
let loaded = false;

/** Agent ids the catalog has an install command for. */
export { installable, installing };

export async function loadInstallable() {
  if (loaded) return;
  loaded = true;
  try {
    const tools = await getToolCatalog();
    setInstallable(new Set(tools.filter((t) => !!t.install_cmd).map((t) => t.id)));
  } catch (e) {
    loaded = false;
    console.error("Failed to load tool catalog:", e);
  }
}

export async function installAgent(agentId: string) {
  if (installing().has(agentId)) return;
  const name = store.agents.find((a) => a.id === agentId)?.name ?? agentId;
  setInstalling((s) => new Set(s).add(agentId));
  try {
    const cwd = store.currentProject?.path ?? (await homeDir());
    const sessionId = await installTool(agentId, cwd);
    addTerminal({ sessionId, label: `Install · ${name}`, kind: "install" });
    openSide("terminal");
    const done = await onPtyExit(sessionId, async () => {
      done();
      setInstalling((s) => { const n = new Set(s); n.delete(agentId); return n; });
      try {
        setStore("agents", await getAgents(true));
        const ready = store.agents.find((a) => a.id === agentId)?.installed;
        toast(ready ? `${name} installed` : `${name} install finished — check the terminal output`, ready ? "success" : "info");
      } catch { /* detection failure is harmless */ }
    });
  } catch (e) {
    setInstalling((s) => { const n = new Set(s); n.delete(agentId); return n; });
    toast(`Couldn't start the installer: ${String(e)}`, "error");
  }
}
