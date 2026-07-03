import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";

// Editor chrome — matches the terminal area / DiffPane surfaces.
const theme = EditorView.theme(
  {
    "&": {
      background: "#0b0c10",
      color: "#c9d1d9",
      fontSize: "12.5px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "'JetBrains Mono', monospace",
      lineHeight: "1.6",
    },
    ".cm-content": {
      caretColor: "#58a6ff",
      padding: "8px 0",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#58a6ff" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { background: "#58a6ff33" },
    ".cm-selectionMatch": {
      background: "#58a6ff24",
      outline: "1px solid #58a6ff55",
      borderRadius: "2px",
    },
    ".cm-activeLine": { background: "#ffffff06" },
    ".cm-gutters": {
      background: "#0b0c10",
      color: "#484f58",
      border: "none",
      borderRight: "1px solid #1a1d25",
    },
    ".cm-activeLineGutter": { background: "#ffffff06", color: "#8b949e" },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 16px" },
    ".cm-foldGutter .cm-gutterElement": { padding: "0 6px" },
    ".cm-foldPlaceholder": {
      background: "#14161d",
      border: "1px solid #2a2e3a",
      color: "#8b949e",
    },
    ".cm-matchingBracket": {
      background: "#58a6ff2e",
      outline: "1px solid #58a6ff66",
    },
    ".cm-panels": {
      background: "#14161d",
      color: "#c9d1d9",
      borderTop: "1px solid #2a2e3a",
    },
    ".cm-panels input, .cm-panels button": {
      fontFamily: "'IBM Plex Sans', sans-serif",
      fontSize: "12px",
    },
    ".cm-searchMatch": { background: "#d2992240" },
    ".cm-searchMatch-selected": { background: "#d2992270" },
    ".cm-tooltip": {
      background: "#14161d",
      border: "1px solid #2a2e3a",
      color: "#c9d1d9",
    },
    ".cm-tooltip-autocomplete": {
      boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
    },
    ".cm-tooltip-autocomplete > ul": {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: "12px",
      maxHeight: "280px",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      background: "#1f6feb33",
      color: "#f0f6fc",
    },
    ".cm-completionDetail": { color: "#8b949e" },
    ".cm-diagnostic": {
      background: "#14161d",
      border: "1px solid #2a2e3a",
      color: "#c9d1d9",
    },
    ".cm-lintRange-error": { backgroundImage: "linear-gradient(45deg, transparent 65%, #f85149 80%, transparent 90%)" },
    ".cm-lintRange-warning": { backgroundImage: "linear-gradient(45deg, transparent 65%, #d29922 80%, transparent 90%)" },
  },
  { dark: true }
);

// Token colors — mirrors highlight.js github-dark, already used by DiffPane.
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.moduleKeyword], color: "#ff7b72" },
  { tag: [t.controlKeyword, t.definitionKeyword], color: "#ff7b72" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a5d6ff" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#d2a8ff" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#8b949e", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName)], color: "#79c0ff" },
  { tag: [t.className, t.typeName, t.namespace], color: "#ffa657" },
  { tag: [t.tagName, t.angleBracket], color: "#7ee787" },
  { tag: [t.propertyName, t.attributeName], color: "#79c0ff" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "#c9d1d9" },
  { tag: [t.operator, t.punctuation, t.separator], color: "#c9d1d9" },
  { tag: t.meta, color: "#8b949e" },
  { tag: t.heading, color: "#79c0ff", fontWeight: "700" },
  { tag: t.link, color: "#a5d6ff", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.invalid, color: "#f85149" },
]);

export const flipflopperTheme: Extension[] = [theme, syntaxHighlighting(highlightStyle)];
