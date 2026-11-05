// Rebindable keyboard shortcuts for commands handled in the web layer. Shortcuts owned by the
// native menu (new session, palette, sidebar, …) stay fixed because the menu intercepts them first.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

/** A key combination. `mod` is ⌘ on macOS and Ctrl elsewhere. `key` is `event.key` lowercased, or `code:KeyN` for a physical key. */
export interface Binding { key: string; mod: boolean; shift: boolean; alt: boolean }

export type CommandId =
  | "find-in-conversation" | "find-in-file" | "stash-prompt" | "reopen-closed" | "scratch-session" | "focus-next-area" | "focus-previous-area"
  | "toggle-focus-view" | "open-usage" | "ask-side-question" | "open-compare" | "file-picker" | "project-search";

export interface CommandDef { id: CommandId; label: string; group: string; fallback: string | null; /** Default `when` expression. */ when?: string }

/** What is active when a shortcut fires; referenced by `when` expressions. */
export interface ShortcutContext {
  composerFocus: boolean;
  terminalFocus: boolean;
  editableFocus: boolean;
  paletteOpen: boolean;
  sessionOpen: boolean;
  turnRunning: boolean;
  diffFocus: boolean;
}

/** Ready-made conditions for Settings → Shortcuts. The stored value is the expression. */
export const WHEN_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Anywhere" },
  { value: "composerFocus", label: "Composer focused" },
  { value: "!editableFocus", label: "Not in a text field" },
  { value: "sessionOpen", label: "Session open" },
  { value: "!sessionOpen", label: "No session open" },
  { value: "turnRunning", label: "Turn running" },
  { value: "terminalFocus", label: "Terminal focused" },
  { value: "diffFocus", label: "Diff focused" },
];

/** Rebindable commands with their default combos (`null` = unbound by default). */
export const COMMANDS: CommandDef[] = [
  { id: "find-in-conversation", label: "Find in the conversation", group: "Conversation", fallback: "mod+f" },
  { id: "find-in-file", label: "Find in the open file", group: "Navigation", fallback: null },
  { id: "stash-prompt", label: "Stash the draft prompt / restore it", group: "Composer", fallback: "mod+s" },
  { id: "reopen-closed", label: "Reopen the last archived session", group: "Sessions", fallback: "mod+shift+t" },
  { id: "scratch-session", label: "New session without a project", group: "Sessions", fallback: "mod+alt+code:KeyN" },
  { id: "focus-next-area", label: "Focus the next area", group: "Navigation", fallback: "f6" },
  { id: "focus-previous-area", label: "Focus the previous area", group: "Navigation", fallback: "shift+f6" },
  { id: "toggle-focus-view", label: "Show final answers only", group: "Conversation", fallback: null },
  { id: "open-usage", label: "Open usage", group: "Navigation", fallback: "mod+u" },
  { id: "file-picker", label: "Go to file", group: "Navigation", fallback: "mod+p" },
  { id: "project-search", label: "Search project contents", group: "Navigation", fallback: "mod+shift+f" },
  { id: "ask-side-question", label: "Ask a side question", group: "Conversation", fallback: null },
  { id: "open-compare", label: "Compare agents started together", group: "Conversation", fallback: null },
];

const MODIFIERS = new Set(["mod", "ctrl", "cmd", "shift", "alt", "option"]);

/** `"mod+shift+t"` → binding; `null` for anything that is not a valid combo. */
export function parseBinding(text: string | null | undefined): Binding | null {
  if (!text) return null;
  const code = /code:(\w+)/i.exec(text);
  const parts = text.replace(/code:\w+/i, "").toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const mods = parts.filter((p) => MODIFIERS.has(p));
  const keys = parts.filter((p) => !MODIFIERS.has(p));
  const key = code ? `code:${code[1]}` : keys[keys.length - 1];
  if (!key) return null;
  return { key, mod: mods.some((m) => ["mod", "ctrl", "cmd"].includes(m)), shift: mods.includes("shift"), alt: mods.some((m) => ["alt", "option"].includes(m)) };
}

/** Canonical stored form, e.g. `mod+shift+t`. */
export const bindingToString = (b: Binding): string => [b.mod && "mod", b.alt && "alt", b.shift && "shift", b.key].filter(Boolean).join("+");

const KEY_LABELS: Record<string, string> = { " ": "Space", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", escape: "Esc", enter: "Enter", tab: "Tab", backspace: "⌫" };

/** Human-readable combo: `⌘⇧T` on macOS, `Ctrl+Shift+T` elsewhere. */
export function formatBinding(b: Binding, mac: boolean): string {
  const raw = b.key.startsWith("code:") ? b.key.slice(5).replace(/^Key|^Digit/, "") : b.key;
  const key = KEY_LABELS[raw] ?? (raw.length === 1 ? raw.toUpperCase() : raw.toUpperCase());
  return mac ? `${b.mod ? "⌘" : ""}${b.alt ? "⌥" : ""}${b.shift ? "⇧" : ""}${key}` : [b.mod && "Ctrl", b.alt && "Alt", b.shift && "Shift", key].filter(Boolean).join("+");
}

/** The binding a key press represents; letters and digits typed with Alt use the physical key (Option rewrites characters on macOS). */
export function bindingFromEvent(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): Binding | null {
  if (["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock"].includes(e.key)) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const physical = e.altKey && /^(Key|Digit)/.test(e.code);
  return { key: physical ? `code:${e.code}` : e.key.toLowerCase(), mod, shift: e.shiftKey, alt: e.altKey };
}

export function eventMatches(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, b: Binding, mac: boolean): boolean {
  if ((mac ? e.metaKey : e.ctrlKey) !== b.mod || e.shiftKey !== b.shift || e.altKey !== b.alt) return false;
  return b.key.startsWith("code:") ? e.code === b.key.slice(5) : e.key.toLowerCase() === b.key;
}

/** Why a combo can't be used, or `null`. Plain letters would steal typing; function keys are fine on their own. */
export function bindingProblem(b: Binding): string | null {
  const functionKey = /^f([1-9]|1[0-2])$/.test(b.key);
  if (!b.mod && !b.alt && !functionKey) return "Use ⌘/Ctrl or Alt with a key, or a function key.";
  if (["escape", "enter", "tab", "backspace", " "].includes(b.key) && !b.mod) return "That key is needed for typing and navigation.";
  return null;
}

/** Combos the native menu already owns (and the app's other fixed shortcuts). */
export const RESERVED: string[] = ["mod+n", "mod+shift+n", "mod+o", "mod+k", "mod+l", "mod+.", "mod+,", "mod+b", "mod+alt+b", "mod+shift+g", "mod+j", "mod+z", "mod+shift+[", "mod+shift+]", "mod+=", "mod+-", "mod+0", "mod+w", "mod+q", "mod+c", "mod+v", "mod+x", "mod+a"];

type WhenPredicate = (context: ShortcutContext) => boolean;
const whenCache = new Map<string, WhenPredicate | null>();

function tokenizeWhen(input: string): string[] | null {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) { index += 1; continue; }
    const pair = input.slice(index, index + 2);
    if (pair === "&&" || pair === "||") { tokens.push(pair); index += 2; continue; }
    if (char === "!" || char === "(" || char === ")") { tokens.push(char); index += 1; continue; }
    const identifier = /^[A-Za-z][A-Za-z0-9_]*/.exec(input.slice(index));
    if (!identifier) return null;
    tokens.push(identifier[0]);
    index += identifier[0].length;
  }
  return tokens;
}

/** Parse a `when` expression: identifiers, `!`, `&&`, `||` and parentheses, with `&&`
 *  binding tighter than `||`. An empty expression is always true; invalid syntax is `null`. */
export function parseWhen(expression: string | null | undefined): WhenPredicate | null {
  const text = (expression ?? "").trim();
  if (!text) return () => true;
  if (whenCache.has(text)) return whenCache.get(text)!;
  const tokens = tokenizeWhen(text);
  let predicate: WhenPredicate | null = null;
  if (tokens && tokens.length > 0) {
    let index = 0;
    const eat = (value: string) => { if (tokens[index] === value) { index += 1; return true; } return false; };
    const parseUnary = (): WhenPredicate | null => {
      if (eat("!")) {
        const inner = parseUnary();
        return inner ? (context) => !inner(context) : null;
      }
      if (eat("(")) {
        const inner = parseOr();
        return inner && eat(")") ? inner : null;
      }
      const token = tokens[index];
      if (!token || !/^[A-Za-z][A-Za-z0-9_]*$/.test(token)) return null;
      index += 1;
      return (context) => context[token as keyof ShortcutContext] === true;
    };
    const parseAnd = (): WhenPredicate | null => {
      let left = parseUnary();
      while (left && eat("&&")) {
        const right = parseUnary();
        if (!right) return null;
        const previous = left;
        left = (context) => previous(context) && right(context);
      }
      return left;
    };
    function parseOr(): WhenPredicate | null {
      let left = parseAnd();
      while (left && eat("||")) {
        const right = parseAnd();
        if (!right) return null;
        const previous = left;
        left = (context) => previous(context) || right(context);
      }
      return left;
    }
    predicate = parseOr();
    if (index !== tokens.length) predicate = null;
  }
  whenCache.set(text, predicate);
  return predicate;
}

/** Whether a `when` expression is syntactically valid (empty counts as valid). */
export function validWhenExpression(expression: string | null | undefined): boolean {
  return !(expression ?? "").trim() || parseWhen(expression) !== null;
}

/** Evaluate a condition against the current context; unknown identifiers are false. */
export function evaluateWhen(expression: string | null | undefined, context: ShortcutContext): boolean {
  const predicate = parseWhen(expression);
  return predicate ? predicate(context) : false;
}

const overrides = createSignal<Record<string, string | null>>({});
const [overrideMap, setOverrideMap] = overrides;
export const keybindingOverrides = overrideMap;

const whenOverrides = createSignal<Record<string, string>>({});
const [whenMap, setWhenMap] = whenOverrides;
/** User overrides for each command's `when` expression. */
export const keybindingWhen = whenMap;

/** Effective combo for a command: the user's choice (or "none"), else its default. */
export function effectiveBinding(id: CommandId, map: Record<string, string | null> = overrideMap()): Binding | null {
  const def = COMMANDS.find((c) => c.id === id);
  if (!def) return null;
  return parseBinding(Object.prototype.hasOwnProperty.call(map, id) ? map[id] : def.fallback);
}

/** The `when` expression for a command: the user's choice, else its default, else always. */
export function effectiveWhen(id: CommandId, map: Record<string, string> = whenMap()): string {
  const def = COMMANDS.find((command) => command.id === id);
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : (def?.when ?? "");
}

/** The command (other than `except`) already using this combo, or a reserved-shortcut label.
 *  Two commands may share a combo when both are limited to different non-empty contexts. */
export function bindingConflict(
  b: Binding,
  except: CommandId,
  map: Record<string, string | null> = overrideMap(),
  when: Record<string, string> = whenMap(),
): string | null {
  const text = bindingToString(b);
  if (RESERVED.includes(text)) return "That shortcut belongs to the app menu.";
  const exceptWhen = effectiveWhen(except, when);
  const other = COMMANDS.find((command) => {
    if (command.id === except) return false;
    const binding = effectiveBinding(command.id, map);
    if (!binding || bindingToString(binding) !== text) return false;
    const whenOther = effectiveWhen(command.id, when);
    return whenOther === exceptWhen || !whenOther || !exceptWhen;
  });
  return other ? `Already used by “${other.label}”.` : null;
}

const KEY = "keybindings";
const WHEN_KEY = "keybindingWhen";
export async function hydrateKeybindings() {
  const [saved, savedWhen] = await Promise.all([
    readPref<Record<string, string | null>>(KEY, {}),
    readPref<Record<string, string>>(WHEN_KEY, {}),
  ]);
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    setOverrideMap(Object.fromEntries(Object.entries(saved).filter(([id, v]) => COMMANDS.some((c) => c.id === id) && (v === null || parseBinding(v)))));
  }
  if (savedWhen && typeof savedWhen === "object" && !Array.isArray(savedWhen)) {
    setWhenMap(Object.fromEntries(Object.entries(savedWhen).filter(([id, value]) => COMMANDS.some((c) => c.id === id) && typeof value === "string" && value.trim() && validWhenExpression(value))));
  }
}

/** Save a combo (`null` = unbind) or restore the default (`undefined`). */
export function setKeybinding(id: CommandId, binding: Binding | null | undefined) {
  const next = { ...overrideMap() };
  if (binding === undefined) delete next[id];
  else next[id] = binding ? bindingToString(binding) : null;
  setOverrideMap(next);
  writePref(KEY, next);
}

/** Save a command's `when` expression (`undefined` restores its default). Invalid expressions
 *  are refused. Returns whether the value was saved. */
export function setKeybindingWhen(id: CommandId, expression: string | undefined): boolean {
  const next = { ...whenMap() };
  const clean = (expression ?? "").trim();
  if (!clean) delete next[id];
  else {
    if (!validWhenExpression(clean)) return false;
    next[id] = clean;
  }
  setWhenMap(next);
  writePref(WHEN_KEY, next);
  return true;
}

/** The command a key press triggers, if any. With a context, commands whose `when`
 *  expression does not hold are skipped. */
export function commandForEvent(
  e: Parameters<typeof eventMatches>[0],
  mac: boolean,
  map: Record<string, string | null> = overrideMap(),
  when: Record<string, string> = whenMap(),
  context?: ShortcutContext,
): CommandId | null {
  for (const command of COMMANDS) {
    const binding = effectiveBinding(command.id, map);
    if (!binding || !eventMatches(e, binding, mac)) continue;
    if (context && !evaluateWhen(effectiveWhen(command.id, when), context)) continue;
    return command.id;
  }
  return null;
}
