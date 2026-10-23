//! Per-agent headless invocation + stream parsing.
//!
//! Every adapter turns one agent CLI's machine-readable output into the shared
//! [`ChatEvent`] stream. Parsing is deliberately tolerant: unknown lines are
//! ignored (or surfaced as plain text for agents without a structured mode),
//! never a panic.

use serde::{Deserialize, Serialize};

use super::event::ChatEvent;

mod agy;
mod claude;
mod codex;
mod droid;
mod generic;
mod kimi;
mod opencode;

/// Autonomy level chosen in the composer. ACP agents can request live input;
/// headless agents receive their policy at launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Read-only: analyze and propose a plan, no edits.
    Plan,
    /// Edit files in the workspace; shell is limited by the agent's sandbox.
    AutoEdit,
    /// Auto-approve tools using the CLI's full-access mode. Native security
    /// policies may still reject an action.
    Full,
}

pub struct TurnRequest<'a> {
    /// Fully composed prompt (including any replay digest).
    pub prompt: &'a str,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub mode: PermissionMode,
    pub resume_id: Option<&'a str>,
}

/// How to launch one headless turn.
#[derive(Debug, Default)]
pub struct Invocation {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Prompt written to stdin (then closed). `None` → stdin is closed
    /// immediately; some CLIs (codex) hang waiting on an open stdin.
    pub stdin: Option<String>,
}

pub trait Parser: Send {
    fn parse_line(&mut self, line: &str) -> Vec<ChatEvent>;
    /// Called once at EOF to flush buffered state.
    fn finish(&mut self) -> Vec<ChatEvent> {
        Vec::new()
    }
}

/// Agents that can run as a chat session.
const CHAT_AGENTS: &[&str] = &[
    "claude", "codex", "cursor", "agy", "qwen", "opencode", "droid", "grok", "kimi", "aider",
    "goose",
];

/// Agents whose CLI can resume a native session by id.
const RESUMABLE: &[&str] = &[
    "claude", "codex", "cursor", "agy", "qwen", "opencode", "droid", "kimi",
];

pub fn supports_chat(agent_id: &str) -> bool {
    CHAT_AGENTS.contains(&agent_id)
}

pub fn supports_resume(agent_id: &str) -> bool {
    RESUMABLE.contains(&agent_id)
}

/// For agents with no native read-only mode: steer via the prompt instead.
fn with_plan_preamble(prompt: &str, mode: PermissionMode) -> String {
    if mode == PermissionMode::Plan {
        format!(
            "Plan mode: do NOT modify any files or run commands that change state. \
             Investigate read-only and reply with a concrete plan.\n\n{prompt}"
        )
    } else {
        prompt.to_string()
    }
}

/// Prompts passed as argv must not be mistaken for a flag.
fn argv_prompt(prompt: String) -> String {
    if prompt.starts_with('-') {
        format!("\n{prompt}")
    } else {
        prompt
    }
}

fn push_opt(args: &mut Vec<String>, flag: &str, value: Option<&str>) {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        args.push(flag.into());
        args.push(v.into());
    }
}

pub fn build_invocation(agent_id: &str, req: &TurnRequest) -> Result<Invocation, String> {
    let mut args: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();
    let mut stdin = None;

    match agent_id {
        "claude" | "cursor" => return Err(format!("{agent_id} requires its native ACP connection")),
        "codex" => {
            args.extend(["exec", "--json", "--skip-git-repo-check"].map(String::from));
            push_opt(&mut args, "-m", req.model);
            if let Some(effort) = req.effort.filter(|e| !e.is_empty()) {
                args.push("-c".into());
                args.push(format!("model_reasoning_effort={effort}"));
            }
            match req.mode {
                PermissionMode::Plan => args.extend(["-s", "read-only"].map(String::from)),
                PermissionMode::AutoEdit => {
                    args.extend(["-s", "workspace-write"].map(String::from))
                }
                PermissionMode::Full => {
                    args.push("--dangerously-bypass-approvals-and-sandbox".into())
                }
            }
            if let Some(id) = req.resume_id {
                args.extend(["resume", id].map(String::from));
            }
            args.push("-".into());
            stdin = Some(req.prompt.to_string());
        }
        "agy" => {
            args.extend(["--output-format", "stream-json"].map(String::from));
            push_opt(&mut args, "--model", req.model);
            push_opt(&mut args, "--effort", req.effort);
            match req.mode {
                PermissionMode::Plan => args.extend(["--mode", "plan"].map(String::from)),
                PermissionMode::AutoEdit => {
                    args.extend(["--mode", "accept-edits"].map(String::from))
                }
                PermissionMode::Full => args.push("--dangerously-skip-permissions".into()),
            }
            push_opt(&mut args, "--conversation", req.resume_id);
            // `-p` swallows the next token as its prompt, so attach it.
            args.push(format!("-p={}", req.prompt));
        }
        "qwen" => {
            args.extend(["-o", "stream-json"].map(String::from));
            push_opt(&mut args, "-m", req.model);
            match req.mode {
                PermissionMode::Plan => args.extend(["--approval-mode", "plan"].map(String::from)),
                PermissionMode::AutoEdit => {
                    args.extend(["--approval-mode", "auto-edit"].map(String::from))
                }
                PermissionMode::Full => args.push("--yolo".into()),
            }
            push_opt(&mut args, "-r", req.resume_id);
            args.push("-p".into());
            args.push(req.prompt.to_string());
        }
        "opencode" => {
            args.extend(["run", "--format", "json"].map(String::from));
            push_opt(&mut args, "-m", req.model);
            push_opt(&mut args, "--variant", req.effort);
            match req.mode {
                PermissionMode::Plan => args.extend(["--agent", "plan"].map(String::from)),
                PermissionMode::AutoEdit => {}
                PermissionMode::Full => args.push("--auto".into()),
            }
            push_opt(&mut args, "-s", req.resume_id);
            args.push(argv_prompt(req.prompt.to_string()));
        }
        "droid" => {
            args.extend(["exec", "-o", "stream-json"].map(String::from));
            push_opt(&mut args, "-m", req.model);
            push_opt(&mut args, "-r", req.effort);
            match req.mode {
                PermissionMode::Plan => {}
                PermissionMode::AutoEdit => args.extend(["--auto", "medium"].map(String::from)),
                PermissionMode::Full => args.push("--skip-permissions-unsafe".into()),
            }
            push_opt(&mut args, "-s", req.resume_id);
            args.push(argv_prompt(with_plan_preamble(req.prompt, req.mode)));
        }
        "grok" => {
            args.extend(["--output-format", "streaming-json"].map(String::from));
            push_opt(&mut args, "-m", req.model);
            if req.mode == PermissionMode::Full {
                args.push("--always-approve".into());
            }
            args.push("-p".into());
            args.push(with_plan_preamble(req.prompt, req.mode));
        }
        "kimi" => {
            args.extend(["--output-format", "stream-json"].map(String::from));
            push_opt(&mut args, "-m", req.model);
            // `--yolo` / `--auto` are rejected together with `-p`; prompt mode
            // already uses auto permission (Kimi Code 2.x).
            push_opt(&mut args, "-S", req.resume_id);
            args.push("-p".into());
            args.push(with_plan_preamble(req.prompt, req.mode));
        }
        "aider" => {
            args.extend(["--no-pretty", "--no-stream", "--no-auto-commits"].map(String::from));
            push_opt(&mut args, "--model", req.model);
            if req.mode != PermissionMode::Plan {
                args.push("--yes-always".into());
            }
            args.push("--message".into());
            args.push(with_plan_preamble(req.prompt, req.mode));
        }
        "goose" => {
            if req.mode == PermissionMode::Full {
                env.push(("GOOSE_MODE".into(), "auto".into()));
            }
            args.extend(["run", "-t"].map(String::from));
            args.push(with_plan_preamble(req.prompt, req.mode));
        }
        other => return Err(format!("{other} does not support chat sessions yet")),
    }

    Ok(Invocation { args, env, stdin })
}

pub fn new_parser(agent_id: &str) -> Box<dyn Parser> {
    match agent_id {
        // Claude imports and Qwen use the legacy stream-json schema.
        "claude" | "qwen" => Box::new(claude::ClaudeParser::default()),
        "agy" => Box::new(agy::AgyParser::default()),
        "droid" => Box::new(droid::DroidParser::default()),
        "kimi" => Box::new(kimi::KimiParser),
        "codex" => Box::new(codex::CodexParser::default()),
        "opencode" => Box::new(opencode::OpenCodeParser::default()),
        _ => Box::new(generic::GenericParser::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(mode: PermissionMode, resume: Option<&'static str>) -> TurnRequest<'static> {
        TurnRequest {
            prompt: "hello",
            model: Some("m1"),
            effort: None,
            mode,
            resume_id: resume,
        }
    }

    #[test]
    fn native_agents_cannot_fall_back_to_headless() {
        for agent in ["claude", "cursor"] {
            assert!(build_invocation(agent, &req(PermissionMode::Full, Some("abc"))).unwrap_err().contains("native ACP"));
        }
    }

    #[test]
    fn yolo_uses_each_headless_agents_native_policy() {
        for (agent, flag) in [
            ("codex", "--dangerously-bypass-approvals-and-sandbox"),
            ("agy", "--dangerously-skip-permissions"),
            ("qwen", "--yolo"),
            ("opencode", "--auto"),
            ("droid", "--skip-permissions-unsafe"),
            ("grok", "--always-approve"),
            ("aider", "--yes-always"),
        ] {
            let inv = build_invocation(agent, &req(PermissionMode::Full, None)).unwrap();
            assert!(inv.args.iter().any(|arg| arg == flag), "{agent}: {:?}", inv.args);
        }
        let goose = build_invocation("goose", &req(PermissionMode::Full, None)).unwrap();
        assert!(goose.env.contains(&("GOOSE_MODE".into(), "auto".into())));
        let kimi = build_invocation("kimi", &req(PermissionMode::Full, None)).unwrap();
        assert!(kimi.args.iter().any(|arg| arg == "-p"));
        assert!(!kimi.args.iter().any(|arg| arg == "--yolo" || arg == "--auto"));
    }

    #[test]
    fn codex_resume_comes_after_exec_options() {
        let inv = build_invocation("codex", &req(PermissionMode::AutoEdit, Some("tid"))).unwrap();
        let s = inv.args.join(" ");
        assert!(s.starts_with("exec --json"));
        assert!(s.contains("-s workspace-write resume tid -"));
        assert_eq!(inv.stdin.as_deref(), Some("hello"));
    }

    #[test]
    fn argv_prompt_never_starts_with_dash() {
        assert!(!argv_prompt("-rf".into()).starts_with('-'));
    }

    #[test]
    fn unsupported_agent_errors() {
        assert!(build_invocation("plandex", &req(PermissionMode::Plan, None)).is_err());
    }

    #[test]
    fn plan_preamble_only_in_plan_mode() {
        assert!(with_plan_preamble("x", PermissionMode::Plan).contains("Plan mode"));
        assert_eq!(with_plan_preamble("x", PermissionMode::Full), "x");
    }
}
