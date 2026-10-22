// Exercise the actual chat store/reducer in Node. Only OS/UI boundaries are
// mocked; no DOM, provider login or additional test framework is required.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import * as solid from "solid-js";
import * as solidStore from "solid-js/store";

const source = ts.transpileModule(readFileSync(new URL("../src/lib/chat.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const imports = new Map();
for (const declaration of ts.createSourceFile("chat.js", source, ts.ScriptTarget.ES2022).statements) {
  if (ts.isImportDeclaration(declaration)) imports.set(declaration.moduleSpecifier.text, declaration.importClause.namedBindings.elements.map((e) => e.propertyName?.text ?? e.name.text));
}
async function loadChat(overrides = {}) {
  // Keep Solid's prototype checks in the same JS realm as the store values.
  globalThis.document = { hasFocus: () => true };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const mocks = { "solid-js": solid, "solid-js/store": solidStore, "./agentMeta": { AGENT_TUNING: {} }, "./store": { store: {} }, ...overrides };
  const module = new SourceTextModule(source);
  await module.link((specifier) => {
    const names = imports.get(specifier);
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, mocks[specifier]?.[name] ?? (() => { throw new Error(`Unexpected boundary call: ${specifier}.${name}`); }));
    });
  });
  await module.evaluate();
  return module.namespace;
}
const event = (event, ts = 1) => ({ kind: "event", event, ts });
const request = { id: "approval", turn_id: "turn", kind: "permission", title: "Run command", payload: { options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] } };
const runtime = () => ({ connected: true, active_turn_id: "turn", agent_id: "claude", native_session_id: "native", config_options: [], modes: [], commands: [], pending: [structuredClone(request)] });
const waiting = () => [
  event({ type: "turn_started", turn_id: "turn", agent_id: "claude" }),
  event({ type: "runtime_updated", state: runtime() }),
  event({ type: "interaction_requested", request: structuredClone(request) }),
];

test("persisted requests stay historical after process restart", async () => {
  const chat = await loadChat(), view = chat.reduceTranscript(waiting());
  assert.equal(view.running, false);
  assert.equal(view.messages[0].status, "cancelled");
  assert.equal(view.runtime.pending.length, 0);
  chat.setChat("views", "s", view);
  assert.equal(chat.interactionIsLive("s", "approval"), false);
});
test("webview reload restores only a request owned by the live backend turn", async () => {
  const chat = await loadChat(), view = chat.reduceTranscript(waiting(), runtime());
  chat.setChat("views", "s", view);
  assert.equal(chat.interactionIsLive("s", "approval"), true);
  assert.equal(chat.pendingInputCount("s"), 1);
  const wrongTurn = chat.reduceTranscript(waiting(), { ...runtime(), active_turn_id: "other-turn" });
  assert.equal(wrongTurn.running, false);
  assert.equal(wrongTurn.runtime.pending.length, 0);
});
test("request resolution and turn completion do not replay or duplicate tools", async () => {
  const chat = await loadChat(), entries = waiting();
  entries.push(
    event({ type: "tool_call", id: "edit", kind: "other", title: "Edit", input: {} }),
    event({ type: "tool_updated", id: "edit", kind: "edit", title: "Edit file", input: { file_path: "a.ts", old_string: "a", new_string: "b" } }),
    event({ type: "interaction_resolved", id: "approval", outcome: "answered" }),
    event({ type: "context_usage", used: 123, size: 200000, cost_usd: 0.01 }),
    event({ type: "turn_ended", turn_id: "turn", status: "done", changed_files: [] }),
  );
  const view = chat.reduceTranscript(entries, runtime()), assistant = view.messages[0];
  assert.equal(view.running, false);
  assert.equal(assistant.status, "done");
  assert.equal(assistant.blocks.filter((b) => b.kind === "tool").length, 1);
  assert.equal(assistant.blocks.find((b) => b.kind === "tool").input.new_string, "b");
  assert.equal(assistant.blocks.find((b) => b.kind === "tool").toolKind, "edit");
  assert.equal(assistant.blocks.find((b) => b.kind === "interaction").outcome, "answered");
  assert.equal(assistant.contextUsage.used, 123);
  assert.equal(view.runtime.pending.length, 0);
});
test("model, effort and command pickers use the active provider catalog", async () => {
  const chat = await loadChat();
  const state = { ...runtime(), config_options: [
    { id: "model", category: "model", options: [{ group: "Models", options: [{ value: "native-model", name: "Native model" }] }] },
    { id: "effort", category: "thought_level", options: [{ value: "native-effort", name: "Native effort" }] },
  ], commands: [{ name: "native-command", description: "From the provider" }] };
  chat.setChat("views", "s", { messages: [], loaded: true, running: false, runtime: state });
  chat.setChat("activeId", "s");
  assert.equal(chat.agentTuning("claude").models[0].id, "native-model");
  assert.equal(chat.agentTuning("claude").efforts[0].id, "native-effort");
  assert.equal(chat.agentTuning("cursor").models.length, 0);
  assert.equal(chat.nativeCommands()[0].name, "native-command");
  chat.setChat("composer", "agentId", "cursor");
  assert.equal(chat.nativeCommands().length, 0);
});


test("live requests keep progressing when an occluded webview has no paint frames", async () => {
  let listener;
  const meta = { id: "s", project_path: "/fixture/project", cwd: "/fixture/project", agent_id: "claude", status: "idle" };
  const chat = await loadChat({ "./ipc": {
    chatCreateSession: async () => meta,
    onChatEntry: async (_id, callback) => { listener = callback; return () => {}; },
    chatSend: async () => { for (const entry of waiting()) listener(entry); return "turn"; },
    chatListSessions: async () => [meta],
  } });
  await chat.startSessionTurn({ projectPath: "/fixture/project", agentId: "claude", mode: "auto_edit", prompt: "fixture", activate: false });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(chat.isRunning("s"), true, JSON.stringify(chat.chat.views));
  assert.equal(chat.interactionIsLive("s", "approval"), true);
  assert.equal(chat.pendingInputCount("s"), 1);
});
