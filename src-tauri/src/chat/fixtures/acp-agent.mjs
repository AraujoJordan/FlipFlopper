// Deterministic ACP peer. No provider authentication, network, or model calls.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const sessionId = "fixture-native";
const pending = new Map();
let nextId = 100, turns = 0, cancelled = false;
let authenticated = process.env.ACP_REQUIRE_AUTH !== "1";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (update) => send({ method: "session/update", params: { sessionId, update } });
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); send({ id, method, params: { sessionId, ...params } }); });
const configs = [
  { id: "model", name: "Model", type: "select", category: "model", currentValue: "model-a", options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }] },
  { id: "effort", name: "Effort", type: "select", category: "thought_level", currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
];
const session = () => ({ sessionId, configOptions: configs, modes: { currentModeId: "acceptEdits", availableModes: ["plan", "acceptEdits", "bypassPermissions", "agent"].map((id) => ({ id, name: id })) } });

async function handle(message) {
  if (!message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
  const p = message.params ?? {};
  let result = {};
  switch (message.method) {
    case "initialize":
      result = { protocolVersion: 1, agentInfo: { name: "fixture", version: "1.0" }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] }; break;
    case "authenticate": authenticated = true; break;
    case "session/new":
    case "session/load":
      if (!authenticated) { send({ id: message.id, error: { code: -32000, message: "Authentication required" } }); return; }
      if (p.sessionId === "missing") { send({ id: message.id, error: { code: -32000, message: "Session not found" } }); return; }
      // A compliant load can replay both text and tool calls before its reply.
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HISTORY MUST NOT REPLAY" } });
      update({ sessionUpdate: "tool_call", toolCallId: "historical-tool", title: "Old tool", kind: "read" });
      update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "fixture", description: "Native fixture command" }] });
      result = session(); break;
    case "session/set_mode": result = {}; break;
    case "session/set_model": configs[0].currentValue = p.modelId; result = {}; break;
    case "session/set_config_option":
      if (p.configId === "model" && p.value === "no-effort") configs.splice(1);
      configs.find((o) => o.id === p.configId).currentValue = p.value;
      result = { configOptions: configs }; break;
    case "session/cancel": cancelled = true; return;
    case "session/prompt": {
      cancelled = false; turns++;
      const text = p.prompt[0].text;
      if (text === "disconnect") process.exit(2);
      if (["incomplete-tool", "untyped-incomplete-tool", "other-tool-error", "cancel-incomplete-tool"].includes(text)) {
        update({ sessionUpdate: "tool_call", toolCallId: "unfinished-tool", title: "Run command", kind: "execute", status: "in_progress" });
        if (text === "cancel-incomplete-tool") {
          await ask("session/request_permission", { toolCall: { toolCallId: "unfinished-tool", title: "Run command", kind: "execute" }, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] });
          while (!cancelled) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        update({ sessionUpdate: "tool_call_update", toolCallId: "unfinished-tool", status: "failed", content: [{ type: "content", content: { type: "text", text: "Claude ended the turn without returning a result for this tool." } }] });
        send({ id: message.id, error: {
          code: -32603,
          message: "Internal error: Claude ended the turn without returning results for tool calls: unfinished-tool",
          ...(text === "untyped-incomplete-tool" ? {} : { data: { errorKind: text === "other-tool-error" ? "no_result" : "incomplete_tool_call" } }),
        } });
        return;
      }
      if (text === "stderr") process.stderr.write("x".repeat(180000) + "\n");
      if (text.startsWith("hang:")) {
        const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });
        writeFileSync(text.slice(5), `${process.pid},${child.pid}`);
        await new Promise(() => {}); // Ignores protocol cancellation deliberately.
      }
      const replies = [];
      if (text === "interactions") {
        replies.push(await ask("session/request_permission", { toolCall: { toolCallId: "shell", title: "Run command", kind: "execute" }, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }));
        replies.push(await ask("elicitation/create", { mode: "form", message: "Choose options", requestedSchema: { type: "object", properties: { choice: { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] }, many: { type: "array", items: { anyOf: [{ const: "a" }, { const: "b" }] } } }, required: ["choice"] } }));
        replies.push(await ask("cursor/ask_question", { questions: [{ id: "q", prompt: "Which?", options: [{ id: "a", label: "A" }] }] }));
        replies.push(await ask("cursor/create_plan", { title: "Build fixture", plan: "1. Build it" }));
        replies.push(await ask("elicitation/create", { mode: "url", message: "Authenticate", url: "https://example.com/auth", elicitationId: "auth" }));
      }
      if (text === "waiting") await ask("session/request_permission", { toolCall: { toolCallId: "shell", title: "Wait", kind: "execute" }, options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }] });
      const answer = JSON.stringify({ turns, cwd: process.cwd(), model: configs[0].currentValue, effort: configs[1]?.currentValue ?? null, images: p.prompt.filter((b) => b.type === "image").length, replies: replies.map((r) => r.result) });
      for (const char of answer) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: char } });
      update({ sessionUpdate: "usage_update", used: 123, size: 200000, cost: { amount: 0.01, currency: "USD" } });
      result = { stopReason: cancelled ? "cancelled" : "end_turn" }; break;
    }
    default: send({ id: message.id, error: { code: -32601, message: "Unknown method" } }); return;
  }
  if (message.id !== undefined) send({ id: message.id, result });
}
createInterface({ input: process.stdin }).on("line", (line) => { void handle(JSON.parse(line)); });
