import { Component, createSignal, Show } from "solid-js";

export type AgentMode = "normal" | "acceptEdits" | "plan" | "bypass";

interface AgentModeSupport {
  cycle: AgentMode[];
  labels: Partial<Record<AgentMode, string>>;
  shortLabels: Partial<Record<AgentMode, string>>;
  markers: { pattern: RegExp; mode: AgentMode }[];
}

export interface AgentCommand {
  name: string;
  description: string;
  marker?: "/" | "\\";
}

export const AGENT_MODE_SUPPORT: Record<string, AgentModeSupport> = {
  claude: {
    cycle: ["normal", "acceptEdits", "plan"],
    labels: {
      acceptEdits: "auto-accept",
      plan: "plan mode",
      bypass: "bypass perms",
    },
    shortLabels: {
      acceptEdits: "auto",
      plan: "plan",
      bypass: "bypass",
    },
    markers: [
      { pattern: /accept edits on/i, mode: "acceptEdits" },
      { pattern: /plan mode on/i, mode: "plan" },
      { pattern: /bypass permissions on/i, mode: "bypass" },
    ],
  },
};

export const AGENT_SLASH_COMMANDS: Record<string, AgentCommand[]> = {
  claude: [
    { name: "clear", description: "Clear conversation history" },
    { name: "compact", description: "Compact conversation context" },
    { name: "config", description: "Open Claude Code configuration" },
    { name: "context", description: "Show or manage context" },
    { name: "cost", description: "Show token and usage cost" },
    { name: "init", description: "Initialize Claude Code project memory" },
    { name: "memory", description: "Edit Claude Code memory" },
    { name: "model", description: "Select or inspect the active model" },
    { name: "permissions", description: "Manage tool permissions" },
    { name: "resume", description: "Resume a previous conversation" },
    { name: "review", description: "Review code changes" },
    { name: "rewind", description: "Rewind conversation state" },
    { name: "status", description: "Show Claude Code status" },
    { name: "agents", description: "Manage subagents" },
    { name: "mcp", description: "Manage MCP servers" },
    { name: "hooks", description: "Manage hooks" },
    { name: "doctor", description: "Run diagnostics" },
    { name: "help", description: "Show help" },
    { name: "exit", description: "Exit Claude Code" },
  ],
  codex: [
    { name: "new", description: "Start a new conversation" },
    { name: "init", description: "Create project instructions" },
    { name: "compact", description: "Compact conversation context" },
    { name: "diff", description: "Show current changes" },
    { name: "mention", description: "Insert a file reference" },
    { name: "status", description: "Show current status" },
    { name: "model", description: "Select or inspect the active model" },
    { name: "permissions", description: "Configure approval mode" },
    { name: "ide", description: "Include IDE context" },
    { name: "keymap", description: "Remap TUI keyboard shortcuts" },
    { name: "vim", description: "Toggle Vim mode" },
    { name: "sandbox-add-read-dir", description: "Grant sandbox read access to a directory" },
    { name: "agent", description: "Switch active agent thread" },
    { name: "apps", description: "Browse apps and connectors" },
    { name: "plugins", description: "Browse and manage plugins" },
    { name: "hooks", description: "Manage lifecycle hooks" },
    { name: "clear", description: "Clear terminal and start a fresh chat" },
    { name: "archive", description: "Archive current session and exit" },
    { name: "delete", description: "Delete current session and exit" },
    { name: "copy", description: "Copy latest completed output" },
    { name: "exit", description: "Exit Codex" },
    { name: "experimental", description: "Toggle experimental features" },
    { name: "approve", description: "Approve one retry after auto review denial" },
    { name: "memories", description: "Configure memory use and generation" },
    { name: "skills", description: "Browse and use skills" },
    { name: "import", description: "Import Claude Code setup and chats" },
    { name: "feedback", description: "Send logs and feedback" },
    { name: "logout", description: "Sign out of Codex" },
    { name: "mcp", description: "List configured MCP tools" },
    { name: "fast", description: "Toggle Fast service tier" },
    { name: "plan", description: "Switch to plan mode" },
    { name: "goal", description: "Set, pause, resume, view, or clear a goal" },
    { name: "personality", description: "Choose communication style" },
    { name: "ps", description: "Show background terminals" },
    { name: "stop", description: "Stop background terminals" },
    { name: "fork", description: "Fork current conversation" },
    { name: "side", description: "Start a side conversation" },
    { name: "btw", description: "Start a side conversation" },
    { name: "raw", description: "Toggle raw scrollback mode" },
    { name: "resume", description: "Resume a saved conversation" },
    { name: "review", description: "Review working tree changes" },
    { name: "usage", description: "View account token usage" },
    { name: "debug-config", description: "Print config diagnostics" },
    { name: "statusline", description: "Configure status line fields" },
    { name: "title", description: "Configure terminal title fields" },
    { name: "theme", description: "Choose syntax highlighting theme" },
    { name: "quit", description: "Exit Codex" },
  ],
  cursor: [
    { name: "ask", description: "Switch to Ask mode" },
    { name: "plan", description: "Switch to Plan mode" },
    { name: "model", description: "Set or list models" },
    { name: "compress", description: "Summarize the conversation to free context" },
    { name: "usage", description: "Show usage and context stats" },
    { name: "rules", description: "Manage project rules" },
    { name: "commands", description: "Create or edit custom commands" },
    { name: "mcp", description: "Manage MCP servers and list tools" },
    { name: "plugin", description: "Manage plugins and marketplaces" },
    { name: "config", description: "Configure CLI settings" },
    { name: "sandbox", description: "Configure sandbox and network access" },
    { name: "setup-terminal", description: "Configure terminal newline keybindings" },
    { name: "help", description: "Show help" },
    { name: "feedback", description: "Share feedback with the team" },
    { name: "open", description: "Open the repository Git root in Cursor" },
    { name: "cursor", description: "Open the repository Git root in Cursor" },
    { name: "copy", description: "Copy a previous user message" },
    { name: "copy-request-id", description: "Copy the last request ID" },
    { name: "copy-conversation-id", description: "Copy the current conversation ID" },
    { name: "logout", description: "Sign out from Cursor" },
    { name: "quit", description: "Exit Cursor CLI" },
    { name: "exit", description: "Exit Cursor CLI" },
    { name: "bedrock", description: "Configure Bedrock when enabled" },
  ],
  opencode: [
    { name: "connect", description: "Add a provider and API keys" },
    { name: "compact", description: "Compact the current session" },
    { name: "summarize", description: "Compact the current session" },
    { name: "details", description: "Toggle tool execution details" },
    { name: "editor", description: "Open external editor for composing messages" },
    { name: "exit", description: "Exit OpenCode" },
    { name: "quit", description: "Exit OpenCode" },
    { name: "q", description: "Exit OpenCode" },
    { name: "export", description: "Export current conversation to Markdown" },
    { name: "help", description: "Show the help dialog" },
    { name: "init", description: "Create or update AGENTS.md" },
    { name: "models", description: "List available models" },
    { name: "new", description: "Start a new session" },
    { name: "clear", description: "Start a new session" },
    { name: "redo", description: "Redo a previously undone message" },
    { name: "sessions", description: "List and switch between sessions" },
    { name: "resume", description: "List and switch between sessions" },
    { name: "continue", description: "List and switch between sessions" },
    { name: "share", description: "Share current session" },
    { name: "unshare", description: "Unshare current session" },
    { name: "themes", description: "List available themes" },
    { name: "thinking", description: "Toggle thinking block visibility" },
    { name: "undo", description: "Undo last message and file changes" },
  ],
  aider: [
    { name: "add", description: "Add files to the chat" },
    { name: "architect", description: "Enter architect/editor mode" },
    { name: "ask", description: "Ask about the codebase without editing" },
    { name: "chat-mode", description: "Switch to a new chat mode" },
    { name: "clear", description: "Clear chat history" },
    { name: "code", description: "Ask for code changes" },
    { name: "commit", description: "Commit edits made outside the chat" },
    { name: "context", description: "See surrounding code context" },
    { name: "copy", description: "Copy the last assistant message" },
    { name: "copy-context", description: "Copy current chat context as Markdown" },
    { name: "diff", description: "Display changes since the last message" },
    { name: "drop", description: "Remove files from the chat" },
    { name: "edit", description: "Open an editor to write a prompt" },
    { name: "editor", description: "Open an editor to write a prompt" },
    { name: "editor-model", description: "Switch the editor model" },
    { name: "exit", description: "Exit aider" },
    { name: "git", description: "Run a git command" },
    { name: "help", description: "Ask questions about aider" },
    { name: "lint", description: "Lint and fix files" },
    { name: "load", description: "Load and execute commands from a file" },
    { name: "ls", description: "List known files and chat inclusion status" },
    { name: "map", description: "Print the repository map" },
    { name: "map-refresh", description: "Refresh the repository map" },
    { name: "model", description: "Switch the main model" },
    { name: "models", description: "Search available models" },
    { name: "multiline-mode", description: "Toggle multiline mode" },
    { name: "ok", description: "Approve proceeding with changes" },
    { name: "paste", description: "Paste image or text from clipboard" },
    { name: "quit", description: "Exit aider" },
    { name: "read-only", description: "Add read-only reference files" },
    { name: "reasoning-effort", description: "Set reasoning effort" },
    { name: "report", description: "Report a problem" },
    { name: "reset", description: "Drop files and clear chat history" },
    { name: "run", description: "Run a shell command" },
    { name: "save", description: "Save commands to reconstruct the session" },
    { name: "settings", description: "Print current settings" },
    { name: "test", description: "Run a shell command and add failing output" },
    { name: "think-tokens", description: "Set thinking token budget" },
    { name: "tokens", description: "Report context token usage" },
    { name: "undo", description: "Undo the last aider git commit" },
    { name: "voice", description: "Record and transcribe voice input" },
    { name: "weak-model", description: "Switch the weak model" },
    { name: "web", description: "Scrape a webpage into the chat" },
  ],
  goose: [
    { name: "?", description: "Display the help menu" },
    { name: "help", description: "Display the help menu" },
    { name: "builtin", description: "Add builtin extensions by name" },
    { name: "clear", description: "Clear current chat history" },
    { name: "endplan", description: "Exit plan mode" },
    { name: "exit", description: "Exit the session" },
    { name: "quit", description: "Exit the session" },
    { name: "extension", description: "Add a stdio extension" },
    { name: "mode", description: "Set goose mode" },
    { name: "plan", description: "Enter plan mode with optional message" },
    { name: "prompt", description: "Get prompt info or execute a prompt" },
    { name: "prompts", description: "List available prompts" },
    { name: "recipe", description: "Generate a recipe from the conversation" },
    { name: "compact", description: "Compact and summarize conversation" },
    { name: "r", description: "Toggle full tool output display" },
    { name: "skills", description: "List available skills" },
    { name: "t", description: "Toggle or set theme" },
  ],
  agy: [
    { name: "btw", description: "Ask a side question" },
    { name: "clear", description: "Clear the current conversation" },
    { name: "config", description: "Configure Antigravity CLI settings" },
    { name: "context", description: "Show context window usage" },
    { name: "help", description: "Show help and commands" },
    { name: "mcp", description: "Configure and manage MCP servers" },
    { name: "model", description: "View or switch the current model" },
    { name: "open", description: "Open a path" },
    { name: "permissions", description: "Manage permission rules" },
    { name: "planning", description: "Configure planning behavior" },
    { name: "settings", description: "Configure Antigravity CLI settings" },
  ],
  cline: [
    { name: "newtask", description: "Start a fresh task with distilled context" },
    { name: "smol", description: "Compress conversation history" },
    { name: "newrule", description: "Create a rule file" },
    { name: "deep-planning", description: "Investigate and plan a complex implementation" },
    { name: "reportbug", description: "Report a bug with diagnostic info" },
    { name: "history", description: "Resume a previous task" },
    { name: "settings", description: "Change configuration mid-session" },
  ],
  qwen: [
    { name: "init", description: "Analyze current directory and create context" },
    { name: "summary", description: "Generate a project summary" },
    { name: "compress", description: "Compress chat history" },
    { name: "summarize", description: "Compress chat history" },
    { name: "compress-fast", description: "Fast compression without AI" },
    { name: "resume", description: "Resume a previous session" },
    { name: "continue", description: "Resume a previous session" },
    { name: "recap", description: "Generate a one-line session recap" },
    { name: "restore", description: "Restore files to a checkpoint" },
    { name: "delete", description: "Delete a previous session" },
    { name: "branch", description: "Fork current conversation" },
    { name: "fork", description: "Spawn a background agent" },
    { name: "rewind", description: "Rewind conversation to a previous turn" },
    { name: "rollback", description: "Rewind conversation to a previous turn" },
    { name: "export", description: "Export session history" },
    { name: "rename", description: "Rename or tag current session" },
    { name: "tag", description: "Rename or tag current session" },
    { name: "clear", description: "Clear conversation history" },
    { name: "reset", description: "Clear conversation history" },
    { name: "new", description: "Clear conversation history" },
    { name: "context", description: "Show context window usage" },
    { name: "history", description: "Control history display" },
    { name: "diff", description: "Open interactive diff viewer" },
    { name: "theme", description: "Change visual theme" },
    { name: "vim", description: "Toggle Vim editing mode" },
    { name: "voice", description: "Toggle voice dictation input" },
    { name: "directory", description: "Manage multi-directory workspace" },
    { name: "dir", description: "Manage multi-directory workspace" },
    { name: "cd", description: "Move session to a new working directory" },
    { name: "editor", description: "Select supported editor" },
    { name: "statusline", description: "Configure status line" },
    { name: "terminal-setup", description: "Configure multiline input keybindings" },
    { name: "language", description: "View or change language settings" },
    { name: "mcp", description: "List configured MCP servers and tools" },
    { name: "import-config", description: "Import MCP servers from Claude configs" },
    { name: "tools", description: "Display available tools" },
    { name: "skills", description: "List and run available skills" },
    { name: "plan", description: "Switch plan mode on or off" },
    { name: "approval-mode", description: "Change tool approval mode" },
    { name: "model", description: "Switch model" },
    { name: "effort", description: "Set reasoning effort" },
    { name: "extensions", description: "Manage extensions" },
    { name: "memory", description: "Open memory manager" },
    { name: "remember", description: "Save a durable memory" },
    { name: "forget", description: "Remove matching auto-memory entries" },
    { name: "dream", description: "Run auto-memory consolidation" },
    { name: "hooks", description: "Manage hooks" },
    { name: "permissions", description: "Manage permission rules" },
    { name: "agents", description: "Manage subagents" },
    { name: "arena", description: "Manage Arena sessions" },
    { name: "goal", description: "Set or clear a persistent goal" },
    { name: "tasks", description: "List background tasks" },
    { name: "workflows", description: "Inspect workflow runs" },
    { name: "lsp", description: "Show LSP server status" },
    { name: "trust", description: "Manage folder trust settings" },
    { name: "review", description: "Review code changes" },
    { name: "loop", description: "Run a recurring prompt" },
    { name: "simplify", description: "Review and apply cleanup edits" },
    { name: "qc-helper", description: "Ask about Qwen Code usage" },
    { name: "btw", description: "Ask a quick side question" },
    { name: "help", description: "Display command help" },
    { name: "?", description: "Display command help" },
    { name: "status", description: "Display version and session info" },
    { name: "about", description: "Display version and session info" },
    { name: "stats", description: "Open usage statistics" },
    { name: "usage", description: "Open usage statistics" },
    { name: "settings", description: "Open settings editor" },
    { name: "config", description: "Get or set settings" },
    { name: "auth", description: "Change authentication method" },
    { name: "connect", description: "Change authentication method" },
    { name: "login", description: "Change authentication method" },
    { name: "doctor", description: "Run diagnostics" },
    { name: "docs", description: "Open documentation" },
    { name: "ide", description: "Manage IDE integration" },
    { name: "insight", description: "Generate programming insights" },
    { name: "setup-github", description: "Set up GitHub Actions" },
    { name: "bug", description: "Submit issue about Qwen Code" },
    { name: "copy", description: "Copy reply, code, or formatted output" },
    { name: "quit", description: "Exit Qwen Code" },
    { name: "exit", description: "Exit Qwen Code" },
  ],
  plandex: [
    { name: "quit", description: "Quit the Plandex REPL", marker: "\\" },
    { name: "q", description: "Quit the Plandex REPL", marker: "\\" },
    { name: "help", description: "Show REPL help", marker: "\\" },
    { name: "h", description: "Show REPL help", marker: "\\" },
    { name: "run", description: "Use a file as a prompt", marker: "\\" },
    { name: "r", description: "Use a file as a prompt", marker: "\\" },
    { name: "chat", description: "Switch to chat mode", marker: "\\" },
    { name: "ch", description: "Switch to chat mode", marker: "\\" },
    { name: "tell", description: "Switch to tell implementation mode", marker: "\\" },
    { name: "t", description: "Switch to tell implementation mode", marker: "\\" },
    { name: "multi", description: "Switch to multi-line mode", marker: "\\" },
    { name: "m", description: "Switch to multi-line mode", marker: "\\" },
  ],
  droid: [
    { name: "account", description: "Open Factory account settings" },
    { name: "billing", description: "View and manage billing settings" },
    { name: "btw", description: "Ask a side question" },
    { name: "bug", description: "Create a bug report" },
    { name: "clear", description: "Start a new session" },
    { name: "commands", description: "Manage custom slash commands" },
    { name: "compress", description: "Compress session into a new one" },
    { name: "context", description: "Show context window usage" },
    { name: "copy", description: "Copy prompts, responses, or session ID" },
    { name: "cost", description: "Show usage statistics" },
    { name: "create-skill", description: "Create a reusable skill" },
    { name: "cwd", description: "Change session working directory" },
    { name: "diagnostics", description: "Show settings errors" },
    { name: "droids", description: "Manage custom droids" },
    { name: "missions", description: "Enter Mission Mode" },
    { name: "fast", description: "Enable or disable fast mode" },
    { name: "favorite", description: "Mark current session as favorite" },
    { name: "fork", description: "Duplicate current session" },
    { name: "help", description: "Show available slash commands" },
    { name: "hooks", description: "Manage lifecycle hooks" },
    { name: "ide", description: "Configure IDE integrations" },
    { name: "install-code-review", description: "Set up automated code review" },
    { name: "install-slack-app", description: "Install or connect Slack integration" },
    { name: "language", description: "Switch TUI display language" },
    { name: "limits", description: "Manage token usage limits" },
    { name: "login", description: "Sign in to Factory" },
    { name: "logout", description: "Sign out of Factory" },
    { name: "mcp", description: "Manage MCP servers" },
    { name: "model", description: "Switch AI model" },
    { name: "new", description: "Start a new session" },
    { name: "plugins", description: "Manage plugins and marketplaces" },
    { name: "quit", description: "Exit Droid" },
    { name: "readiness-fix", description: "Fix failing readiness signals" },
    { name: "readiness-report", description: "Generate readiness report" },
    { name: "rename", description: "Rename current session" },
    { name: "review", description: "Start AI code review workflow" },
    { name: "rewind-conversation", description: "Undo recent session changes" },
    { name: "sessions", description: "List and select previous sessions" },
    { name: "settings", description: "Configure application settings" },
    { name: "setup-incident-response", description: "Set up Slack incident response" },
    { name: "share", description: "Share session with organization" },
    { name: "skills", description: "Manage and invoke skills" },
    { name: "stats", description: "Show usage statistics" },
    { name: "status", description: "Show Droid status" },
    { name: "statusline", description: "Configure custom status line" },
    { name: "terminal-setup", description: "Configure terminal keybindings" },
    { name: "themes", description: "Choose a color theme" },
  ],
};

export function stripAnsi(value: string) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function supportsModes(agentId: string) {
  return agentId in AGENT_MODE_SUPPORT;
}

export function detectModeMarker(agentId: string, stripped: string): AgentMode | null {
  const support = AGENT_MODE_SUPPORT[agentId];
  if (!support) return null;

  let detected: { index: number; mode: AgentMode } | null = null;
  for (const marker of support.markers) {
    marker.pattern.lastIndex = 0;
    const match = marker.pattern.exec(stripped);
    if (match && match.index >= (detected?.index ?? -1)) {
      detected = { index: match.index, mode: marker.mode };
    }
  }

  return detected?.mode ?? null;
}

export function nextMode(agentId: string, current: AgentMode): AgentMode | null {
  const cycle = AGENT_MODE_SUPPORT[agentId]?.cycle;
  if (!cycle) return null;

  const index = cycle.indexOf(current);
  if (index === -1) return null;
  return cycle[(index + 1) % cycle.length];
}

export function agentModeLabel(agentId: string, mode: AgentMode) {
  return AGENT_MODE_SUPPORT[agentId]?.labels[mode] ?? null;
}

export function agentModeShortLabel(agentId: string, mode: AgentMode) {
  return AGENT_MODE_SUPPORT[agentId]?.shortLabels[mode] ?? null;
}

// ── Agent visual identity (colors, letters, logo) ────────────────────────────
// Single source of truth for how an agent is represented in the UI. Consumed
// by App.tsx, AgentBar.tsx, TerminalPanel.tsx, PromptComposer.tsx, and
// AgentTaskDialog.tsx.

const AGENT_COLORS: Record<string, string> = {
  claude: "#D97756",
  qwen: "#a371f7",
  gemini: "#1A73E8",
  codex: "#10A37F",
  cursor: "#8b949e", // Cursor's mark is monochrome black/white; #0A0A0A was
                     // near-invisible on the app's dark surfaces, so this uses
                     // a neutral light gray for legible contrast instead.
  agy: "#1A73E8",
  aider: "#f0883e",
  opencode: "#0052CC",
  cline: "#39c5cf",
  goose: "#56d364",
  plandex: "#a5d6ff",
  droid: "#f778ba",
  run: "#3fb950",
  validate: "#58a6ff",
};

export function agentColor(agentId: string): string {
  return AGENT_COLORS[agentId] ?? "#8b949e";
}

export function agentLetter(agentId: string): string {
  const map: Record<string, string> = {
    claude: "C", qwen: "Q", gemini: "G", codex: "X", cursor: "C",
    agy: "A", aider: "D", opencode: "O", cline: "L", goose: "S", plandex: "P", droid: "R",
    run: "▶",
    validate: "✓",
  };
  return map[agentId] ?? agentId[0]?.toUpperCase() ?? "?";
}

export const AgentLogo: Component<{
  agentId: string;
  icon?: string | null;
  name?: string;
  size?: number;
  radius?: number;
}> = (props) => {
  const [imageFailed, setImageFailed] = createSignal(false);
  const [imageLoaded, setImageLoaded] = createSignal(false);
  const size = () => props.size ?? 24;
  const radius = () => props.radius ?? 7;

  return (
    <span style={{
      width: `${size()}px`, height: `${size()}px`,
      "border-radius": `${radius()}px`,
      background: `${agentColor(props.agentId)}22`,
      border: "1px solid rgba(255,255,255,.08)",
      display: "flex", "align-items": "center", "justify-content": "center",
      overflow: "hidden",
      flex: "0 0 auto",
    }}>
      <Show when={props.icon && !imageFailed()} fallback={
        <span style={{
          color: "#f0f6fc",
          "font-family": "'JetBrains Mono', monospace",
          "font-weight": "700", "font-size": `${Math.max(10, Math.round(size() * 0.52))}px`,
          "line-height": "1",
        }}>
          {agentLetter(props.agentId)}
        </span>
      }>
        <img
          src={props.icon ?? ""}
          alt={props.name ? `${props.name} logo` : ""}
          onError={() => setImageFailed(true)}
          onLoad={() => setImageLoaded(true)}
          style={{
            width: "100%", height: "100%",
            "object-fit": "contain",
            display: "block",
            opacity: imageLoaded() ? "1" : "0",
            transition: "opacity var(--dur-base) var(--ease-standard)",
          }}
        />
      </Show>
    </span>
  );
};
