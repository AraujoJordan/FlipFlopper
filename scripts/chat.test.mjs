// Exercise the actual chat store/reducer in Node. Only OS/UI boundaries are
// mocked; no DOM, provider login or additional test framework is required.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, runInNewContext } from "node:vm";
import ts from "typescript";
import * as solid from "solid-js";
import * as solidStore from "solid-js/store";

const claudeHelper = new URL("../src-tauri/agent-runtime/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js", import.meta.url);
test("prepared Claude helper resolves advisor results and only dispatches client tools", {
  skip: !existsSync(claudeHelper) && "Run npm run prepare:agents to test the bundled helper",
}, async () => {
  const helper = readFileSync(claudeHelper, "utf8");
  const start = helper.indexOf("const MAX_DISPATCHED_TOOL_CALLS =");
  const end = helper.indexOf("const MAX_REACHED_TOOL_USES =", start);
  assert.ok(start >= 0 && end > start);
  const record = runInNewContext(helper.slice(start, end) + "; recordDispatchedToolUses");
  const session = {};
  record(session, [
    { type: "server_tool_use", id: "server" },
    { type: "tool_use", id: "local" },
    { type: "mcp_tool_use", id: "mcp" },
  ]);
  assert.deepEqual([...session.dispatchedToolCalls], ["local", "mcp"]);

  const { toAcpNotifications } = await import(claudeHelper.href);
  for (const [content, status, expected] of [
    [{ type: "advisor_result", text: "Advice" }, "completed", "Advice"],
    [{ type: "advisor_redacted_result", data: "secret-ciphertext" }, "completed", "Advisor guidance applied server-side."],
    [{ type: "advisor_tool_result_error", error_code: "unavailable" }, "failed", "Advisor error: unavailable"],
  ]) {
    const cache = {};
    const options = { emittedToolCalls: new Set(["server"]) };
    const notify = (blocks) => toAcpNotifications(blocks, "assistant", "test", cache, {}, console, options);
    notify([{ type: "server_tool_use", id: "server", name: "advisor", input: {} }]);
    const updates = notify([{ type: "advisor_tool_result", tool_use_id: "server", content }]);
    assert.equal(updates[0].update.status, status);
    assert.equal(updates[0].update.rawOutput, expected);
    assert.equal(options.emittedToolCalls.size, 0);
    assert.equal(cache.server, undefined);
    assert.ok(!JSON.stringify(updates).includes("secret-ciphertext"));
  }
});

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
  const transcript = overrides["./transcript"] ?? await loadFrontend("../src/lib/transcript.ts", {});
  const mocks = { "solid-js": solid, "solid-js/store": solidStore, "./agentMeta": { discoveredTuning: () => ({ models: [], efforts: [] }) }, "./store": { store: { agents: [{ id: "claude", installed: true }] } }, "./layout": { layout: {projectNames:{},projectOrder:[],hiddenProjects:[]}, openSide() {} }, "./transcript": transcript, "./unread": { markRead() {} }, "./settings": { defaultAgentId: () => null, defaultModel: () => null, notificationMode: () => "off", notifyOnlyUnfocused: () => false, settleKeepPr: () => false, titleInstructions: () => "", worktreePrefix: () => "flipflopper/" }, "./linkedPrs": { linkedPrsFor: () => [] }, "./forkLineage": { recordFork() {} }, ...overrides };
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

async function loadMarkdown() {
  const source = ts.transpileModule(readFileSync(new URL("../src/lib/markdownLite.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const hljs = { registerLanguage() {}, registerAliases() {}, getLanguage() { return false; } };
  // The real math converter: markdownLite imports it by name.
  const math = await loadFrontend("../src/lib/math.ts", {});
  const module = new SourceTextModule(source);
  await module.link((specifier) => specifier === "./math"
    ? new SyntheticModule(["INLINE_MATH", "renderMath"], function () { this.setExport("INLINE_MATH", math.INLINE_MATH); this.setExport("renderMath", math.renderMath); })
    : new SyntheticModule(["default"], function () {
      this.setExport("default", specifier === "highlight.js/lib/core" ? hljs : () => {});
    }));
  await module.evaluate();
  return module.namespace;
}

test("conversation file references link every file type without linking loose filenames or URLs", async () => {
  const { renderPlainTextWithFileRefs: render } = await loadMarkdown();
  const html = render('/tmp/note.txt, images/photo.png videos/clip.mp4 ./README.md @src/App.tsx:42. App.tsx https://example.com/a.png');
  assert.match(html, /data-file-path="\/tmp\/note\.txt"[^>]*>\/tmp\/note\.txt<\/a>,/);
  assert.match(html, /data-file-path="images\/photo\.png"/);
  assert.match(html, /data-file-path="videos\/clip\.mp4"/);
  assert.match(html, /data-file-path="\.\/README\.md"/);
  assert.match(html, /data-file-path="src\/App\.tsx"[^>]*>@src\/App\.tsx:42<\/a>\./);
  assert.match(html, / App\.tsx <a href="https:\/\/example\.com\/a\.png" data-md-link>https:\/\/example\.com\/a\.png<\/a>$/);
  assert.match(render('C:\\media\\clip.mp4'), /data-file-path="C:\\media\\clip\.mp4"[^>]*>C:\\media\\clip\.mp4<\/a>/);
  assert.match(render('<img src=x> /tmp/a&b.txt'), /&lt;img src=x&gt; <a [^>]*data-file-path="\/tmp\/a&amp;b\.txt"[^>]*>\/tmp\/a&amp;b\.txt<\/a>/);
  assert.equal(render('https://example.com/?a=1&b=2'), '<a href="https://example.com/?a=1&amp;b=2" data-md-link>https://example.com/?a=1&amp;b=2</a>');
});

test("Markdown links file paths in prose and inline code but leaves fenced code unchanged", async () => {
  const { renderMarkdownLite: render } = await loadMarkdown();
  assert.match(render('`videos/clip.mp4`'), /data-file-path="videos\/clip\.mp4"[^>]*><code>videos\/clip\.mp4<\/code><\/a>/);
  assert.match(render('[open image](images/photo.png)'), /data-file-path="images\/photo\.png"[^>]*>open image<\/a>/);
  assert.match(render('https://example.com/a.png'), /data-md-link/);
  assert.doesNotMatch(render('```txt\n/tmp/a.txt\n```'), /data-file-path/);
});

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

test("CLI presentation reuses the native terminal and preserves the transcript", async () => {
  let opens = 0;
  const module = await loadChat({ "./ipc": {
    chatOpenTerminal: async () => { opens++; return "pty"; },
    chatRuntimeState: async () => ({ ...runtime(), active_turn_id: null, terminal_id: "pty" }),
  } });
  module.setChat("sessions", [{ id: "s", agent_id: "claude", native_ids: { claude: "native" } }]);
  module.setChat("activeId", "s");
  const view = module.reduceTranscript(waiting());
  view.running = false;
  module.setChat("views", "s", view);
  const before = JSON.stringify(module.chat.views.s.messages);
  await module.setConversationMode("cli");
  assert.equal(module.conversationMode(), "cli");
  assert.equal(module.conversationTerminal(), "pty");
  await module.setConversationMode("chat");
  assert.equal(module.conversationTerminal(), "pty", "view changes must not kill the CLI");
  await module.setConversationMode("cli");
  assert.equal(opens, 1);
  assert.equal(JSON.stringify(module.chat.views.s.messages), before);
  module.setChat("activeId", null);
  assert.equal(module.conversationMode(), "chat");
});

test("CLI can create a fresh session before the first chat turn", async () => {
  const meta = { id: "fresh", project_path: "/project", cwd: "/project", agent_id: "claude", native_ids: {}, mode: "auto_edit", yolo: false };
  let opens = 0, created;
  const module = await loadChat({
    "./store": { store: { agents: [{ id: "claude", installed: true }], currentProject: { path: "/project" } }, setStore() {} },
    "./appPrefs": { writePref() {} },
    "./ipc": {
      chatCreateSession: async () => meta,
      onChatEntry: async () => () => {},
      chatOpenTerminal: async () => { opens++; return "pty"; },
      chatRuntimeState: async () => ({ ...runtime(), active_turn_id: null, terminal_id: "pty" }),
    },
  });
  const off = module.onCliSessionCreated((id) => { created = id; });
  module.setChat("draftProject", "/project");
  await module.setConversationMode("cli");
  off();
  assert.equal(created, "fresh");
  assert.equal(module.chat.activeId, "fresh");
  assert.equal(module.conversationTerminal(), "pty");
  assert.equal(opens, 1);
  await module.setConversationMode("chat");
  assert.equal(module.conversationTerminal(), "pty");
  await module.setConversationMode("cli");
  assert.equal(opens, 1);
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
test("notices, compaction and subagents reduce into blocks; old transcripts are unaffected", async () => {
  const chat = await loadChat();
  const view = chat.reduceTranscript([
    event({ type: "turn_started", turn_id: "turn", agent_id: "claude" }),
    event({ type: "notice", severity: "warning", title: "Rate limited", description: "Retrying" }),
    event({ type: "compaction", id: "c", status: "in_progress" }),
    event({ type: "compaction", id: "c", status: "in_progress", summary: "Sum" }),
    event({ type: "compaction", id: "c", status: "completed", summary: "mary" }),
    event({ type: "subagent", id: "child", title: "Explorer", state: "running" }),
    event({ type: "tool_call", id: "launch", kind: "other", title: "Task", input: {} }),
    event({ type: "subagent", id: "child", prompt: "List files", launched_by: "launch" }),
    event({ type: "tool_call", id: "t1", kind: "bash", title: "ls", input: {} }),
    event({ type: "subagent_tool", id: "t1", subagent: "child" }),
    event({ type: "title_changed", title: "ignored by the transcript" }),
    event({ type: "turn_ended", turn_id: "turn", status: "done", changed_files: [] }),
  ]);
  const blocks = view.messages[0].blocks;
  assert.equal(blocks.find((b) => b.kind === "notice").description, "Retrying");
  const compaction = blocks.filter((b) => b.kind === "compaction");
  assert.equal(compaction.length, 1);
  assert.deepEqual([compaction[0].status, compaction[0].summary], ["completed", "Summary"]);
  const sub = blocks.find((b) => b.kind === "subagent");
  assert.deepEqual([sub.title, sub.prompt, sub.state], ["Explorer", "List files", "idle"]);
  assert.equal(blocks.find((b) => b.id === "t1").subagent, "child");
  assert.equal(blocks.find((b) => b.id === "launch").subagent, "child");
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
  // New-session screen (activeId = null) reuses discovered commands for the same agent.
  chat.setChat("activeId", null);
  assert.equal(chat.nativeCommands()[0].name, "native-command");
  chat.setChat("composer", "agentId", "cursor");
  assert.equal(chat.nativeCommands().length, 0);
});

test("Cursor merges its complete CLI model catalog with native options", async () => {
  const chat = await loadChat({ "./agentMeta": { discoveredTuning: () => ({ models: [
    { id: "cli-only-a", label: "CLI A" },
    { id: "native-model", label: "Duplicate native id" },
    { id: "cli-only-b", label: "CLI B" },
  ], efforts: [] }) } });
  const state = { ...runtime(), agent_id: "cursor", config_options: [
    { id: "model", category: "model", options: [{ value: "native-model", name: "Native model" }] },
    { id: "effort", category: "thought_level", options: [{ value: "high", name: "High" }] },
  ] };
  chat.setChat("views", "s", { messages: [], loaded: true, running: false, runtime: state });
  chat.setChat("activeId", "s");
  const tuning = chat.agentTuning("cursor");
  assert.deepEqual(tuning.models.map((model) => model.id), ["native-model", "cli-only-a", "cli-only-b"]);
  assert.equal(tuning.models[0].label, "Native model");
  assert.equal(tuning.efforts[0].id, "high");
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

test('YOLO is a toggle on top of the mode and follows every chat agent', async () => {
  const writes = [];
  const module = await loadChat({ './appPrefs': { writePref: (...args) => writes.push(args) } });
  module.setYolo(true);
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo], ['auto_edit', true]);
  module.setYolo(false);
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo], ['auto_edit', false]);
  module.setComposer({ mode: 'plan' });
  module.setYolo(true);
  module.setYolo(true); // Idempotent.
  for (const agent of ['claude','codex','cursor','agy','qwen','opencode','droid','grok','kimi','aider','goose']) {
    module.setComposerAgent(agent);
    assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo], ['plan', true], agent);
    assert.equal(writes.at(-1)[1].mode, 'plan');
    assert.equal(writes.at(-1)[1].yolo, true);
  }
  module.setYolo(false);
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo], ['plan', false]);
  assert.equal(writes.at(-1)[1].yolo, false);
  module.setComposer({ mode: 'ask' }); // Changing the mode keeps whatever YOLO was.
  module.setYolo(true); module.setComposer({ mode: 'manual' });
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo], ['manual', true]);
});

test('legacy Full is read as Auto-edit plus YOLO', async () => {
  const module = await loadChat();
  assert.deepEqual(module.splitMode('full'), { mode: 'auto_edit', yolo: true });
  assert.deepEqual(module.splitMode('full', false), { mode: 'auto_edit', yolo: true });
  assert.deepEqual(module.splitMode('plan', true), { mode: 'plan', yolo: true });
  assert.deepEqual(module.splitMode('ask'), { mode: 'ask', yolo: false });
});

test('Shift+Tab cycles Manual, Auto-edit, Plan, Ask, skips Manual for headless agents and keeps YOLO', async () => {
  const module = await loadChat({ './appPrefs': { writePref() {} } });
  const seen = () => { module.cycleMode(1); return module.chat.composer.mode; };
  module.setComposerAgent('claude');
  module.setChat('composer', 'mode', 'manual');
  assert.deepEqual([seen(), seen(), seen(), seen()], ['auto_edit', 'plan', 'ask', 'manual']);
  module.cycleMode(-1); assert.equal(module.chat.composer.mode, 'ask');
  module.setComposerAgent('codex');
  module.setChat('composer', 'mode', 'ask');
  assert.deepEqual([seen(), seen(), seen()], ['auto_edit', 'plan', 'ask']);
  module.setYolo(true); assert.equal(seen(), 'auto_edit'); // Steps on from Ask itself, no detour through a Full mode.
  assert.equal(seen(), 'plan');
  assert.equal(module.chat.composer.yolo, true); // Plan + YOLO.
  module.setComposerAgent('claude'); module.setComposer({ mode: 'manual' });
  module.setComposerAgent('goose'); assert.equal(module.chat.composer.mode, 'auto_edit');
});

const modeReply = (id, mode, yolo = false, extra = {}) => ({ session: { id, mode, yolo }, runtime: { ...runtime(), pending: [], permission_mode: mode, yolo, ...extra } });

test('YOLO is scoped to each conversation and never changes its mode', async () => {
  const module = await loadChat({ './ipc': { chatSetMode: async (id, mode, yolo) => modeReply(id, mode, yolo) } });
  module.setChat('sessions', [{ id: 'a', mode: 'plan', yolo: false }, { id: 'b', mode: 'auto_edit', yolo: false }]);
  module.setChat('activeId', 'a'); module.setChat('composer', { mode: 'plan', yolo: false }); await module.setYolo(true);
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo], ['plan', true]);
  module.setChat('activeId', 'b'); module.setChat('composer', { mode: 'auto_edit', yolo: false }); await module.setYolo(true);
  await module.setYolo(false);
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo], ['auto_edit', false]);
  assert.deepEqual(module.chat.sessions.map((s) => [s.id, s.mode, s.yolo]), [['a', 'plan', true], ['b', 'auto_edit', false]]);
});

test('YOLO converts an active native session only after acknowledgement and can be disabled live', async () => {
  let reply;
  const updates = [];
  const module = await loadChat({ './ipc': { chatSetMode: (id, mode, yolo) => { updates.push([id, mode, yolo]); return new Promise((resolve) => { reply = () => resolve(modeReply(id, mode, yolo)); }); } } });
  module.setChat('activeId', 's');
  module.setChat('sessions', [{ id:'s', mode:'plan', yolo:false }]);
  module.setChat('composer', { mode:'plan', yolo:false });
  module.setChat('views', 's', { messages:[], loaded:true, running:true });
  const enabling = module.setYolo(true);
  assert.equal(module.permissionModeUpdating(),true);
  assert.equal(module.chat.composer.yolo,false);
  assert.equal(await module.setYolo(true),false); // Coalesce double-clicks.
  reply(); assert.equal(await enabling,true);
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['plan',true]);
  assert.deepEqual([module.chat.sessions[0].mode, module.chat.sessions[0].yolo],['plan',true]);
  assert.equal(module.sessionModePending(),false);
  assert.equal(module.isRunning('s'),true);
  const disabling = module.setYolo(false); reply(); await disabling;
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['plan',false]);
  assert.deepEqual(updates,[['s','plan',true],['s','plan',false]]);
});

test('headless conversion is saved on the same session and honestly labels the current launch policy', async () => {
  const notices = [];
  const module = await loadChat({ '../components/ui': { toast: (...args) => notices.push(args) }, './ipc': { chatSetMode: async (id, mode, yolo) => modeReply(id, mode, yolo, { connected:false, agent_id:'codex', permission_mode:'auto_edit', yolo:false }) } });
  module.setChat('activeId','s'); module.setChat('sessions',[{id:'s',mode:'auto_edit'}]);
  module.setChat('views','s',{messages:[],loaded:true,running:true});
  await module.setYolo(true);
  assert.equal(module.chat.composer.yolo,true);
  assert.equal(module.chat.sessions[0].yolo,true);
  assert.equal(module.sessionModePending(),true);
  assert.equal(notices.length,1);
  module.setChat('views','s','runtime','yolo',true);
  assert.equal(module.sessionModePending(),false);
  module.setChat('views','s','runtime','permission_mode','full'); // Legacy payloads still compare correctly.
  module.setChat('views','s','runtime','yolo',false);
  assert.equal(module.sessionModePending(),false);
});

test('failed live conversion does not claim success or change the saved session', async () => {
  const notices=[];
  const module = await loadChat({ '../components/ui': { toast: (...args)=>notices.push(args) }, './ipc': { chatSetMode: async()=>{throw new Error('CLI refused mode');}, chatRuntimeState: async()=>modeReply('s','auto_edit',false).runtime } });
  module.setChat('activeId','s'); module.setChat('sessions',[{id:'s',mode:'auto_edit'}]);
  module.setChat('views','s',{messages:[],loaded:true,running:true});
  assert.equal(await module.setYolo(true),false);
  assert.equal(module.chat.composer.yolo,false);
  assert.equal(module.chat.sessions[0].yolo,undefined);
  assert.equal(module.permissionModeUpdating(),false);
  assert.match(notices[0][0],/CLI refused mode/);
});

test('finishing a mode update in another session cannot overwrite the active composer', async () => {
  let reply;
  const module = await loadChat({ './ipc': { chatSetMode: (id, mode, yolo)=>new Promise(resolve=>{ reply=()=>resolve(modeReply(id,mode,yolo)); }) } });
  module.setChat('activeId','a'); module.setChat('sessions',[{id:'a',mode:'auto_edit'},{id:'b',mode:'plan'}]);
  const pending=module.setYolo(true);
  module.setChat('activeId','b'); module.setChat('composer',{mode:'plan',yolo:false});
  reply(); await pending;
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['plan',false]);
  assert.equal(module.chat.sessions[0].yolo,true);
});

test('a queued turn waits for conversion and uses its own session policy after switching conversations', async () => {
  let reply;
  const sent=[];
  const sessions=[{id:'a',agent_id:'codex',mode:'plan',yolo:false,model:'a-model'}, {id:'b',agent_id:'claude',mode:'plan'}];
  const module=await loadChat({ './ipc': {
    chatSetMode:(id,mode,yolo)=>new Promise(resolve=>{reply=()=>{sessions[0].mode=mode;sessions[0].yolo=yolo;resolve(modeReply(id,mode,yolo));};}),
    chatSend:async(args)=>{sent.push(args);return 'new-turn';},
    chatListSessions:async()=>sessions,
  } });
  module.setChat('sessions',sessions);
  module.setChat('activeId','a');
  module.setChat('composer',{agentId:'codex',mode:'plan',yolo:false});
  module.setChat('views','a',{messages:[],loaded:true,running:false});
  module.setChat('queued','a',[{text:'Continue the task',attachments:[]}]);
  const change=module.setYolo(true);
  module.setChat('activeId','b'); module.setChat('composer',{agentId:'claude',mode:'plan',yolo:false,model:'b-model'});
  const next=module.sendQueuedNow('a',0);
  assert.equal(sent.length,0);
  reply(); await change; await next;
  assert.equal(sent[0].session_id,'a');
  assert.equal(sent[0].agent_id,'codex');
  assert.deepEqual([sent[0].mode,sent[0].yolo],['plan',true]);
  assert.equal(sent[0].model,'a-model');
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['plan',false]);
});

test('repeated native snapshots cannot re-enable YOLO after switching it off', async () => {
  let listener;
  const meta = { id:'s', project_path:'/fixture/project', cwd:'/fixture/project', agent_id:'claude', status:'idle', mode:'auto_edit', yolo:true };
  const module = await loadChat({ './ipc': {
    chatCreateSession: async () => meta,
    onChatEntry: async (_id, callback) => { listener = callback; return () => {}; },
    chatSend: async () => 'turn', chatListSessions: async () => [meta],
    chatSetMode: async (id, mode, yolo) => modeReply(id,mode,yolo,{current_mode:yolo?'bypassPermissions':'acceptEdits'}),
  } });
  await module.startSessionTurn({ projectPath:meta.project_path, agentId:'claude', mode:'auto_edit', yolo:true, prompt:'fixture', activate:false });
  module.setChat('activeId','s');
  const state = { ...runtime(), active_turn_id:null, pending:[], current_mode:'bypassPermissions' };
  listener(event({ type:'runtime_updated', state }));
  await new Promise((resolve) => setTimeout(resolve,70));
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['auto_edit',true]);
  await module.setYolo(false);
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['auto_edit',false]);
  const idleState = { ...module.chat.views.s.runtime, commands:[{name:'refreshed'}] };
  listener(event({ type:'runtime_updated', state: idleState }));
  await new Promise((resolve) => setTimeout(resolve,70));
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['auto_edit',false]);
  listener(event({ type:'runtime_updated', state: { ...idleState, current_mode:'plan', permission_mode:'plan' } }));
  await new Promise((resolve) => setTimeout(resolve,70));
  assert.equal(module.chat.composer.mode,'plan'); // Actual native transitions still synchronize.
  assert.equal(module.chat.composer.yolo,false);
});

test('a native plan transition keeps an enabled YOLO toggle', async () => {
  let listener;
  const meta = { id:'s', project_path:'/fixture/project', cwd:'/fixture/project', agent_id:'claude', status:'idle', mode:'plan', yolo:true };
  const module = await loadChat({ './ipc': {
    chatCreateSession: async () => meta,
    onChatEntry: async (_id, callback) => { listener = callback; return () => {}; },
    chatSend: async () => 'turn', chatListSessions: async () => [meta],
  } });
  await module.startSessionTurn({ projectPath:meta.project_path, agentId:'claude', mode:'plan', yolo:true, prompt:'fixture', activate:false });
  module.setChat('activeId','s'); module.setChat('composer',{mode:'plan',yolo:true});
  const base = { ...runtime(), active_turn_id:null, pending:[], current_mode:'plan', permission_mode:'plan', yolo:true };
  listener(event({ type:'runtime_updated', state: base }));
  await new Promise((resolve) => setTimeout(resolve,70));
  // The approved plan hands over to implementation; the backend reports YOLO unchanged.
  listener(event({ type:'runtime_updated', state: { ...base, current_mode:'bypassPermissions', permission_mode:'auto_edit' } }));
  await new Promise((resolve) => setTimeout(resolve,70));
  assert.deepEqual([module.chat.composer.mode, module.chat.composer.yolo],['auto_edit',true]);
});

// Motion uses Solid's browser condition so these lifecycle tests exercise real
// effects/cleanup. The DOM below only controls geometry and animation clocks.
async function loadFrontend(file, mocks, transform = source => source) {
  const code = ts.transpileModule(transform(readFileSync(new URL(file, import.meta.url), 'utf8')), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const bindings = new Map();
  for (const node of ts.createSourceFile('frontend.js', code, ts.ScriptTarget.ES2022).statements) {
    if (ts.isImportDeclaration(node)) bindings.set(node.moduleSpecifier.text, [
      ...(node.importClause.name ? ['default'] : []),
      ...(node.importClause.namedBindings?.elements.map((e) => e.propertyName?.text ?? e.name.text) ?? []),
    ]);
  }
  const module = new SourceTextModule(code);
  await module.link((specifier) => new SyntheticModule(bindings.get(specifier), function () {
    for (const name of bindings.get(specifier)) this.setExport(name, mocks[specifier]?.[name] ?? (() => { throw new Error(`Unexpected frontend boundary: ${specifier}.${name}`); }));
  }));
  await module.evaluate();
  return module.namespace;
}
test("Explain refreshes for delegated progress and changed questions without retrying identical failures", async () => {
  const child = { kind: "subagent", id: "child", title: "Check checkout", state: "running" };
  const question = { id: "q", payload: { message: "Choose a delivery option" } };
  const view = { loaded: true, running: false, messages: [{ role: "assistant", status: "done", blocks: [child] }], runtime: { pending: [question] } };
  let calls = 0;
  let fail = false;
  const explain = await loadFrontend("../src/lib/explain.ts", {
    "solid-js/store": solidStore,
    "@tauri-apps/plugin-os": { locale: async () => "en" },
    "./ipc": { chatExplain: async () => { calls++; if (fail) throw new Error("offline"); return { text: "Summary", source: "Test" }; } },
    "./chat": { chat: { sessions: [{ id: "s", agent_id: "kimi" }], views: { s: view } } },
    "./store": { store: { agents: [{ id: "kimi", installed: true, headless_supported: true }] } },
    "./appPrefs": { readPref: async (_key, fallback) => fallback, writePref: () => {} },
  });
  await explain.explain("s");
  assert.equal(explain.explainIsStale("s"), false);
  child.state = "idle";
  child.error = "Service unavailable";
  assert.equal(explain.explainIsStale("s"), true);
  await explain.explain("s");
  question.payload.message = "Choose a payment option";
  assert.equal(explain.explainIsStale("s"), true);
  fail = true;
  await explain.explain("s");
  assert.equal(explain.explainIsStale("s"), false);
  await explain.explain("s");
  assert.equal(calls, 3);
  assert.equal(explain.explanationFor("s").text, "Summary");
});

async function motionFixture(saved = {}) {
  const reduced = new EventTarget(); reduced.matches = false;
  const narrow = new EventTarget(); narrow.matches = false;
  const document = new EventTarget();
  document.hidden = false; document.documentElement = { dataset: {}, setAttribute() {}, removeAttribute() {} }; document.activeElement = null;
  const window = new EventTarget();
  window.innerWidth = 1440; window.innerHeight = 900;
  window.matchMedia = (query) => query.includes('reduced-motion') ? reduced : narrow;
  Object.assign(globalThis, { document, window, HTMLElement: class {}, SVGElement: class {}, getComputedStyle: () => ({ opacity: '.5', transform: 'none', width: '100px', height: '100px' }) });
  const writes = [];
  const layout = await loadFrontend('../src/lib/layout.ts', {
    'solid-js': solid, 'solid-js/store': solidStore,
    './appPrefs': { readPref: async () => saved, writePref: (...args) => writes.push(args) },
    './theme': { CUSTOM_THEME_PROPERTIES: [], customThemeTokens: () => ({}), normalizeCustomTheme: () => null },
  });
  const dispose = layout.watchMotionPreferences();
  await layout.hydrateLayout();
  return { layout, document, window, reduced, writes, dispose };
}
const settle = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };

test('transcript module is pure and chat re-exports the same reducer', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const chat = await loadChat({ './transcript': transcript });
  assert.equal(chat.applyEntry, transcript.applyEntry);
  assert.equal(chat.reduceTranscript, transcript.reduceTranscript);
  const view = transcript.reduceTranscript([
    { kind:'user', ts:1, agent_id:'claude', text:'Legacy prompt' },
    event({ type:'turn_started', turn_id:'turn', agent_id:'claude' },2),
    event({ type:'thinking', delta:'Consider' },3),
    event({ type:'text', delta:'Answer' },4),
  ]);
  assert.equal(view.messages[0].attachments.length, 0);
  assert.equal(view.messages[1].blocks[0].endedAt, 4);
  assert.equal(view.messages[1].status, 'cancelled');
});

test('diff model indexes lines and builds selected forward and reverse patches', async () => {
  const model = await loadFrontend('../src/lib/diffModel.ts', {});
  const file = {
    old_path:'src/a.ts', new_path:'src/a.ts', hunks:[{
      header:'@@ -1,2 +1,2 @@', old_start:1, new_start:1,
      lines:[
        { kind:'context', content:'const keep = true;', old_lineno:1, new_lineno:1 },
        { kind:'del', content:'const oldValue = 1;', old_lineno:2, new_lineno:null },
        { kind:'add', content:'const newValue = 2;', old_lineno:null, new_lineno:2 },
      ],
    }],
  };
  const { hunks, flat } = model.indexFileHunks(file);
  assert.equal(flat.map((line) => line.flatIndex).join(','), '0,1,2');
  assert.equal(model.formatLineRange(flat), 'L1–L2');
  assert.equal(model.formatColonRange(flat.slice(1)), '2');
  assert.equal(model.langForPath('src/a.TSX'), 'typescript');
  assert.equal(model.basename('src/a.ts'), 'a.ts');
  assert.equal(model.buildPatchForFile(file,hunks,new Set([2]),'forward'),
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const keep = true;\n const oldValue = 1;\n+const newValue = 2;\n');
  assert.equal(model.buildPatchForFile(file,hunks,new Set([1]),'reverse'),
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,2 @@\n const keep = true;\n-const oldValue = 1;\n const newValue = 2;\n');
  assert.equal(model.buildPatchForFile(file,hunks,null,'forward'),
    '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const keep = true;\n-const oldValue = 1;\n+const newValue = 2;\n');
  assert.match(model.buildSelectionPrompt('src/a.ts',flat.slice(1),' Update it '), /```diff\n-const oldValue = 1;\n\+const newValue = 2;\n```\nUpdate it$/);
  assert.equal(model.buildPatchForFile(file,hunks,new Set([0]),'forward'), null);
  const renamed = { ...file, old_path:'src/before.ts', new_path:'src/after.ts' };
  assert.match(model.buildPatchForFile(renamed,hunks,null,'reverse'), /^--- a\/src\/before\.ts\n\+\+\+ b\/src\/after\.ts\n/);
});

test('diff model identifies media files and calculates comparison size deltas', async () => {
  const model = await loadFrontend('../src/lib/diffModel.ts', {});
  // Images
  assert.equal(model.isImageFile('assets/hero.png'), true);
  assert.equal(model.isImageFile('public/icons/app.JPG'), true);
  assert.equal(model.isImageFile('images/photo.jpeg'), true);
  assert.equal(model.isImageFile('anim.gif'), true);
  assert.equal(model.isImageFile('banner.webp'), true);
  assert.equal(model.isImageFile('vector.svg'), true);
  assert.equal(model.isImageFile('icon.ico'), true);
  assert.equal(model.isImageFile('image.avif'), true);
  assert.equal(model.isImageFile('src/code.ts'), false);

  // Videos
  assert.equal(model.isVideoFile('demo.mp4'), true);
  assert.equal(model.isVideoFile('recording.webm'), true);
  assert.equal(model.isVideoFile('clip.MOV'), true);
  assert.equal(model.isVideoFile('screencast.mkv'), true);
  assert.equal(model.isVideoFile('demo.mp3'), false);

  // Combined media
  assert.equal(model.isMediaFile('hero.png'), true);
  assert.equal(model.isMediaFile('demo.mp4'), true);
  assert.equal(model.isMediaFile('package.json'), false);
  assert.equal(model.isMediaFile(null), false);

  // Formatting bytes
  assert.equal(model.formatMediaBytes(500), '500 B');
  assert.equal(model.formatMediaBytes(1024), '1.0 KB');
  assert.equal(model.formatMediaBytes(1536), '1.5 KB');
  assert.equal(model.formatMediaBytes(1048576 * 2.5), '2.50 MB');

  // Size delta calculations
  const decreased = model.formatMediaSizeDelta(1000, 800);
  assert.equal(decreased.delta, -200);
  assert.equal(decreased.percent, -20.0);
  assert.equal(decreased.isIncrease, false);
  assert.equal(decreased.text, '-200 B (-20%)');

  const increased = model.formatMediaSizeDelta(1000, 1500);
  assert.equal(increased.delta, 500);
  assert.equal(increased.percent, 50.0);
  assert.equal(increased.isIncrease, true);
  assert.equal(increased.text, '+500 B (+50%)');

  const unchanged = model.formatMediaSizeDelta(1000, 1000);
  assert.equal(unchanged.delta, 0);
  assert.equal(unchanged.text, 'No size change');
});

test('preferred targets use saved choices and retain concrete short labels', async () => {
  const module = await loadFrontend('../src/components/TargetButton.tsx', { 'solid-js':solid });
  const targets = [
    { id:'dev', label:'Web - npm run dev', command:'npm run dev' },
    { id:'test', label:'Tests', command:'npm test' },
  ];
  assert.equal(module.preferredTarget(targets,'test').id, 'test');
  assert.equal(module.preferredTarget(targets,'removed').id, 'dev');
  assert.equal(module.preferredTarget([],undefined), null);
  assert.equal(module.shortLabel(targets[0]), 'Web');
  assert.equal(module.shortLabel({ id:'fallback', label:'', command:'' }), 'fallback');
});

test('project string preferences preserve legacy seeding, durable hydration and writes', async () => {
  const legacy = { 'flipflopper:run-targets':{ '/project':'legacy-run' } };
  const durable = { 'flipflopper:run-targets':{ '/project':'durable-run' } };
  const writes = [];
  const module = await loadFrontend('../src/lib/store.ts', {
    'solid-js/store':solidStore,
    './appPrefs': {
      readLegacyJson:(key,fallback) => ({ ...(legacy[key] ?? fallback) }),
      readPref:async (key,fallback) => durable[key] ?? fallback,
      writePref:(...args) => writes.push(args),
    },
  });
  assert.equal(module.readRunTargets()['/project'], 'legacy-run');
  module.writeRunTarget('/project','canonical-choice');
  assert.equal(module.readRunTargets()['/project'], 'canonical-choice');
  assert.equal(writes[0][0], 'flipflopper:run-targets');
  await module.hydrateStorePreferences();
  assert.equal(module.readRunTargets()['/project'], 'durable-run');
  module.writeValidationTarget('/project','npm-test');
  assert.equal(module.readValidationTargets()['/project'], 'npm-test');
});

test('branch updates ignore stale responses after the effective root changes', async () => {
  const requests = [];
  const module = await loadFrontend('../src/lib/store.ts', {
    'solid-js/store':solidStore,
    './appPrefs': { readLegacyJson:(_key,fallback) => fallback, readPref:async (_key,fallback) => fallback, writePref() {} },
    './ipc': { getCurrentBranch:(root) => new Promise((resolve,reject) => requests.push({root,resolve,reject})) },
  });
  module.setStore({ currentProject:{ path:'/project', name:'project', is_git:true, has_agents_md:false }, activeCwd:'/worktree-a' });
  const first = module.updateCurrentBranch();
  module.setStore('activeCwd','/worktree-b');
  const second = module.updateCurrentBranch();
  assert.deepEqual(requests.map((request) => request.root), ['/worktree-a','/worktree-b']);
  requests[1].resolve('branch-b');
  await second;
  requests[0].resolve('branch-a');
  await first;
  assert.equal(module.store.currentBranch, 'branch-b');
});

test('preview setup unsubscribes stale listeners and ignores stale URLs', async () => {
  const [sessions,setSessions] = solidStore.createStore({ runSessionId:'old', runTargets:[], currentProject:null });
  const signals = [], urlListeners = new Map(), urlDeferred = new Map(), existingDeferred = new Map(), exitDeferred = new Map();
  const removed = [], existingReads = [];
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve=done; }); return {promise,resolve}; };
  for (const id of ['old','new']) { urlDeferred.set(id,deferred()); existingDeferred.set(id,deferred()); exitDeferred.set(id,deferred()); }
  const previewTabs = await loadFrontend('../src/lib/previewTabs.ts', {});
  const module = await loadFrontend('../src/components/side/PreviewView.tsx', {
    'solid-js': { ...solid, createSignal:(...args) => { const signal=solid.createSignal(...args); signals.push(signal); return signal; } },
    '../../lib/store': { store:sessions, effectiveRoot:() => null, readRunTargets:() => ({}), setRunSessionId:(id) => setSessions('runSessionId',id) },
    '../../lib/ipc': {
      onPreviewUrl:(id,callback) => { urlListeners.set(id,callback); return urlDeferred.get(id).promise; },
      getSessionUrl:(id) => { existingReads.push(id); return existingDeferred.get(id).promise; },
      onPtyExit:(id) => exitDeferred.get(id).promise,
      openPreviewInspector: async () => {},
      setPreviewInspectorBounds: async () => {},
      navigatePreviewInspector: async () => {},
      closePreviewInspector: async () => {},
      closePreviewProfile: async () => {},
      listListeningServers: async () => [],
      openPreviewPicker: async () => {},
      closePreviewPicker: async () => {},
      capturePreviewRegion: async () => '',
      onPreviewPick: async () => () => {},
      onPreviewPickCancel: async () => () => {},
      startPreviewRecording: async () => {},
      stopPreviewRecording: async () => '',
    },
    '../../lib/attachments': { addPaths: () => {} },
    '../../lib/previewPick': { previewAnnotationText: () => '' },
    '../../lib/layout': { openSide() {}, layout: { sideOpen: true, sideTab: 'preview', sideWidth: 480 } },
    '../../lib/previewTabs': previewTabs,
    '../../lib/previewRequests': { previewRequest: () => null },
    '../../lib/settings': { previewViewport: () => 'desktop', setPreviewViewport: () => {}, searchUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}` },
    '../../lib/browserProfiles': { profiles: () => [], selectedId: () => null, selectBrowserProfile: () => {}, setSelectedId: () => {}, activeProfile: () => null, setActiveProfile: async () => {}, openProfile: async () => {} },
    '../../lib/previewRecent': { recentPreviewUrls: () => [], rememberPreviewUrl: () => {}, clearRecentPreviewUrls: () => {} },
    '../ui': { useValueMotion() {}, animateElement() {} },
    '../RunButton': { default:() => null },
    './AndroidPreview': { default:() => null },
    './IosPreview': { default:() => null },
    '../shell/Icon': { Icon:() => null },
  });
  const previousReact = globalThis.React;
  globalThis.React = { createElement:(tag,props,...children) => ({tag,props,children}) };
  let dispose;
  try {
    solid.createRoot((stop) => { dispose=stop; module.default({}); });
    await settle();
    setSessions('runSessionId','new');
    urlDeferred.get('new').resolve(() => removed.push('new-url'));
    await settle();
    existingDeferred.get('new').resolve('http://new.test');
    await settle();
    exitDeferred.get('new').resolve(() => removed.push('new-exit'));
    await settle();
    assert.equal(signals[0][0]()[0]?.url, 'http://new.test');
    urlDeferred.get('old').resolve(() => removed.push('old-url'));
    await settle();
    assert.deepEqual(removed, ['old-url']);
    assert.deepEqual(existingReads, ['new']);
    urlListeners.get('old')('http://stale.test');
    assert.equal(signals[0][0]()[0]?.url, 'http://new.test');
    assert.equal(signals[0][0]()[0]?.kind, 'run');
  } finally { dispose?.(); globalThis.React=previousReact; }
});

test('review panes protect conversation width across sidebar sizes and zoom', async () => {
  const f = await motionFixture({ sideWidth: 1200 });
  try {
    for (const windowWidth of [1440, 1000, 720]) {
      for (const zoom of [1, 1.25, 2]) {
        for (const sidebar of [0, 220, 272, 420]) {
          const logicalWidth = windowWidth / zoom;
          const dockedSidebar = logicalWidth >= sidebar + 520 + 16 ? sidebar : 0;
          const available = logicalWidth - dockedSidebar - 16;
          const pane = f.layout.resolveSidePane(available, f.layout.layout.sideWidth);
          if (available >= 868) {
            assert.equal(pane.overlay, false);
            assert.ok(available - pane.width - 8 >= 520);
            assert.ok(pane.width >= 340);
          } else {
            assert.equal(pane.overlay, true);
            assert.ok(pane.width <= available);
          }
        }
      }
    }
    assert.equal(f.layout.layout.sideWidth, 1200, 'render constraints do not overwrite the preference');
    assert.equal(f.layout.resolveSidePane(1800, f.layout.layout.sideWidth).width, 1200);
    assert.equal(f.layout.resolveSidePane(868, 480).width, 340);
    assert.equal(f.layout.resolveSidePane(867, 480).overlay, true);
    assert.equal(f.layout.resolveSidePane(1200, NaN).width, 480);
  } finally { f.dispose(); }
});

test('measured layout drives overlays and resizing without overwriting restored widths', async () => {
  const f = await motionFixture({ sideWidth: 1000, sidebarWidth: 272 });
  const previous = globalThis.ResizeObserver;
  const root = { clientWidth: 1440 }, main = { clientWidth: 1152 };
  let notify, disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  try {
    const stop = f.layout.watchLayoutSizes(root, main);
    assert.equal(f.layout.sidebarIsOverlay(), false);
    assert.equal(f.layout.paneIsOverlay(), false);
    assert.equal(f.layout.renderedSideWidth(), 624);
    notify([{ target:root, contentRect:{width:720} }, { target:main, contentRect:{width:704} }]);
    assert.equal(f.layout.sidebarIsOverlay(), true);
    assert.equal(f.layout.paneIsOverlay(), true);
    assert.equal(f.layout.renderedSideWidth(), 704);
    assert.equal(f.layout.layout.sideWidth, 1000);
    f.layout.openSide('changes');
    assert.equal(f.layout.layout.sidebarOpen, false, 'opening review dismisses an overlay sidebar');
    f.layout.toggleSidebar();
    assert.equal(f.layout.layout.sideOpen, false, 'opening navigation dismisses review on narrow windows');
    assert.equal(f.layout.layout.sidebarOpen, true);
    f.layout.toggleSide('preview');
    assert.equal(f.layout.layout.sidebarOpen, false);
    assert.equal(f.layout.layout.sideOpen, true);
    notify([{ target:root, contentRect:{width:1800} }, { target:main, contentRect:{width:1512} }]);
    assert.equal(f.layout.renderedSideWidth(), 984);
    assert.equal(f.layout.layout.sideWidth, 1000);
    notify([{ target:main, contentRect:{width:1600} }]);
    assert.equal(f.layout.renderedSideWidth(), 1000, "preferred width returns when space permits");
    notify([{ target:main, contentRect:{width:1512} }]);
    f.layout.setSideWidth(1500);
    assert.equal(f.layout.layout.sideWidth, 984, 'explicit dragging respects the conversation minimum');
    stop(); assert.equal(disconnected, true);
  } finally { globalThis.ResizeObserver = previous; f.dispose(); }
});

test('native frame appearance coalesces theme changes and follows system colors', async () => {
  const f = await motionFixture();
  f.window.__TAURI_INTERNALS__ = {};
  let preference = 'light', color = '#E7EEF1', finishTheme;
  const themes = [], colors = [];
  const media = f.window.matchMedia('(prefers-color-scheme: light)');
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => color });
  const native = await loadFrontend('../src/lib/native.ts', {
    '@tauri-apps/plugin-os': { platform: () => 'macos' },
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      assert.equal(command, 'plugin:window|set_background_color');
      assert.equal(args.label, 'main');
      assert.equal(typeof args.value, 'string', 'Rust window setters require the value argument');
      colors.push(args.value);
    } },
    '@tauri-apps/api/window': { getCurrentWindow: () => ({
      label: 'main',
      setTheme: async (value) => {
        themes.push(value);
        if (themes.length === 1) await new Promise((resolve) => { finishTheme = resolve; });
      },
    }) },
  });
  const watcher = native.watchNativeAppearance(() => preference);
  try {
    await settle();
    preference = 'dark'; color = '#0F1417';
    f.window.dispatchEvent(new Event('flipflopper:theme-changed'));
    finishTheme(); await watcher.ready; await settle();
    assert.deepEqual(themes, ['light', 'dark']);
    assert.deepEqual(colors, ['#0F1417'], 'a stale native request must not apply the old background');
    media.dispatchEvent(new Event('change')); await settle();
    assert.equal(colors.length, 1, 'system changes do not override an explicit theme');
    preference = 'system'; color = '#E7EEF1';
    f.window.dispatchEvent(new Event('flipflopper:theme-changed')); await settle();
    assert.equal(themes.at(-1), null);
    color = '#0F1417'; media.dispatchEvent(new Event('change')); await settle();
    assert.equal(colors.at(-1), '#0F1417');
    assert.equal(themes.length, 3, 'system color events must not reapply appearance and cause feedback');
    const count = colors.length;
    watcher.dispose();
    f.window.dispatchEvent(new Event('flipflopper:theme-changed'));
    media.dispatchEvent(new Event('change')); await settle();
    assert.equal(colors.length, count);
  } finally { watcher.dispose(); f.dispose(); }
});

test('native appearance failures remain observable and later changes can recover', async () => {
  const f = await motionFixture();
  f.window.__TAURI_INTERNALS__ = {};
  let fail = true, errors = 0, applied = 0;
  const previousError = console.error;
  console.error = () => {};
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#0F1417' });
  const native = await loadFrontend('../src/lib/native.ts', {
    '@tauri-apps/plugin-os': { platform: () => 'macos' },
    '@tauri-apps/api/core': { invoke: async () => { if (fail) throw new Error('fixture failure'); applied++; } },
    '@tauri-apps/api/window': { getCurrentWindow: () => ({
      setTheme: async () => {},
    }) },
  });
  const watcher = native.watchNativeAppearance(() => 'dark', () => { errors++; });
  try {
    await watcher.ready;
    assert.equal(errors, 1);
    fail = false;
    f.window.dispatchEvent(new Event('flipflopper:theme-changed')); await settle();
    assert.equal(applied, 1);
    assert.equal(errors, 1);
  } finally { watcher.dispose(); f.dispose(); console.error = previousError; }
});

test('integrated headers drag blank space without capturing toolbar controls', async () => {
  const f = await motionFixture();
  f.window.__TAURI_INTERNALS__ = {};
  const previousElement = globalThis.Element;
  class HeaderTarget {
    constructor(header, interactive = false) { this.header = header; this.interactive = interactive; }
    closest(selector) { return (selector === '[data-window-header]' ? this.header : this.interactive) ? this : null; }
  }
  globalThis.Element = HeaderTarget;
  let os = 'macos', drags = 0, doubleClicks = 0, prevented = 0;
  try {
    const native = await loadFrontend('../src/lib/native.ts', {
      '@tauri-apps/plugin-os': { platform: () => os },
      '@tauri-apps/api/window': { getCurrentWindow: () => ({ startDragging: async () => { drags++; } }) },
      './ipc': { windowTitlebarDoubleClick: async () => { doubleClicks++; } },
    });
    const event = (target, detail = 1, button = 0) => ({ target, detail, button, preventDefault: () => { prevented++; } });
    const blank = new HeaderTarget(true);
    for (const target of [new HeaderTarget(false), new HeaderTarget(true, true), null]) {
      await native.handleWindowHeaderMouseDown(event(target));
      await native.handleWindowHeaderDoubleClick(event(target, 2));
    }
    await native.handleWindowHeaderMouseDown(event(blank, 1, 2));
    await native.handleWindowHeaderMouseDown(event(blank, 2));
    assert.equal(drags, 0);
    assert.equal(doubleClicks, 0);
    await native.handleWindowHeaderMouseDown(event(blank));
    await native.handleWindowHeaderDoubleClick(event(blank, 2));
    assert.equal(drags, 1);
    assert.equal(doubleClicks, 1, 'native preference decides double-click behavior');
    assert.equal(prevented, 2);
    os = 'windows';
    await native.handleWindowHeaderMouseDown(event(blank));
    await native.handleWindowHeaderDoubleClick(event(blank, 2));
    assert.equal(drags, 1);
    assert.equal(doubleClicks, 1);
  } finally { globalThis.Element = previousElement; f.dispose(); }
});

test('native frame customization is macOS-only', async () => {
  const f = await motionFixture();
  f.window.__TAURI_INTERNALS__ = {};
  try {
    const native = await loadFrontend('../src/lib/native.ts', {
      '@tauri-apps/plugin-os': { platform: () => 'windows' },
      '@tauri-apps/api/window': { getCurrentWindow: () => { throw new Error('must retain native decorations'); } },
    });
    const watcher = native.watchNativeAppearance(() => 'dark');
    await watcher.ready;
    watcher.dispose();
  } finally { f.dispose(); }
});

test('project icons hydrate sanitized and default to none', async () => {
  const f = await motionFixture({ projectIcons: { '/x': { letter: 'q', hue: 10 }, '/bad': { letter: '!!!' }, '/text': 'nope' } });
  try {
    assert.deepEqual(f.layout.layout.projectIcons, { '/x': { letter: 'Q', hue: 10 } });
  } finally { f.dispose(); }
});

test('project names, hidden projects and manual order survive hydration without changing checkout paths', async () => {
  const fixture=await motionFixture();
  try {
    const {layout}=fixture;
    layout.setProjectDisplayName('/a','  Alpha workspace  ');
    layout.moveSidebarProject('/c','/a','before',['/a','/b','/c']);
    layout.setProjectFilter('/b');layout.hideSidebarProject('/b');
    assert.deepEqual([...layout.layout.projectOrder],['/c','/a','/b']);
    assert.equal(layout.layout.projectFilter,null);
    const saved=JSON.parse(JSON.stringify(fixture.writes.at(-1)[1]));
    const restored=await motionFixture(saved);
    try {
      assert.equal(restored.layout.layout.projectNames['/a'],'Alpha workspace');
      assert.deepEqual([...restored.layout.layout.projectOrder],['/c','/a','/b']);
      assert.deepEqual([...restored.layout.layout.hiddenProjects],['/b']);
      restored.layout.restoreSidebarProject('/b');
      assert.deepEqual([...restored.layout.layout.hiddenProjects],[]);
      restored.layout.setProjectDisplayName('/a','');
      assert.equal(restored.layout.layout.projectNames['/a'],undefined);
    } finally {restored.dispose();}
  } finally {fixture.dispose();}
});

test('reordering retains absent and hidden projects and rejects invalid destinations', async () => {
  const f=await motionFixture({projectOrder:['/a','/hidden','/b','/c'],hiddenProjects:['/hidden']});
  try {
    f.layout.moveSidebarProject('/c','/a','before',['/a','/b','/c']);
    assert.deepEqual([...f.layout.layout.projectOrder],['/c','/a','/hidden','/b']);
    const writes=f.writes.length;
    f.layout.moveSidebarProject('/c','/missing','after',['/a','/b','/c']);
    f.layout.moveSidebarProject('/c','/c','before',['/a','/b','/c']);
    assert.equal(f.writes.length,writes);
  } finally {f.dispose();}
});

test('project preference migration rejects malformed collections', async () => {
  const f=await motionFixture({projectOrder:['/a',null,42,'/a',''],hiddenProjects:'invalid',projectNames:{'/a':' Alpha ','/empty':' ','/bad':42}});
  try {
    assert.deepEqual([...f.layout.layout.projectOrder],['/a']);
    assert.deepEqual([...f.layout.layout.hiddenProjects],[]);
    assert.deepEqual({...f.layout.layout.projectNames},{'/a':'Alpha'});
  } finally {f.dispose();}
});

test('project grouping respects saved order and aliases, keeps pinned first, and includes empty recent projects', async () => {
  const prefs={projectNames:{'/a':'Renamed workspace'},projectOrder:['/b','/a'],hiddenProjects:['/hidden']};
  const module=await loadChat({'./layout':{layout:prefs},'./store':{store:{recentProjects:[{path:'/empty',name:'empty'}]}}});
  const sessions=[
    {id:'a',project_path:'/a',title:'First',updated_at:Date.now()},
    {id:'b',project_path:'/b',title:'Second',updated_at:Date.now()},
    {id:'pinned',project_path:'/a',title:'Pin',pinned:true,updated_at:Date.now()},
    {id:'hidden',project_path:'/hidden',title:'Hidden',pinned:true,updated_at:Date.now()},
  ];
  module.setChat('sessions',sessions);
  const options={includeArchived:false,query:'',group:'project',filter:null};
  const groups=module.sessionGroups(options);
  assert.deepEqual(Array.from(groups,(g)=>g.key),['pinned','/b','/a','/empty']);
  assert.equal(groups[2].label,'Renamed workspace');
  assert.equal(groups[3].sessions.length,0);
  assert.equal(groups[0].sessions.length,1);
  assert.deepEqual(Array.from(module.sessionGroups({...options,query:'Renamed'}),(g)=>g.key),['pinned','/a']);
  assert.deepEqual(Array.from(module.sessionGroups({...options,query:'not-found'}),(g)=>g.key),[]);
  assert.deepEqual(Array.from(module.sessionGroups({...options,filter:'/b'}),(g)=>g.key),['/b']);
  assert.equal(module.sessionGroups({...options,group:'date'}).flatMap((g)=>g.sessions).some((s)=>s.id==='hidden'),false);
  assert.equal(module.chat.sessions.find((s)=>s.id==='a').project_path,'/a');
  prefs.pinnedProjects=['/b'];
  assert.deepEqual(Array.from(module.sessionProjects(),(p)=>p.path),['/b','/a','/empty'],'pinned projects come first');
});

test('removing a sidebar project requires confirmation and Undo restores it without deleting conversations or files', async () => {
  const f=await motionFixture();
  let confirm=false,undo;
  try {
    const module=await loadFrontend('../src/lib/projects.ts',{
      './chat':{projectName:()=> 'Alpha'},
      './layout':{hideSidebarProject:f.layout.hideSidebarProject,restoreSidebarProject:f.layout.restoreSidebarProject},
      '../components/ui':{confirmDialog:async()=>confirm,toast:(_text,_kind,options)=>{undo=options.onAction;}},
    });
    await module.removeSidebarProject('/a');
    assert.deepEqual([...f.layout.layout.hiddenProjects],[]);
    confirm=true;await module.removeSidebarProject('/a');
    assert.deepEqual([...f.layout.layout.hiddenProjects],['/a']);
    undo();assert.deepEqual([...f.layout.layout.hiddenProjects],[]);
  } finally {f.dispose();}
});

test('attachment presentation recognizes media paths without changing persisted attachment kinds', async () => {
  const module=await loadFrontend('../src/lib/attachments.ts',{'solid-js':solid});
  for (const [path,kind] of [
    ['/fixture/photo.PNG','image'],['C:\\media\\clip.MOV','video'],
    ['/fixture/audio.flac','audio'],['/fixture/REPORT.PDF','pdf'],
    ['/fixture/data.csv','file'],['/fixture/code.html','file'],
  ]) assert.equal(module.attachmentPreviewKind(path),kind);
  assert.equal(module.attachmentFor('/fixture/clip.mp4').kind,'file');
  assert.equal(module.attachmentFor('/fixture/report.pdf').kind,'file');
});

test('attachment removal stays separate from preview opening and Escape closes the preview', async () => {
  const signals=[],nodes=[],requests=[];
  let dispose,removed=0;
  const document=new EventTarget();
  globalThis.document=document;
  const module=await loadFrontend('../src/components/chat/AttachmentChip.tsx',{
    'solid-js':{...solid,createSignal:(...args)=>{const s=solid.createSignal(...args);signals.push(s);return s;}},
    '@tauri-apps/api/core':{convertFileSrc:(path)=>`asset://local${path}`},
    '../../lib/ipc':{prepareAttachmentPreview:async(path)=>{requests.push(path);return {path,kind:'video',size:5000};}},
    '../../lib/attachments':{attachmentPreviewKind:()=> 'video'},
    '../../lib/fileIcons':{getFileIcon:()=> 'video'},
    '../ui':{useValueMotion(){}},
  });
  const previousReact=globalThis.React;
  globalThis.React={createElement:(tag,props,...children)=>{const node={tag,props,children};nodes.push(node);return node;}};
  try {
    solid.createRoot((stop)=>{dispose=stop;module.default({attachment:{path:'/fixture/clip.mp4',name:'clip.mp4',kind:'file'},onRemove:()=>removed++});});
    await settle();
    assert.deepEqual(requests,['/fixture/clip.mp4']);
    nodes.find((node)=>node.props?.['aria-label']==='Remove clip.mp4').props.onClick();
    assert.equal(removed,1);
    assert.equal(signals[0][0](),false);
    nodes.find((node)=>node.props?.['aria-label']==='Preview clip.mp4').props.onClick({currentTarget:{focus(){}}});
    assert.equal(signals[0][0](),true);
    const escape=new Event('keydown',{cancelable:true});Object.defineProperty(escape,'key',{value:'Escape'});
    document.dispatchEvent(escape);
    assert.equal(signals[0][0](),false);
    assert.equal(escape.defaultPrevented,true);
  } finally {dispose?.();globalThis.React=previousReact;}
});

// Exercise Composer's real input handlers and Solid effects. JSX is represented
// by inert nodes; provider latency is controlled by the deferred submit boundary.
async function composerFixture(activeId = 's', behavior = {}) {
  const [chat, setChat] = solidStore.createStore({
    activeId, views: {}, composer: { agentId:'claude', mode:'auto_edit' },
    sessions: [{id:'s'}, {id:'other'}], queued: {}, fanOut: [], scratchDraft: false,
  });
  const [attachments, setAttachments] = solid.createSignal([]);
  const signals = [], nodes = [], submissions = [], queuedSends = [], animations = [], launches = [], rollbacks = [], yoloCalls = [], sideTabs = [];
  let resolve, dispose;
  const module = await loadFrontend('../src/components/chat/Composer.tsx', {
    'solid-js': { ...solid, createSignal: (...args) => { const signal=solid.createSignal(...args); signals.push(signal); return signal; } },
    '../../lib/chat': {
      chat, activeView: () => undefined, isRunning: () => false, isAcpAgent: (id) => id === 'claude' || id === 'cursor' || id === 'dsh', clearFanOut() {}, toggleFanOutAgent() {}, askSideQuestion() {}, setScratchDraft() {}, cycleMode() {}, modeAvailable: () => true, splitMode: (mode, yolo) => ({ mode, yolo: !!yolo }), permissionModeUpdating: () => false, sessionModePending: () => false, onCliSessionCreated: () => () => {},
      setYolo: (v) => { yoloCalls.push(v); setChat('composer', 'yolo', v); },
      agentTuning: () => ({ models:[], efforts:[] }), nativeCommands: () => [], contextUsage: () => undefined,
      submitPrompt: (...args) => { submissions.push(args); return new Promise((done) => { resolve=done; }); },
      sendQueuedNow: (...args) => { queuedSends.push(args); return Promise.resolve(); },
    },
    '../../lib/ipc': {
      listPromptSkills: async () => [{ name: 'pdf', path: '/fixture/pdf/SKILL.md', source: 'claude', description: 'Read PDFs' }],
      listMcpServers: async () => [{ name: 'termux', transport: 'stdio', target: 'node termux.js', source: 'Claude', scope: 'user', agents: ['claude'], enabled: true }],
      searchPromptFiles: async () => [],
      openAttachment: async () => {},
    },
    '../../lib/layout': { openSide: (tab) => sideTabs.push(tab) },
    '../../lib/agentMeta': { AgentLogo() {}, agentModelsLoading: () => false, agentModelsError: () => null, hydrateAgentModels() {}, refreshAgentModels() {} },
    '../../lib/customModels': { addCustomModel: () => true, customModelsFor: () => [], mergeModelChoices: (base) => base },
    '../../lib/store': { store: { agents:[], currentProject:null }, effectiveRoot: () => null },
    '../../lib/attachments': { attachments, setAttachments, clearAttachments: () => setAttachments([]), captureSnapShot() {} },
    '../../lib/scripts': { projectScripts: () => [], runProjectScript() {} },
    '../../lib/triage': { startTriageSession() {} },
    '../../lib/settings': {
      followUpBehavior: () => behavior.followUp ?? 'queue',
      sendShortcut: () => behavior.shortcut ?? 'enter',
      richTextComposer: () => behavior.richText ?? false,
    },
    '../../lib/shortcuts': { registerShortcutHandler: () => () => {}, runAction() {} },
    '../../lib/stash': { stashes: () => [], stashDraft: () => false, takeStash() {}, discardStash() {} },
    '../../lib/drafts': { drafts: () => [], draftFor: () => null, saveDraft() {}, removeDraft() {} },
    '../../lib/composerContexts': {
      composerContextsForDraft: () => [],
      contextToken: (context) => `@ctx:${context.kind}:${context.id}`,
      removeComposerContext() {},
      resolveComposerContexts: (text) => ({ clean: text, prompt: text }),
      restoreComposerContexts() {},
      clearComposerContexts() {},
    },
    '../ui': {
      animateElement: (...args) => { animations.push(args); return Promise.resolve(); },
      startPromptLaunch: (opts) => { launches.push(opts); return { rollback: (target) => rollbacks.push(target), cancel() {} }; },
      cancelMotion() {}, useValueMotion() {}, useListMotion() {}, useSelectionMotion() {},
      usePresence: () => () => false, Presence: (props) => props.children, toast() {},
    },
  });
  const previousReact = globalThis.React;
  globalThis.React = { createElement: (tag, props, ...children) => { const node={tag,props,children}; nodes.push(node); return node; } };
  try { solid.createRoot((stop) => { dispose=stop; module.default({}); }); }
  finally { globalThis.React=previousReact; }
  const input = nodes.find((node) => node.tag === 'textarea').props;
  return {
    chat, setChat, attachments, setAttachments, submissions, queuedSends, animations, launches, rollbacks, yoloCalls, sideTabs, dispose,
    value: signals[0][0], submitting: signals[1][0], inspectorTab: signals[11][0], inspectorQuery: signals[12][0],
    type: (value) => input.onInput({currentTarget:{value,selectionStart:value.length}}),
    send: () => input.onKeyDown({key:'Enter',preventDefault(){}}),
    steer: () => input.onKeyDown({key:'Enter',ctrlKey:true,preventDefault(){}}),
    finish: async (ok) => { resolve(ok); await settle(); },
  };
}

test('composer clears immediately during slow startup and keeps the next draft after success', async () => {
  const f=await composerFixture();
  try {
    const file={path:'/fixture/a.png',name:'a.png',kind:'image'};
    f.type('First prompt'); f.setAttachments([file]); f.send();
    assert.equal(f.value(),'');
    assert.deepEqual(f.attachments(),[]);
    assert.equal(f.submitting(),true);
    assert.equal(f.submissions[0][0],'First prompt');
    assert.deepEqual(f.submissions[0][1],[file]);
    f.send(); assert.equal(f.submissions.length,1); // No duplicate launch.
    assert.equal(f.launches.length,1);
    assert.equal(f.launches[0].text,'First prompt');
    assert.equal(f.launches[0].attachmentsCount,1);
    f.type('A follow-up');
    await f.finish(true);
    assert.equal(f.rollbacks.length,0);
    assert.equal(f.value(),'A follow-up');
    assert.equal(f.submitting(),false);
    assert(f.animations.length>0);
  } finally { f.dispose(); }
});

test('failed composer submission restores its original draft and attachments without touching another conversation', async () => {
  const f=await composerFixture();
  try {
    const first={path:'/fixture/a.png',name:'a.png',kind:'image'};
    const second={path:'/fixture/b.txt',name:'b.txt',kind:'file'};
    f.type('  Original prompt\n'); f.setAttachments([first]); f.send();
    f.type('Next draft'); f.setAttachments([second]);
    f.setChat('activeId','other'); f.type('Other conversation');
    await f.finish(false);
    assert.equal(f.rollbacks.length,1);
    assert.equal(f.value(),'Other conversation');
    assert.deepEqual(f.attachments(),[]);
    f.setChat('activeId','s');
    assert.equal(f.value(),'  Original prompt\n\n\nNext draft');
    assert.deepEqual(f.attachments(),[first,second]);
  } finally { f.dispose(); }
});

test('a follow-up draft follows a newly created session and survives a startup failure', async () => {
  const f=await composerFixture(null);
  try {
    f.type('Initial task'); f.send(); f.type('More detail');
    f.submissions[0][2]('created');
    f.setChat('sessions',(s) => [...s,{id:'created'}]);
    f.setChat('activeId','created');
    assert.equal(f.value(),'More detail');
    await f.finish(false);
    assert.equal(f.value(),'Initial task\n\nMore detail');
    f.setChat('activeId',null);
    assert.equal(f.value(),'');
  } finally { f.dispose(); }
});

test('removing a failed first-turn session brings its follow-up draft back to the new-session composer', async () => {
  const f=await composerFixture(null);
  try {
    f.type('Initial task'); f.send();
    f.submissions[0][2]('removed');
    f.setChat('sessions',(s) => [...s,{id:'removed'}]);
    f.setChat('activeId','removed');
    f.type('Keep this follow-up');
    const file={path:'/fixture/follow-up.txt',name:'follow-up.txt',kind:'file'};
    f.setAttachments([file]);
    f.setChat('sessions',(s) => s.filter((session) => session.id!=='removed'));
    f.setChat('activeId',null);
    await f.finish(false);
    assert.equal(f.value(),'Initial task\n\nKeep this follow-up');
    assert.deepEqual(f.attachments(),[file]);
  } finally { f.dispose(); }
});

test('Ctrl+Enter force-sends a queued message when the composer is empty or steers a new draft immediately', async () => {
  const f=await composerFixture('s');
  try {
    f.setChat('queued','s',[{text:'Already queued',attachments:[]}]);
    f.steer();
    assert.deepEqual(f.queuedSends,[['s',0]]);
    assert.equal(f.submissions.length,0);
    f.type('Steer directly');
    f.steer();
    assert.equal(f.submissions.length,1);
    assert.equal(f.submissions[0][0],'Steer directly');
    assert.equal(f.submissions[0][3],true);
    await f.finish(true);
  } finally { f.dispose(); }
});

test('composer follows the configured send shortcut and follow-up behavior', async () => {
  const plain = await composerFixture('s', { followUp: 'queue', shortcut: 'enter' });
  try {
    plain.type('Queue this');
    plain.send();
    assert.equal(plain.submissions.length, 1);
    assert.equal(plain.submissions[0][3], false, 'Enter queues while a turn runs by default');
    await plain.finish(true);
  } finally { plain.dispose(); }

  const steers = await composerFixture('s', { followUp: 'steer', shortcut: 'enter' });
  try {
    steers.type('Redirect the turn');
    steers.send();
    assert.equal(steers.submissions.length, 1);
    assert.equal(steers.submissions[0][3], true, 'Enter steers when that is the configured behavior');
    await steers.finish(true);
    steers.type('Queue this instead');
    steers.steer();
    assert.equal(steers.submissions.length, 2);
    assert.equal(steers.submissions[1][3], false, 'mod+Enter performs the opposite action');
    await steers.finish(true);
  } finally { steers.dispose(); }

  const mod = await composerFixture('s', { followUp: 'queue', shortcut: 'mod+enter' });
  try {
    mod.type('First line');
    mod.send();
    assert.equal(mod.submissions.length, 0, 'plain Enter inserts a newline when mod+Enter sends');
    mod.steer();
    assert.equal(mod.submissions.length, 1);
    assert.equal(mod.submissions[0][3], false, 'mod+Enter performs the primary action');
    await mod.finish(true);
  } finally { mod.dispose(); }
});

test('/mcp, /skills, /compact and /yolo slash commands work with and without arguments', async () => {
  const f = await composerFixture('s');
  try {
    // `/mcp` opens the MCP inspector modal without sending a chat turn.
    f.type('/mcp');
    f.send();
    assert.equal(f.value(), '');
    assert.equal(f.inspectorTab(), 'mcp');
    assert.equal(f.submissions.length, 0);

    // `/mcp reconnect all` on Claude routes directly to `/agent:mcp reconnect all`.
    f.type('/mcp reconnect all');
    f.send();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0][0], '/agent:mcp reconnect all');

    // `/skills pdf` opens the Skills browser filtered by "pdf".
    f.type('/skills pdf');
    f.send();
    assert.equal(f.inspectorTab(), 'skills');
    assert.equal(f.inspectorQuery(), 'pdf');

    // `/compact` routes to `/agent:compact` even before the first native turn connects.
    f.type('/compact focus on auth');
    f.send();
    assert.equal(f.submissions.length, 2);
    assert.equal(f.submissions[1][0], '/agent:compact focus on auth');

    // `/yolo on` and `/changes` alias work as local commands.
    f.type('/yolo on');
    f.send();
    assert.deepEqual(f.yoloCalls, [true]);
    f.type('/changes');
    f.send();
    assert.deepEqual(f.sideTabs, ['changes']);
  } finally { f.dispose(); }
});

test('force-sending a queued message or steering during a running turn cancels the active turn and sends on turn end', async () => {
  let listener;
  const cancelled=[], sent=[];
  const sessions=[{id:'a',project_path:'/fixture',cwd:'/fixture',agent_id:'claude',mode:'auto_edit',yolo:false}];
  const module=await loadChat({
    './ipc': {
      chatCancel:async(id)=>{cancelled.push(id);},
      chatSend:async(args)=>{sent.push(args);return 'next-turn';},
      chatListSessions:async()=>sessions,
      chatLoadTranscript:async()=>[],
      chatRuntimeState:async()=>runtime(),
      onChatEntry:async(_id,cb)=>{listener=cb;return()=>{};},
    },
    './appPrefs': { writePref() {} },
    './store': { store:{currentProject:{path:'/fixture'}}, setStore() {}, bumpGitStatus() {} },
    '../components/ui': { toast() {} },
  });
  module.setChat('sessions',sessions);
  await module.selectSession('a');
  listener(event({type:'turn_started',turn_id:'t1',agent_id:'claude'},1));
  await new Promise((resolve)=>setTimeout(resolve,70));
  assert.equal(module.isRunning('a'),true);

  await module.submitPrompt('First queued');
  await module.submitPrompt('Second queued');
  assert.equal(module.chat.queued.a.length,2);
  assert.equal(cancelled.length,0);

  await module.sendQueuedNow('a',1);
  assert.deepEqual(cancelled,['a']);
  assert.equal(module.chat.queued.a[0].text,'Second queued');

  listener(event({type:'turn_ended',turn_id:'t1',status:'cancelled',changed_files:[]},2));
  await new Promise((resolve)=>setTimeout(resolve,70));
  assert.equal(sent.length,1);
  assert.equal(sent[0].prompt,'Second queued');
  assert.deepEqual(module.chat.queued.a.map((q)=>q.text),['First queued']);
});

test('new-session submission identifies its draft destination before navigation and the slow send acknowledgement', async () => {
  const meta={id:'created',project_path:'/fixture',cwd:'/fixture',agent_id:'claude',mode:'auto_edit'};
  let acknowledge, destination;
  const module=await loadChat({
    './ipc': {
      chatCreateSession: async () => meta,
      onChatEntry: async () => () => {},
      chatSend: () => new Promise((resolve) => { acknowledge=resolve; }),
      chatListSessions: async () => [meta],
    },
    './appPrefs': { writePref() {} },
    './store': { store:{}, setStore() {} },
  });
  module.setChat('draftProject','/fixture');
  const pending=module.submitPrompt('Initial task',[],(id) => {
    destination=id;
    assert.equal(module.chat.activeId,null);
  });
  await settle();
  assert.equal(destination,'created');
  assert.equal(module.chat.activeId,'created');
  assert.equal(typeof acknowledge,'function');
  acknowledge('turn');
  assert.equal(await pending,true);
});

test('headless reload restores the active turn from backend authority without reactivating historical requests', async () => {
  const module = await loadChat();
  const state = { ...runtime(), connected:false, permission_mode:'auto_edit', pending:[] };
  const view = module.reduceTranscript(waiting(),state);
  assert.equal(view.running,true);
  assert.equal(view.runtime.permission_mode,'auto_edit');
  module.setChat('views','s',view);
  assert.equal(module.interactionIsLive('s','approval'),false);
  const history = module.reduceTranscript([...waiting(),event({type:'runtime_updated',state})]);
  assert.equal(history.running,false);
});

test('motion preference migrates safely and respects live OS changes', async () => {
  const fixture = await motionFixture({ theme: 'dark', motion: 'obsolete' });
  const { layout, reduced, document } = fixture;
  try {
    assert.equal(layout.layout.motion, 'system');
    assert.equal(layout.resolvedMotion(), 'full');
    reduced.matches = true; reduced.dispatchEvent(new Event('change'));
    assert.equal(layout.resolvedMotion(), 'reduced');
    assert.equal(document.documentElement.dataset.motion, 'reduced');
    layout.setMotion('off');
    reduced.matches = false; reduced.dispatchEvent(new Event('change'));
    assert.equal(layout.resolvedMotion(), 'off');
    assert.equal(fixture.writes.at(-1)[1].motion, 'off');
    document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(layout.motionForeground(), false);
  } finally { fixture.dispose(); }
});

test('interrupted presence cannot hide a reopened view; Off settles an active exit', async () => {
  const fixture = await motionFixture();
  const ui = await loadFrontend('../src/components/ui.tsx', { 'solid-js': solid, 'solid-js/web': {}, '../lib/layout': fixture.layout, './shell/Icon': {} });
  const clocks = [];
  const element = {
    isConnected: true, hidden: true, inert: false, scrollHeight: 100,
    classList: { contains: () => false },
    closest: () => element.hidden ? element : null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    setAttribute() {}, removeAttribute() {}, contains: () => false,
    animate(frames, options) {
      let finish, cancel;
      const finished = new Promise((resolve, reject) => { finish = resolve; cancel = () => reject(new Error('cancelled')); });
      const animation = { finished, finish, cancel, frames, options };
      clocks.push(animation); return animation;
    },
  };
  let stop, setOpen, present;
  solid.createRoot((dispose) => {
    stop = dispose;
    const [open, update] = solid.createSignal(false); setOpen = update;
    present = ui.usePresence(open, () => element, { axis: 'height' });
    solid.createEffect(() => { element.hidden = !present(); });
  });
  try {
    await settle();
    setOpen(true); await settle();
    assert.equal(present(), true);
    clocks.at(-1).finish(); await settle();
    setOpen(false); await settle();
    assert.equal(element.inert, true);
    assert.equal(present(), true);
    setOpen(true); await settle();
    assert.equal(present(), true);
    assert.equal(element.inert, false);
    clocks.at(-1).finish(); await settle();
    assert.equal(present(), true);
    setOpen(false); await settle();
    fixture.layout.setMotion('off'); await settle();
    assert.equal(present(), false);
    const count = clocks.length;
    setOpen(true); await settle();
    assert.equal(present(), true);
    assert.equal(clocks.length, count);
  } finally { stop(); fixture.dispose(); }
});

test('reduced motion strips geometry and missing WAAPI completes immediately', async () => {
  const fixture = await motionFixture({ motion: 'reduced' });
  const ui = await loadFrontend('../src/components/ui.tsx', { 'solid-js': solid, 'solid-js/web': {}, '../lib/layout': fixture.layout, './shell/Icon': {} });
  let recorded;
  const element = {
    isConnected: true, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    animate(frames, options) { recorded = { frames, options }; return { finished: Promise.resolve(), cancel() {} }; },
  };
  try {
    await ui.animateElement(element, [{ opacity: 0, height: '0px', transform: 'scale(.5)' }, { opacity: 1, height: '100px', transform: 'none' }], 420);
    assert.deepEqual(recorded.frames, [{ opacity: 0 }, { opacity: 1 }]);
    assert.equal(recorded.options.duration, 80);
    delete element.animate;
    await ui.animateElement(element, [{ opacity: 0 }, { opacity: 1 }]);
  } finally { fixture.dispose(); }
});

test('prompt launch animates from composer to transcript bubble and settles cleanly on reduced or off motion', async () => {
  const fixture = await motionFixture();
  const mounted = new Set();
  fixture.document.body = {
    append(node) { node.isConnected = true; mounted.add(node); },
  };
  fixture.document.createElement = (tag) => {
    const classes = new Set();
    const children = [];
    const node = {
      tag, isConnected: false, inert: false, style: {}, dataset: {}, textContent: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      setAttribute() {}, removeAttribute() {},
      closest: () => null,
      append: (...items) => children.push(...items),
      remove() { node.isConnected = false; mounted.delete(node); },
      getBoundingClientRect: () => ({ top: 680, left: 240, right: 740, bottom: 724, width: 500, height: 44 }),
      animate(frames, options) {
        return { frames, options, finished: Promise.resolve(), cancel() {} };
      },
    };
    return node;
  };
  const ui = await loadFrontend('../src/components/ui.tsx', { 'solid-js': solid, 'solid-js/web': {}, '../lib/layout': fixture.layout, './shell/Icon': {} });
  const makeNode = (rect) => {
    const classes = new Set();
    const recorded = [];
    return {
      isConnected: true, style: {}, dataset: {}, recorded,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      closest: () => null,
      getBoundingClientRect: () => rect,
      animate(frames, options) {
        const anim = { frames, options, finished: Promise.resolve(), cancel() {}, finish() {} };
        recorded.push(anim);
        return anim;
      },
    };
  };
  try {
    const source = makeNode({ top: 720, left: 240, right: 740, bottom: 764, width: 500, height: 44 });
    const box = makeNode({ top: 700, left: 220, right: 760, bottom: 800, width: 540, height: 100 });
    const sendBtn = makeNode({ top: 756, left: 710, right: 746, bottom: 792, width: 36, height: 36 });
    const bubble = makeNode({ top: 420, left: 240, right: 640, bottom: 468, width: 400, height: 48 });

    ui.startPromptLaunch({ source, box, sendBtn, text: 'Ship the prompt launch animation', attachmentsCount: 2, mode: 'plan' });
    assert.equal(mounted.size, 1, 'spawns an inert flight ghost in full motion');
    assert.equal(box.recorded.length, 1);
    assert.equal(sendBtn.recorded.length, 1);

    const consumed = ui.consumePromptLaunch(bubble);
    assert.equal(consumed, true, 'transcript bubble claims the active prompt launch');
    assert.equal(mounted.size, 0, 'removes the flight ghost immediately upon handoff');
    assert.equal(bubble.recorded.length, 1);
    assert.match(bubble.recorded[0].frames[0].transform, /translate\(0px, 260px\)/);
    assert.equal(ui.consumePromptLaunch(bubble), false, 'each launch is consumed at most once');

    // Settler removes an unconsumed ghost when switching motion to Off.
    ui.startPromptLaunch({ source, box, sendBtn, text: 'Another prompt', attachmentsCount: 0 });
    assert.equal(mounted.size, 1);
    fixture.layout.setMotion('off');
    assert.equal(mounted.size, 0, 'motion settler cleans up any active flight ghost');
  } finally { fixture.dispose(); }
});

test('presentation hints are live-only, do not replay text deltas, and unsubscribe', async () => {
  let listener;
  const meta = { id:'motion-session', project_path:'/fixture/project', cwd:'/fixture/project', agent_id:'claude', status:'idle' };
  const module = await loadChat({ './ipc': {
    chatCreateSession: async () => meta,
    onChatEntry: async (_id, callback) => { listener = callback; return () => {}; },
    chatSend: async () => 'turn',
    chatListSessions: async () => [meta],
  } });
  await module.startSessionTurn({ projectPath:meta.project_path, agentId:'claude', mode:'auto_edit', prompt:'fixture', activate:false });
  module.setChat('activeId',meta.id);
  const batches=[];
  const off=module.onLivePresentation((_id,hints) => batches.push(hints));
  module.reduceTranscript(waiting());
  assert.equal(batches.length,0);
  listener({kind:'user',ts:2,agent_id:'claude',text:'Hello',attachments:[]});
  listener(event({type:'turn_started',turn_id:'turn',agent_id:'claude'},3));
  listener(event({type:'text',delta:'Hello'},4));
  listener(event({type:'text',delta:' again'},5));
  await new Promise((resolve)=>setTimeout(resolve,70));
  assert.equal(batches.flat().filter((hint)=>hint.kind==='text').length,1);
  listener(event({type:'text',delta:' more'},6));
  await new Promise((resolve)=>setTimeout(resolve,70));
  assert.equal(batches.length,1);
  globalThis.document.hidden=true;
  listener(event({type:'tool_call',id:'background',kind:'read',title:'Read',input:{}},7));
  await new Promise((resolve)=>setTimeout(resolve,70));
  assert.equal(batches.length,1);
  assert(module.chat.views[meta.id].messages.at(-1).blocks.some((block)=>block.id==='background'));
  globalThis.document.hidden=false;
  off();
  listener(event({type:'tool_result',id:'background',ok:true,output:'Done'},8));
  await new Promise((resolve)=>setTimeout(resolve,70));
  assert.equal(batches.length,1);
});

test('spinner and running indicator animations are enabled in standard motion', () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(css, /\.ui-spinner\s*\{[^}]*animation:\s*spin/);
  assert.doesNotMatch(css, /\.sidebar\s+\.ui-spinner[^{]*\{\s*animation:\s*none/);
  assert.doesNotMatch(css, /\.tool-row\s+\.ui-spinner[^{]*\{\s*animation:\s*none/);
  assert.doesNotMatch(css, /(^|\n)\.session-header-live[^{]*\{\s*animation:\s*none/);
  assert.doesNotMatch(css, /(^|\n)\.flow-gate-pulse\s*\{\s*animation:\s*none/);
});

test('conversation column scales with available horizontal space', () => {
  const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
  assert.match(css, /\.center-col\s*\{[^}]*--conversation-max:\s*clamp\(920px,\s*88%,\s*1440px\)/);
  assert.match(css, /\.dock\s+\.composer\s*\{[^}]*max-width:\s*var\(--conversation-max\)/);
  assert.match(css, /\.transcript-inner\s*\{[^}]*max-width:\s*var\(--conversation-max\)/);
  assert.match(css, /\.empty-state-inner\s*\{[^}]*max-width:\s*var\(--conversation-max\)/);
});

// ── Device mirror (Android scrcpy / iOS idb) wire helpers ────────────────────

async function loadMirror() {
  const source = ts.transpileModule(readFileSync(new URL("../src/lib/androidMirror.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const names = new Map();
  for (const declaration of ts.createSourceFile("m.js", source, ts.ScriptTarget.ES2022).statements) {
    if (ts.isImportDeclaration(declaration)) names.set(declaration.moduleSpecifier.text, declaration.importClause.namedBindings.elements.map((e) => e.propertyName?.text ?? e.name.text));
  }
  const module = new SourceTextModule(source);
  await module.link((specifier) => new SyntheticModule(names.get(specifier), function () {
    for (const name of names.get(specifier)) this.setExport(name, specifier === "solid-js" ? solid[name] : () => { throw new Error(`Unexpected boundary call: ${specifier}.${name}`); });
  }));
  await module.evaluate();
  return module.namespace;
}

const bytes = (...values) => new Uint8Array(values);

test("Annex B streams split into NAL units with 3- and 4-byte start codes", async () => {
  const { splitAnnexB } = await loadMirror();
  const nals = splitAnnexB(bytes(0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 9, 0, 0, 0, 1, 0x65, 7));
  assert.deepEqual(nals.map((n) => [...n]), [[0x67, 1, 2], [0x68, 9], [0x65, 7]]);
});

test("a config packet becomes an avcC description and codec string", async () => {
  const { parseConfigPacket } = await loadMirror();
  const sps = [0x67, 0x64, 0x00, 0x32, 0xac];
  const pps = [0x68, 0xee, 0x3c, 0x80];
  const config = parseConfigPacket(bytes(0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps));
  assert.equal(config.codec, "avc1.640032");
  assert.deepEqual([...config.description], [1, 0x64, 0x00, 0x32, 0xff, 0xe1, 0, 5, ...sps, 1, 0, 4, ...pps]);
  assert.equal(parseConfigPacket(bytes(0, 0, 0, 1, ...sps)), null, "PPS is required");
});

test("frames are re-prefixed with 4-byte NAL lengths for the avcC decoder", async () => {
  const { annexBToAvcc } = await loadMirror();
  assert.deepEqual([...annexBToAvcc(bytes(0, 0, 0, 1, 0x65, 7, 0, 0, 1, 0x41, 0xaa, 0xbb))], [0, 0, 0, 2, 0x65, 7, 0, 0, 0, 3, 0x41, 0xaa, 0xbb]);
});

test("scrcpy control messages use the documented byte layout", async () => {
  const { encodeTouch, encodeKeycode, encodeText, encodeRotate } = await loadMirror();

  const down = encodeTouch("down", 3, 540, 1200, 1080, 2400);
  const view = new DataView(down.buffer);
  assert.equal(down.length, 32);
  assert.equal(down[0], 2);
  assert.equal(down[1], 0);
  assert.equal(view.getBigUint64(2), 3n);
  assert.equal(view.getUint32(10), 540);
  assert.equal(view.getUint32(14), 1200);
  assert.equal(view.getUint16(18), 1080);
  assert.equal(view.getUint16(20), 2400);
  assert.equal(view.getUint16(22), 0xffff, "finger down has full pressure");
  assert.equal(new DataView(encodeTouch("up", 3, 1, 1, 1080, 2400).buffer).getUint16(22), 0, "release has zero pressure");
  assert.equal(encodeTouch("move", 0, 1, 1, 10, 10)[1], 2);
  assert.equal(new DataView(encodeTouch("move", 0, -5, 1, 10, 10).buffer).getUint32(10), 0, "negative coordinates clamp to 0");

  const [keyDown, keyUp] = encodeKeycode(66);
  assert.deepEqual([keyDown.length, keyDown[0], keyDown[1], keyUp[1]], [14, 0, 0, 1]);
  assert.equal(new DataView(keyDown.buffer).getUint32(2), 66);

  const text = encodeText("héllo");
  assert.equal(text[0], 1);
  assert.equal(new DataView(text.buffer).getUint32(1), text.length - 5);
  assert.equal(new TextDecoder().decode(text.subarray(5)), "héllo");
  assert.deepEqual([...encodeRotate()], [11]);
});


test("Android inspection reads CLI bounds and preserves element metadata", async () => {
  const { androidInspectionNodes } = await loadMirror();
  const nodes = androidInspectionNodes([{ root: [{ class: "FrameLayout", bounds: "[0,0][1080,2400]", children: [
    { text: "Submit", "resource-id": "app:id/submit", "content-desc": "Submit order", bounds: "[20,40][200,100]", state: ["enabled"] },
    { text: "Invalid", bounds: "[20,40][0,0]" },
  ] }] }]);
  assert.equal(nodes.length, 3);
  assert.deepEqual([...nodes[1].bounds], [20, 40, 200, 100]);
  assert.equal(nodes[1].label, "Submit");
  assert.equal(nodes[1].properties["resource-id"], "app:id/submit");
  assert.equal(nodes[2].bounds, null);
  assert.ok(!("children" in nodes[0].properties));
  assert.equal(androidInspectionNodes(null).length, 0);
});

test("Android inspection traversal is bounded for large or cyclic layouts", async () => {
  const { androidInspectionNodes } = await loadMirror();
  const cyclic = { text: "Loop" }; cyclic.children = [cyclic];
  assert.equal(androidInspectionNodes(cyclic).length, 2000);
});


async function androidPanelFixture() {
  const [root, setRoot] = solid.createSignal('/checkout-a');
  const [conversation, setConversation] = solidStore.createStore({ activeId: 'session-a', draftProject: null });
  const calls = [], cancelled = [], attached = [];
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const begins = [], runs = [];
  const module = await loadFrontend('../src/components/side/AndroidPreview.tsx', {
    'solid-js': solid,
    '../../lib/store': { effectiveRoot: root },
    '../../lib/chat': { chat: conversation },
    '../../lib/attachments': { MAX_ATTACHMENTS: 10, attachments: () => [], addAttachments: items => attached.push(...items) },
    '../../lib/androidMirror': { androidInspectionNodes: () => [] },
    '../../lib/ipc': {
      androidCliBegin: () => { const d = deferred(); begins.push(d); return d.promise; },
      androidCliCancel: async id => { cancelled.push(id); },
      androidCliRun: (...args) => { calls.push(args); const d = deferred(); runs.push(d); return d.promise; },
      prepareAttachmentPreview: async path => ({path}),
    },
    '../ui': { toast() {} },
  }, source => source.replace('const AndroidCliPanel:', 'export const AndroidCliPanel:')
    .replace(/  return <section classList=[\s\S]*?\n};\n\nexport default AndroidPreview;/,
      '  return { run, cancel, attach, result, busy, error, setTarget, setFqn };\n};\n\nexport default AndroidPreview;'));
  let panel, dispose;
  solid.createRoot(stop => {
    dispose = stop;
    panel = module.AndroidCliPanel({ mode: 'compose', info: null, serial: null });
  });
  await settle();
  return { panel, dispose, root, setRoot, setConversation, calls, cancelled, attached, begins, runs };
}

test('Android operation cancellation during begin consumes and cancels the reservation', async () => {
  const f = await androidPanelFixture();
  try {
    const pending = f.panel.run('list');
    f.panel.cancel();
    f.begins[0].resolve('job-a');
    await settle();
    assert.deepEqual(f.cancelled, ['job-a']);
    assert.equal(f.calls[0][0], 'job-a');
    f.runs[0].reject(new Error('Cancelled'));
    await pending;
    assert.equal(f.panel.busy(), '');
    assert.equal(f.panel.error(), '');
  } finally { f.dispose(); }
});

test('Android operations snapshot their checkout and reject results after switching worktrees', async () => {
  const f = await androidPanelFixture();
  try {
    f.panel.setTarget(':library'); f.panel.setFqn('example.Preview');
    const pending = f.panel.run('render');
    f.panel.setTarget(':other');
    f.begins[0].resolve('job-a');
    await settle();
    assert.deepEqual(f.calls[0].slice(1, 5), ['/checkout-a', 'render', ':library', 'example.Preview']);
    f.setRoot('/checkout-b');
    f.runs[0].resolve({ artifacts: [{ path:'/capture.png', kind:'image', name:'capture.png' }], context: { capture_started_ms:0 } });
    await pending;
    assert.equal(f.panel.result(), null);
    assert.deepEqual(f.cancelled, ['job-a']);
  } finally { f.dispose(); }
});

test('Android captures attach only to the originating conversation and retain a successful result on failure', async () => {
  const f = await androidPanelFixture();
  try {
    const pending = f.panel.run('render');
    f.begins[0].resolve('job-a'); await settle();
    const capture = { artifacts: [{ path:'/capture.png', kind:'image', name:'capture.png' }, { path:'/context.json', kind:'file', name:'context.json' }], context: { capture_started_ms:0 } };
    f.runs[0].resolve(capture); await pending;
    f.setConversation('activeId', 'session-b');
    await f.panel.attach(); assert.equal(f.attached.length, 0);
    f.setConversation('activeId', 'session-a');
    await f.panel.attach(); assert.equal(f.attached.length, 2);
    const retry = f.panel.run('render');
    f.begins[1].resolve('job-b'); await settle();
    f.runs[1].reject(new Error('Build failed')); await retry;
    assert.equal(f.panel.result(), capture);
    assert.match(f.panel.error(), /Build failed/);
  } finally { f.dispose(); }
});

test('goal signals, prompts and the turn-end driver', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const calls = { updates: [], queued: [], toasts: [] };
  const state = { sessions: [{ id: 's1', goal: { text: 'ship it', status: 'active', rounds: 0, max_rounds: 3 } }], queued: {}, views: {} };
  const chatMock = {
    chat: state,
    setChat: (_k, _match, _field, goal) => { state.sessions[0].goal = goal; },
    enqueueFollowUp: (id, text) => calls.queued.push([id, text]),
    submitPrompt: async () => true,
  };
  const goals = await loadFrontend('../src/lib/goals.ts', {
    './chat': chatMock,
    './ipc': { chatUpdateSession: async (id, patch) => { calls.updates.push([id, patch]); } },
    './transcript': transcript,
    '../components/ui': { toast: (m) => calls.toasts.push(m) },
  });
  assert.deepEqual({ ...goals.parseGoalSignal('done\n**GOAL COMPLETE**') }, { kind: 'complete' });
  assert.deepEqual({ ...goals.parseGoalSignal('x\nGOAL BLOCKED: need a key') }, { kind: 'blocked', reason: 'need a key' });
  assert.equal(goals.parseGoalSignal('we are not at GOAL COMPLETE yet'), null);
  assert.ok(goals.goalPrompt({ text: 'ship it', rounds: 1, max_rounds: 3 }, false).includes('Turn 2 of 3'));

  const reply = (text) => transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: 't', agent_id: 'claude' }, 1),
    event({ type: 'text', delta: text }, 2),
    event({ type: 'turn_ended', turn_id: 't', status: 'done', changed_files: [] }, 3),
  ]);
  // No sentinel: continue and count the round.
  state.views.s1 = reply('working on it');
  goals.onGoalTurnEnd('s1', 'done');
  assert.equal(calls.queued.length, 1);
  assert.equal(state.sessions[0].goal.rounds, 1);
  // The last allowed round pauses instead of queueing.
  state.sessions[0].goal.rounds = 2;
  goals.onGoalTurnEnd('s1', 'done');
  assert.equal(calls.queued.length, 1);
  assert.equal(state.sessions[0].goal.status, 'paused');
  // Completion, failure and user follow-ups.
  state.sessions[0].goal = { text: 'ship it', status: 'active', rounds: 0, max_rounds: 3 };
  state.views.s1 = reply('all good\nGOAL COMPLETE');
  goals.onGoalTurnEnd('s1', 'done');
  assert.equal(state.sessions[0].goal.status, 'done');
  state.sessions[0].goal.status = 'active';
  goals.onGoalTurnEnd('s1', 'error');
  assert.equal(state.sessions[0].goal.status, 'paused');
  state.sessions[0].goal.status = 'active';
  state.queued.s1 = [{ text: 'mine' }];
  state.views.s1 = reply('still going');
  goals.onGoalTurnEnd('s1', 'done');
  assert.equal(calls.queued.length, 1);
  assert.equal(state.sessions[0].goal.status, 'active');
});

test('schedule rules parse and compute the next run', async () => {
  const schedule = await loadFrontend('../src/lib/schedule.ts', { 'solid-js': solid, 'solid-js/store': solidStore });
  assert.deepEqual(JSON.parse(JSON.stringify(schedule.parseScheduleSpec('every 30m run tests'))), { rule: { kind: 'every', minutes: 30 }, prompt: 'run tests', newSession: false });
  assert.equal(schedule.parseScheduleSpec('every 2h x').rule.minutes, 120);
  assert.equal(schedule.parseScheduleSpec('weekdays 9:05 standup').rule.time, '09:05');
  for (const bad of ['every 1m x', 'daily 25:00 x', 'daily 09:00', 'hourly x']) assert.equal(typeof schedule.parseScheduleSpec(bad), 'string');
  const from = new Date(2026, 10, 6, 10, 0, 0); // Friday 10:00 local
  assert.equal(schedule.nextRun({ kind: 'every', minutes: 15 }, from), from.getTime() + 15 * 60_000);
  assert.deepEqual([new Date(schedule.nextRun({ kind: 'daily', time: '09:00' }, from))].map((d) => [d.getDate(), d.getHours()])[0], [7, 9]);
  assert.deepEqual([new Date(schedule.nextRun({ kind: 'daily', time: '11:30' }, from))].map((d) => [d.getDate(), d.getHours()])[0], [6, 11]);
  const monday = new Date(schedule.nextRun({ kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] }, from));
  assert.equal(monday.getDay(), 1);
  assert.equal(schedule.describeRule({ kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] }), 'weekdays at 09:00');
});

test('loop guard counts identical trailing tool calls and export renders markdown', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const tool = (id, path) => event({ type: 'tool_call', id, kind: 'read', title: 'Read file', input: { path } }, 2);
  const view = (paths) => transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: 't', agent_id: 'claude' }, 1),
    ...paths.map((p, i) => tool(`c${i}`, p)),
  ]);
  const last = (v) => v.messages[v.messages.length - 1];
  assert.equal(transcript.detectToolLoop(last(view(['a', 'a']))), null);
  assert.deepEqual({ ...transcript.detectToolLoop(last(view(['a', 'a', 'a']))) }, { title: 'Read file', count: 3 });
  assert.equal(transcript.detectToolLoop(last(view(['a', 'a', 'b', 'a']))), null);
  assert.equal(transcript.detectToolLoop(last(view(['a', 'b', 'a', 'a', 'a']))).count, 3);

  const exporter = await loadFrontend('../src/lib/exportTranscript.ts', {});
  const md = exporter.transcriptToMarkdown({ title: 'Demo', project_path: '/p', agent_id: 'claude' }, transcript.reduceTranscript([
    { kind: 'user', ts: 1, agent_id: 'claude', text: 'Hello' },
    event({ type: 'turn_started', turn_id: 't', agent_id: 'claude' }, 2),
    event({ type: 'text', delta: 'Hi there' }, 3),
    event({ type: 'turn_ended', turn_id: 't', status: 'done', changed_files: [{ path: 'a.txt', status: 'added' }] }, 4),
  ]));
  assert.match(md, /^# Demo\n/);
  assert.match(md, /## You\n\nHello/);
  assert.match(md, /## claude\n\nHi there/);
  const withSource = exporter.transcriptToMarkdown({ title: 'Demo', project_path: '/p', agent_id: 'claude' }, transcript.reduceTranscript([]), (id) => id, '/data/chat/abc.jsonl');
  assert.match(withSource, /- Source: `\/data\/chat\/abc\.jsonl`/);
  assert.doesNotMatch(md, /Source:/);
  assert.match(md, /- `a\.txt`/);
});

test('quote blockquotes and the latest todo list', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  assert.equal(transcript.toBlockquote('  one\n\ntwo  '), '> one\n>\n> two\n\n');
  assert.equal(transcript.toBlockquote('   '), '');
  assert.equal(transcript.toBlockquote('a\r\nb'), '> a\n> b\n\n');
  assert.equal(transcript.citeInComposer('one\ntwo'), '> one\n> two\n\n', 'a plain quote is unchanged');
  assert.equal(transcript.citeInComposer('one', '  Focus on the retry  '), '> one\n\nAbout the quoted text: Focus on the retry', 'comments are trimmed and attributed');
  assert.equal(transcript.citeInComposer('one', '   '), '> one\n\n', 'a blank comment is ignored');
  assert.equal(transcript.citeInComposer('one', 'line\r\ntwo'), '> one\n\nAbout the quoted text: line\ntwo');

  const todoCall = (id, input) => event({ type: 'tool_call', id, kind: 'todo', title: 'Todos', input }, 2);
  const view = transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: 't1', agent_id: 'claude' }, 1),
    todoCall('a', { todos: [{ content: 'old', status: 'pending' }] }),
    event({ type: 'turn_ended', turn_id: 't1', status: 'done', changed_files: [] }, 3),
    event({ type: 'turn_started', turn_id: 't2', agent_id: 'claude' }, 4),
    todoCall('b', { todos: [{ content: 'write', status: 'completed' }, { content: 'test', status: 'in_progress' }, { content: 'ship', status: 'pending' }] }),
    todoCall('c', { nothing: true }),
  ]);
  const todos = transcript.latestTodos(view);
  assert.deepEqual(todos.map((t) => [t.text, t.done, t.active]), [['write', true, false], ['test', false, true], ['ship', false, false]]);
  assert.equal(transcript.latestTodos({ messages: [], loaded: true, running: false }), null);
  const codex = transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: 't', agent_id: 'codex' }, 1),
    todoCall('x', { items: [{ text: 'step', completed: true }] }),
  ]);
  assert.deepEqual(transcript.latestTodos(codex).map((t) => [t.text, t.done]), [['step', true]]);
});

test('session usage sums headless turns and prefers the ACP cumulative cost', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const usage = await loadFrontend('../src/lib/usage.ts', {});
  const turn = (n, extra = []) => [
    event({ type: 'turn_started', turn_id: `t${n}`, agent_id: 'codex' }, n * 10),
    event({ type: 'usage', input_tokens: 1000 * n, output_tokens: 100 * n, cost_usd: 0.5 * n }, n * 10 + 1),
    ...extra,
    event({ type: 'turn_ended', turn_id: `t${n}`, status: 'done', changed_files: [] }, n * 10 + 2),
  ];
  const summed = usage.sessionUsage(transcript.reduceTranscript([...turn(1), ...turn(2)]));
  assert.deepEqual({ ...summed }, { input: 3000, output: 300, cost: 1.5, turns: 2 });
  assert.equal(usage.formatUsage(summed), '3.0k in · 300 out · $1.50 · 2 turns');

  const cumulative = usage.sessionUsage(transcript.reduceTranscript([
    ...turn(1, [event({ type: 'context_usage', used: 10, size: 100, cost_usd: 0.4 }, 15)]),
    ...turn(2, [event({ type: 'context_usage', used: 20, size: 100, cost_usd: 0.9 }, 25)]),
  ]));
  assert.equal(cumulative.cost, 0.9);

  const none = usage.sessionUsage(transcript.reduceTranscript([event({ type: 'turn_started', turn_id: 't', agent_id: 'claude' }, 1)]));
  assert.deepEqual({ ...none }, { input: 0, output: 0, cost: null, turns: 0 });
  assert.equal(usage.formatUsage(none), null);
  assert.deepEqual({ ...usage.sessionUsage(undefined) }, { input: 0, output: 0, cost: null, turns: 0 });
});

test('schedule v2: one-time rules, new-session mode, names, history cap and sidebar marks', async () => {
  const chatMock = {
    chat: { sessions: [{ id: 's1' }], composer: { mode: 'auto_edit', yolo: false } },
    enqueueFollowUp() {}, isRunning: () => false, sendPromptTo: async () => true,
    startSessionTurn: async (o) => { started.push(o); return { id: `new-${started.length}` }; },
  };
  const started = [];
  const schedule = await loadFrontend('../src/lib/schedule.ts', {
    'solid-js': solid, 'solid-js/store': solidStore, './chat': chatMock,
    './appPrefs': { readPref: async () => [], writePref() {} },
    '../components/ui': { toast() {} },
  });
  const now = new Date(2026, 10, 6, 10, 0, 0);
  const inTwoHours = schedule.parseScheduleSpec('in 2h check CI', now);
  assert.equal(inTwoHours.rule.kind, 'once');
  assert.equal(inTwoHours.rule.at, now.getTime() + 2 * 3_600_000);
  const later = new Date(schedule.parseScheduleSpec('once 11:30 later', now).rule.at);
  assert.deepEqual([later.getDate(), later.getHours(), later.getMinutes()], [6, 11, 30]);
  const tomorrow = new Date(schedule.parseScheduleSpec('once 09:00 early', now).rule.at);
  assert.equal(tomorrow.getDate(), 7);
  assert.equal(schedule.parseScheduleSpec('new daily 09:00 standup', now).newSession, true);
  assert.equal(typeof schedule.parseScheduleSpec('in 0m x', now), 'string');
  assert.equal(schedule.describeRule({ kind: 'every', minutes: 90 }), 'every 90m');

  assert.equal(schedule.addSchedule({ session_id: 's1', project_path: '/p', agent_id: 'claude' }, 'every 10m summarize the repository in detail please, every file', now), null);
  assert.equal(schedule.addSchedule({ session_id: 's1', project_path: '/p', agent_id: 'claude' }, 'new daily 09:00 standup', now), null);
  assert.equal(typeof schedule.addSchedule({ session_id: null, project_path: null, agent_id: 'claude' }, 'every 10m x', now), 'string');
  const [session, fresh] = schedule.schedules;
  assert.ok('session_id' in session.target && 'project_path' in fresh.target);
  assert.ok(session.name.length <= 40 && session.name.endsWith('…'));
  assert.deepEqual([...schedule.scheduledSessionIds()], ['s1']);
  schedule.toggleSchedule(session.id);
  assert.equal(schedule.scheduledSessionIds().size, 0);

  // Runs are recorded newest-first and capped; project targets open titled sessions.
  for (let i = 0; i < 25; i++) await schedule.runSchedule({ ...schedule.schedules[1] });
  assert.equal(schedule.schedules[1].runs.length, 20);
  assert.equal(schedule.schedules[1].runs[0].session_id, 'new-25');
  assert.match(started[0].title, /^standup · /);

  // A one-time schedule ends after delivery and is no longer due.
  schedule.addSchedule({ session_id: 's1', agent_id: 'claude' }, 'in 5m once', now);
  const once = schedule.schedules[2];
  await schedule.runSchedule({ ...once });
  assert.equal(schedule.schedules[2].ended, true);
  assert.equal(schedule.scheduledSessionIds().has('s1'), false);
});

test('pull request review prompt names the diff and stays read-only', async () => {
  const chat = await loadChat();
  const prompt = chat.prReviewPrompt({ number: 7, title: 'Fix cache', body: 'Clears stale keys.', base_ref: 'origin/main', head_sha: 'abcdef1234567890' });
  assert.match(prompt, /^Review pull request #7: Fix cache\./);
  assert.match(prompt, /Description:\nClears stale keys\./);
  assert.match(prompt, /abcdef1\)/);
  assert.match(prompt, /git diff origin\/main\.\.\.HEAD/);
  assert.match(prompt, /do not modify files/);
  const bare = chat.prReviewPrompt({ number: 8, title: null, body: null, base_ref: 'upstream/dev', head_sha: '0123456789' });
  assert.ok(bare.startsWith('Review pull request #8.') && !bare.includes('Description:') && !bare.includes('\n\n\n'));
  const long = chat.prReviewPrompt({ number: 9, title: 't', body: 'x'.repeat(5000), base_ref: 'origin/main', head_sha: 'abc' });
  assert.ok(long.includes('(description truncated)') && long.length < 5000);
});

test('secret masking covers common credential shapes without touching prose and is idempotent', async () => {
  const secrets = await loadFrontend('../src/lib/secrets.ts', { './settings': { maskSecretsEnabled: () => true } });
  const mask = secrets.maskSecrets;
  const stars = (n) => '*'.repeat(n);
  assert.equal(mask('key sk-proj-abcdefghijklmnopqrstuv end'), `key sk-proj-${stars(22)} end`);
  assert.equal(mask('ghp_' + 'a'.repeat(36)), 'ghp_aaaa' + stars(32));
  assert.equal(mask('AKIAABCDEFGHIJKLMNOP'), 'AKIAAB' + stars(14)); // keeps at most a third of short keys
  assert.ok(!mask('xoxb-1234567890-abcdefghij').includes('abcdefghij'));
  assert.ok(!mask('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123').includes('uvwxyz0123'));
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  assert.ok(mask(`token ${jwt}`).startsWith('token eyJhbGci') && !mask(jwt).includes('dozjgNry'));
  assert.equal(mask('postgres://admin:hunter22@db.local/app'), 'postgres://admin:' + stars(8) + '@db.local/app');
  assert.equal(mask('OPENAI_API_KEY=abcd1234efgh5678'), 'OPENAI_API_KEY=abcd' + stars(12));
  assert.equal(mask('{"apiKey": "abcd1234efgh5678"}'), '{"apiKey": "abcd' + stars(12) + '"}');
  assert.equal(mask('DB_PASSWORD: supersecret1'), 'DB_PASSWORD: supe' + stars(8));
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----';
  assert.equal(mask(`x ${pem} y`), 'x -----BEGIN RSA PRIVATE KEY-----\n********\n-----END RSA PRIVATE KEY----- y');
  // Prose, short values, placeholders and variable references stay readable.
  for (const safe of ['task-12345 and sk-learn are fine', 'max_tokens: 4096', 'token=abc', 'tokenizer: transformers-base', 'API_KEY=$OPENAI_API_KEY', 'password: <your-password-here>', 'SECRET_KEY=process.env.SECRET_KEY', 'short']) {
    assert.equal(mask(safe), safe, safe);
  }
  for (const input of ['sk-proj-abcdefghijklmnopqrstuv', 'OPENAI_API_KEY=abcd1234efgh5678', 'postgres://admin:hunter22@db.local/app', pem, 'Bearer abcdefghijklmnopqrstuvwxyz0123']) {
    assert.equal(mask(mask(input)), mask(input), input);
  }
  const off = await loadFrontend('../src/lib/secrets.ts', { './settings': { maskSecretsEnabled: () => false } });
  assert.equal(off.maskForDisplay('sk-proj-abcdefghijklmnopqrstuv'), 'sk-proj-abcdefghijklmnopqrstuv');
  assert.notEqual(secrets.maskForDisplay('sk-proj-abcdefghijklmnopqrstuv'), 'sk-proj-abcdefghijklmnopqrstuv');
});

test('file links carry the referenced line for open-in-editor', async () => {
  const md = await loadMarkdown();
  const html = md.renderMarkdownLite('See `src/lib/a.ts:42` and [the file](src/b.ts:7:3) and src/c.ts:9. Also src/d.ts');
  assert.match(html, /data-file-path="src\/lib\/a\.ts" data-file-line="42"/);
  assert.match(html, /data-file-path="src\/b\.ts" data-file-line="7"/);
  assert.match(html, /data-file-path="src\/c\.ts" data-file-line="9"/);
  assert.match(html, /data-file-path="src\/d\.ts" title/);
  assert.equal(md.renderPlainTextWithFileRefs('at src/e.ts:12:5 failed').includes('data-file-line="12"'), true);
});

test('tool timings: per-call durations, parallel spans counted once, slowest call', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const call = (id, title, ts) => event({ type: 'tool_call', id, kind: 'bash', title, input: { id } }, ts);
  const result = (id, ts) => event({ type: 'tool_result', id, ok: true, output: 'ok' }, ts);
  const view = transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: 't', agent_id: 'claude' }, 1000),
    call('a', 'Run tests', 2000), call('b', 'Lint', 3000), result('b', 5000), result('a', 12000),
    call('c', 'Build', 20000), result('c', 24000),
    call('d', 'Unfinished', 30000),
    event({ type: 'turn_ended', turn_id: 't', status: 'done', changed_files: [] }, 60000),
  ]);
  const [message] = view.messages;
  const tools = message.blocks.filter((b) => b.kind === 'tool');
  assert.deepEqual(tools.map((t) => transcript.toolDurationMs(t)), [10000, 2000, 4000, 30000]);
  // a and b overlap (2s–12s once), c is 20s–24s, d runs to the end of the turn (30s–60s).
  assert.equal(transcript.toolSpanMs(tools), 10000 + 4000 + 30000);
  const timing = transcript.turnTiming(message);
  assert.deepEqual({ ...timing, slowest: { ...timing.slowest } }, { totalMs: 59000, toolMs: 44000, slowest: { title: 'Unfinished', ms: 30000 } });
  assert.equal(transcript.formatDuration(4000), '4s');
  assert.equal(transcript.formatDuration(72000), '1m 12s');
  assert.equal(transcript.formatDuration(65000), '1m 05s');

  const tool = (kind, n = 1) => ({ kind: 'tool', toolKind: kind, title: kind, input: {}, status: 'ok' });
  assert.equal(transcript.describeToolRun([]), 'No activity');
  assert.equal(transcript.describeToolRun([tool('bash')]), 'Ran 1 command');
  assert.equal(transcript.describeToolRun([tool('bash'), tool('bash')]), 'Ran 2 commands');
  assert.equal(transcript.describeToolRun([tool('edit'), tool('write')]), '2 file changes');
  assert.equal(transcript.describeToolRun([tool('bash'), tool('bash'), tool('read')]), 'Ran 2 commands · 1 file read');
  assert.equal(transcript.describeToolRun([tool('bash'), tool('read'), tool('search'), tool('todo')]), 'Ran 1 command · 1 search · 2 more');
  assert.equal(transcript.describeToolRun([tool('web'), tool('other')]), '1 web lookup · 1 tool call');
  assert.equal(transcript.describeToolRun([tool('todo')]), '1 plan update');

  const quick = transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: 'q', agent_id: 'claude' }, 1000),
    call('x', 'cat', 1100), result('x', 2200),
    event({ type: 'turn_ended', turn_id: 'q', status: 'done', changed_files: [] }, 3000),
  ]);
  assert.equal(transcript.turnTiming(quick.messages[0]), null);
  const running = transcript.reduceTranscript([event({ type: 'turn_started', turn_id: 'r', agent_id: 'claude' }, 1000), call('y', 'slow', 1500)]);
  assert.equal(transcript.turnTiming(running.messages[0]), null);
  assert.equal(transcript.toolDurationMs(running.messages[0].blocks[0]), null);
});

test('code size snaps to its steps, persists, and notifies terminals', async () => {
  const f = await motionFixture({ codeScale: 1.23 });
  const styles = {};
  f.document.documentElement.style = { setProperty: (name, value) => { styles[name] = value; } };
  let events = 0;
  f.window.addEventListener(f.layout.CODE_SCALE_EVENT, () => { events += 1; });
  // A stale saved value snaps to the nearest step.
  assert.equal(f.layout.layout.codeScale, 1.2);
  f.layout.applyCodeScale(f.layout.layout.codeScale);
  assert.equal(styles['--code-scale'], '1.2');
  f.layout.stepCodeScale(1);
  assert.equal(f.layout.layout.codeScale, 1.3);
  f.layout.stepCodeScale(1); f.layout.stepCodeScale(1); f.layout.stepCodeScale(1);
  assert.equal(f.layout.layout.codeScale, 1.4);
  for (let i = 0; i < 10; i++) f.layout.stepCodeScale(-1);
  assert.equal(f.layout.layout.codeScale, 0.85);
  f.layout.setCodeScale(0.97);
  assert.equal(f.layout.layout.codeScale, 1);
  assert.equal(styles['--code-scale'], '1');
  assert.ok(events >= 3);
  assert.ok(f.writes.length > 0);
  f.dispose();
});

test('find matching, focus view blocks and quoted replies', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  assert.deepEqual(transcript.findTextMatches('Foo foo FOO fo', 'foo'), [0, 4, 8]);
  assert.deepEqual(transcript.findTextMatches('aaaa', 'aa'), [0, 2]);
  assert.deepEqual(transcript.findTextMatches('a.b(c) a.b(c)', 'a.b(c)'), [0, 7]);
  assert.deepEqual(transcript.findTextMatches('anything', ''), []);
  assert.deepEqual([transcript.stepMatch(0, 3, 1), transcript.stepMatch(2, 3, 1), transcript.stepMatch(0, 3, -1), transcript.stepMatch(0, 0, 1)], [1, 0, 2, 0]);

  const call = (id) => event({ type: 'tool_call', id, kind: 'bash', title: id, input: {} }, 2);
  const events = [
    event({ type: 'turn_started', turn_id: 't', agent_id: 'claude' }, 1),
    event({ type: 'thinking', delta: 'hmm' }, 2),
    event({ type: 'text', delta: 'Let me look.' }, 3), call('a'),
    event({ type: 'text', delta: 'Final answer.' }, 4),
  ];
  // Loaded history settles unfinished turns, so a live message is built entry by entry.
  const live = { messages: [], loaded: true, running: false };
  events.forEach((e) => transcript.applyEntry(live, e));
  const running = live.messages[0];
  assert.equal(running.status, 'running');
  assert.equal(transcript.focusBlocks(running).length, 4);
  const done = transcript.reduceTranscript([...events, event({ type: 'turn_ended', turn_id: 't', status: 'done', changed_files: [] }, 5)]).messages[0];
  assert.deepEqual(transcript.focusBlocks(done).map((b) => b.kind === 'text' ? b.text : b.kind), ['Final answer.']);
  const noText = transcript.reduceTranscript([events[0], call('x'), event({ type: 'turn_ended', turn_id: 't', status: 'error', changed_files: [] }, 5)]).messages[0];
  assert.deepEqual(transcript.focusBlocks(noText), []);

  assert.deepEqual({ ...transcript.splitLeadingQuote('> one\n>two\n\nMy reply') }, { quote: 'one\ntwo', rest: 'My reply' });
  assert.deepEqual({ ...transcript.splitLeadingQuote('plain\n> not leading') }, { quote: null, rest: 'plain\n> not leading' });
  assert.deepEqual({ ...transcript.splitLeadingQuote('> only quote') }, { quote: 'only quote', rest: '' });
  assert.deepEqual({ ...transcript.splitLeadingQuote('>\n>\nbody') }, { quote: null, rest: 'body' });
});

test('second opinion forks with the worktree and sends a read-only review on the chosen agent', async () => {
  const forks = [], sends = [];
  const fork = { id: 'fork', project_path: '/project', cwd: '/project/wt', agent_id: 'claude', native_ids: {}, mode: 'auto_edit', yolo: true, model: 'opus', effort: 'high', worktree: { path: '/project/wt', branch: 'b', source_branch: 'main' } };
  const module = await loadChat({
    './ipc': {
      chatForkSession: async (...args) => { forks.push(args); return fork; },
      chatSend: async (args) => { sends.push(args); return 'turn'; },
      chatListSessions: async () => [fork], chatLoadTranscript: async () => [], chatRuntimeState: async () => runtime(),
      onChatEntry: async () => () => {}, openProject: async () => ({ path: '/project' }),
    },
    './store': { store: { agents: [{ id: 'claude', installed: true }], currentProject: { path: '/project' } }, setStore() {}, bumpGitStatus() {} },
    './appPrefs': { writePref() {}, readPref: async (_k, fallback) => fallback },
    '../components/ui': { toast() {}, confirmDialog: async () => true },
  });
  module.setChat('sessions', [{ id: 'src', project_path: '/project', agent_id: 'claude', worktree: fork.worktree }]);
  assert.match(module.secondOpinionPrompt('Claude Code'), /Claude Code produced the last answer[\s\S]*do not modify files/);
  assert.equal(await module.secondOpinion('src', 'turn-1', 'codex', 'Claude Code'), true);
  assert.deepEqual(forks, [['src', 'turn-1', true]]);
  assert.equal(sends.length, 1);
  const [sent] = sends;
  assert.deepEqual([sent.session_id, sent.agent_id, sent.mode, sent.yolo, sent.model ?? null, sent.effort ?? null], ['fork', 'codex', 'ask', false, null, null]);
  assert.match(sent.prompt, /Second opinion requested/);
  assert.equal(module.chat.activeId, 'fork');
});

test('session search also matches the session id', async () => {
  const module = await loadChat();
  const meta = (id, title) => ({ id, title, project_path: '/p', archived: false, pinned: false, updated_at: 1, created_at: 1 });
  module.setChat('sessions', [meta('0f3a-aa11', 'Alpha'), meta('9b7c-bb22', 'Beta')]);
  const found = module.sessionGroups({ includeArchived: false, query: '9b7c', group: 'date', filter: null }).flatMap((g) => g.sessions.map((s) => s.id));
  assert.deepEqual(found, ['9b7c-bb22']);
});

test('pull request chip summarizes checks, state and review, and caches lookups', async () => {
  let lookups = 0, answer = null;
  const prStatus = await loadFrontend('../src/lib/prStatus.ts', {
    'solid-js/store': solidStore,
    './ipc': { prStatus: async () => { lookups += 1; return answer; } },
  });
  const base = { number: 12, title: 'Fix cache', url: 'https://github.com/o/r/pull/12', state: 'OPEN', is_draft: false, review_decision: 'APPROVED', checks: { passing: 3, failing: 0, pending: 0 } };
  const chip = (patch) => prStatus.prChip({ ...base, ...patch, checks: { ...base.checks, ...patch?.checks } });
  assert.equal(chip({}).label, 'PR #12');
  assert.equal(chip({}).tone, 'pass');
  assert.equal(chip({ checks: { failing: 1 } }).tone, 'fail');
  assert.equal(chip({ checks: { failing: 0, pending: 2 } }).tone, 'pending');
  assert.equal(chip({ checks: { passing: 0 } }).tone, 'none');
  assert.deepEqual([chip({ is_draft: true }).tone, chip({ is_draft: true }).label], ['draft', 'PR #12 · Draft']);
  assert.deepEqual([chip({ state: 'MERGED' }).tone, chip({ state: 'merged' }).label], ['merged', 'PR #12 · Merged']);
  assert.equal(chip({ state: 'CLOSED' }).tone, 'closed');
  assert.match(chip({ review_decision: 'CHANGES_REQUESTED' }).title, /Review: Changes requested/);
  assert.match(chip({ checks: { passing: 2, failing: 1, pending: 1 } }).title, /Checks: 2 passing, 1 failing, 1 pending/);
  assert.match(chip({ review_decision: '' }).title, /No review decision/);

  // Found PRs refresh every minute; "none" results wait five minutes; force always looks.
  answer = base;
  await prStatus.refreshPrStatus('/a', false, 0);
  assert.equal(prStatus.prStatusFor('/a').number, 12);
  await prStatus.refreshPrStatus('/a', false, Date.now() + 1000);
  assert.equal(lookups, 1);
  await prStatus.refreshPrStatus('/a', false, Date.now() + prStatus.REFRESH_MS + 1000);
  assert.equal(lookups, 2);
  answer = null;
  await prStatus.refreshPrStatus('/b', false, 0);
  assert.equal(prStatus.prStatusFor('/b'), null);
  await prStatus.refreshPrStatus('/b', false, Date.now() + prStatus.REFRESH_MS + 1000);
  assert.equal(lookups, 3, 'a negative result is not re-probed after one minute');
  await prStatus.refreshPrStatus('/b', false, Date.now() + prStatus.NONE_TTL_MS + 1000);
  assert.equal(lookups, 4);
  await prStatus.refreshPrStatus('/b', true);
  assert.equal(lookups, 5);
  assert.equal(prStatus.prStatusFor(null), null);
});

test('fan-out selection and compare rows', async () => {
  const chatModule = await loadChat({ './appPrefs': { writePref() {} } });
  assert.deepEqual(chatModule.toggleFanOut([], 'codex', 'claude'), ['codex']);
  assert.deepEqual(chatModule.toggleFanOut(['codex'], 'codex', 'claude'), []);
  assert.deepEqual(chatModule.toggleFanOut(['codex'], 'claude', 'claude'), ['codex'], 'the primary agent is never an extra');
  chatModule.setChat('composer', 'agentId', 'claude');
  chatModule.toggleFanOutAgent('codex'); chatModule.toggleFanOutAgent('cursor');
  assert.deepEqual([...chatModule.chat.fanOut], ['codex', 'cursor']);
  chatModule.setComposerAgent('cursor');
  assert.deepEqual([...chatModule.chat.fanOut], ['codex'], 'choosing an extra as primary removes it from the extras');
  chatModule.clearFanOut();
  assert.deepEqual([...chatModule.chat.fanOut], []);

  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const usage = await loadFrontend('../src/lib/usage.ts', { './transcript': transcript });
  const view = (agent, text, files, status = 'done') => transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: `t-${agent}`, agent_id: agent }, 1000),
    event({ type: 'text', delta: `${agent} is thinking.` }, 1500), event({ type: 'tool_call', id: 'x', kind: 'bash', title: 'ls', input: {} }, 1600),
    event({ type: 'text', delta: text }, 2000), event({ type: 'usage', input_tokens: 2000, output_tokens: 300, cost_usd: 0.25 }, 2500),
    event({ type: 'turn_ended', turn_id: `t-${agent}`, status, changed_files: files }, 5000),
  ]);
  const sessions = [{ id: 'a', title: 'Fix', agent_id: 'claude', worktree: { path: '/w' } }, { id: 'b', title: '', agent_id: 'codex' }, { id: 'c', title: 'Idle', agent_id: 'cursor' }];
  const rows = usage.compareRows(sessions, { a: view('claude', 'Claude answer', [{ path: 'a.ts', status: 'modified' }]), b: view('codex', 'Codex answer', [], 'error') });
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.finalText, r.changedFiles, r.hasWorktree]), [['a', 'done', 'Claude answer', 1, true], ['b', 'error', 'Codex answer', 0, false], ['c', 'idle', '', 0, false]]);
  assert.equal(rows[0].durationMs, 4000);
  assert.equal(rows[0].usage.cost, 0.25);
  assert.equal(rows[1].title, 'New session');
  assert.equal(rows[2].durationMs, null);
});

test('undo toasts, snooze rules and snooze presets', async () => {
  const updates = [], toasts = [];
  const meta = (extra = {}) => ({ id: 's', project_path: '/p', status: 'idle', archived: false, pinned: false, title: 'S', ...extra });
  const module = await loadChat({
    './ipc': { chatUpdateSession: async (id, patch) => { updates.push([id, patch]); return meta(patch); } },
    '../components/ui': { toast: (message, kind, opts) => toasts.push([message, opts?.actionLabel]) },
  });
  const snooze = await loadFrontend('../src/lib/snooze.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async (_key, fallback) => fallback, writePref() {} },
  });
  module.setChat('sessions', [meta()]);
  await module.pinSession('s', true);
  assert.deepEqual(toasts.at(-1), ['Session pinned', 'Undo']);
  assert.equal(await module.undoLast(), true);
  assert.deepEqual(updates.map((u) => u[1]), [{ pinned: true }, { pinned: false }]);
  assert.equal(toasts.length, 1, 'undoing does not offer another undo');
  assert.equal(await module.undoLast(), false);
  // An undo older than five seconds is gone.
  module.registerUndo('Old', () => { updates.push('ran'); }, Date.now() - 6000);
  assert.equal(await module.undoLast(), false);
  assert.ok(!updates.includes('ran'));

  const now = 1_000_000;
  assert.equal(module.isSnoozed({ snoozed_until: now + 5, status: 'idle' }, now, false), true);
  assert.equal(module.isSnoozed({ snoozed_until: now - 5, status: 'idle' }, now, false), false, 'expired');
  assert.equal(module.isSnoozed({ snoozed_until: now + 5, status: 'idle' }, now, true), false, 'needs input wakes it');
  assert.equal(module.isSnoozed({ snoozed_until: now + 5, status: 'error' }, now, false), false, 'a failed run wakes it');
  assert.equal(module.isSnoozed({ snoozed_until: null, status: 'idle' }, now, false), false);

  const wed = new Date(2026, 10, 4, 14, 30); // Wednesday
  const presets = snooze.snoozePresets(wed).map((p) => [p.label, new Date(p.until)]);
  assert.equal(presets[0][1].getTime(), wed.getTime() + 3_600_000);
  assert.deepEqual([presets[2][1].getDate(), presets[2][1].getHours()], [5, 9]);
  assert.deepEqual([presets[3][1].getDay(), presets[3][1].getDate(), presets[3][1].getHours()], [1, 9, 9]);
  const mon = new Date(2026, 10, 9, 8, 0);
  assert.equal(new Date(snooze.snoozePresets(mon)[3].until).getDate(), 16, 'next Monday is a week away on a Monday');

  // Settings → Chat → Snooze options: custom, sorted, invalid and passed choices.
  assert.equal(snooze.humanizeSnoozeMinutes(30), '30 minutes');
  assert.equal(snooze.humanizeSnoozeMinutes(60), '1 hour');
  assert.equal(snooze.humanizeSnoozeMinutes(90), '1.5 hours');
  assert.equal(snooze.humanizeSnoozeMinutes(2880), '2 days');
  snooze.setSnoozeOptions([
    { kind: 'at', day: 'weekday', weekday: 3, time: '12:00' },
    { kind: 'after', minutes: 30 },
    { kind: 'at', day: 'today', weekday: 1, time: '23:59' },
  ]);
  const custom = snooze.snoozePresets(wed);
  assert.deepEqual(custom.map((preset) => preset.label.split(' ')[0]), ['30', 'Today', 'Next'], 'sorted soonest first');
  assert.equal(new Date(custom[2].until).getDate(), 11, 'the next Wednesday, not today');
  snooze.setSnoozeOptions([{ kind: 'after', minutes: 0 }, { kind: 'after', minutes: 15 }]);
  assert.deepEqual(snooze.snoozeOptions(), [{ kind: 'after', minutes: 15 }], 'invalid choices are dropped');
  snooze.setSnoozeOptions([]);
  assert.equal(snooze.snoozeOptions().length, 1, 'an empty list keeps the previous options');
  snooze.setSnoozeOptions([{ kind: 'at', day: 'today', weekday: 1, time: '10:00' }]);
  assert.deepEqual(snooze.snoozePresets(wed), [], 'a passed today time is hidden');
  snooze.resetSnoozeOptions();
  assert.equal(snooze.snoozeOptions().length, 4, 'reset restores the defaults');
  assert.equal(snooze.resolveSnoozeOption({ kind: 'at', day: 'tomorrow', weekday: 1, time: '09:00' }, wed.getTime()), new Date(2026, 10, 5, 9, 0).getTime());

  // Snoozing hides a session from the groups and wakes it when it needs input.
  module.setChat('sessions', [meta({ snoozed_until: Date.now() + 60_000 }), meta({ id: 't', snoozed_until: Date.now() + 60_000, status: 'error' }), meta({ id: 'u', hidden: true })]);
  module.setSnoozeClock(Date.now());
  const ids = module.sessionGroups({ includeArchived: false, query: '', group: 'date', filter: null }).flatMap((g) => g.sessions.map((x) => x.id));
  assert.deepEqual(ids, ['t'], 'snoozed and side-question sessions leave the list; the failed one returns');
  assert.deepEqual(module.snoozedSessions().map((x) => x.id), ['s']);
});

test('prompt stash keeps the newest twenty and restores by id', async () => {
  const saved = [];
  const stash = await loadFrontend('../src/lib/stash.ts', { 'solid-js': solid, './appPrefs': { readPref: async () => [], writePref: (_k, v) => saved.push(v) } });
  const make = (n) => ({ id: `s${n}`, text: `t${n}`, attachments: [], ts: n });
  let list = [];
  for (let n = 0; n < 25; n++) list = stash.pushStash(list, make(n));
  assert.equal(list.length, 20);
  assert.equal(list[0].id, 's24');
  assert.deepEqual(stash.removeStash(list, 's24').map((s) => s.id).slice(0, 2), ['s23', 's22']);
  assert.equal(stash.stashDraft('  ', []), false, 'an empty draft is not stashed');
  assert.equal(stash.stashDraft('first', []), true);
  assert.equal(stash.stashDraft('second', [{ path: '/a.png', name: 'a.png', kind: 'image' }]), true);
  assert.deepEqual(stash.stashes().map((s) => s.text), ['second', 'first']);
  const second = stash.takeStash();
  assert.equal(second.text, 'second');
  assert.equal(second.attachments.length, 1);
  assert.equal(stash.takeStash('missing'), undefined);
  assert.equal(stash.takeStash('nope'), undefined);
  assert.equal(stash.takeStash().text, 'first');
  assert.equal(stash.takeStash(), undefined);
  assert.ok(saved.length >= 4, 'every change is persisted');
});

test('large pastes become attachments and UTF-8 survives the base64 hop', async () => {
  const attachments = await loadFrontend('../src/lib/attachments.ts', {
    'solid-js': solid, '@tauri-apps/api/path': {}, './ipc': {}, './store': {}, '../components/ui': {}, './openIn': {},
  });
  assert.equal(attachments.shouldAttachPaste('x'.repeat(32 * 1024 - 1)), false);
  assert.equal(attachments.shouldAttachPaste('x'.repeat(32 * 1024)), true);
  assert.equal(attachments.shouldAttachPaste('é'.repeat(16 * 1024)), true, 'the limit counts bytes, not characters');
  const text = 'héllo wörld ✓ '.repeat(3000);
  assert.equal(Buffer.from(attachments.utf8ToBase64(text), 'base64').toString('utf8'), text);
  assert.equal(attachments.utf8ToBase64(''), '');
});

test('minimap items, nearest tick and the first unread message', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const user = (id, text) => ({ id, role: 'user', text, agentId: 'claude', ts: 0, attachments: [] });
  const assistant = (id, startedAt) => ({ id, role: 'assistant', agentId: 'claude', blocks: [], status: 'done', changedFiles: [], startedAt });
  const long = Array.from({ length: 6 }, (_, i) => [user(`u${i}`, i === 2 ? 'Third prompt\nwith a second line' : `Prompt ${i}`), assistant(`a${i}`, 100 + i * 10)]).flat();
  const items = transcript.minimapItems(long);
  assert.equal(items.length, 6);
  assert.deepEqual([items[2].label, items[2].index, items[5].index], ['Third prompt', 4, 10]);
  assert.deepEqual(transcript.minimapItems(long.slice(0, 8)), [], 'short conversations get no minimap');
  assert.deepEqual(transcript.minimapItems([...long.slice(0, 2), user('x', '   ')].slice(0, 3), 1).map((i) => i.label), ['Prompt 0', 'Attachment']);
  assert.equal(transcript.nearestMinimapIndex([0, 400, 900, 1500], 950), 2);
  assert.equal(transcript.nearestMinimapIndex([200, 400], 50), 0);
  assert.equal(transcript.nearestMinimapIndex([], 50), 0);
  assert.equal(transcript.firstUnreadId(long, 125), 'a3');
  assert.equal(transcript.firstUnreadId(long, undefined), null);
  assert.equal(transcript.firstUnreadId(long, 9999), null);
  assert.equal(transcript.firstUnreadId(long, 0), 'a0', 'something precedes the first reply, so a marker is shown');
  assert.equal(transcript.firstUnreadId([assistant('only', 50)], 0), null, 'nothing before it: no marker');
});

test('visits mark what is new, edit-from-here branches before a prompt, and /btw asks read-only in a hidden branch', async () => {
  const forks = [], sends = [], added = [], writes = [];
  const base = { project_path: '/project', cwd: '/project', agent_id: 'claude', native_ids: {}, mode: 'auto_edit', yolo: false, status: 'idle', archived: false, pinned: false };
  const module = await loadChat({
    './ipc': {
      chatForkSession: async (...args) => { forks.push(args); return { ...base, id: `fork-${forks.length}`, title: 'Fork', hidden: args[3] === true }; },
      chatSend: async (args) => { sends.push(args); return 'turn'; },
      chatListSessions: async () => [], chatLoadTranscript: async () => [], chatRuntimeState: async () => runtime(),
      onChatEntry: async () => () => {}, openProject: async () => ({ path: '/project' }),
    },
    './store': { store: { agents: [{ id: 'claude', installed: true }], currentProject: { path: '/project' } }, setStore: (...args) => { writes.push(args); }, bumpGitStatus() {} },
    './appPrefs': { writePref: (...args) => writes.push(args), readPref: async (_k, fallback) => fallback },
    './attachments': { addAttachments: (items) => added.push(...items) },
    '../components/ui': { toast() {}, confirmDialog: async () => true },
  });
  const turn = (n, text) => [
    { kind: 'user', ts: n * 100, agent_id: 'claude', text, attachments: n === 2 ? [{ path: '/a.png', name: 'a.png', kind: 'image' }] : [] },
    event({ type: 'turn_started', turn_id: `t${n}`, agent_id: 'claude' }, n * 100 + 1),
    event({ type: 'text', delta: `answer ${n}` }, n * 100 + 2),
    event({ type: 'turn_ended', turn_id: `t${n}`, status: 'done', changed_files: [] }, n * 100 + 3),
  ];
  const view = module.reduceTranscript([...turn(1, 'first'), ...turn(2, 'second')]);
  module.setChat('sessions', [{ ...base, id: 'src', title: 'Src' }]);
  module.setChat('views', 'src', view);
  module.setChat('activeId', 'src');

  // Leaving a session remembers the time; returning marks what happened after it.
  module.markLeft('src', 150);
  module.markReturned('src');
  assert.equal(module.chat.unreadFrom.src, 150);
  module.markReturned('never-seen');
  assert.equal(module.chat.unreadFrom['never-seen'], undefined);

  // Editing the second prompt forks at the first turn and restores prompt + files.
  const userIds = view.messages.filter((m) => m.role === 'user').map((m) => m.id);
  assert.equal(await module.editFromHere('src', userIds[1]), true);
  assert.deepEqual(forks[0].slice(0, 2), ['src', 't1']);
  assert.deepEqual(writes.filter((w) => w[0] === 'pendingPromptSeed').at(-1)[1], { text: 'second' });
  assert.deepEqual(added.map((a) => a.name), ['a.png']);
  assert.equal(await module.editFromHere('src', 'not-a-message'), false);

  // The side question forks hidden + keeps the worktree, then asks read-only on the same agent.
  module.setChat('activeId', 'src');
  assert.equal(await module.askSideQuestion('why did you pick that?'), true);
  assert.deepEqual(forks.at(-1), ['src', 't2', true, true]);
  const asked = sends.at(-1);
  assert.deepEqual([asked.agent_id, asked.mode, asked.yolo], ['claude', 'ask', false]);
  assert.match(asked.prompt, /Side question about this conversation[\s\S]*why did you pick that\?/);
  assert.equal(module.sideQuestion().question, 'why did you pick that?');
  assert.equal(await module.askSideQuestion('   '), false);
});

test('html fences get a Preview button and the preview document applies the sandbox policy first', async () => {
  const md = await loadMarkdown();
  const html = md.renderMarkdownLite('```html\n<h1>Hi</h1>\n```\n\n```js\nconst a = 1;\n```');
  assert.equal((html.match(/data-md-html-preview/g) ?? []).length, 1, 'only the html fence is previewable');
  assert.match(html, /data-md-html-preview>Preview<\/button><button type="button" data-md-copy>/);
  const doc = md.buildPreviewDocument('<h1>Chart</h1><script>1</script>', 'dark');
  assert.match(doc, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.equal((doc.match(/Content-Security-Policy/g) ?? []).length, 1);
  assert.match(doc, /color-scheme" content="dark"/);
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<h1>Chart</h1>'), 'the policy comes before the agent\'s markup');
  const full = md.buildPreviewDocument('<!doctype html><html lang="en"><head><title>x</title></head><body>b</body></html>', 'light');
  assert.ok(full.indexOf('Content-Security-Policy') < full.indexOf('<title>x</title>'));
  assert.match(full, /<html lang="en"><head><meta charset/);
  const noHead = md.buildPreviewDocument('<html><body>b</body></html>', 'light');
  assert.ok(noHead.indexOf('Content-Security-Policy') < noHead.indexOf('<body>b'));
  assert.equal(md.PREVIEW_CSP.includes('connect-src'), false);
  assert.match(md.PREVIEW_CSP, /default-src 'none'/);

  // A whole page renders as an inline Visual reply above its source; a snippet stays source-only.
  const page = md.renderMarkdownLite('```html\n<!doctype html><html><body><h1>"Hi"</h1></body></html>\n```');
  assert.equal((page.match(/class="md-visual"/g) ?? []).length, 1);
  assert.match(page, /data-md-visual="&quot;&lt;!doctype html/);
  assert.ok(page.indexOf('md-visual') < page.indexOf('md-code'), 'the page card comes before the source block');
  assert.match(page, /data-md-html-preview>Preview/, 'the source keeps its Preview button');
  assert.match(md.renderMarkdownLite('```html\n<html><body>x</body></html>\n```'), /class="md-visual"/, 'a closing </html> also marks a page');
  assert.equal(md.renderMarkdownLite('```html\n<h1>Hi</h1>\n```').includes('md-visual'), false, 'snippets do not get a card');
  assert.equal(md.visualSourceOf(JSON.stringify('<!doctype html><p>x</p>')), '<!doctype html><p>x</p>');
  assert.equal(md.visualSourceOf('not json'), null);
  assert.equal(md.visualSourceOf('{}'), null);
  assert.equal(md.visualSourceOf('""'), null);
  assert.equal(md.visualSourceOf(null), null);
});

test('usage aggregation groups rows, keeps null costs null and fills the daily series', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const usage = await loadFrontend('../src/lib/usage.ts', { './transcript': transcript });
  const day = (d, h = 12) => new Date(2026, 10, d, h).getTime();
  const rows = [
    { ts: day(3), agent: 'claude', model: 'opus', project: '/a', session: 's1', input: 100, output: 10, cost: 0.5 },
    { ts: day(3, 18), agent: 'codex', model: 'gpt', project: '/a', session: 's2', input: 50, output: 5, cost: null },
    { ts: day(5), agent: 'claude', model: 'opus', project: '/b', session: 's3', input: 10, output: 1, cost: 0.25 },
  ];
  const byAgent = usage.aggregateUsage(rows, 'agent');
  assert.deepEqual(byAgent.map((b) => [b.key, b.turns, b.input, b.cost]), [['claude', 2, 110, 0.75], ['codex', 1, 50, null]]);
  assert.deepEqual(usage.aggregateUsage(rows, 'project').map((b) => b.key), ['/a', '/b'], 'costliest first');
  assert.deepEqual(usage.aggregateUsage(rows, 'day').map((b) => b.key), ['2026-11-03', '2026-11-05']);
  const totals = usage.usageTotals(rows);
  assert.deepEqual([totals.turns, totals.input, totals.output, totals.cost], [3, 160, 16, 0.75]);
  assert.deepEqual([usage.usageTotals([]).turns, usage.usageTotals([]).cost], [0, null]);
  const series = usage.dailySeries(rows, 5, day(7));
  assert.deepEqual(series.map((b) => b.key), ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
  assert.deepEqual(series.map((b) => b.turns), [2, 0, 1, 0, 0]);

  // Drill-down: keys, row filtering and the per-model metric.
  assert.equal(usage.usageGroupKey(rows[0], 'model'), 'opus');
  assert.equal(usage.usageGroupKey(rows[0], 'project'), '/a');
  assert.deepEqual(usage.filterUsageRows(rows, 'agent', 'claude').map((r) => r.session), ['s1', 's3']);
  assert.deepEqual(usage.filterUsageRows(rows, 'model', 'gpt').map((r) => r.session), ['s2']);
  assert.deepEqual(usage.filterUsageRows(rows, 'agent', 'nobody'), []);
  const claude = byAgent[0];
  assert.equal(usage.usageMetricValue(claude, 'tokens'), 121);
  assert.equal(usage.usageMetricValue(claude, 'cost'), 0.75);
  const perMillion = usage.usagePerMillion(claude);
  assert.ok(Math.abs(perMillion - (0.75 / 121) * 1_000_000) < 0.001);
  assert.equal(usage.usagePerMillion(byAgent[1]), null, 'unknown cost has no rate');
  assert.equal(usage.usagePerMillion({ key: 'x', input: 0, output: 0, cost: 1, turns: 1 }), null, 'no tokens, no rate');
  assert.equal(usage.usageMetricValue({ key: 'x', input: 1, output: 2, cost: null, turns: 1 }, 'cost'), 0, 'missing cost counts as zero in the chart');

  // Custom model prices estimate only rows that reported no cost.
  const prices = new Map([['gpt', { input: 2, output: 8 }]]);
  const priceOf = (model) => prices.get(model) ?? null;
  assert.equal(usage.estimatedCost(1_000_000, 500_000, { input: 3, output: 15 }), 10.5);
  const estimated = usage.aggregateUsage(rows, 'agent', priceOf);
  const codex = estimated.find((bucket) => bucket.key === 'codex');
  assert.equal(codex.estimated, true);
  assert.ok(Math.abs(codex.cost - ((50 / 1_000_000) * 2 + (5 / 1_000_000) * 8)) < 1e-12);
  assert.equal(estimated.find((bucket) => bucket.key === 'claude').estimated, undefined, 'reported cost is never marked estimated');
  const pricedTotals = usage.usageTotals(rows, priceOf);
  assert.equal(pricedTotals.estimated, true);
  assert.ok(Math.abs(pricedTotals.cost - (0.75 + codex.cost)) < 1e-12);
  assert.deepEqual(usage.aggregateUsage(rows, 'agent').map((bucket) => bucket.cost), [0.75, null], 'no price leaves cost unknown');
  assert.equal(usage.dailySeries(rows, 5, day(7), priceOf)[0].estimated, true);
});

test('model prices validate, persist and resolve case-insensitively', async () => {
  let stored = {};
  const saved = [];
  const mod = await loadFrontend('../src/lib/modelPrices.ts', {
    'solid-js': solid,
    './appPrefs': {
      readPref: async () => stored,
      writePref: (_key, value) => { saved.push(value); stored = value; },
    },
  });
  assert.equal(mod.priceForModel('claude'), null);
  assert.equal(mod.setModelPrice('claude', { input: 3, output: 15 }), true);
  assert.deepEqual(saved.at(-1), { claude: { input: 3, output: 15 } });
  assert.deepEqual(mod.priceForModel('claude'), { input: 3, output: 15 });
  assert.deepEqual(mod.priceForModel('CLAUDE'), { input: 3, output: 15 }, 'model ids match case-insensitively');
  assert.equal(mod.setModelPrice('claude', { input: 3, output: 15 }), false, 'unchanged prices do not persist');
  assert.equal(saved.length, 1);
  assert.equal(mod.setModelPrice('', { input: 1, output: 1 }), false);
  assert.equal(mod.setModelPrice('bad', { input: -1, output: 1 }), false);
  assert.equal(mod.setModelPrice('bad', { input: 1, output: Number.NaN }), false);
  assert.deepEqual(mod.parsePrice('0.5', '2'), { input: 0.5, output: 2 });
  assert.equal(mod.parsePrice('', '2'), null);
  assert.deepEqual(mod.parsePrice('1,5', '0'), { input: 1.5, output: 0 }, 'comma decimals are accepted');
  assert.equal(mod.cleanRate('abc'), null);
  mod.setModelPrice('free', { input: 0, output: 0 });
  assert.deepEqual(mod.priceForModel('free'), { input: 0, output: 0 });
  mod.setModelPrice('claude', null);
  assert.equal(mod.priceForModel('claude'), null);
  assert.equal(mod.setModelPrice('never-saved', null), false, 'removing an unknown model is a no-op');
  mod.resetModelPrices();
  assert.deepEqual(saved.at(-1), {});

  // Hydration keeps valid entries, drops invalid ids/rates and non-objects.
  stored = { good: { input: 1, output: 2 }, bad: { input: 'x', output: 2 }, '': { input: 1, output: 1 }, zero: { input: 0, output: 0 }, text: 'nope' };
  await mod.hydrateModelPrices();
  assert.deepEqual(Object.keys(mod.modelPrices()).sort(), ['good', 'zero']);
  assert.deepEqual(mod.priceForModel('good'), { input: 1, output: 2 });
});

test('accent colors normalize, stay readable and import from VS Code themes', async () => {
  const f = await motionFixture({ accent: '#ABC' });
  try {
    const { layout } = f;
    assert.equal(layout.layout.accent, '#aabbcc', 'a saved short color is expanded');
    assert.deepEqual(['#4C8DFF', '4c8dff', '#fff', '#12345678', 'blue', '#12', '', null].map((v) => layout.normalizeHex(v)), ['#4c8dff', '#4c8dff', '#ffffff', '#123456', null, null, null, null]);
    assert.equal(layout.contrastText('#ffffff'), '#0b1411');
    assert.equal(layout.contrastText('#54e0ba'), '#0b1411');
    assert.equal(layout.contrastText('#1a237e'), '#ffffff');
    const dark = layout.accentTokens('#4c8dff', 'dark');
    const light = layout.accentTokens('#4c8dff', 'light');
    assert.deepEqual([dark.accent, dark.rgb, light.soft], ['#4c8dff', '76, 141, 255', '#4c8dff']);
    assert.notEqual(dark.soft, dark.accent, 'dark themes get a lighter soft variant');
    assert.equal(dark.soft, '#' + [76, 141, 255].map((c) => Math.round(c + (255 - c) * 0.28).toString(16).padStart(2, '0')).join(''));

    const theme = `{
      // a comment with "quotes" and a url https://example.com
      "name": "Night // Owl", "type": "dark",
      /* block */ "colors": { "editor.background": "#011627", "focusBorder": "#5f7e97", "button.background": "#7e57c2",
      },
    }`;
    assert.deepEqual({ ...layout.parseVsCodeAccent(theme) }, { accent: '#7e57c2', scheme: 'dark', name: 'Night // Owl' });
    assert.equal(layout.parseVsCodeAccent('{"colors":{"focusBorder":"#abc"},"type":"light"}').scheme, 'light');
    assert.equal(layout.parseVsCodeAccent('{"colors":{"editor.background":"#000"}}'), null);
    assert.equal(layout.parseVsCodeAccent('not json'), null);

    const style = {};
    style.setProperty = (n, v) => { style[n] = v; }; style.removeProperty = (n) => { delete style[n]; };
    f.document.documentElement.style = style;
    f.document.documentElement.getAttribute = () => 'dark';
    assert.equal(layout.setAccent('#ff6fa8'), true);
    assert.equal(style['--accent'], '#ff6fa8');
    assert.equal(style['--accent-rgb'], '255, 111, 168');
    assert.equal(layout.layout.accent, '#ff6fa8');
    assert.equal(layout.setAccent('nope'), false);
    assert.equal(layout.layout.accent, '#ff6fa8', 'an invalid color changes nothing');
    layout.setAccent(null);
    assert.deepEqual(['--accent', '--accent-rgb', '--accent-soft', '--fg-on-accent'].map((n) => n in style), [false, false, false, false]);
  } finally { f.dispose(); }
});

test('idle sessions settle only when nothing needs them', async () => {
  const toasts = [], updates = [];
  const module = await loadChat({
    './ipc': { chatUpdateSession: async (id, patch) => { updates.push([id, patch]); return { id, ...patch }; } },
    '../components/ui': { toast: (...a) => toasts.push(a) },
  });
  const day = 86_400_000, now = 100 * day;
  const s = (id, extra = {}) => ({ id, project_path: '/p', archived: false, pinned: false, updated_at: now - 10 * day, ...extra });
  const sessions = [
    s('idle'), s('fresh', { updated_at: now - day }), s('pinned', { pinned: true }), s('archived', { archived: true }),
    s('snoozed', { snoozed_until: now + day }), s('goal', { goal: { status: 'active' } }), s('paused', { goal: { status: 'paused' } }),
    s('child', { parent_id: 'idle' }), s('hidden', { hidden: true }), s('busy'), s('waiting'), s('scheduled'),
    s('opted-out', { settle_disabled: true }),
  ];
  const busy = { running: (id) => id === 'busy', needsInput: (id) => id === 'waiting', scheduled: new Set(['scheduled']) };
  assert.deepEqual(module.settleCandidates(sessions, now, 7, busy).map((x) => x.id), ['idle', 'paused']);
  assert.deepEqual(module.settleCandidates(sessions, now, 0, busy), [], 'off by default');
  assert.deepEqual(module.settleCandidates(sessions, now, 30, busy), []);
});

test('shift-click selection spans the visible order and clamps to known ids', async () => {
  const module = await loadChat();
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(module.selectionRange(order, null, 'b'), ['b'], 'no anchor selects only the target');
  assert.deepEqual(module.selectionRange(order, 'a', 'c'), ['a', 'b', 'c']);
  assert.deepEqual(module.selectionRange(order, 'd', 'b'), ['b', 'c', 'd'], 'works upward too');
  assert.deepEqual(module.selectionRange(order, 'c', 'c'), ['c']);
  assert.deepEqual(module.selectionRange(order, 'a', 'missing'), ['missing']);
  assert.deepEqual(module.selectionRange([], 'a', 'b'), ['b']);
});

test('keeping a side chat unhides it without touching the conversation', async () => {
  const updates = [];
  const module = await loadChat({
    './ipc': {
      chatUpdateSession: async (id, patch) => { updates.push([id, patch]); return { id, project_path: '/p', hidden: false, status: 'idle', archived: false, pinned: false }; },
    },
    '../components/ui': { toast: () => {} },
  });
  module.setChat('sessions', [{ id: 'side', project_path: '/p', hidden: true, status: 'idle', archived: false, pinned: false }]);
  assert.equal(await module.keepSideChat('side'), true);
  assert.deepEqual(updates, [['side', { hidden: false }]]);
  assert.equal(module.chat.sessions[0].hidden, false);
});

test('restarting an agent session calls the backend and refuses while a turn runs', async () => {
  const calls = [];
  const module = await loadChat({
    './ipc': {
      chatRestartSession: async (id) => { calls.push(id); return { id, project_path: '/p', status: 'idle', archived: false, pinned: false, title: 'S' }; },
    },
    '../components/ui': { toast: () => {} },
  });
  module.setChat('sessions', [{ id: 's', project_path: '/p', status: 'idle', archived: false, pinned: false, title: 'S' }]);
  assert.equal(await module.restartAgentSession('s'), true);
  assert.deepEqual(calls, ['s']);
  assert.equal(module.chat.sessions.find((s) => s.id === 's').title, 'S', 'the transcript metadata is kept');
  module.setChat('views', 's', { loaded: true, running: true, messages: [] });
  assert.equal(await module.restartAgentSession('s'), false, 'a running turn must stop first');
  assert.deepEqual(calls, ['s']);
});

test('notification mutes persist and ignore unknown sessions', async () => {
  let stored = ['a', 'gone'];
  const saved = [];
  const mod = await loadFrontend('../src/lib/muted.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async () => stored, writePref: (_key, value) => { saved.push(value); stored = value; } },
  });
  assert.equal(mod.isMuted('a'), false);
  mod.setSessionMuted('a', true);
  mod.setSessionMuted('a', true);
  assert.deepEqual(saved.at(-1), ['a'], 'repeated mutes do not persist again');
  assert.equal(mod.isMuted('a'), true);
  assert.equal(mod.mutedCount(), 1);
  mod.toggleSessionMuted('b');
  assert.deepEqual([...mod.mutedSessions()].sort(), ['a', 'b']);
  mod.setSessionMuted('a', false);
  assert.equal(mod.isMuted('a'), false);
  stored = ['x', 'gone'];
  await mod.hydrateMuted(new Set(['x', 'y']));
  assert.deepEqual([...mod.mutedSessions()], ['x'], 'sessions that no longer exist are dropped');
});

test('manual unread marks persist, survive unknown sessions and clear explicitly', async () => {
  const saved = [];
  let stored = ['a', 'gone'];
  const mod = await loadFrontend('../src/lib/unread.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async () => stored, writePref: (_key, value) => { saved.push(value); stored = value; } },
  });
  assert.equal(mod.isManuallyUnread('a'), false);
  mod.markUnread('a');
  mod.markUnread('b');
  mod.markUnread('a');
  assert.deepEqual([...mod.manuallyUnread()], ['a', 'b']);
  assert.deepEqual(saved.at(-1), ['a', 'b']);
  assert.equal(mod.manualUnreadCount(), 2);
  mod.markRead('a');
  assert.deepEqual([...mod.manuallyUnread()], ['b']);
  mod.markManyUnread(['b', 'c']);
  assert.deepEqual([...mod.manuallyUnread()], ['b', 'c']);
  mod.clearManualUnread();
  assert.equal(mod.manualUnreadCount(), 0);
  assert.equal(saved.length, 5);
  mod.markRead('not-there');
  assert.equal(saved.length, 5, 'no-ops do not persist');
  stored = ['x', 'gone'];
  await mod.hydrateUnread(new Set(['x', 'y']));
  assert.deepEqual([...mod.manuallyUnread()], ['x'], 'sessions that no longer exist are dropped');
});

test('archiving and deleting a session clear its unread mark', async () => {
  const reads = [];
  const module = await loadChat({
    './unread': { markRead: (id) => reads.push(id) },
    './ipc': {
      chatUpdateSession: async (id, patch) => ({ id, project_path: '/p', archived: false, pinned: false, status: 'idle', ...patch }),
      chatDeleteSession: async () => {},
    },
  });
  module.setChat('sessions', [{ id: 's', project_path: '/p', archived: false, pinned: false, status: 'idle' }]);
  await module.archiveSession('s', true, false);
  assert.deepEqual(reads, ['s']);
  await module.deleteSession('s');
  assert.deepEqual(reads, ['s', 's']);
});

test('thread details rows store only deviations from their defaults', async () => {
  const saved = [];
  const mod = await loadFrontend('../src/lib/threadDetails.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async (_key, fallback) => fallback, writePref: (_key, value) => saved.push(value) },
  });
  assert.deepEqual(Object.values(mod.resolveThreadDetailsVisibility(undefined)), [true, true, true, true, true, true, true, true]);
  assert.equal(mod.threadDetailsVisibility().usage, true);
  mod.setThreadDetailsItem('usage', false);
  assert.deepEqual(saved.at(-1), { usage: false });
  assert.equal(mod.threadDetailsVisibility().usage, false);
  assert.equal(mod.isDefaultThreadDetailsVisibility(saved.at(-1)), false);
  assert.deepEqual(mod.withThreadDetailsItem({ branch: false, stale: true }, 'usage', false), { branch: false, usage: false }, 'unknown ids are dropped');
  mod.setThreadDetailsItem('usage', true);
  assert.deepEqual(saved.at(-1), {}, 'matching the default removes the override');
  assert.equal(mod.isDefaultThreadDetailsVisibility({}), true);
  assert.deepEqual(mod.resolveThreadDetailsVisibility({ branch: false, usage: 'nope' }), { workspace: true, branch: false, linkedPrs: true, lineage: true, session: true, activity: true, sideChats: true, usage: true });
  mod.setThreadDetailsItem('activity', false);
  mod.resetThreadDetails();
  assert.deepEqual(saved.at(-1), {});
  assert.equal(mod.threadDetailsVisibility().activity, true);
});

test('custom snooze resolves future local times and positive durations', async () => {
  const snooze = await loadFrontend('../src/lib/snooze.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async (_key, fallback) => fallback, writePref() {} },
  });
  const now = new Date(2026, 4, 20, 12, 0, 0).getTime(); // 2026-05-20 12:00 local
  assert.equal(snooze.resolveSnoozeDate('2026-05-20', '12:01', now), new Date(2026, 4, 20, 12, 1).getTime());
  assert.equal(snooze.resolveSnoozeDate('2026-05-21', '09:00', now), new Date(2026, 4, 21, 9, 0).getTime());
  assert.equal(snooze.resolveSnoozeDate('2026-05-20', '11:59', now), null, 'the past is refused');
  assert.equal(snooze.resolveSnoozeDate('2026-02-31', '09:00', now), null, 'impossible dates are refused');
  assert.equal(snooze.resolveSnoozeDate('', '', now), null);
  assert.equal(snooze.resolveSnoozeDate('2026-05-20', '24:00', now), null);
  assert.equal(snooze.resolveSnoozeDuration('2', 'hours', now), now + 2 * 3_600_000);
  assert.equal(snooze.resolveSnoozeDuration('0.5', 'hours', now), now + 1_800_000);
  assert.equal(snooze.resolveSnoozeDuration('3', 'days', now), now + 3 * 86_400_000);
  assert.equal(snooze.resolveSnoozeDuration('0', 'hours', now), null);
  assert.equal(snooze.resolveSnoozeDuration('-2', 'hours', now), null);
  assert.equal(snooze.resolveSnoozeDuration('0.001', 'minutes', now), null, 'shorter than a minute is refused');
  assert.equal(snooze.resolveSnoozeDuration('abc', 'days', now), null);
  assert.equal(snooze.snoozeDateValue(new Date(2026, 0, 5, 9, 7)), '2026-01-05');
  assert.equal(snooze.snoozeTimeValue(new Date(2026, 0, 5, 9, 7)), '09:07');
});

test('swipes, monograms, alerts and reopening archived sessions', async () => {
  const shortcuts = await loadFrontend('../src/lib/shortcuts.ts', {
    'solid-js': solid, './chat': {}, './layout': {}, './palette': {}, './store': {},
  });
  const state = () => ({ sum: 0, at: 0, lockedUntil: 0 });
  let s = state();
  assert.equal(shortcuts.swipeStep(s, -60, 2, 0), null);
  assert.equal(shortcuts.swipeStep(s, -60, 3, 50), null);
  assert.equal(shortcuts.swipeStep(s, -60, 1, 100), 'back', 'a deliberate swipe right goes back');
  assert.equal(shortcuts.swipeStep(s, -200, 0, 300), null, 'cooldown after a swipe');
  assert.equal(shortcuts.swipeStep(s, 200, 0, 900), 'forward');
  s = state();
  assert.equal(shortcuts.swipeStep(s, 100, 100, 0), null, 'diagonal scrolling is not a swipe');
  assert.equal(shortcuts.swipeStep(s, 80, 0, 10), null);
  assert.equal(shortcuts.swipeStep(s, 80, 0, 500), null, 'a slow drift does not add up');
  assert.equal(shortcuts.swipeStep(state(), 0, 0, 0), null);

  const f = await motionFixture({});
  try {
    const a = f.layout.projectMonogram('  flip-flopper'); const b = f.layout.projectMonogram('flip-flopper');
    assert.deepEqual([a.letter, a.hue === b.hue, a.hue >= 0 && a.hue < 360], ['F', true, true]);
    assert.equal(f.layout.projectMonogram('…').letter, '?');
    assert.equal(f.layout.projectMonogram('éclair').letter, 'É');
    assert.notEqual(f.layout.projectMonogram('alpha').hue, f.layout.projectMonogram('omega').hue);
    // Custom monograms: up to two letters and a hue override.
    assert.deepEqual(f.layout.projectMonogram('flip', { letter: 'ff', hue: 123 }), { letter: 'FF', hue: 123 });
    assert.deepEqual(f.layout.projectMonogram('flip', { letter: 'xy' }), { letter: 'XY', hue: f.layout.projectMonogram('flip').hue });
    assert.deepEqual(f.layout.sanitizeProjectIcon({ letter: 'a-b!9', hue: 400 }), { letter: 'AB' });
    assert.deepEqual(f.layout.sanitizeProjectIcon({ hue: 12.6 }), { hue: 13 });
    assert.equal(f.layout.sanitizeProjectIcon({ letter: '  ', hue: -1 }), null);
    assert.equal(f.layout.sanitizeProjectIcon('nope'), null);
    assert.deepEqual(f.layout.sanitizeProjectIcons({ '/a': { letter: 'x' }, '': { letter: 'y' }, '/b': { hue: 12.6 }, '/c': 'nope' }), { '/a': { letter: 'X' }, '/b': { hue: 13 } });
    f.layout.setProjectIcon('/p', { letter: 'zz', hue: 200 });
    assert.deepEqual(f.layout.layout.projectIcons['/p'], { letter: 'ZZ', hue: 200 });
    f.layout.setProjectIcon('/p', null);
    assert.equal('/p' in f.layout.layout.projectIcons, false);
  } finally { f.dispose(); }

  const md = await loadMarkdown();
  const html = md.renderMarkdownLite('> [!WARNING]\n> Do not **run** this.\n\n> plain quote\n\n> [!note] not an alert');
  assert.match(html, /<div class="md-alert md-alert-warning" role="note"><div class="md-alert-title">Warning<\/div>.*<strong>run<\/strong>/);
  assert.equal((html.match(/md-alert /g) ?? []).length, 1);
  assert.equal((html.match(/<blockquote>/g) ?? []).length, 2);

  const archived = (id) => ({ id, project_path: '/p', archived: true, status: 'idle' });
  const calls = [];
  const module = await loadChat({
    './ipc': { chatUpdateSession: async (id, patch) => { calls.push([id, patch]); return { id, project_path: '/p', status: 'idle', ...patch }; } },
    '../components/ui': { toast: (m) => calls.push(m) },
    './store': { store: { agents: [{ id: 'claude', installed: true }], currentProject: { path: '/p' } }, setStore() {}, bumpGitStatus() {} },
    './appPrefs': { writePref() {}, readPref: async (_k, d) => d },
  });
  module.setChat('sessions', [{ ...archived('a'), archived: false }, { ...archived('b'), archived: false }]);
  await module.archiveSession('a', true, false);
  await module.archiveSession('b', true, false);
  assert.equal(await module.reopenClosedSession(), true);
  assert.deepEqual(calls.filter((c) => Array.isArray(c)).at(-1), ['b', { archived: false }], 'the newest archived session returns first');
  assert.equal(module.chat.activeId, 'b');
});

test('terminal output yields clickable file references with lines', async () => {
  const md = await loadMarkdown();
  const refs = md.findFileReferences('error: src/lib/a.ts:42:7 failed, see ./b/c.rs:9. Also (docs/x.md) and C:\\proj\\f.ts:3 plus http://x.dev/a/b and plain.ts');
  assert.deepEqual(refs.map((r) => [r.path, r.line]), [['src/lib/a.ts', 42], ['./b/c.rs', 9], ['docs/x.md', null], ['C:\\proj\\f.ts', 3]]);
  const text = 'error: src/lib/a.ts:42:7 failed';
  assert.equal(text.slice(refs[0].start, refs[0].end), 'src/lib/a.ts:42:7');
  assert.deepEqual(md.findFileReferences('nothing to see here'), []);
});

test('font families are sanitized and applied in front of the built-in stacks', async () => {
  const f = await motionFixture({ uiFont: 'Inter; } body { color: red', codeFont: '  Fira  Code  ' });
  try {
    const { layout } = f;
    assert.equal(layout.layout.uiFont, 'Inter body color red', 'CSS punctuation is stripped');
    assert.equal(layout.layout.codeFont, 'Fira Code');
    assert.equal(layout.sanitizeFontFamily('<script>'), 'script');
    assert.equal(layout.sanitizeFontFamily('{};:"\''), null);
    assert.equal(layout.sanitizeFontFamily(42), null);
    assert.equal(layout.sanitizeFontFamily('x'.repeat(200)).length, 60);
    assert.equal(layout.fontStack('Fira Code', 'ui-monospace, monospace'), '"Fira Code", ui-monospace, monospace');
    assert.equal(layout.fontStack(null, 'ui-monospace'), 'ui-monospace');
    const style = {}; style.setProperty = (n, v) => { style[n] = v; }; style.removeProperty = (n) => { delete style[n]; };
    f.document.documentElement.style = style;
    globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--font-mono' ? 'Menlo, monospace' : 'system-ui') });
    layout.setFonts({ codeFont: 'JetBrains Mono' });
    assert.equal(style['--font-mono'], '"JetBrains Mono", Menlo, monospace');
    assert.equal(style['--font-sans'], '"Inter body color red", system-ui');
    layout.setFonts({ codeFont: '', uiFont: null });
    assert.deepEqual(['--font-mono' in style, '--font-sans' in style], [false, false]);
  } finally { f.dispose(); }
});

test('palette ranking remembers what you pick for a query and how often you open sessions', async () => {
  const palette = await loadFrontend('../src/lib/palette.ts', { 'solid-js': solid, './appPrefs': { readPref: async (_k, d) => d, writePref() {} } });
  const day = 86_400_000, now = 100 * day;
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  assert.deepEqual(palette.rankByPicks(items, 'x', palette.emptyHistory(), now).map((i) => i.id), ['a', 'b', 'c', 'd'], 'no history keeps the order');
  let history = palette.recordPick(palette.emptyHistory(), 'c', 'Fix Login ', now - 2 * day);
  history = palette.recordPick(history, 'd', '', now - day);
  history = palette.recordPick(history, 'd', '', now - day / 2);
  assert.deepEqual(palette.rankByPicks(items, 'fix login', history, now).map((i) => i.id), ['c', 'd', 'a', 'b'], 'the pick for this query comes first, then frequent ones');
  assert.deepEqual(palette.rankByPicks(items, 'other', history, now).map((i) => i.id), ['d', 'c', 'a', 'b']);
  assert.deepEqual(palette.rankByPicks(items, 'fix login', history, now + 40 * day).map((i) => i.id), ['a', 'b', 'c', 'd'], 'after weeks the query memory expires and old picks fade');
  let many = palette.emptyHistory();
  for (let i = 0; i < 120; i++) many = palette.recordPick(many, 'a', `q${i}`, now + i);
  assert.equal(Object.keys(many.byQuery).length, 80, 'query memory is capped');
  assert.equal(many.picks.a.n, 120);
});

test('changed files flatten into a collapsible folder tree', async () => {
  const model = await loadFrontend('../src/lib/diffModel.ts', {});
  const paths = ['src/lib/b.ts', 'README.md', 'src/lib/a.ts', 'src/ui/x.tsx', 'package.json'];
  const label = (rows) => rows.map((r) => `${' '.repeat(r.depth)}${r.kind === 'dir' ? r.name + '/' : r.name}`);
  assert.deepEqual(label(model.fileTreeRows(paths)), ['package.json', 'README.md', 'src/', ' lib/', '  a.ts', '  b.ts', ' ui/', '  x.tsx']);
  const collapsed = model.fileTreeRows(paths, (dir) => dir === 'src/lib');
  assert.deepEqual(label(collapsed), ['package.json', 'README.md', 'src/', ' lib/', ' ui/', '  x.tsx']);
  assert.deepEqual(label(model.fileTreeRows(paths, (dir) => dir === 'src')), ['package.json', 'README.md', 'src/']);
  assert.deepEqual(model.fileTreeRows([]), []);
});

test('settings search finds rows by title and keyword, title hits first', async () => {
  const settings = await loadFrontend('../src/lib/settings.ts', { 'solid-js': solid, './appPrefs': { readPref: async (_k, d) => d, writePref() {}, readLegacyBool: (_k, d) => d }, './ipc': {} });
  const titles = (q) => settings.searchSettings(settings.SETTINGS_INDEX, q).map((e) => e.title);
  assert.deepEqual(titles(''), []);
  assert.deepEqual(titles('proxy').slice(0, 2), ['Proxy', 'Proxy URL']);
  assert.ok(titles('proxy').includes('Bypass hosts'), 'keyword match');
  assert.deepEqual(titles('font size'), ['Code size', 'Fonts'].filter((t) => titles('font size').includes(t)).length ? titles('font size') : []);
  assert.equal(titles('font size')[0], 'Code size', 'every word in the title ranks first');
  assert.ok(titles('mask').includes('Secrets'));
  assert.deepEqual(titles('zzzz'), []);
  assert.ok(settings.SETTINGS_INDEX.every((e) => e.title && e.keywords), 'every entry is complete');
  assert.equal(new Set(settings.SETTINGS_INDEX.map((e) => e.title)).size, settings.SETTINGS_INDEX.length, 'titles are unique');
});

test('custom models are saved per agent and merged after catalog models', async () => {
  let saved = [];
  const mod = await loadFrontend('../src/lib/customModels.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async () => saved, writePref: (_key, value) => { saved = value; } },
  });
  assert.equal(mod.addCustomModel('codex', 'gpt-x'), true);
  assert.equal(mod.addCustomModel('codex', 'gpt-x'), true, 're-adding the same ID is idempotent');
  assert.equal(mod.customModelsFor('codex').length, 1);
  assert.equal(mod.addCustomModel('claude', 'opus-x'), true);
  assert.equal(mod.customModelsFor('codex').length, 1);
  assert.equal(mod.addCustomModel('', 'x'), false);
  assert.equal(mod.addCustomModel('codex', '   '), false);
  assert.deepEqual(mod.mergeModelChoices([{ id: 'a', label: 'A' }], mod.customModelsFor('codex')).map((model) => model.id), ['a', 'gpt-x']);
  assert.deepEqual(mod.mergeModelChoices([{ id: 'gpt-x', label: 'Catalog' }], mod.customModelsFor('codex')).map((model) => model.label), ['Catalog']);
  mod.removeCustomModel('codex', 'gpt-x');
  assert.equal(mod.customModelsFor('codex').length, 0);
  saved = [{ agentId: 'codex', id: '  x  ', addedAt: 5 }, { agentId: 'codex', id: 'x' }, { agentId: '', id: 'y' }, { agentId: 'claude', id: 7 }];
  await mod.hydrateCustomModels();
  assert.deepEqual(mod.customModels(), [{ agentId: 'codex', id: 'x', addedAt: 5 }], 'invalid and duplicate saved entries are dropped');
  saved = [];
  await mod.hydrateCustomModels();
  for (let index = 0; index < 24; index += 1) assert.equal(mod.addCustomModel('codex', `m-${index}`), true);
  assert.equal(mod.addCustomModel('codex', 'm-24'), false, 'per-agent limit holds');
});

test('auto-pull preferences resolve project overrides over the default', async () => {
  let stored = {};
  const writes = [];
  const mod = await loadFrontend('../src/lib/autoPull.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async () => stored, writePref: (_key, value) => { writes.push(value); stored = value; } },
  });
  assert.equal(mod.resolveAutoPull('/p'), false);
  mod.setAutoPullEnabled(true);
  assert.equal(mod.resolveAutoPull('/p'), true);
  assert.equal(mod.projectAutoPullOverride('/p'), null);
  mod.setProjectAutoPull('/p', false);
  assert.equal(mod.resolveAutoPull('/p'), false);
  assert.equal(mod.projectAutoPullOverride('/p'), false);
  mod.setProjectAutoPull('/p', null);
  assert.equal(mod.resolveAutoPull('/p'), true);
  mod.setAutoPullEnabled(false);
  mod.setProjectAutoPull('/other', true);
  assert.equal(mod.resolveAutoPull('/other'), true, 'the project override wins over the default');
  assert.deepEqual(writes.at(-1), { enabled: false, projects: { '/other': true } });
  stored = { enabled: 1, projects: { '/a': true, '/bad': 'yes', '': true, '/b': false } };
  await mod.hydrateAutoPull();
  assert.deepEqual(mod.autoPullPrefs(), { enabled: false, projects: { '/a': true, '/b': false } }, 'invalid saved values are dropped');
  assert.equal(mod.resolveAutoPull('/a'), true);
  assert.equal(mod.resolveAutoPull(null), false);
});

test('local server discovery normalizes and dedupes terminal URLs', async () => {
  const fakeTerminal = (lines) => ({ terminal: { buffer: { active: { length: lines.length, getLine: (index) => ({ translateToString: () => lines[index] }) } } } });
  let cached = null;
  const mod = await loadFrontend('../src/lib/localServers.ts', {
    './terminalCache': { getCachedTerminal: (id) => (id === 'tty' ? cached : undefined) },
  });
  const servers = mod.findLocalServers([
    'Local:   http://localhost:5173/',
    'Network: http://0.0.0.0:5173/',
    'API at 127.0.0.1:8787/api.',
    'docs: https://example.com',
    'ipv6 http://[::1]:3000/health',
    'dup http://localhost:5173/',
  ]);
  assert.deepEqual(servers.map((server) => server.url), ['http://localhost:5173', 'http://localhost:8787/api', 'http://localhost:3000/health']);
  assert.deepEqual(servers.map((server) => server.port), [5173, 8787, 3000]);
  assert.deepEqual(mod.findLocalServers(['nothing here', 'https://example.com:443']), []);
  assert.equal(mod.findLocalServers(Array.from({ length: 20 }, (_, i) => `http://localhost:${4000 + i}`)).length, 8);
  cached = fakeTerminal(['ready http://localhost:4000', 'http://localhost:4001']);
  assert.deepEqual(mod.terminalLocalServers('tty').map((server) => server.port), [4000, 4001]);
  assert.deepEqual(mod.terminalLocalServers('tty', 1).map((server) => server.port), [4001], 'window limits the scan');
  assert.deepEqual(mod.terminalLocalServers('missing'), []);
  cached = null;
  assert.deepEqual(mod.terminalLocalServers('tty'), []);
});

test('worktree cleanup removes only safe archived worktrees', async () => {
  const now = Date.now();
  const removed = [], updates = [], patched = [];
  const tree = (path, branch) => ({ path, branch, source_branch: 'main' });
  const sessions = [
    { id: 'old', project_path: '/p', archived: true, updated_at: 1, worktree: tree('/wt/old', 'b1') },
    { id: 'shared', project_path: '/p', archived: true, updated_at: 1, worktree: tree('/wt/shared', 'b2') },
    { id: 'active', project_path: '/p', archived: false, updated_at: now, worktree: tree('/wt/shared', 'b2') },
    { id: 'dirty', project_path: '/p', archived: true, updated_at: 1, worktree: tree('/wt/dirty', 'b3') },
    { id: 'broken', project_path: '/p', archived: true, updated_at: 1, worktree: tree('/wt/broken', 'b4') },
    { id: 'recent', project_path: '/p', archived: true, updated_at: now, worktree: tree('/wt/recent', 'b5') },
  ];
  const mod = await loadFrontend('../src/lib/worktreeCleanup.ts', {
    './chat': { chat: { sessions }, setChat: (...args) => patched.push(args) },
    './ipc': {
      getWorktreeStatus: async (path) => ({ dirty: path === '/wt/dirty' }),
      removeWorktree: async (...args) => { if (args[1] === '/wt/broken') throw new Error('locked'); removed.push(args); },
      chatUpdateSession: async (id, patch) => { updates.push([id, patch]); return { id, project_path: '/p', ...patch }; },
    },
  });
  const result = await mod.cleanupArchivedWorktrees(7, false, now);
  assert.deepEqual(result, { removed: 1, kept: 2, failed: 1, candidates: 4 });
  assert.deepEqual(removed, [['/p', '/wt/old', 'b1', false]], 'branches are kept');
  assert.deepEqual(updates, [['old', { worktree: null, cwd: '/p' }]]);
  assert.equal(patched.length, 1, 'the cleaned session is updated in the store');
});

test('manual session order keeps new sessions above arranged ones', async () => {
  const module = await loadChat();
  const s = (id, ts) => ({ id, project_path: '/p', updated_at: ts, archived: false, pinned: false, title: id });
  const list = [s('new', 9), s('b', 2), s('a', 1)];
  assert.deepEqual(module.applySessionOrder(list, ['a', 'b']).map((x) => x.id), ['new', 'a', 'b']);
  assert.deepEqual(module.applySessionOrder(list, []).map((x) => x.id), ['new', 'b', 'a'], 'no order keeps the existing order');
  assert.deepEqual(module.applySessionOrder(list, ['b']).map((x) => x.id), ['new', 'a', 'b'], 'unlisted sessions stay on top');
  assert.deepEqual(module.applySessionOrder([], ['x']), []);
});

test('the optional Working group collects running and waiting sessions below the pinned ones', async () => {
  const module = await loadChat({ './layout': { layout: { projectNames: {}, projectOrder: [], hiddenProjects: [], workingGroup: true } } });
  const meta = (id, extra = {}) => ({ id, title: id, project_path: '/p', archived: false, pinned: false, updated_at: 1, status: 'idle', ...extra });
  module.setChat('sessions', [meta('idle'), meta('busy', { status: 'running' }), meta('pin', { pinned: true }), meta('waits')]);
  module.setChat('views', 'busy', { messages: [], loaded: true, running: true });
  module.setChat('views', 'waits', { messages: [], loaded: true, running: false, runtime: { connected: true, pending: [{ id: 'q', kind: 'approval' }] } });
  const groups = module.sessionGroups({ includeArchived: false, query: '', group: 'date', filter: null });
  assert.equal(JSON.stringify(groups.map((g) => [g.key, g.sessions.map((s) => s.id)]).slice(0, 2)), JSON.stringify([['pinned', ['pin']], ['working', ['busy', 'waits']]]));
  assert.ok(!groups.slice(2).some((g) => g.sessions.some((s) => ['busy', 'waits'].includes(s.id))), 'working sessions leave the regular groups');
});

test('scratch sessions group together until turned into projects', async () => {
  const module = await loadChat({ './layout': { layout: { projectNames: {}, projectOrder: [], hiddenProjects: [], promotedScratch: ['/data/scratch/2026-11-05-keep-a1'] } } });
  const root = '/data/scratch';
  assert.equal(module.isScratchPath('/data/scratch/2026-11-05-x-ab12cd34', root, []), true);
  assert.equal(module.isScratchPath('/data/scratchpad/x', root, []), false, 'only folders inside the scratch root');
  assert.equal(module.isScratchPath('/data/scratch/2026-11-05-keep-a1', root, ['/data/scratch/2026-11-05-keep-a1']), false, 'promoted folders are regular projects');
  assert.equal(module.isScratchPath('/work/app', root, []), false);
  assert.equal(module.isScratchPath('/work/app', '', []), false, 'unknown root: nothing is scratch');
  assert.equal(module.isScratchPath('C:\\data\\scratch\\x', 'C:\\data\\scratch', []), true);
});

test('MCP app events attach their HTML resource to the completed tool block', async () => {
  const transcript = await loadFrontend('../src/lib/transcript.ts', {});
  const app = {
    server: 'weather', tool: 'forecast', resource_uri: 'ui://weather/app', title: 'Weather card',
    html: '<!doctype html><html><body>sunny</body></html>', csp: null, permissions: null, prefers_border: false,
  };
  const view = transcript.reduceTranscript([
    event({ type: 'turn_started', turn_id: 't', agent_id: 'claude' }, 1),
    event({ type: 'tool_call', id: 'tool-1', kind: 'other', title: 'Weather', input: { city: 'Paris' } }, 2),
    event({ type: 'tool_result', id: 'tool-1', ok: true, output: 'sunny' }, 3),
    event({ type: 'mcp_app', tool_id: 'tool-1', app }, 4),
    event({ type: 'turn_ended', turn_id: 't', status: 'done', changed_files: [] }, 5),
  ]);
  const block = view.messages[0].blocks.find((entry) => entry.kind === 'tool' && entry.id === 'tool-1');
  assert.equal(block.status, 'ok');
  assert.deepEqual(block.app, app);
});

test('MCP app documents get a restrictive CSP, theme bridge and permission allow list', async () => {
  const app = await loadFrontend('../src/lib/mcpApp.ts', {});
  const csp = app.readMcpAppCsp({
    connectDomains: ['https://api.weather.test', 'javascript:alert(1)', 'https://api.weather.test'],
    resourceDomains: ['https://cdn.weather.test'],
    frameDomains: ['https://frames.weather.test'],
  });
  assert.deepEqual(csp.connectDomains, ['https://api.weather.test']);
  assert.equal(csp.resourceDomains[0], 'https://cdn.weather.test');
  assert.equal(app.readMcpAppCsp({ connectDomains: ['not-a-domain'] }), undefined);
  const permissions = app.readMcpAppPermissions({ camera: {}, microphone: {}, nonsense: {} });
  assert.deepEqual(permissions, { camera: true, microphone: true });
  assert.equal(app.mcpAppAllowAttribute(permissions), 'camera; microphone');

  const policy = app.mcpAppContentSecurityPolicy(csp);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'unsafe-inline' https:\/\/cdn\.weather\.test/);
  assert.match(policy, /connect-src https:\/\/api\.weather\.test/);
  assert.match(policy, /frame-src https:\/\/frames\.weather\.test/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /javascript:/);

  const doc = app.injectMcpAppDocument('<!doctype html><html><body>weather</body></html>', csp);
  assert.match(doc, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
  assert.match(doc, /ui\/notifications\/host-context-changed/);
  assert.match(doc, /weather/);
  assert.match(app.injectMcpAppDocument('<p>fragment</p>', undefined), /^<!doctype html>/);
  assert.equal(app.clampMcpAppHeight(1), app.MCP_APP_MIN_HEIGHT);
  assert.equal(app.clampMcpAppHeight(99999), app.MCP_APP_MAX_HEIGHT);
  assert.equal(app.mcpAppFileName({ tool: 'weather/card' }), 'weather-card.html');
});

test('prompt and thread links round-trip repo, provider and model context', async () => {
  const links = await loadFrontend('../src/lib/promptLinks.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async (_key, fallback) => fallback, writePref() {} },
    './ipc': { gitRemoteUrl: async () => null },
    './chat': {
      chat: { draftProject: null, sessions: [] },
      selectSession: async () => {},
      setComposer() {},
      startNewSession() {},
      startScratchSession() {},
    },
    './projects': { openProjectPath: async () => null },
    './store': { effectiveRoot: () => null, setPendingPromptSeed() {}, store: { currentProject: null, recentProjects: [] } },
    './native': { writeClipboardText: async () => {} },
    '../components/ui': { toast() {} },
  });

  const prompt = links.buildPromptLink({ prompt: 'Fix **build**', repo: 'owner/name', provider: 'claude', model: 'opus', title: 'Fix' });
  assert.match(prompt, /^flipflopper:\/\/new\?/);
  const parsed = links.parsePromptLink(prompt);
  assert.deepEqual({ kind: parsed.kind, prompt: parsed.prompt, repo: parsed.repo, provider: parsed.provider, model: parsed.model }, {
    kind: 'new', prompt: 'Fix **build**', repo: 'owner/name', provider: 'claude', model: 'opus',
  });
  assert.equal(parsed.hiddenCharacters, false);

  const thread = links.buildThreadLink({ id: 'session/one', title: 'Fix cache', prompt: 'Continue', repo: 'owner/name', provider: 'codex', model: 'gpt' });
  const threadParsed = links.parsePromptLink(thread);
  assert.deepEqual({ kind: threadParsed.kind, id: threadParsed.threadId, title: threadParsed.title, prompt: threadParsed.prompt }, {
    kind: 'thread', id: 'session/one', title: 'Fix cache', prompt: 'Continue',
  });

  const hidden = links.parsePromptLink('flipflopper://new?prompt=he\u200Bllo');
  assert.equal(hidden.prompt, 'hello');
  assert.equal(hidden.hiddenCharacters, true);
  assert.equal(links.repoSlugFromUrl('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(links.repoSlugFromUrl('https://github.com/owner/repo'), 'owner/repo');
  assert.equal(links.repoSlugFromUrl('ssh://git@github.com/owner/repo.git'), 'owner/repo');
  assert.equal(links.repoSlugFromUrl('owner/repo'), 'owner/repo');
  assert.equal(links.repoSlugFromUrl('not a repo'), null);

  assert.throws(() => links.parsePromptLink('flipflopper://new'), /no prompt/i);
  assert.throws(() => links.parsePromptLink('https://example.com/new?prompt=x'), /only flipflopper/i);
  assert.throws(() => links.parsePromptLink('flipflopper://thread'), /session id/i);
  assert.throws(() => links.buildPromptLink({ prompt: 'x'.repeat(links.MAX_PROMPT_LINK_CHARS + 1) }), /at most/i);
  assert.throws(() => links.buildThreadLink({ id: 'x', prompt: 'x'.repeat(links.MAX_PROMPT_LINK_CHARS + 1) }), /at most/i);
});

test('opening a prompt link resolves the repo, applies model context and saves a draft', async () => {
  const calls = [], writes = [];
  const links = await loadFrontend('../src/lib/promptLinks.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async (_key, fallback) => fallback, writePref: (key, value) => writes.push([key, value]) },
    './ipc': { gitRemoteUrl: async () => 'git@github.com:owner/name.git' },
    './chat': {
      chat: { sessions: [], draftProject: null },
      startNewSession: (path) => calls.push(['new', path]),
      startScratchSession: () => calls.push(['scratch']),
      setComposer: (patch) => calls.push(['composer', patch]),
      selectSession: async (id) => calls.push(['select', id]),
    },
    './projects': { openProjectPath: async (path) => { calls.push(['open', path]); return null; } },
    './store': {
      effectiveRoot: () => null,
      setPendingPromptSeed: (seed) => calls.push(['seed', seed]),
      store: { currentProject: null, recentProjects: [{ path: '/repo', name: 'Renamed checkout' }], agents: [{ id: 'claude', installed: true, chat_supported: true }] },
    },
    './native': { writeClipboardText: async () => {} },
    '../components/ui': { toast() {} },
  });
  assert.equal(await links.findProjectForRepo('owner/name'), '/repo', 'matches a renamed checkout through its git remote');
  const link = links.buildPromptLink({ prompt: 'Fix the build', repo: 'owner/name', provider: 'claude', model: 'opus' });
  await links.openPromptLink(link);
  assert.deepEqual(calls, [
    ['open', '/repo'],
    ['new', '/repo'],
    ['composer', { agentId: 'claude', model: 'opus', effort: null }],
    ['seed', { text: 'Fix the build', projectPath: '/repo' }],
  ]);
  assert.equal(writes[0][0], 'pendingPromptLink');
  assert.equal(writes[0][1].link, link);

  const thread = links.buildThreadLink({ id: 'thread-1', title: 'Existing', prompt: 'Continue' });
  // The mock has no stored thread, so opening it reports a clear failure and clears the saved link.
  await assert.rejects(() => links.openPromptLink(thread), /not in this FlipFlopper installation/);
  assert.equal(writes.at(-1)[0], 'pendingPromptLink');
  assert.equal(writes.at(-1)[1], null);
  assert.throws(() => links.buildPromptLink({ prompt: '' }), /write a prompt/i);
});

test('preview tabs keep independent history and close/reopen selection', async () => {
  const preview = await loadFrontend('../src/lib/previewTabs.ts', {});
  const first = preview.createPreviewTab('http://localhost:3000', 'run', 'first');
  const second = preview.createPreviewTab('http://localhost:5173', 'user', 'second');
  assert.equal(first.title, 'localhost:3000');
  assert.deepEqual([first.history, first.index], [['http://localhost:3000'], 0]);

  const docs = preview.navigatePreviewTab(first, 'http://localhost:3000/docs');
  assert.deepEqual([docs.history, docs.index], [['http://localhost:3000', 'http://localhost:3000/docs'], 1]);
  assert.equal(docs.title, 'localhost:3000/docs');
  const back = preview.stepPreviewTab(docs, -1);
  assert.equal(back.url, 'http://localhost:3000');
  assert.equal(preview.stepPreviewTab(back, -1), back, 'back at the start is a no-op');
  const forward = preview.stepPreviewTab(back, 1);
  assert.equal(forward.url, 'http://localhost:3000/docs');
  const rewritten = preview.navigatePreviewTab(back, 'http://localhost:3000/new');
  assert.deepEqual(rewritten.history, ['http://localhost:3000', 'http://localhost:3000/new'], 'forward history is dropped');

  const closed = preview.closePreviewTab([first, second], 'first', 'first');
  assert.deepEqual(closed.tabs.map((tab) => tab.id), ['second']);
  assert.equal(closed.activeId, 'second');
  const closedLast = preview.closePreviewTab([first, second], 'second', 'second');
  assert.equal(closedLast.activeId, 'first');
  assert.equal(preview.closePreviewTab([], 'first', 'missing').activeId, 'first');
});

test('custom themes normalize colors and derive a complete readable palette', async () => {
  const theme = await loadFrontend('../src/lib/theme.ts', {});
  const dark = theme.defaultCustomTheme('dark');
  assert.deepEqual(theme.normalizeCustomTheme({ ...dark, canvas: '#abc', surface: '#123', foreground: '#fff', accent: '#0f0' }), {
    ...dark, canvas: '#aabbcc', surface: '#112233', foreground: '#ffffff', accent: '#00ff00',
  });
  const tokens = theme.customThemeTokens(dark);
  assert.equal(tokens['color-scheme'], 'dark');
  assert.equal(tokens['--surface-0'], dark.canvas);
  assert.equal(tokens['--surface-2'], dark.surface);
  assert.equal(tokens['--accent'], dark.accent);
  assert.match(tokens['--accent-rgb'], /^\d+, \d+, \d+$/);
  for (const key of ['--fg-default', '--fg-muted', '--border-strong', '--status-add']) assert.match(tokens[key], /^#|^rgba/, key);
  assert.equal(theme.customThemeTokens(theme.defaultCustomTheme('light'))['color-scheme'], 'light');
  assert.equal(theme.normalizeCustomTheme(null), null);
  assert.equal(theme.normalizeCustomTheme({ canvas: 'nope', surface: '#fff', foreground: '#000', accent: '#fff' }), null);
});

test('rich composer styles Markdown without changing the source or enabling HTML', async () => {
  const rich = await loadFrontend('../src/lib/richText.ts', {});
  const source = '**bold** and *italic* and ~~gone~~ and `code`\n- [x] done\n> quote\n```ts\nconst x = 1 < 2;\n```\n@src/main.ts /test';
  const html = rich.renderRichMarkdown(source);
  assert.equal(rich.richTextSource(html), source, 'the editor textContent round-trips exactly');
  assert.match(html, /md-rich-strong/);
  assert.match(html, /md-rich-em/);
  assert.match(html, /md-rich-del/);
  assert.match(html, /md-rich-task/);
  assert.match(html, /md-rich-quote/);
  assert.match(html, /md-rich-codeblock/);
  assert.match(html, /md-rich-mention/);
  assert.match(html, /&lt; 2/, 'code fences escape HTML');
  const hostile = rich.renderRichMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.equal(rich.richTextSource(hostile), '<img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.match(hostile, /&lt;img src=x/);
});

test('project scripts validate, persist, edit and remove per checkout', async () => {
  let saved = {};
  const scripts = await loadFrontend('../src/lib/scripts.ts', {
    'solid-js': solid,
    './appPrefs': { readPref: async (_key, fallback) => fallback, writePref: (key, value) => { saved = { [key]: value }; } },
    './store': { store: { currentProject: null, activeCwd: null }, addTerminal() {} },
    './layout': { openSide() {} },
    './ipc': { openTerminal: async () => 'terminal-1', ptySendLine: async () => {} },
    '../components/ui': { toast() {} },
  });
  await scripts.hydrateProjectScripts();
  assert.deepEqual(scripts.projectScripts('/repo'), []);
  assert.match(scripts.addProjectScript('/repo', '', 'npm test'), /name/);
  assert.match(scripts.addProjectScript('/repo', 'Test', ''), /command/);
  assert.equal(scripts.addProjectScript('/repo', 'Test', 'npm test'), null);
  assert.match(scripts.addProjectScript('/repo', 'test', 'npm run other'), /already used/);
  const added = scripts.projectScripts('/repo');
  assert.equal(added.length, 1);
  assert.equal(added[0].command, 'npm test');
  assert.equal(scripts.updateProjectScript('/repo', added[0].id, 'Unit tests', 'npm run unit'), null);
  assert.equal(scripts.projectScripts('/repo')[0].name, 'Unit tests');
  assert.match(scripts.updateProjectScript('/repo', added[0].id, 'Unit tests', ''), /command/);
  assert.ok(saved.projectScripts['/repo'][0].command === 'npm run unit', 'writes preferences.json');
  scripts.removeProjectScript('/repo', added[0].id);
  assert.deepEqual(scripts.projectScripts('/repo'), []);
  assert.equal(saved.projectScripts['/repo'], undefined, 'empty projects are dropped');
});

test('clone URL previews mirror the backend checks', async () => {
  const mod = await loadFrontend('../src/lib/repoUrl.ts', {});
  assert.equal(mod.repositoryNameFromUrl('https://github.com/a/b.git'), 'b');
  assert.equal(mod.repositoryNameFromUrl('git@github.com:owner/repo.git'), 'repo');
  assert.equal(mod.repositoryNameFromUrl('https://host/team/My Repo/'), 'My-Repo');
  assert.equal(mod.repositoryNameFromUrl('file:///tmp/some/repo'), 'repo');
  assert.equal(mod.repositoryNameFromUrl('/tmp/local-repo'), 'local-repo');
  assert.equal(mod.repositoryNameFromUrl('https://host/'), null);
  assert.equal(mod.repositoryNameFromUrl(''), null);
  assert.equal(mod.looksLikeCloneUrl('https://github.com/a/b'), true);
  assert.equal(mod.looksLikeCloneUrl('git@github.com:a/b.git'), true);
  assert.equal(mod.looksLikeCloneUrl('ssh://git@host/a/b'), true);
  assert.equal(mod.looksLikeCloneUrl('/tmp/x'), true);
  assert.equal(mod.looksLikeCloneUrl('github.com/a/b'), false);
  assert.equal(mod.looksLikeCloneUrl('-oProxyCommand=evil'), false);
  assert.equal(mod.looksLikeCloneUrl(''), false);
  assert.equal(mod.defaultRepositoryName('My Project!'), 'my-project');
  assert.equal(mod.defaultRepositoryName('  '), 'repository');
  assert.equal(mod.defaultRepositoryName('...'), 'repository');
  assert.equal(mod.defaultRepositoryName('x'.repeat(120)).length, 100);
  assert.equal(mod.isValidRepositoryName('flip.flopper_2'), true);
  assert.equal(mod.isValidRepositoryName(''), false);
  assert.equal(mod.isValidRepositoryName('-bad'), false);
  assert.equal(mod.isValidRepositoryName('bad/name'), false);
  assert.equal(mod.isValidRepositoryName('x'.repeat(101)), false);
});

test('keybindings parse, format, match, validate and resolve overrides', async () => {
  const kb = await loadFrontend('../src/lib/keybindings.ts', { 'solid-js': solid, './appPrefs': { readPref: async (_k, d) => d, writePref() {} } });
  const ev = (key, extra = {}) => ({ key, code: `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
  assert.deepEqual({ ...kb.parseBinding('mod+shift+t') }, { key: 't', mod: true, shift: true, alt: false });
  assert.deepEqual({ ...kb.parseBinding('Ctrl+Alt+code:KeyN') }, { key: 'code:KeyN', mod: true, shift: false, alt: true });
  assert.deepEqual({ ...kb.parseBinding('shift+f6') }, { key: 'f6', mod: false, shift: true, alt: false });
  assert.equal(kb.parseBinding(''), null);
  assert.equal(kb.parseBinding('mod+'), null);
  assert.equal(kb.parseBinding(null), null);
  assert.equal(kb.bindingToString(kb.parseBinding('Shift+Mod+T')), 'mod+shift+t', 'canonical order');
  assert.equal(kb.bindingToString(kb.parseBinding('mod+alt+code:KeyN')), 'mod+alt+code:KeyN');
  assert.equal(kb.formatBinding(kb.parseBinding('mod+shift+t'), true), '⌘⇧T');
  assert.equal(kb.formatBinding(kb.parseBinding('mod+alt+code:KeyN'), true), '⌘⌥N');
  assert.equal(kb.formatBinding(kb.parseBinding('mod+shift+t'), false), 'Ctrl+Shift+T');
  assert.equal(kb.formatBinding(kb.parseBinding('f6'), true), 'F6');

  const f = kb.parseBinding('mod+f');
  assert.equal(kb.eventMatches(ev('f', { metaKey: true }), f, true), true);
  assert.equal(kb.eventMatches(ev('F', { metaKey: true }), f, true), true, 'case-insensitive');
  assert.equal(kb.eventMatches(ev('f', { ctrlKey: true }), f, true), false, 'Ctrl is not the modifier on macOS');
  assert.equal(kb.eventMatches(ev('f', { metaKey: true, shiftKey: true }), f, true), false, 'extra modifiers do not match');
  assert.equal(kb.eventMatches(ev('f', { ctrlKey: true }), f, false), true);
  const scratch = kb.parseBinding('mod+alt+code:KeyN');
  assert.equal(kb.eventMatches({ key: 'ñ', code: 'KeyN', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true }, scratch, true), true, 'Option rewrites characters; the physical key matches');
  assert.deepEqual({ ...kb.bindingFromEvent({ key: 'ñ', code: 'KeyN', metaKey: true, ctrlKey: false, shiftKey: false, altKey: true }, true) }, { key: 'code:KeyN', mod: true, shift: false, alt: true });
  assert.equal(kb.bindingFromEvent(ev('Shift', { shiftKey: true }), true), null, 'a bare modifier is not a binding');

  assert.match(kb.bindingProblem(kb.parseBinding('a')), /⌘\/Ctrl or Alt/);
  assert.equal(kb.bindingProblem(kb.parseBinding('f9')), null);
  assert.equal(kb.bindingProblem(kb.parseBinding('mod+g')), null);
  assert.match(kb.bindingProblem(kb.parseBinding('alt+enter')) ?? 'ok', /ok|typing/);

  assert.match(kb.bindingConflict(kb.parseBinding('mod+k'), 'stash-prompt'), /app menu/);
  assert.match(kb.bindingConflict(kb.parseBinding('mod+f'), 'stash-prompt'), /Find in the conversation/);
  assert.equal(kb.bindingConflict(kb.parseBinding('mod+f'), 'find-in-conversation'), null, 'a command may keep its own combo');
  assert.equal(kb.bindingConflict(kb.parseBinding('mod+shift+u'), 'stash-prompt'), null);

  assert.equal(kb.bindingToString(kb.effectiveBinding('stash-prompt', {})), 'mod+s');
  assert.equal(kb.bindingToString(kb.effectiveBinding('open-usage', {})), 'mod+u');
  assert.equal(kb.bindingToString(kb.effectiveBinding('file-picker', {})), 'mod+p');
  assert.equal(kb.bindingToString(kb.effectiveBinding('project-search', {})), 'mod+shift+f');
  assert.equal(kb.bindingToString(kb.effectiveBinding('open-usage', { 'open-usage': 'mod+shift+u' })), 'mod+shift+u');
  assert.equal(kb.effectiveBinding('stash-prompt', { 'stash-prompt': null }), null, 'explicitly cleared');
  assert.equal(kb.commandForEvent(ev('s', { metaKey: true }), true, {}), 'stash-prompt');
  assert.equal(kb.commandForEvent(ev('s', { metaKey: true }), true, { 'stash-prompt': null }), null);
  assert.equal(kb.commandForEvent(ev('s', { metaKey: true }), true, { 'open-usage': 'mod+s', 'stash-prompt': 'mod+shift+s' }), 'open-usage');
  assert.equal(kb.commandForEvent({ key: 'F6', code: 'F6', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false }, true, {}), 'focus-previous-area');
  assert.equal(new Set(kb.COMMANDS.map((c) => c.id)).size, kb.COMMANDS.length);

  kb.setKeybinding('open-usage', kb.parseBinding('mod+shift+u'));
  assert.equal(kb.keybindingOverrides()['open-usage'], 'mod+shift+u');
  kb.setKeybinding('open-usage', undefined);
  assert.equal('open-usage' in kb.keybindingOverrides(), false, 'reset restores the default');
  assert.equal(kb.bindingToString(kb.effectiveBinding('open-usage', {})), 'mod+u');

  // `when` contexts: expressions, defaults and context-aware dispatch.
  const context = (over = {}) => ({ composerFocus: false, terminalFocus: false, editableFocus: false, paletteOpen: false, sessionOpen: false, turnRunning: false, diffFocus: false, ...over });
  assert.equal(kb.evaluateWhen('', context()), true);
  assert.equal(kb.evaluateWhen('composerFocus', context()), false);
  assert.equal(kb.evaluateWhen('composerFocus', context({ composerFocus: true })), true);
  assert.equal(kb.evaluateWhen('!editableFocus', context()), true);
  assert.equal(kb.evaluateWhen('!editableFocus', context({ editableFocus: true })), false);
  assert.equal(kb.evaluateWhen('sessionOpen && turnRunning', context({ sessionOpen: true })), false);
  assert.equal(kb.evaluateWhen('sessionOpen && turnRunning', context({ sessionOpen: true, turnRunning: true })), true);
  assert.equal(kb.evaluateWhen('composerFocus || diffFocus', context({ diffFocus: true })), true);
  assert.equal(kb.evaluateWhen('composerFocus || sessionOpen && turnRunning', context({ composerFocus: true })), true, '&& binds tighter than ||');
  assert.equal(kb.evaluateWhen('!(composerFocus || sessionOpen)', context()), true);
  assert.equal(kb.evaluateWhen('unknownKey', context()), false);
  assert.equal(kb.evaluateWhen('composerFocus &&', context({ composerFocus: true })), false, 'invalid expressions never match');
  assert.equal(kb.validWhenExpression('composerFocus && !editableFocus'), true);
  assert.equal(kb.validWhenExpression('composerFocus &&'), false);
  assert.equal(kb.validWhenExpression(''), true);
  assert.equal(kb.validWhenExpression('composerFocus $'), false);
  assert.deepEqual(kb.WHEN_PRESETS.map((option) => option.value), ['', 'composerFocus', '!editableFocus', 'sessionOpen', '!sessionOpen', 'turnRunning', 'terminalFocus', 'diffFocus']);

  kb.setKeybindingWhen('stash-prompt', 'composerFocus');
  assert.equal(kb.effectiveWhen('stash-prompt'), 'composerFocus');
  assert.equal(kb.commandForEvent(ev('s', { metaKey: true }), true, undefined, undefined, context()), null, 'a scoped command stays quiet elsewhere');
  assert.equal(kb.commandForEvent(ev('s', { metaKey: true }), true, undefined, undefined, context({ composerFocus: true })), 'stash-prompt');
  kb.setKeybinding('open-usage', kb.parseBinding('mod+s'));
  assert.match(kb.bindingConflict(kb.parseBinding('mod+s'), 'open-usage'), /Stash the draft prompt/, 'a global shortcut conflicts with a scoped one');
  kb.setKeybindingWhen('open-usage', 'diffFocus');
  assert.equal(kb.bindingConflict(kb.parseBinding('mod+s'), 'open-usage'), null, 'different non-empty contexts may share a combo');
  assert.equal(kb.commandForEvent(ev('s', { metaKey: true }), true, undefined, undefined, context({ diffFocus: true })), 'open-usage');
  assert.equal(kb.setKeybindingWhen('open-usage', 'broken &&'), false, 'invalid conditions are refused');
  assert.equal(kb.effectiveWhen('open-usage'), 'diffFocus');
  kb.setKeybindingWhen('open-usage', undefined);
  kb.setKeybindingWhen('stash-prompt', undefined);
  kb.setKeybinding('open-usage', undefined);
  assert.equal(kb.effectiveWhen('stash-prompt'), '');
});

test('LaTeX renders to MathML without a library, and dollar amounts stay text', async () => {
  const math = await loadFrontend('../src/lib/math.ts', {});
  const body = (tex, display = false) => math.latexToMathML(tex, display).replace(/^.*?<mrow>/s, '<mrow>').replace(/<\/mrow><annotation.*$/s, '</mrow>');
  assert.equal(body('x^2'), '<mrow><msup><mi>x</mi><mn>2</mn></msup></mrow>');
  assert.equal(body('x_1^{n+1}'), '<mrow><msubsup><mi>x</mi><mn>1</mn><mrow><mi>n</mi><mo>+</mo><mn>1</mn></mrow></msubsup></mrow>');
  assert.equal(body('\\frac{a}{b}'), '<mrow><mfrac><mi>a</mi><mi>b</mi></mfrac></mrow>');
  assert.equal(body('\\sqrt{x}'), '<mrow><msqrt><mi>x</mi></msqrt></mrow>');
  assert.equal(body('\\sqrt[3]{x}'), '<mrow><mroot><mi>x</mi><mrow><mn>3</mn></mrow></mroot></mrow>');
  assert.match(body('\\sum_{i=1}^{n} i'), /<munderover><mo largeop="true" movablelimits="true">∑<\/mo>/);
  assert.match(body('\\int_0^1 f'), /<msubsup><mo>∫<\/mo><mn>0<\/mn><mn>1<\/mn><\/msubsup>/);
  assert.match(body('\\alpha \\leq \\infty'), /<mi>α<\/mi><mo>≤<\/mo><mi>∞<\/mi>/);
  assert.match(body('\\text{if } x'), /<mtext>if <\/mtext>|<mtext>if<\/mtext>/);
  assert.match(body('\\left( x \\right)'), /<mrow><mo>\(<\/mo><mi>x<\/mi><mo>\)<\/mo><\/mrow>/);
  assert.match(math.latexToMathML('E=mc^2', true), /display="block"[\s\S]*application\/x-tex">E=mc\^2</);
  assert.match(body('3.14'), /<mn>3\.14<\/mn>/);
  assert.match(body('a<b'), /<mo>&lt;<\/mo>/, 'operators are escaped');
  for (const bad of ['', '   ', '\\unknowncmd{x}', 'x^', '{x', 'x}', '\\frac{a}', '\\left( x', 'a & b']) assert.equal(math.latexToMathML(bad), null, JSON.stringify(bad));
  assert.equal(math.latexToMathML('x'.repeat(5000)), null, 'oversized input is refused');
  assert.equal(math.latexToMathML('{'.repeat(60) + 'x' + '}'.repeat(60)), null, 'deep nesting is refused');
  assert.match(math.renderMath('\\bad{', false), /<code class="md-math-error"[^>]*>\$\\bad\{\$<\/code>/);

  const md = await loadMarkdown();
  const render = (text) => md.renderMarkdownLite(text);
  assert.doesNotMatch(render('It costs $5 and $10 today.'), /<math/);
  assert.doesNotMatch(render('Prices: $ 5 and 7$.'), /<math/);
  assert.match(render('Inline $x_1^2$ here, and *emphasis*.'), /<math[^>]*display="inline">[\s\S]*<msubsup>[\s\S]*<\/math>[^]*<em>emphasis<\/em>/);
  assert.match(render('Also \\(a+b\\) works.'), /<math/);
  assert.doesNotMatch(render('Escaped \\$x\\$ stays.'), /<math/);
  assert.match(render('$$\n\\frac{a}{b}\n$$'), /<div class="md-math-block"><math[^>]*display="block">[\s\S]*<mfrac>/);
  assert.match(render('$$ x^2 $$'), /md-math-block/);
  assert.match(render('\\[ y = mx + b \\]'), /md-math-block/);
  assert.match(render('```math\nE=mc^2\n```'), /md-math-block/);
  assert.doesNotMatch(render('`$x^2$` in code'), /<math/);
  assert.doesNotMatch(render('```js\nconst a = "$x$";\n```'), /<math/);
  assert.match(render('| a | b |\n|---|---|\n| $x^2$ | 1 |'), /<td>.*<math/);
  md.setMathRendering(false);
  assert.doesNotMatch(render('Inline $x^2$ and $$y$$'), /<math/);
  md.setMathRendering(true);
  assert.match(render('Inline $x^2$'), /<math/);
});

test('file viewer paths map onto the checkout and highlighted code splits into lines', async () => {
  const viewer = await loadFrontend('../src/lib/fileViewer.ts', { 'solid-js': solid, './layout': {}, './store': {}, './attachments': {}, '../components/ui': {} });
  const rel = viewer.relativeToRoot;
  assert.equal(rel('/work/app/src/a.ts', '/work/app'), 'src/a.ts');
  assert.equal(rel('/work/app/src/a.ts', '/work/app/'), 'src/a.ts', 'trailing slash on the root');
  assert.equal(rel('./src/a.ts', '/work/app'), 'src/a.ts');
  assert.equal(rel('src//a.ts', '/work/app'), 'src/a.ts');
  assert.equal(rel('/work/other/a.ts', '/work/app'), null, 'outside the checkout');
  assert.equal(rel('/work/application/a.ts', '/work/app'), null, 'a sibling that shares a prefix is outside');
  assert.equal(rel('C:\\work\\app\\src\\a.ts', 'C:\\work\\app'), 'src/a.ts', 'Windows separators');
  assert.equal(rel('/work/app', '/work/app'), '', 'the root itself has no file');

  const md = await loadMarkdown();
  assert.deepEqual(md.highlightLines('a\nb\nc', null), ['a', 'b', 'c']);
  assert.deepEqual(md.highlightLines('x <y> & z\n', null), ['x &lt;y&gt; &amp; z'], 'escaped, and a trailing newline adds no line');
  assert.deepEqual(md.highlightLines('', null), ['']);
  assert.deepEqual(md.highlightLines('a\n\nb', null), ['a', '', 'b']);
});

test('highlighted HTML splits into balanced lines', async () => {
  const md = await loadMarkdown();
  assert.deepEqual(md.splitHighlighted('<span class="c">/* one\ntwo */</span> x\ny'), ['<span class="c">/* one</span>', '<span class="c">two */</span> x', 'y']);
  assert.deepEqual(md.splitHighlighted('<span class="a"><span class="b">p\nq</span> r\ns</span>t'), ['<span class="a"><span class="b">p</span></span>', '<span class="a"><span class="b">q</span> r</span>', '<span class="a">s</span>t']);
  assert.deepEqual(md.splitHighlighted('x\n', true), ['x']);
  assert.deepEqual(md.splitHighlighted('<span class="k">a</span>\n', true), ['<span class="k">a</span>']);
  assert.deepEqual(md.splitHighlighted('\n\n', true), ['', '']);
  const balanced = (html) => (html.match(/<span/g) ?? []).length === (html.match(/<\/span>/g) ?? []).length;
  assert.ok(md.splitHighlighted('<span class="c">a\nb\nc\nd</span>').every(balanced));
});

test('preview annotations serialize the page, selector, text and screenshot', async () => {
  const module = await loadFrontend('../src/lib/previewPick.ts', {});
  const withImage = module.previewAnnotationText({
    url: 'http://localhost:5173/app',
    title: 'Demo',
    selector: 'main > button.primary',
    text: 'Save changes',
  }, true);
  assert.match(withImage, /## Preview annotation/);
  assert.match(withImage, /Page: http:\/\/localhost:5173\/app — Demo/);
  assert.match(withImage, /Element: `main > button\.primary`/);
  assert.match(withImage, /Text: Save changes/);
  assert.match(withImage, /screenshot of the preview is attached/);
  const textOnly = module.previewAnnotationText({ url: 'https://example.test', title: '', selector: '#x', text: '' }, false);
  assert.doesNotMatch(textOnly, /Text:/);
  assert.doesNotMatch(textOnly, /screenshot/);
});

test('composer context chips serialize into a referenced-context prompt', async () => {
  const module = await loadFrontend('../src/lib/composerContexts.ts', {
    'solid-js': solid,
    './chat': { chat: { activeId: null } },
  });
  const context = { id: 'a1', kind: 'pr', label: 'PR #7', detail: 'Fix the parser', draftKey: 'new', created_at: 1 };
  const token = module.contextToken(context);
  const resolved = module.resolveComposerContexts(`Please review ${token} today`, [context]);
  assert.equal(resolved.clean, 'Please review today');
  assert.match(resolved.prompt, /## Referenced context/);
  assert.match(resolved.prompt, /### Pull request/);
  assert.match(resolved.prompt, /Fix the parser/);
  const dropped = module.resolveComposerContexts('Look @ctx:terminal:gone', [context]);
  assert.doesNotMatch(dropped.prompt, /@ctx:/);
});

test('rich composer styles context tokens without changing the source', async () => {
  const module = await loadFrontend('../src/lib/richText.ts', {});
  const source = 'see @ctx:preview:abc123';
  const html = module.renderRichMarkdown(source);
  assert.match(html, /md-rich-context/);
  assert.equal(module.richTextSource(html), source);
});

test('diff test-file filter covers common test layouts', async () => {
  const module = await loadFrontend('../src/lib/diffModel.ts', {});
  for (const path of ['src/app.test.ts', 'src/app.spec.tsx', 'src/app.e2e.ts', 'tests/app.ts', '__tests__/a.ts', 'pkg/foo_test.go', 'pkg/test_foo.py', 'cypress/e2e/login.cy.ts']) {
    assert.equal(module.isTestFile(path), true, path);
  }
  for (const path of ['src/app.ts', 'src/contest.ts', 'src/latest.ts', 'src/attestation.ts', 'src/testing/foo.ts']) {
    assert.equal(module.isTestFile(path), false, path);
  }
});

test('worktree setup cards track pending, running and finished steps', async () => {
  const module = await loadFrontend('../src/lib/worktreeSetup.ts', { 'solid-js': solid });
  const id = module.beginWorktreeSetup('/p', '/w', [
    { id: 'a', name: 'Install', command: 'npm ci' },
    { id: 'b', name: 'Build', command: 'npm run build' },
  ]);
  assert.equal(module.worktreeSetups().length, 1);
  assert.deepEqual(module.worktreeSetups()[0].steps.map((step) => step.status), ['pending', 'pending']);
  module.updateWorktreeSetupStep(id, 0, { status: 'running', startedAt: 1 });
  module.updateWorktreeSetupStep(id, 0, { status: 'done', endedAt: 2, output: 'ok' });
  assert.equal(module.worktreeSetups()[0].steps[0].status, 'done');
  module.finishWorktreeSetup(id);
  assert.ok(module.worktreeSetups()[0].finishedAt);
  module.dismissWorktreeSetup(id);
  assert.equal(module.worktreeSetups().length, 0);
});

test('project icons keep a safe image path and fall back to a monogram', async () => {
  const module = await loadFrontend('../src/lib/layout.ts', {
    'solid-js': solid,
    'solid-js/store': solidStore,
    '@tauri-apps/api/webview': { getCurrentWebview: () => ({ setZoom: async () => {} }) },
    './appPrefs': { readPref: async (_key, fallback) => fallback, writePref() {} },
    './theme': { CUSTOM_THEME_PROPERTIES: [], customThemeTokens: () => ({}), normalizeCustomTheme: () => null },
  });
  const icon = module.sanitizeProjectIcon({ letter: 'f', hue: 200, image: '/tmp/flip.png' });
  assert.deepEqual(icon, { letter: 'F', hue: 200, image: '/tmp/flip.png' });
  const monogram = module.projectMonogram('FlipFlopper', icon);
  assert.deepEqual(monogram, { letter: 'F', hue: 200, image: '/tmp/flip.png' });
  assert.equal(module.sanitizeProjectIcon({ image: 'bad\npath' }), null);
  assert.equal(module.projectMonogram('Other', null).letter, 'O');
});

test('snapshot metadata formats app, window and visible text', async () => {
  const module = await loadFrontend('../src/lib/snapshotText.ts', {});
  assert.equal(module.snapshotAnnotation({}), '');
  const text = module.snapshotAnnotation({ app_name: 'Safari', window_title: 'Docs', app_text: 'Hello\nWorld' });
  assert.match(text, /App: Safari/);
  assert.match(text, /Window: Docs/);
  assert.match(text, /Visible text:\nHello/);
});
