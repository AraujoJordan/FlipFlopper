//! App-wide usage: one row per finished turn, built from the transcripts FlipFlopper already stores.
//! Tokens come from `Usage` events; cost comes from `Usage.cost_usd`, or, for agents that report a
//! running session total in `ContextUsage.cost_usd`, from the change since the previous turn.

use crate::chat::event::ChatEvent;
use crate::chat::store::{self, Entry};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageRow {
    /// When the turn ended (ms since epoch).
    pub ts: u64,
    pub agent: String,
    pub model: String,
    pub project: String,
    pub session: String,
    pub input: u64,
    pub output: u64,
    /// `None` when the agent reported no cost.
    pub cost: Option<f64>,
}

/// Rows for one transcript, keeping turns that ended at or after `since_ms`.
pub fn rows_for(entries: &[Entry], project: &str, session: &str, since_ms: u64) -> Vec<UsageRow> {
    let mut rows = Vec::new();
    let mut agent = String::new();
    let mut model = String::new();
    let (mut input, mut output) = (0u64, 0u64);
    let mut summed: Option<f64> = None;
    let mut cumulative: Option<f64> = None;
    let mut previous_cumulative: Option<f64> = None;
    for entry in entries {
        let Entry::Event { event, ts } = entry else { continue };
        match event {
            ChatEvent::TurnStarted { agent_id, .. } => {
                agent = agent_id.clone();
                model.clear();
                (input, output, summed, cumulative) = (0, 0, None, None);
            }
            ChatEvent::Model { name } => model = name.clone(),
            ChatEvent::Usage { input_tokens, output_tokens, cost_usd } => {
                input += input_tokens;
                output += output_tokens;
                if let Some(cost) = cost_usd {
                    summed = Some(summed.unwrap_or(0.0) + cost);
                }
            }
            ChatEvent::ContextUsage { cost_usd: Some(cost), .. } => cumulative = Some(*cost),
            ChatEvent::TurnEnded { .. } => {
                let delta = cumulative.map(|total| (total - previous_cumulative.unwrap_or(0.0)).max(0.0));
                if cumulative.is_some() {
                    previous_cumulative = cumulative;
                }
                let cost = summed.or(delta);
                if *ts >= since_ms && (input + output > 0 || cost.is_some()) {
                    rows.push(UsageRow {
                        ts: *ts,
                        agent: agent.clone(),
                        model: if model.is_empty() { "default".into() } else { model.clone() },
                        project: project.to_string(),
                        session: session.to_string(),
                        input,
                        output,
                        cost,
                    });
                }
            }
            _ => {}
        }
    }
    rows
}

/// Rows for every stored session active in the last `days` days (side-question sessions included).
pub fn usage_rows(days: u32) -> Vec<UsageRow> {
    let since = store::now_ms().saturating_sub(u64::from(days.clamp(1, 365)) * 86_400_000);
    let mut rows: Vec<UsageRow> = store::list_sessions()
        .into_iter()
        .filter(|session| session.updated_at >= since)
        .flat_map(|session| rows_for(&store::load_entries(&session.id), &session.project_path, &session.id, since))
        .collect();
    rows.sort_by_key(|row| row.ts);
    rows
}

/// A provider usage/rate-limit notice found in a stored transcript.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageLimitEvent {
    pub ts: u64,
    pub agent: String,
    pub project: String,
    pub session: String,
    pub session_title: String,
    pub title: String,
    pub message: String,
}

fn looks_like_limit(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("usage limit")
        || lower.contains("quota")
        || lower.contains("too many requests")
        || lower.contains("429")
}

fn limit_events_for(
    entries: &[Entry],
    initial_agent: &str,
    project: &str,
    session: &str,
    session_title: &str,
    since: u64,
) -> Vec<UsageLimitEvent> {
    let mut agent = initial_agent.to_string();
    let mut events = Vec::new();
    for entry in entries {
        let Entry::Event { event, ts } = entry else { continue };
        if let ChatEvent::TurnStarted { agent_id, .. } = event {
            agent = agent_id.clone();
            continue;
        }
        if *ts < since {
            continue;
        }
        let (title, message) = match event {
            ChatEvent::TurnStarted { .. } => continue,
            ChatEvent::Notice { severity, title, description } => {
                let message = description.clone().unwrap_or_default();
                if !looks_like_limit(&format!("{title} {message}")) {
                    continue;
                }
                (title.clone(), format!("{severity}{}{}", if message.is_empty() { "" } else { " · " }, message))
            }
            ChatEvent::Error { message } => {
                if !looks_like_limit(message) {
                    continue;
                }
                ("Provider error".into(), message.clone())
            }
            _ => continue,
        };
        events.push(UsageLimitEvent {
            ts: *ts,
            agent: agent.clone(),
            project: project.to_string(),
            session: session.to_string(),
            session_title: session_title.to_string(),
            title,
            message,
        });
    }
    events
}

/// Limit/quota notices and errors from transcripts updated in the last `days` days,
/// newest first. Provider quotas themselves stay with the provider account.
pub fn limit_events(days: u32) -> Vec<UsageLimitEvent> {
    let since = store::now_ms().saturating_sub(u64::from(days.clamp(1, 365)) * 86_400_000);
    let mut events: Vec<UsageLimitEvent> = store::list_sessions()
        .into_iter()
        .filter(|session| session.updated_at >= since)
        .flat_map(|session| {
            limit_events_for(
                &store::load_entries(&session.id),
                &session.agent_id,
                &session.project_path,
                &session.id,
                &session.title,
                since,
            )
        })
        .collect();
    events.sort_by(|a, b| b.ts.cmp(&a.ts));
    events.truncate(100);
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::event::TurnStatus;

    fn ev(event: ChatEvent, ts: u64) -> Entry {
        Entry::Event { event, ts }
    }
    fn turn(n: u64, usage: Option<(u64, u64, Option<f64>)>, context_cost: Option<f64>, model: Option<&str>) -> Vec<Entry> {
        let mut entries = vec![ev(ChatEvent::TurnStarted { turn_id: format!("t{n}"), agent_id: "claude".into(), checkpoint: None }, n * 1000)];
        if let Some(name) = model {
            entries.push(ev(ChatEvent::Model { name: name.into() }, n * 1000 + 1));
        }
        if let Some((input_tokens, output_tokens, cost_usd)) = usage {
            entries.push(ev(ChatEvent::Usage { input_tokens, output_tokens, cost_usd }, n * 1000 + 2));
        }
        if let Some(cost) = context_cost {
            entries.push(ev(ChatEvent::ContextUsage { used: 1, size: 2, cost_usd: Some(cost) }, n * 1000 + 3));
        }
        entries.push(ev(ChatEvent::TurnEnded { turn_id: format!("t{n}"), status: TurnStatus::Done, changed_files: vec![] }, n * 1000 + 4));
        entries
    }

    #[test]
    fn limit_events_keep_only_quota_and_rate_limit_notices_after_the_cutoff() {
        let entries = vec![
            ev(ChatEvent::TurnStarted { turn_id: "t".into(), agent_id: "claude".into(), checkpoint: None }, 1000),
            ev(ChatEvent::Notice { severity: "warning".into(), title: "Rate limited".into(), description: Some("Retrying in 30s".into()) }, 2000),
            ev(ChatEvent::Notice { severity: "info".into(), title: "Model fallback".into(), description: None }, 3000),
            ev(ChatEvent::Error { message: "429 Too Many Requests".into() }, 4000),
            ev(ChatEvent::Error { message: "Network unreachable".into() }, 5000),
        ];
        let events = limit_events_for(&entries, "codex", "/p", "s", "Session", 1500);
        assert_eq!(events.len(), 2);
        assert_eq!((events[0].agent.as_str(), events[0].title.as_str()), ("claude", "Rate limited"));
        assert!(events[0].message.contains("Retrying"));
        assert!(events[1].message.contains("429"));
        assert!(limit_events_for(&entries, "codex", "/p", "s", "Session", 4500).is_empty(), "cutoff filters old notices");
    }

    #[test]
    fn per_turn_costs_are_summed_and_cumulative_costs_become_deltas() {
        let summed = [turn(1, Some((100, 20, Some(0.5))), None, Some("gpt")), turn(2, Some((10, 5, Some(0.25))), None, None)].concat();
        let rows = rows_for(&summed, "/p", "s", 0);
        assert_eq!(rows.iter().map(|r| (r.input, r.output, r.cost)).collect::<Vec<_>>(), vec![(100, 20, Some(0.5)), (10, 5, Some(0.25))]);
        assert_eq!((rows[0].model.as_str(), rows[1].model.as_str(), rows[0].project.as_str()), ("gpt", "default", "/p"));

        let running_total = [turn(1, Some((50, 5, None)), Some(0.40), None), turn(2, Some((60, 6, None)), Some(0.90), None), turn(3, None, Some(0.90), None)].concat();
        let costs: Vec<_> = rows_for(&running_total, "/p", "s", 0).iter().map(|r| r.cost.map(|c| (c * 100.0).round() as i64)).collect();
        assert_eq!(costs, vec![Some(40), Some(50), Some(0)], "the third turn reported no new spend");
    }

    #[test]
    fn the_window_and_empty_turns_filter_rows() {
        let entries = [turn(1, Some((10, 1, Some(0.1))), None, None), turn(2, Some((20, 2, Some(0.2))), None, None), turn(3, None, None, None)].concat();
        let rows = rows_for(&entries, "/p", "s", 2000);
        assert_eq!(rows.len(), 1, "turn 1 is outside the window and turn 3 reported nothing");
        assert_eq!(rows[0].input, 20);
        // A cumulative baseline set before the window still produces correct deltas inside it.
        let history = [turn(1, None, Some(1.0), None), turn(2, None, Some(1.5), None)].concat();
        let rows = rows_for(&history, "/p", "s", 2000);
        assert_eq!(rows.len(), 1);
        assert!((rows[0].cost.unwrap() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn usage_rows_read_stored_sessions_in_time_order() {
        let _env = store::ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let data = std::env::temp_dir().join(format!("ff-usage-{}", uuid::Uuid::new_v4()));
        let previous = std::env::var_os("FLIPFLOPPER_DATA_DIR");
        std::env::set_var("FLIPFLOPPER_DATA_DIR", &data);
        let now = store::now_ms();
        let recent = [vec![ev(ChatEvent::TurnStarted { turn_id: "t".into(), agent_id: "codex".into(), checkpoint: None }, now - 1000)], vec![ev(ChatEvent::Usage { input_tokens: 7, output_tokens: 3, cost_usd: Some(0.07) }, now - 900)], vec![ev(ChatEvent::TurnEnded { turn_id: "t".into(), status: TurnStatus::Done, changed_files: vec![] }, now - 800)]].concat();
        let session = crate::chat::create_session(crate::chat::NewSession { project_path: "/proj".into(), cwd: None, worktree: None, agent_id: "codex".into(), model: None, effort: None, mode: crate::chat::adapters::PermissionMode::AutoEdit, yolo: false, parent_id: None, compare_group: None, title: None }).unwrap();
        store::write_entries(&session.id, &recent).unwrap();
        let rows = usage_rows(30);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].agent.as_str(), rows[0].project.as_str(), rows[0].input, rows[0].output), ("codex", "/proj", 7, 3));
        assert!(usage_rows(0).len() <= 1, "days are clamped to at least one");
        match previous { Some(value) => std::env::set_var("FLIPFLOPPER_DATA_DIR", value), None => std::env::remove_var("FLIPFLOPPER_DATA_DIR") }
        let _ = std::fs::remove_dir_all(data);
    }
}
