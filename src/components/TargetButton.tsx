import { Component, For, Show, type JSX } from "solid-js";
import { Icon, type IconName } from "./shell/Icon";
import { Menu, MenuItem, MenuLabel, Spinner } from "./ui";

export interface TargetChoice {
  id: string;
  label: string;
  command: string;
}

export const shortLabel = (target: TargetChoice) => target.label.split(" - ")[0] || target.id;

export function preferredTarget<T extends TargetChoice>(targets: readonly T[], savedId: string | undefined): T | null {
  if (targets.length === 0) return null;
  return targets.find((target) => target.id === savedId) ?? targets[0];
}

const TargetButton: Component<{
  targets: readonly TargetChoice[];
  selectedId?: string;
  running: boolean;
  busy: boolean;
  starting: boolean;
  detecting: boolean;
  mainDisabled: boolean;
  menuDisabled: boolean;
  menuOpen: boolean;
  title: string;
  menuTitle: string;
  menuLabel: string;
  detectingLabel: string;
  accent: string;
  icon: IconName;
  onMainClick: () => void;
  onToggleMenu: (event: MouseEvent) => void;
  onCloseMenu: () => void;
  onSelectTarget: (target: TargetChoice) => void;
  badge?: (target: TargetChoice) => JSX.Element;
  children?: JSX.Element;
}> = (props) => {
  let toggleRef: HTMLDivElement | undefined;
  const selected = (target: TargetChoice) => props.selectedId === target.id;
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
          onclick={props.onMainClick}
          disabled={props.mainDisabled}
          title={props.title}
          aria-label={props.title}
          style={{
            height: "23px",
            width: "29px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            color: props.running ? "var(--status-del)" : props.targets.length > 0 ? props.accent : "var(--fg-faint)",
            cursor: props.mainDisabled ? "default" : "pointer",
          }}
        >
          <div style={{ position: "relative", width: "13px", height: "13px", display: "flex", "align-items": "center", "justify-content": "center" }}>
            <span class="icon-fade" classList={{ "icon-fade-visible": props.busy }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <Spinner size={12} color={props.accent} />
            </span>
            <span class="icon-fade" classList={{ "icon-fade-visible": !props.busy && !props.running }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <Icon name={props.icon} size={13} />
            </span>
            <span class="icon-fade" classList={{ "icon-fade-visible": !props.busy && props.running }} style={{ position: "absolute", inset: 0, display: "flex", "align-items": "center", "justify-content": "center" }}>
              <Icon name="stop" size={12} class="running-pulse" style={{ color: "var(--status-del)" }} />
            </span>
          </div>
        </button>
        <button
          class="hover-tint press"
          onclick={props.onToggleMenu}
          disabled={props.menuDisabled}
          title={props.menuTitle}
          aria-label={`Choose ${props.menuTitle.toLowerCase()}`}
          style={{
            height: "23px",
            width: "20px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            color: !props.menuDisabled ? "var(--fg-subtle)" : "var(--fg-faint)",
            border: "0",
            "border-left": "1px solid var(--border-muted)",
            cursor: !props.menuDisabled ? "pointer" : "default",
          }}
        >
          <Icon name="chevronDown" size={10} style={{ transform: props.menuOpen ? "rotate(180deg)" : "none", transition: "transform var(--dur-base) var(--ease-standard)" }} />
        </button>
      </div>

      <Menu open={props.menuOpen} onClose={props.onCloseMenu} anchorRef={toggleRef} align="right" width={360}>
        <MenuLabel>{props.menuLabel}</MenuLabel>
        {props.children}
        <For each={props.targets}>
          {(target) => (
            <MenuItem
              disabled={props.starting}
              onSelect={() => props.onSelectTarget(target)}
              style={{
                "align-items": "flex-start",
                background: selected(target) ? "var(--surface-4)" : undefined,
              }}
            >
              <Icon name={props.icon} size={13} style={{ color: selected(target) ? props.accent : "var(--fg-muted)" }} />
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
                  {props.badge?.(target)}
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
              <Show when={selected(target)}>
                <span style={{ color: props.accent, "font-size": "12px" }}>•</span>
              </Show>
            </MenuItem>
          )}
        </For>
        <Show when={props.detecting}>
          <div style={{
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "8px 10px",
            color: "var(--fg-subtle)",
            "font-size": "11px",
          }}>
            <Spinner size={12} />
            {props.detectingLabel}
          </div>
        </Show>
      </Menu>
    </div>
  );
};

export default TargetButton;
