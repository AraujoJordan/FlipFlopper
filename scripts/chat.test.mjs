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

test('YOLO restores Plan or Auto-edit and follows every chat agent', async () => {
  const writes = [];
  const module = await loadChat({ './appPrefs': { writePref: (...args) => writes.push(args) } });
  module.setYolo(true);
  assert.equal(module.chat.composer.mode, 'full');
  module.setYolo(false);
  assert.equal(module.chat.composer.mode, 'auto_edit');
  module.setComposer({ mode: 'plan' });
  module.setYolo(true);
  module.setYolo(true); // Idempotence must not overwrite the return mode.
  for (const agent of ['claude','codex','cursor','agy','qwen','opencode','droid','grok','kimi','aider','goose']) {
    module.setComposerAgent(agent);
    assert.equal(module.chat.composer.mode, 'full', agent);
    assert.equal(writes.at(-1)[1].mode, 'full');
  }
  module.setYolo(false);
  assert.equal(module.chat.composer.mode, 'plan');
  assert.equal(writes.at(-1)[1].mode, 'plan');
  assert.equal('yolo' in writes.at(-1)[1], false); // Existing permission schema.
});

const modeReply = (id, mode, extra = {}) => ({ session: { id, mode }, runtime: { ...runtime(), pending: [], permission_mode: mode, ...extra } });

test('YOLO return mode is conversation-scoped and restored Full falls back to Auto-edit', async () => {
  const module = await loadChat({ './ipc': { chatSetMode: async (id, mode) => modeReply(id, mode) } });
  module.setChat('sessions', [{ id: 'a', mode: 'plan' }, { id: 'b', mode: 'auto_edit' }, { id: 'restored', mode: 'full' }]);
  module.setChat('activeId', 'a'); module.setChat('composer', 'mode', 'plan'); await module.setYolo(true);
  module.setChat('activeId', 'b'); module.setChat('composer', 'mode', 'auto_edit'); await module.setYolo(true);
  await module.setYolo(false); assert.equal(module.chat.composer.mode, 'auto_edit');
  module.setChat('activeId', 'a'); module.setChat('composer', 'mode', 'full'); await module.setYolo(false);
  assert.equal(module.chat.composer.mode, 'plan');
  module.setChat('activeId', 'restored'); module.setChat('composer', 'mode', 'full'); await module.setYolo(false);
  assert.equal(module.chat.composer.mode, 'auto_edit');
});

test('YOLO converts an active native session only after acknowledgement and can be disabled live', async () => {
  let reply;
  const updates = [];
  const module = await loadChat({ './ipc': { chatSetMode: (id, mode) => { updates.push([id, mode]); return new Promise((resolve) => { reply = () => resolve(modeReply(id, mode)); }); } } });
  module.setChat('activeId', 's');
  module.setChat('sessions', [{ id:'s', mode:'auto_edit' }]);
  module.setChat('views', 's', { messages:[], loaded:true, running:true });
  const enabling = module.setYolo(true);
  assert.equal(module.permissionModeUpdating(),true);
  assert.equal(module.chat.composer.mode,'auto_edit');
  assert.equal(await module.setYolo(true),false); // Coalesce double-clicks.
  reply(); assert.equal(await enabling,true);
  assert.equal(module.chat.composer.mode,'full');
  assert.equal(module.chat.sessions[0].mode,'full');
  assert.equal(module.sessionModePending(),false);
  assert.equal(module.isRunning('s'),true);
  const disabling = module.setYolo(false); reply(); await disabling;
  assert.equal(module.chat.composer.mode,'auto_edit');
  assert.deepEqual(updates,[['s','full'],['s','auto_edit']]);
});

test('headless conversion is saved on the same session and honestly labels the current launch policy', async () => {
  const notices = [];
  const module = await loadChat({ '../components/ui': { toast: (...args) => notices.push(args) }, './ipc': { chatSetMode: async (id, mode) => modeReply(id, mode, { connected:false, agent_id:'codex', permission_mode:'auto_edit' }) } });
  module.setChat('activeId','s'); module.setChat('sessions',[{id:'s',mode:'auto_edit'}]);
  module.setChat('views','s',{messages:[],loaded:true,running:true});
  await module.setYolo(true);
  assert.equal(module.chat.composer.mode,'full');
  assert.equal(module.chat.sessions[0].mode,'full');
  assert.equal(module.sessionModePending(),true);
  assert.equal(notices.length,1);
  module.setChat('views','s','runtime','permission_mode','full');
  assert.equal(module.sessionModePending(),false);
});

test('failed live conversion does not claim success or change the saved session', async () => {
  const notices=[];
  const module = await loadChat({ '../components/ui': { toast: (...args)=>notices.push(args) }, './ipc': { chatSetMode: async()=>{throw new Error('CLI refused mode');}, chatRuntimeState: async()=>modeReply('s','auto_edit').runtime } });
  module.setChat('activeId','s'); module.setChat('sessions',[{id:'s',mode:'auto_edit'}]);
  module.setChat('views','s',{messages:[],loaded:true,running:true});
  assert.equal(await module.setYolo(true),false);
  assert.equal(module.chat.composer.mode,'auto_edit');
  assert.equal(module.chat.sessions[0].mode,'auto_edit');
  assert.equal(module.permissionModeUpdating(),false);
  assert.match(notices[0][0],/CLI refused mode/);
});

test('finishing a mode update in another session cannot overwrite the active composer', async () => {
  let reply;
  const module = await loadChat({ './ipc': { chatSetMode: (id, mode)=>new Promise(resolve=>{ reply=()=>resolve(modeReply(id,mode)); }) } });
  module.setChat('activeId','a'); module.setChat('sessions',[{id:'a',mode:'auto_edit'},{id:'b',mode:'plan'}]);
  const pending=module.setYolo(true);
  module.setChat('activeId','b'); module.setChat('composer','mode','plan');
  reply(); await pending;
  assert.equal(module.chat.composer.mode,'plan');
  assert.equal(module.chat.sessions[0].mode,'full');
});

test('a queued turn waits for conversion and uses its own session policy after switching conversations', async () => {
  let reply;
  const sent=[];
  const sessions=[{id:'a',agent_id:'codex',mode:'auto_edit',model:'a-model'}, {id:'b',agent_id:'claude',mode:'plan'}];
  const module=await loadChat({ './ipc': {
    chatSetMode:(id,mode)=>new Promise(resolve=>{reply=()=>{sessions[0].mode=mode;resolve(modeReply(id,mode));};}),
    chatSend:async(args)=>{sent.push(args);return 'new-turn';},
    chatListSessions:async()=>sessions,
  } });
  module.setChat('sessions',sessions);
  module.setChat('activeId','a');
  module.setChat('views','a',{messages:[],loaded:true,running:false});
  module.setChat('queued','a',[{text:'Continue the task',attachments:[]}]);
  const change=module.setYolo(true);
  module.setChat('activeId','b'); module.setChat('composer',{agentId:'claude',mode:'plan',model:'b-model'});
  const next=module.sendQueuedNow('a',0);
  assert.equal(sent.length,0);
  reply(); await change; await next;
  assert.equal(sent[0].session_id,'a');
  assert.equal(sent[0].agent_id,'codex');
  assert.equal(sent[0].mode,'full');
  assert.equal(sent[0].model,'a-model');
  assert.equal(module.chat.composer.mode,'plan');
});

test('repeated native snapshots cannot re-enable YOLO after switching it off', async () => {
  let listener;
  const meta = { id:'s', project_path:'/fixture/project', cwd:'/fixture/project', agent_id:'claude', status:'idle', mode:'full' };
  const module = await loadChat({ './ipc': {
    chatCreateSession: async () => meta,
    onChatEntry: async (_id, callback) => { listener = callback; return () => {}; },
    chatSend: async () => 'turn', chatListSessions: async () => [meta],
    chatSetMode: async (id, mode) => modeReply(id,mode,{current_mode:mode==='full'?'bypassPermissions':'acceptEdits'}),
  } });
  await module.startSessionTurn({ projectPath:meta.project_path, agentId:'claude', mode:'full', prompt:'fixture', activate:false });
  module.setChat('activeId','s');
  const state = { ...runtime(), active_turn_id:null, pending:[], current_mode:'bypassPermissions' };
  listener(event({ type:'runtime_updated', state }));
  await new Promise((resolve) => setTimeout(resolve,70));
  assert.equal(module.chat.composer.mode,'full');
  await module.setYolo(false);
  assert.equal(module.chat.composer.mode,'auto_edit');
  const idleState = { ...module.chat.views.s.runtime, commands:[{name:'refreshed'}] };
  listener(event({ type:'runtime_updated', state: idleState }));
  await new Promise((resolve) => setTimeout(resolve,70));
  assert.equal(module.chat.composer.mode,'auto_edit');
  listener(event({ type:'runtime_updated', state: { ...idleState, current_mode:'plan', permission_mode:'plan' } }));
  await new Promise((resolve) => setTimeout(resolve,70));
  assert.equal(module.chat.composer.mode,'plan'); // Actual native transitions still synchronize.
});

// Motion uses Solid's browser condition so these lifecycle tests exercise real
// effects/cleanup. The DOM below only controls geometry and animation clocks.
async function loadFrontend(file, mocks) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  const bindings = new Map();
  for (const node of ts.createSourceFile('frontend.js', code, ts.ScriptTarget.ES2022).statements) {
    if (ts.isImportDeclaration(node)) bindings.set(node.moduleSpecifier.text, node.importClause.namedBindings.elements.map((e) => e.propertyName?.text ?? e.name.text));
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
