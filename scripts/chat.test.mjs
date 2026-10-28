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
  const transcript = overrides["./transcript"] ?? await loadFrontend("../src/lib/transcript.ts", {});
  const mocks = { "solid-js": solid, "solid-js/store": solidStore, "./agentMeta": { discoveredTuning: () => ({ models: [], efforts: [] }) }, "./store": { store: {} }, "./layout": { layout: {projectNames:{},projectOrder:[],hiddenProjects:[]} }, "./transcript": transcript, ...overrides };
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
  const module = new SourceTextModule(source);
  await module.link((specifier) => new SyntheticModule(["default"], function () {
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
async function loadFrontend(file, mocks) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
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
  const module = await loadFrontend('../src/components/side/PreviewView.tsx', {
    'solid-js': { ...solid, createSignal:(...args) => { const signal=solid.createSignal(...args); signals.push(signal); return signal; } },
    '../../lib/store': { store:sessions, readRunTargets:() => ({}), setRunSessionId:(id) => setSessions('runSessionId',id) },
    '../../lib/ipc': {
      onPreviewUrl:(id,callback) => { urlListeners.set(id,callback); return urlDeferred.get(id).promise; },
      getSessionUrl:(id) => { existingReads.push(id); return existingDeferred.get(id).promise; },
      onPtyExit:(id) => exitDeferred.get(id).promise,
    },
    '../../lib/layout': { openSide() {} },
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
    assert.equal(signals[0][0](), 'http://new.test');
    urlDeferred.get('old').resolve(() => removed.push('old-url'));
    await settle();
    assert.deepEqual(removed, ['old-url']);
    assert.deepEqual(existingReads, ['new']);
    urlListeners.get('old')('http://stale.test');
    assert.equal(signals[0][0](), 'http://new.test');
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
async function composerFixture(activeId = 's') {
  const [chat, setChat] = solidStore.createStore({
    activeId, views: {}, composer: { agentId:'claude', mode:'auto_edit' },
    sessions: [{id:'s'}, {id:'other'}], queued: {},
  });
  const [attachments, setAttachments] = solid.createSignal([]);
  const signals = [], nodes = [], submissions = [], queuedSends = [], animations = [], launches = [], rollbacks = [], yoloCalls = [], sideTabs = [];
  let resolve, dispose;
  const module = await loadFrontend('../src/components/chat/Composer.tsx', {
    'solid-js': { ...solid, createSignal: (...args) => { const signal=solid.createSignal(...args); signals.push(signal); return signal; } },
    '../../lib/chat': {
      chat, isRunning: () => false, cycleMode() {}, modeAvailable: () => true, splitMode: (mode, yolo) => ({ mode, yolo: !!yolo }), permissionModeUpdating: () => false, sessionModePending: () => false,
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
    '../../lib/store': { store: { agents:[], currentProject:null }, effectiveRoot: () => null },
    '../../lib/attachments': { attachments, setAttachments, clearAttachments: () => setAttachments([]) },
    '../../lib/shortcuts': { registerShortcutHandler: () => () => {}, runAction() {} },
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
