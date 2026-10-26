import { Icon } from "./shell/Icon";
import {
  Component, JSX, For, Show, createSignal, createEffect, createMemo, onMount, onCleanup, on, untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import { layout, applyTheme, resolvedMotion, motionForeground, registerMotionSettler } from "../lib/layout";

// Presentation only: logical actions never wait for motion. The final CSS is
// always authoritative, and one registry settles work on OS/preference changes.
const activeMotion = new Map<Element, Animation>();
registerMotionSettler(() => {
  for (const animation of activeMotion.values()) {
    try { animation.finish(); } catch { animation.cancel(); }
  }
});
export function motionVisible(element: Element) {
  if (!motionForeground() || !element.isConnected || element.closest('[hidden], .side-tab:not(.side-tab-on)')) return false;
  const rect = element.getBoundingClientRect();
  return (element instanceof SVGElement ? rect.width > 0 || rect.height > 0 : rect.width > 0 && rect.height > 0) && rect.bottom >= 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}
export function cancelMotion(element: Element | undefined) {
  if (!element) return;
  activeMotion.get(element)?.cancel();
  activeMotion.delete(element);
}
export function animateElement(element: HTMLElement | SVGElement | undefined, frames: Keyframe[], duration = 180): Promise<void> {
  if (!element) return Promise.resolve();
  const previous = activeMotion.get(element);
  // Reversals begin at the actual current geometry, not at the old endpoint.
  if (previous) {
    const style = getComputedStyle(element);
    frames = frames.map((frame) => ({ ...frame }));
    for (const property of ["opacity", "transform", "width", "height"] as const) {
      if (frames[0][property] !== undefined) frames[0][property] = style[property];
    }
    cancelMotion(element);
  }
  const mode = resolvedMotion();
  if (mode === "off" || !motionVisible(element) || typeof element.animate !== "function") return Promise.resolve();
  const reduced = mode === "reduced";
  const keyframes = reduced ? frames.map((frame) => ({ opacity: frame.opacity ?? 1 })) : frames;
  const animation = element.animate(keyframes, { duration: reduced ? Math.min(80, duration) : duration, easing: "cubic-bezier(.16,1,.3,1)" });
  activeMotion.set(element, animation);
  return animation.finished.catch(() => {}).then(() => {
    if (activeMotion.get(element) === animation) { activeMotion.delete(element); animation.cancel(); }
  });
}
export function reveal(element: HTMLElement | SVGElement | undefined, duration = 180) {
  return animateElement(element, [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], duration);
}
export function useValueMotion(element: () => HTMLElement | SVGElement | undefined, value: () => unknown, hinge = false) {
  createEffect(on(value, () => queueMicrotask(() => {
    void animateElement(element(), [{ opacity: .45, transform: hinge ? "perspective(400px) rotateY(-12deg) scale(.98)" : "translateY(2px)" }, { opacity: 1, transform: "none" }], hinge ? 240 : 120);
  }), { defer: true }));
  onCleanup(() => cancelMotion(element()));
}
export function useSelectionMotion(element: () => HTMLElement | undefined, value: () => unknown, selector: string, horizontal = false) {
  let previous: DOMRect | undefined;
  let marker: HTMLElement | undefined;
  let disposed = false;
  createEffect(on(value, () => queueMicrotask(() => {
    if (disposed) return;
    const root = element(), target = root?.querySelector<HTMLElement>(selector);
    const old = previous;
    previous = target && motionVisible(target) ? target.getBoundingClientRect() : undefined;
    if (marker) { cancelMotion(marker); marker.remove(); marker = undefined; }
    if (!root || !target || !previous || !old || !motionVisible(root) || resolvedMotion() !== "full") return;
    const offset = horizontal ? old.left - previous.left : old.top - previous.top;
    if (Math.abs(offset) < 1 || Math.abs(offset) > window.innerHeight) return;
    const rail = document.createElement("div");
    marker = rail; rail.className = "motion-selection-marker";
    rail.setAttribute("aria-hidden", "true");
    Object.assign(rail.style, { top: `${horizontal ? previous.bottom - 2 : previous.top + 6}px`, left: `${previous.left}px`, width: horizontal ? `${previous.width}px` : "3px", height: horizontal ? "2px" : `${Math.max(4, previous.height - 12)}px` });
    document.body.append(rail);
    void animateElement(rail, [{ transform: `translate${horizontal ? "X" : "Y"}(${offset}px)` }, { transform: "none" }], 180).then(() => { rail.remove(); if (marker === rail) marker = undefined; });
  })));
  onCleanup(() => { disposed = true; if (marker) { cancelMotion(marker); marker.remove(); } });
}

/** Retains an outgoing view through its exit, immediately removing interaction.
 * Reopening invalidates the previous completion so it cannot hide the new view. */
export function usePresence(open: () => boolean, element: () => HTMLElement | undefined, options: { axis?: "width" | "height"; size?: () => number; duration?: number; anchor?: () => HTMLElement | undefined; slide?: () => boolean } = {}) {
  const [present, setPresent] = createSignal(untrack(open));
  let generation = 0;
  let anchor: HTMLElement | undefined;
  createEffect(on(open, (visible) => {
    const turn = ++generation;
    const animate = resolvedMotion() !== "off";
    if (visible) {
      anchor = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      setPresent(true);
    }
    queueMicrotask(() => {
      if (turn !== generation) return;
      const el = element();
      if (!el) { if (!visible) setPresent(false); return; }
      el.inert = !visible;
      if (visible) el.removeAttribute("aria-hidden");
      else {
        el.setAttribute("aria-hidden", "true");
        if (el.contains(document.activeElement)) (options.anchor?.() ?? anchor)?.focus({ preventScroll: true });
      }
      const slide = options.slide?.();
      const axis = slide ? undefined : options.axis;
      const size = options.size?.() ?? (axis === "height" ? el.scrollHeight : el.getBoundingClientRect().width);
      const bounded = axis !== "height" || size <= 400;
      const from: Keyframe = { opacity: visible ? 0 : 1 };
      const to: Keyframe = { opacity: visible ? 1 : 0 };
      if (axis && bounded) { from[axis] = `${visible ? 0 : size}px`; to[axis] = `${visible ? size : 0}px`; }
      else if (!el.classList.contains("motion-host") && !el.classList.contains("motion-scrim")) { from.transform = visible ? slide ? "translateX(24px)" : "translateY(4px)" : "none"; to.transform = visible ? "none" : slide ? "translateX(24px)" : "translateY(4px)"; }
      void (animate ? animateElement(el, [from, to], options.duration ?? (visible ? 180 : 120)) : Promise.resolve()).then(() => {
        if (turn === generation && !visible) setPresent(false);
      });
    });
  }));
  onCleanup(() => { generation++; cancelMotion(element()); });
  return present;
}
export const Disclosure: Component<{ open: boolean; class?: string; children: JSX.Element }> = (props) => {
  let element: HTMLDivElement | undefined;
  const present = usePresence(() => props.open, () => element, { axis: "height", duration: 180 });
  return <Show when={present()}><div ref={element} class={`motion-disclosure ${props.class ?? ""}`}>{props.children}</div></Show>;
};

/** Modal lifetime and focus stay independent from its short visual exit. */
const modalStack: Array<() => HTMLElement | undefined> = [];
let rootWasInert = false;
export const Presence: Component<{ when: boolean; label?: string; children: JSX.Element }> = (props) => {
  let element: HTMLDivElement | undefined;
  const present = usePresence(() => props.when, () => element);
  createEffect(() => {
    if (!props.when) return;
    const root = document.getElementById("root");
    if (modalStack.length === 0) rootWasInert = root?.inert ?? false;
    const ownerScope = () => element;
    modalStack.push(ownerScope);
    if (root) root.inert = true;
    window.dispatchEvent(new Event("flipflopper:modal-opened"));
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !element || modalStack[modalStack.length - 1] !== ownerScope) return;
      const menu = document.querySelector<HTMLElement>('[role="menu"]:not([aria-hidden="true"])');
      const owner = menu ?? element;
      const controls = [...owner.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(motionVisible);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !owner.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !owner.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trap, true);
    const focusFirst = () => {
      if (!props.when || !element || modalStack[modalStack.length - 1] !== ownerScope || element.contains(document.activeElement)) return;
      const first = [...element.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), [tabindex="0"]')].find(motionVisible);
      first?.focus({ preventScroll: true });
      return !!first;
    };
    const observer = new MutationObserver(() => { if (focusFirst()) observer.disconnect(); });
    queueMicrotask(() => { if (!focusFirst() && props.when && element) observer.observe(element, { childList: true, subtree: true }); });
    onCleanup(() => { const index = modalStack.indexOf(ownerScope); if (index >= 0) modalStack.splice(index, 1); if (root) root.inert = modalStack.length > 0 || rootWasInert; observer.disconnect(); document.removeEventListener("keydown", trap, true); });
  });
  return <Show when={present()}><Portal><div ref={element} class="motion-host" role="dialog" aria-modal="true" aria-label={props.label}>{props.children}</div></Portal></Show>;
};
export function RetainedPresence<T>(props: { value: T | null | undefined | false; children: (value: () => T) => JSX.Element }) {
  let last: T | undefined;
  const retained = createMemo(() => { if (props.value) last = props.value; return last; });
  return <Presence when={!!props.value}>{props.children(() => retained()!)}</Presence>;
}

export function useThemeMotion() {
  onMount(() => {
    let hydrated = false;
    const layers = new Set<HTMLElement>();
    const changed = () => {
      if (!hydrated) { hydrated = true; return; }
      if (resolvedMotion() !== "full" || !motionForeground()) return;
      const layer = document.createElement("div");
      layer.className = "theme-settle"; layer.setAttribute("aria-hidden", "true");
      layers.add(layer); document.body.append(layer);
      void animateElement(layer, [{ opacity: .5 }, { opacity: 0 }], 180).then(() => { layer.remove(); layers.delete(layer); });
    };
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const systemChanged = () => { if (layout.theme === "system") applyTheme("system"); };
    window.addEventListener("flipflopper:theme-changed", changed);
    media.addEventListener("change", systemChanged);
    onCleanup(() => { window.removeEventListener("flipflopper:theme-changed", changed); media.removeEventListener("change", systemChanged); layers.forEach((layer) => { cancelMotion(layer); layer.remove(); }); });
  });
}

/** FLIP only the visible rows in one existing list; never stores domain state. */
export function useListMotion(element: () => HTMLElement | undefined, signature: () => unknown, selector: string, entrances = true) {
  let previous = new Map<string, { element: HTMLElement; rect: DOMRect }>();
  let initialized = false;
  let disposed = false;
  const ghosts = new Set<HTMLElement>();
  createEffect(on(signature, () => queueMicrotask(() => {
    const root = element();
    if (!root || disposed) return;
    if (!motionVisible(root)) { previous.clear(); initialized = false; return; }
    const next = new Map<string, { element: HTMLElement; rect: DOMRect }>();
    for (const row of [...root.querySelectorAll<HTMLElement>(selector)].filter(motionVisible).slice(0, 40)) {
      const key = row.dataset.motionKey;
      if (!key) continue;
      const rect = row.getBoundingClientRect();
      next.set(key, { element: row, rect });
      const old = previous.get(key);
      if (initialized && old && (Math.abs(old.rect.top - rect.top) > 1 || Math.abs(old.rect.left - rect.left) > 1)) {
        const dy = old.rect.top - rect.top, dx = old.rect.left - rect.left;
        if (Math.abs(dy) < window.innerHeight) void animateElement(row, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], 240);
      } else if (initialized && !old && entrances) void reveal(row);
    }
    // Removed rows have already lost their Solid owner. A tiny inert clone
    // provides the exit without delaying deletion, navigation or git results.
    if (initialized && resolvedMotion() !== "off" && motionForeground()) {
      for (const [key, old] of previous) if (!next.has(key) && !old.element.isConnected && ghosts.size < 4) {
        const ghost = old.element.cloneNode(true) as HTMLElement;
        ghost.removeAttribute("id"); ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        ghost.inert = true; ghost.setAttribute("aria-hidden", "true");
        Object.assign(ghost.style, { position: "fixed", top: `${old.rect.top}px`, left: `${old.rect.left}px`, width: `${old.rect.width}px`, height: `${old.rect.height}px`, margin: "0", pointerEvents: "none", zIndex: "90" });
        document.body.append(ghost); ghosts.add(ghost);
        void animateElement(ghost, [{ opacity: .6 }, { opacity: 0 }], 80).then(() => { ghost.remove(); ghosts.delete(ghost); });
      }
    }
    previous = next; initialized = true;
  })));
  onCleanup(() => { disposed = true; previous.forEach(({ element }) => cancelMotion(element)); previous.clear(); ghosts.forEach((ghost) => { cancelMotion(ghost); ghost.remove(); }); });
}

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
        flex: "0 0 auto",
      }}
      class="ui-spinner" role="img" aria-label="Working"
    />
  );
};

// ── Button ────────────────────────────────────────────────────────────────────

export const Button: Component<{
  variant?: "outline" | "solid" | "ghost" | "danger";
  size?: "sm" | "md";
  title?: string;
  disabled?: boolean;
  type?: "button" | "submit";
  ref?: (el: HTMLButtonElement) => void;
  onClick?: (e: MouseEvent) => void;
  style?: JSX.CSSProperties;
  classList?: Record<string, boolean | undefined>;
  "aria-label"?: string;
  children: JSX.Element;
}> = (props) => {
  const variant = () => props.variant ?? "outline";
  const size = () => props.size ?? "md";

  const variantStyle = (): JSX.CSSProperties => {
    switch (variant()) {
      case "solid":
        return { background: "var(--accent)", border: "1px solid var(--accent)", color: "var(--fg-on-accent)" };
      case "danger":
        return { background: "var(--status-del)", border: "1px solid var(--status-del)", color: "var(--fg-on-accent)" };
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
      aria-label={props["aria-label"] ?? props.title}
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

// ── Input / Textarea / Checkbox ─────────────────────────────────────
// Shared form field styling (focus ring, border, surface) so consumers stop
// hand-rolling these — previously duplicated with subtly different focus-ring
// values in ChangesTab's commit textarea and SquashPushDialog's name input.

const fieldBaseStyle: JSX.CSSProperties = {
  width: "100%", "box-sizing": "border-box",
  background: "var(--surface-1)",
  border: "1px solid var(--border-strong)",
  "border-radius": "var(--radius-md)",
  color: "var(--fg-default)",
  "font-size": "12.5px",
  outline: "none",
};

export const Input: Component<{
  value: string;
  onInput: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onBlur?: (e: FocusEvent) => void;
  placeholder?: string;
  disabled?: boolean;
  spellcheck?: boolean;
  ref?: (el: HTMLInputElement) => void;
  style?: JSX.CSSProperties;
}> = (props) => (
  <input
    ref={props.ref}
    class="ui-field"
    value={props.value}
    disabled={props.disabled}
    placeholder={props.placeholder}
    spellcheck={props.spellcheck ?? false}
    onInput={(e) => props.onInput(e.currentTarget.value)}
    onBlur={props.onBlur}
    onKeyDown={props.onKeyDown}
    style={{
      ...fieldBaseStyle,
      padding: "8px 10px",
      opacity: props.disabled ? ".6" : "1",
      ...(props.style ?? {}),
    }}
  />
);

export const Textarea: Component<{
  value: string;
  onInput: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  ref?: (el: HTMLTextAreaElement) => void;
  style?: JSX.CSSProperties;
}> = (props) => (
  <textarea
    ref={props.ref}
    class="ui-field"
    value={props.value}
    disabled={props.disabled}
    placeholder={props.placeholder}
    rows={props.rows ?? 3}
    onInput={(e) => props.onInput(e.currentTarget.value)}
    onKeyDown={props.onKeyDown}
    style={{
      ...fieldBaseStyle,
      resize: "none",
      padding: "7px 9px",
      "font-family": "var(--font-mono)",
      "font-size": "12px",
      opacity: props.disabled ? ".6" : "1",
      ...(props.style ?? {}),
    }}
  />
);

export const Checkbox: Component<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: JSX.Element;
  disabled?: boolean;
  style?: JSX.CSSProperties;
}> = (props) => (
  <label
    style={{
      display: "inline-flex", "align-items": "center", gap: "8px",
      cursor: props.disabled ? "default" : "pointer",
      opacity: props.disabled ? ".6" : "1",
      "font-size": "12.5px", color: "var(--fg-body)",
      ...(props.style ?? {}),
    }}
  >
    <input
      type="checkbox"
      checked={props.checked}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.checked)}
      style={{ "accent-color": "var(--accent)", cursor: props.disabled ? "default" : "pointer" }}
    />
    {props.label}
  </label>
);

// ── Menu / MenuItem ───────────────────────────────────────────────────────────
// Dropdown card shared by composer pickers and terminal actions.
// `anchorRef` must be the toggle element that
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
  const present = usePresence(() => props.open && !!pos(), () => ref, { anchor: () => props.anchorRef });

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
    const maxHeight = Math.max(0, Math.min(MENU_MAX_HEIGHT, (openUpward ? spaceAbove : spaceBelow) - MENU_GAP));
    const width = Math.min(props.width ?? 288, window.innerWidth - MENU_GAP * 2);
    const left = Math.max(MENU_GAP, Math.min(props.align === "right" ? rect.right - width : rect.left, window.innerWidth - width - MENU_GAP));

    setPos({
      ...(openUpward
        ? { bottom: window.innerHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
      left,
      maxHeight,
    });
    queueMicrotask(() => { if (props.open) ref?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus({ preventScroll: true }); });
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
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (!props.open || !ref?.contains(document.activeElement)) return;
      if (e.key === "Tab") {
        const controls = [...ref.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if ((!e.shiftKey && index === controls.length - 1) || (e.shiftKey && index === 0)) { e.preventDefault(); props.onClose(); }
      }
      if (document.activeElement?.matches("input, textarea")) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const items = [...ref.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      if (!items.length) return;
      e.preventDefault(); e.stopPropagation();
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
    const modalOpened = () => { if (props.open) props.onClose(); };
    window.addEventListener("flipflopper:modal-opened", modalOpened);
    window.addEventListener("resize", modalOpened);
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKey, true);
    onCleanup(() => {
      window.removeEventListener("flipflopper:modal-opened", modalOpened);
      window.removeEventListener("resize", modalOpened);
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKey, true);
    });
  });

  return (
    <Show when={present() && pos()}>
      {(p) => (
        <Portal>
          <div
            ref={ref}
            role="menu"
            class="motion-menu"
            style={{
              position: "fixed",
              ...(p().top !== undefined ? { top: `${p().top}px` } : {}),
              ...(p().bottom !== undefined ? { bottom: `${p().bottom}px` } : {}),
              ...(p().left !== undefined ? { left: `${p().left}px` } : {}),
              ...(p().right !== undefined ? { right: `${p().right}px` } : {}),
              width: `${props.width ?? 288}px`,
              "max-width": `calc(100vw - ${MENU_GAP * 2}px)`,
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
    "font-size": "12px", "letter-spacing": ".5px",
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
      "border-radius": "var(--radius-md)",
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
  const present = usePresence(() => props.open && !!pos(), () => ref);
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
    const modalOpened = () => props.onClose();
    window.addEventListener("flipflopper:modal-opened", modalOpened);
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
      window.removeEventListener("flipflopper:modal-opened", modalOpened);
      window.clearTimeout(id);
      document.removeEventListener("pointerdown", handleClick, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("contextmenu", handleClick, true);
      document.removeEventListener("scroll", handleClick, true);
      document.removeEventListener("keydown", handleKey, true);
    });
  });

  return (
    <Show when={present() && pos()}>
      {(p) => (
        <Portal>
          <div
            ref={ref}
            role="menu"
            class="motion-menu"
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
  }, resolvedMotion() === "off" ? 0 : resolvedMotion() === "reduced" ? 80 : TOAST_EXIT_MS);
}

const TOAST_COLOR: Record<ToastKind, string> = {
  info: "var(--accent-soft)",
  success: "var(--status-add)",
  error: "var(--status-del)",
};

export const ToastHost: Component = () => (
  <Portal><div class="motion-toasts"
    aria-live="polite"
    aria-atomic="false"
    style={{
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
            role="status"
            classList={{ "toast-item-leaving": t.leaving }}
            style={{
              display: "flex", "align-items": "flex-start", gap: "10px",
              background: "var(--surface-3)",
              border: `1px solid color-mix(in srgb, ${color} 35%, var(--border-default))`,
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
              aria-label="Dismiss notification"
              style={{ "flex-shrink": "0", color: "var(--fg-subtle)", cursor: "pointer", padding: "2px" }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      }}
    </For>
  </div></Portal>
);

// ── Confirm dialog ────────────────────────────────────────────────────────────

interface ConfirmState {
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}

interface ConfirmOptions {
  confirmLabel?: string;
  /** Renders the confirm button in the danger (red) variant, for irreversible
   *  or high-risk actions (discard, rollback, Full access). */
  danger?: boolean;
}

const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null);

export function confirmDialog(message: string, opts?: string | ConfirmOptions): Promise<boolean> {
  const { confirmLabel = "Confirm", danger = false } =
    typeof opts === "string" ? { confirmLabel: opts } : (opts ?? {});
  return new Promise((resolve) => {
    setConfirmState({ message, confirmLabel, danger, resolve });
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
    <RetainedPresence value={confirmState()}>
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
              <Button
                variant={state().danger ? "danger" : "solid"}
                onClick={() => resolveConfirm(true)}
              >
                {state().confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </RetainedPresence>
  );
};
