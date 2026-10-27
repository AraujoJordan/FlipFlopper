import { Component, createEffect, createSignal, onCleanup } from "solid-js";
import {
  detectValidationTargets,
  onPtyExit,
  ptyKill,
  validateProject,
  type ValidationTarget,
  triggerHaptic,
} from "../lib/ipc";
import {
  addTerminal,
  readValidationTargets,
  effectiveRoot,
  setValidationSessionId,
  store,
  writeValidationTarget,
} from "../lib/store";
import { toast } from "./ui";
import TargetButton, { preferredTarget, shortLabel } from "./TargetButton";

const categoryLabel = (category: string) => {
  switch (category) {
    case "test": return "Tests";
    case "lint": return "Lint";
    case "typecheck": return "Typecheck";
    case "format": return "Format check";
    case "build": return "Build check";
    case "database": return "Database";
    case "generate": return "Generate";
    case "services": return "Services";
    default: return "Checks";
  }
};

const ValidationButton: Component = () => {
  const [targets, setTargets] = createSignal<ValidationTarget[]>([]);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [detecting, setDetecting] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  let validationExitUnlisten: (() => void) | null = null;
  let loadSeq = 0;

  const projectPath = () => store.currentProject?.path ?? "";
  const rootPath = () => effectiveRoot() ?? "";
  const running = () => store.validationSessionId !== null;
  const busy = () => detecting() || starting();

  const preferred = () => preferredTarget(targets(), readValidationTargets()[projectPath()]);

  async function loadTargets(path: string) {
    const seq = ++loadSeq;
    setDetecting(true);
    try {
      const next = await detectValidationTargets(path);
      if (seq === loadSeq) setTargets(next);
    } catch (e) {
      if (seq === loadSeq) {
        setTargets([]);
        toast(`Validation detection failed: ${String(e)}`, "error");
      }
    } finally {
      if (seq === loadSeq) setDetecting(false);
    }
  }

  createEffect(() => {
    const root = rootPath();
    validationExitUnlisten?.();
    validationExitUnlisten = null;
    setValidationSessionId(null);
    setMenuOpen(false);
    setTargets([]);
    if (root) void loadTargets(root);
  });

  createEffect(() => {
    const root = rootPath();
    if (root && menuOpen()) void loadTargets(root);
  });

  onCleanup(() => {
    validationExitUnlisten?.();
    validationExitUnlisten = null;
  });

  async function startTarget(target: ValidationTarget) {
    const root = rootPath();
    const project = projectPath();
    if (!root || !project || starting()) return;
    setMenuOpen(false);
    setStarting(true);
    void triggerHaptic("generic");
    try {
      const sessionId = await validateProject(root, target.id);
      writeValidationTarget(project, target.id);
      addTerminal({
        sessionId,
        label: `Validate · ${shortLabel(target)}`,
        kind: "validate",
      });
      setValidationSessionId(sessionId);
      validationExitUnlisten?.();
      validationExitUnlisten = await onPtyExit(sessionId, () => {
        if (store.validationSessionId === sessionId) {
          setValidationSessionId(null);
          void triggerHaptic("alignment");
        }
        validationExitUnlisten?.();
        validationExitUnlisten = null;
      });
    } catch (e) {
      toast(`Validation failed: ${String(e)}`, "error");
    } finally {
      setStarting(false);
    }
  }

  async function stopValidation() {
    const sessionId = store.validationSessionId;
    if (!sessionId) return;
    void triggerHaptic("levelChange");
    try {
      await ptyKill(sessionId);
    } catch (e) {
      toast(`Stop failed: ${String(e)}`, "error");
      setValidationSessionId(null);
      validationExitUnlisten?.();
      validationExitUnlisten = null;
    }
  }

  async function handleMainClick() {
    if (running()) {
      await stopValidation();
      return;
    }
    const target = preferred();
    if (!target) return;
    await startTarget(target);
  }

  const mainTitle = () => {
    if (!projectPath()) return "Open a project to validate";
    if (running()) {
      const target = preferred();
      return target ? `Stop ${shortLabel(target)}` : "Stop validation";
    }
    if (detecting()) return "Detecting validation targets";
    return preferred()?.label ?? "No validation target detected";
  };

  return (
    <TargetButton
      targets={targets()}
      selectedId={preferred()?.id}
      running={running()}
      busy={busy()}
      starting={starting()}
      detecting={detecting()}
      mainDisabled={!projectPath() || (!running() && targets().length === 0) || busy()}
      menuDisabled={!projectPath() || targets().length === 0 || running() || starting()}
      menuOpen={menuOpen()}
      title={mainTitle()}
      menuTitle="Validation target"
      menuLabel="Validate project"
      detectingLabel="Detecting"
      accent="var(--accent)"
      icon="check"
      onMainClick={() => void handleMainClick()}
      onToggleMenu={(e) => {
        e.stopPropagation();
        if (projectPath() && targets().length > 0 && !running()) setMenuOpen((open) => !open);
      }}
      onCloseMenu={() => setMenuOpen(false)}
      onSelectTarget={(target) => void startTarget(target as ValidationTarget)}
      badge={(target) => (
        <span style={{
          "font-size": "10px",
          color: "var(--fg-subtle)",
          border: "1px solid var(--border-muted)",
          "border-radius": "var(--radius-sm)",
          padding: "1px 5px",
        }}>
          {categoryLabel((target as ValidationTarget).category)}
        </span>
      )}
    />
  );
};

export default ValidationButton;
