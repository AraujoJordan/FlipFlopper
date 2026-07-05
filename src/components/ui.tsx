import {
  Component, JSX, For, Show, createSignal, createEffect, onMount, onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";

// ── Spinner ───────────────────────────────────────────────────────────────────

export const Spinner: Component<{ size?: number; color?: string }> = (props) => {
  const size = () => props.size ?? 14;
  return (
    <span
      style={{
        width: `${size()}px`, height: `${size()}px`,
        border: "2px solid var(--border-default)",
        "border-top-color": props.color ?? "var(--accent)",
        "border-radius": "50%",
        display: "inline-block",
        animation: "spin 0.7s linear infinite",
        flex: "0 0 auto",
      }}
    />
  );
};

// ── Button ────────────────────────────────────────────────────────────────────

export const Button: Component<{
  variant?: "outline" | "solid" | "ghost";
  size?: "sm" | "md";
  title?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  ref?: (el: HTMLButtonElement) => void;
  onClick?: (e: MouseEvent) => void;
  style?: JSX.CSSProperties;
  classList?: Record<string, boolean | undefined>;
  children: JSX.Element;
}> = (props) => {
  const variant = () => props.variant ?? "outline";
  const size = () => props.size ?? "md";

  const variantStyle = (): JSX.CSSProperties => {
    switch (variant()) {
      case "solid":
        return { background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--fg-on-accent)" };
      case "ghost":
        return { background: "transparent", border: "1px solid transparent", color: "var(--fg-muted)" };
      default:
        return { background: "var(--surface-4)", border: "1px solid var(--border-default)", color: "var(--fg-body)" };
    }
  };

  return (
    <button
      ref={props.ref}
      class={`ui-btn ui-btn-${variant()}`}
      classList={props.classList}
      type={props.type ?? "button"}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        display: "flex", "align-items": "center", "justify-content": "center", gap: "6px",
        padding: size() === "sm" ? "3px 8px" : "4px 12px",
        "font-size": size() === "sm" ? "11px" : "11.5px",
        "border-radius": "var(--radius-md)",
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? ".55" : "1",
        "white-space": "nowrap",
        ...variantStyle(),
        ...(props.style ?? {}),
      }}
    >
      {props.children}
    </button>
  );
};

// ── Menu / MenuItem ───────────────────────────────────────────────────────────
// Dropdown card pattern shared by AgentBar's new-session menu and the
// "Continue on..." handoff menu. `anchorRef` must be the toggle element that
// opens the menu, so clicking it doesn't get treated as an outside click.

interface MenuPos {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

const MENU_GAP = 6;
const MENU_MAX_HEIGHT = 420;
const MENU_MIN_HEIGHT = 120;

export const Menu: Component<{
  open: boolean;
  onClose: () => void;
  anchorRef?: HTMLElement;
  align?: "left" | "right";
  width?: number;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}> = (props) => {
  let ref: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal<MenuPos | null>(null);

  // Rendered through a Portal at viewport-fixed coordinates so the dropdown
  // is never clipped by an ancestor's `overflow: hidden` (e.g. the terminal
  // pane) or constrained by a scrolled/transformed positioning context.
  // Opens toward whichever side (above/below the anchor) has more room, and
  // clamps its own max-height to that real available space — so however
  // close the anchor sits to a screen edge, the menu never renders partly
  // or wholly outside the viewport.
  createEffect(() => {
    if (!props.open || !props.anchorRef) return;
    const rect = props.anchorRef.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP;
    const spaceAbove = rect.top - MENU_GAP;
    const openUpward = spaceAbove > spaceBelow;
    const maxHeight = Math.max(
      MENU_MIN_HEIGHT,
      Math.min(MENU_MAX_HEIGHT, openUpward ? spaceAbove : spaceBelow)
    );

    setPos({
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
      ...(props.align === "right"
        ? { right: window.innerWidth - rect.right }
        : { left: rect.left }),
      maxHeight,
    });
  });

  onMount(() => {
    function handleClick(e: MouseEvent) {
      if (!props.open) return;
      const target = e.target as Node;
      if (ref?.contains(target)) return;
      if (props.anchorRef?.contains(target)) return;
      props.onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (props.open && e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    }
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKey, true);
    onCleanup(() => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKey, true);
    });
  });

  return (
    <Show when={props.open && pos()}>
      {(p) => (
        <Portal>
          <div
            ref={ref}
            role="menu"
            class="overlay-pop-in"
            style={{
              position: "fixed",
              ...(p().top !== undefined ? { top: `${p().top}px` } : {}),
              ...(p().bottom !== undefined ? { bottom: `${p().bottom}px` } : {}),
              ...(p().left !== undefined ? { left: `${p().left}px` } : {}),
              ...(p().right !== undefined ? { right: `${p().right}px` } : {}),
              width: `${props.width ?? 288}px`,
              "max-height": `min(60vh, ${p().maxHeight}px)`,
              overflow: "auto",
              background: "var(--surface-3)",
              border: "1px solid var(--border-default)",
              "border-radius": "var(--radius-xl)",
              "box-shadow": "var(--shadow-menu)",
              padding: "7px", "z-index": "var(--z-menu)",
              ...(props.style ?? {}),
            }}
          >
            {props.children}
          </div>
        </Portal>
      )}
    </Show>
  );
};

export const MenuLabel: Component<{ children: JSX.Element }> = (props) => (
  <div style={{
    padding: "8px 10px 6px",
    "font-size": "10.5px", "letter-spacing": ".5px",
    "text-transform": "uppercase", color: "var(--fg-subtle)", "font-weight": "600",
  }}>
    {props.children}
  </div>
);

export const MenuItem: Component<{
  onSelect: () => void;
  disabled?: boolean;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}> = (props) => (
  <button
    role="menuitem"
    class={props.disabled ? undefined : "hover-tint"}
    disabled={props.disabled}
    onclick={props.onSelect}
    style={{
      width: "100%", display: "flex", "align-items": "center",
      gap: "11px", padding: "9px 10px",
      "border-radius": "var(--radius-lg)",
      "text-align": "left",
      background: "transparent",
      opacity: props.disabled ? ".5" : "1",
      cursor: props.disabled ? "default" : "pointer",
      ...(props.style ?? {}),
    }}
  >
    {props.children}
  </button>
);

export const MenuDivider: Component = () => (
  <div style={{ height: "1px", background: "var(--border-muted)", margin: "5px 4px" }} />
);

// ── ContextMenu ───────────────────────────────────────────────────────────────
// Same Portal / outside-click / Escape / viewport-clamp pattern as `Menu`, but
// anchored to cursor coordinates (e.g. a right-click) instead of a toggle element.

const CONTEXT_MENU_MARGIN = 8;

export const ContextMenu: Component<{
  open: boolean;
  onClose: () => void;
  x: number;
  y: number;
  width?: number;
  style?: JSX.CSSProperties;
  children: JSX.Element;
}> = (props) => {
  let ref: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);

  createEffect(() => {
    if (!props.open) return;
    const width = props.width ?? 220;
    // Measure actual rendered height once mounted; fall back to a reasonable
    // guess for the first frame so we still clamp against the viewport edge.
    const height = ref?.getBoundingClientRect().height ?? 240;
    const left = Math.min(props.x, window.innerWidth - width - CONTEXT_MENU_MARGIN);
    const top = Math.min(props.y, window.innerHeight - height - CONTEXT_MENU_MARGIN);
    setPos({ left: Math.max(CONTEXT_MENU_MARGIN, left), top: Math.max(CONTEXT_MENU_MARGIN, top) });
  });

  createEffect(() => {
    if (!props.open) return;

    function handleClick(e: Event) {
      if (!props.open) return;
      const target = e.target as Node;
      if (ref?.contains(target)) return;
      props.onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (props.open && e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    }
    // Defer registration until the next tick. SolidJS delegates `contextmenu`
    // and `click` to the document root, so this component's document-level
    // dismissal handlers would otherwise fire on the very same event that
    // opened the menu (the opening handler runs first inside SolidJS's
    // delegated walk and flips `open` to true synchronously; the browser
    // then invokes our other `contextmenu` listener on the same dispatch
    // and immediately closes the menu we just opened). `stopPropagation()`
    // in the opener cannot prevent that since both listeners share document.
    // Any subsequent right-click (context menu) or scroll dismisses too.
    let cancelled = false;
    const id = window.setTimeout(() => {
      if (cancelled) return;
      document.addEventListener("pointerdown", handleClick, true);
      document.addEventListener("click", handleClick, true);
      document.addEventListener("contextmenu", handleClick, true);
      document.addEventListener("scroll", handleClick, true);
      document.addEventListener("keydown", handleKey, true);
    }, 0);

    onCleanup(() => {
      cancelled = true;
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", handleClick, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("contextmenu", handleClick, true);
      document.removeEventListener("scroll", handleClick, true);
      document.removeEventListener("keydown", handleKey, true);
    });
  });

  return (
    <Show when={props.open && pos()}>
      {(p) => (
        <Portal>
          <div
            ref={ref}
            role="menu"
            class="overlay-pop-in"
            style={{
              position: "fixed",
              left: `${p().left}px`,
              top: `${p().top}px`,
              width: `${props.width ?? 220}px`,
              "max-height": "70vh",
              overflow: "auto",
              background: "var(--surface-3)",
              border: "1px solid var(--border-default)",
              "border-radius": "var(--radius-xl)",
              "box-shadow": "var(--shadow-menu)",
              padding: "6px", "z-index": "var(--z-menu)",
              ...(props.style ?? {}),
            }}
          >
            {props.children}
          </div>
        </Portal>
      )}
    </Show>
  );
};

// ── Toast ─────────────────────────────────────────────────────────────────────

export type ToastKind = "info" | "success" | "error";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  actionLabel?: string;
  onAction?: () => void;
  leaving?: boolean;
}

const [toasts, setToasts] = createSignal<ToastItem[]>([]);
let toastSeq = 0;

/** Matches the .toast-item exit transition duration in App.css (--dur-base)
 *  so the row is only removed from the DOM once it has fully faded/slid out. */
const TOAST_EXIT_MS = 160;

export function toast(
  message: string,
  kind: ToastKind = "info",
  opts?: { actionLabel?: string; onAction?: () => void; sticky?: boolean },
) {
  const id = ++toastSeq;
  setToasts((t) => [...t.slice(-3), {
    id, message, kind, actionLabel: opts?.actionLabel, onAction: opts?.onAction,
  }]);
  if (!opts?.sticky) {
    const timeout = kind === "error" ? 8000 : 4000;
    setTimeout(() => dismissToast(id), timeout);
  }
}

export function dismissToast(id: number) {
  setToasts((t) => t.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
  setTimeout(() => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, TOAST_EXIT_MS);
}

const TOAST_COLOR: Record<ToastKind, string> = {
  info: "var(--accent-soft)",
  success: "var(--status-add)",
  error: "var(--status-del)",
};

export const ToastHost: Component = () => (
  <div style={{
    position: "fixed", bottom: "84px", right: "16px",
    display: "flex", "flex-direction": "column", gap: "8px",
    "z-index": "var(--z-toast)", "max-width": "360px",
  }}>
    <For each={toasts()}>
      {(t) => {
        const color = TOAST_COLOR[t.kind];
        return (
          <div
            class="toast-item"
            classList={{ "toast-item-leaving": t.leaving }}
            style={{
              display: "flex", "align-items": "flex-start", gap: "10px",
              background: "var(--surface-3)",
              border: `1px solid ${color}55`,
              "border-radius": "var(--radius-lg)",
              padding: "10px 12px",
              "box-shadow": "var(--shadow-toast)",
              "font-size": "12.5px", color: "var(--fg-body)",
            }}>
            <span style={{ flex: "1", "line-height": "1.5", "word-break": "break-word" }}>
              {t.message}
            </span>
            <Show when={t.actionLabel}>
              <button
                class="press"
                onclick={() => { t.onAction?.(); dismissToast(t.id); }}
                style={{
                  "flex-shrink": "0", color, "font-size": "11.5px", "font-weight": "600",
                  cursor: "pointer", "white-space": "nowrap",
                }}
              >
                {t.actionLabel}
              </button>
            </Show>
            <button
              class="icon-btn press"
              onclick={() => dismissToast(t.id)}
              title="Dismiss"
              style={{ "flex-shrink": "0", color: "var(--fg-subtle)", cursor: "pointer", padding: "2px" }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      }}
    </For>
  </div>
);

// ── Confirm dialog ────────────────────────────────────────────────────────────

interface ConfirmState {
  message: string;
  confirmLabel: string;
  resolve: (v: boolean) => void;
}

const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null);

export function confirmDialog(message: string, confirmLabel = "Confirm"): Promise<boolean> {
  return new Promise((resolve) => {
    setConfirmState({ message, confirmLabel, resolve });
  });
}

function resolveConfirm(v: boolean) {
  confirmState()?.resolve(v);
  setConfirmState(null);
}

export const ConfirmHost: Component = () => {
  onMount(() => {
    function handleKey(e: KeyboardEvent) {
      if (confirmState() && e.key === "Escape") {
        e.stopPropagation();
        resolveConfirm(false);
      }
    }
    document.addEventListener("keydown", handleKey, true);
    onCleanup(() => document.removeEventListener("keydown", handleKey, true));
  });

  return (
    <Show when={confirmState()}>
      {(state) => (
        <div
          class="overlay-backdrop-in"
          onclick={() => resolveConfirm(false)}
          style={{
            position: "fixed", inset: 0, "z-index": "var(--z-modal)",
            display: "flex", "align-items": "center", "justify-content": "center",
            background: "rgba(0,0,0,.5)",
          }}
        >
          <div
            class="overlay-pop-in"
            onclick={(e) => e.stopPropagation()}
            style={{
              width: "340px",
              background: "var(--surface-3)",
              border: "1px solid var(--border-default)",
              "border-radius": "var(--radius-xl)",
              "box-shadow": "var(--shadow-menu)",
              padding: "18px",
            }}
          >
            <div style={{
              "font-size": "13px", color: "var(--fg-default)",
              "line-height": "1.5", "margin-bottom": "16px",
            }}>
              {state().message}
            </div>
            <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
              <Button variant="ghost" onClick={() => resolveConfirm(false)}>Cancel</Button>
              <Button variant="solid" onClick={() => resolveConfirm(true)}>{state().confirmLabel}</Button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};
