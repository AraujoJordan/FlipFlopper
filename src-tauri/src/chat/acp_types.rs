//! UI-facing ACP state. Provider payloads are confined to interaction cards;
//! credentials and raw protocol traffic are never added to the transcript.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RuntimeState {
    pub connected: bool,
    #[serde(default)]
    pub active_turn_id: Option<String>,
    pub agent_id: String,
    pub native_session_id: Option<String>,
    pub agent_version: Option<String>,
    pub capabilities: Value,
    pub config_options: Vec<Value>,
    pub modes: Vec<Value>,
    pub current_mode: Option<String>,
    pub commands: Vec<Value>,
    pub pending: Vec<Interaction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interaction {
    pub id: String,
    pub turn_id: String,
    pub kind: InteractionKind,
    pub title: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    Permission,
    Form,
    Question,
    Plan,
    Url,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FormAction {
    Accept,
    Decline,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionAnswer {
    #[serde(rename = "questionId")]
    pub question_id: String,
    #[serde(rename = "selectedOptionIds")]
    pub selected_option_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteractionResponse {
    Permission {
        option_id: Option<String>,
    },
    Form {
        action: FormAction,
        #[serde(default)]
        content: Value,
    },
    Question {
        action: FormAction,
        #[serde(default)]
        answers: Vec<QuestionAnswer>,
    },
    Plan {
        accepted: bool,
        reason: Option<String>,
        #[serde(default)]
        cancelled: bool,
    },
    Url {
        action: FormAction,
    },
}

impl Interaction {
    pub fn cancelled(&self) -> Value {
        match self.kind {
            InteractionKind::Permission => json!({"outcome":{"outcome":"cancelled"}}),
            InteractionKind::Question | InteractionKind::Plan => {
                json!({"outcome":{"outcome":"cancelled"}})
            }
            InteractionKind::Form | InteractionKind::Url => json!({"action":"cancel"}),
        }
    }

    /// Validate against the *live provider request*. UI values/option IDs are
    /// never treated as permission rules or passed through unchecked.
    pub fn respond(&self, response: &InteractionResponse) -> Result<Value, String> {
        match (self.kind, response) {
            (InteractionKind::Permission, InteractionResponse::Permission { option_id }) => {
                let Some(id) = option_id else {
                    return Ok(self.cancelled());
                };
                let options = self.payload["options"]
                    .as_array()
                    .ok_or("Permission options missing")?;
                if !options.iter().any(|o| o["optionId"].as_str() == Some(id)) {
                    return Err("Unknown permission option".into());
                }
                Ok(json!({"outcome":{"outcome":"selected","optionId":id}}))
            }
            (InteractionKind::Form, InteractionResponse::Form { action, content }) => {
                if *action == FormAction::Accept {
                    validate_form(&self.payload["requestedSchema"], content)?;
                }
                Ok(
                    json!({"action":action,"content":if *action == FormAction::Accept { content.clone() } else { Value::Null }}),
                )
            }
            (InteractionKind::Url, InteractionResponse::Url { action }) => {
                Ok(json!({"action":action}))
            }
            (
                InteractionKind::Plan,
                InteractionResponse::Plan {
                    accepted,
                    reason,
                    cancelled,
                },
            ) => Ok(if *cancelled {
                self.cancelled()
            } else if *accepted {
                json!({"outcome":{"outcome":"accepted"}})
            } else {
                json!({"outcome":{"outcome":"rejected","reason":reason}})
            }),
            (InteractionKind::Question, InteractionResponse::Question { action, answers }) => {
                if *action != FormAction::Accept {
                    return Ok(
                        json!({"outcome":{"outcome":if *action == FormAction::Cancel {"cancelled"} else {"skipped"}}}),
                    );
                }
                let questions = self.payload["questions"]
                    .as_array()
                    .ok_or("Questions missing")?;
                if answers.len() != questions.len() {
                    return Err("Answer every question".into());
                }
                let mut seen = std::collections::HashSet::new();
                for answer in answers {
                    if !seen.insert(&answer.question_id) {
                        return Err("Duplicate answer".into());
                    }
                    let q = questions
                        .iter()
                        .find(|q| q["id"].as_str() == Some(&answer.question_id))
                        .ok_or("Unknown question")?;
                    if answer.selected_option_ids.is_empty()
                        || (q["allowMultiple"] != true && answer.selected_option_ids.len() != 1)
                    {
                        return Err("Choose the requested number of answers".into());
                    }
                    let choices = q["options"].as_array().ok_or("Question choices missing")?;
                    let unique: std::collections::HashSet<_> =
                        answer.selected_option_ids.iter().collect();
                    if unique.len() != answer.selected_option_ids.len()
                        || !answer
                            .selected_option_ids
                            .iter()
                            .all(|id| choices.iter().any(|o| o["id"].as_str() == Some(id)))
                    {
                        return Err("Unknown or duplicate question choice".into());
                    }
                }
                Ok(json!({"outcome":{"outcome":"answered","answers":answers}}))
            }
            _ => Err("Response does not match the pending interaction".into()),
        }
    }
}

/// ACP elicitation's restricted flat schema, not a general JSON Schema engine.
/// Reject unsupported shapes before showing a form instead of silently
/// collecting an answer that the provider cannot interpret.
pub fn validate_schema(schema: &Value) -> Result<(), String> {
    if schema["type"] != "object" {
        return Err("Unsupported elicitation schema".into());
    }
    let fields = schema["properties"]
        .as_object()
        .ok_or("Elicitation fields missing")?;
    if fields.len() > 32 {
        return Err("Too many elicitation fields".into());
    }
    for field in fields.values() {
        match field["type"].as_str() {
            Some("string" | "boolean" | "number" | "integer") => {}
            Some("array") if !enum_values(&field["items"]).is_empty() => {}
            _ => return Err("Unsupported elicitation field type".into()),
        }
    }
    Ok(())
}

fn enum_values(field: &Value) -> Vec<&Value> {
    field["enum"]
        .as_array()
        .map(|a| a.iter().collect())
        .unwrap_or_else(|| {
            field["oneOf"]
                .as_array()
                .or_else(|| field["anyOf"].as_array())
                .map(|a| a.iter().filter_map(|o| o.get("const")).collect())
                .unwrap_or_default()
        })
}

pub fn validate_form(schema: &Value, content: &Value) -> Result<(), String> {
    validate_schema(schema)?;
    let values = content.as_object().ok_or("Expected form values")?;
    let fields = schema["properties"]
        .as_object()
        .ok_or("Elicitation fields missing")?;
    if values.keys().any(|k| !fields.contains_key(k)) {
        return Err("Unknown form field".into());
    }
    if let Some(required) = schema["required"].as_array() {
        for key in required.iter().filter_map(Value::as_str) {
            if !values.contains_key(key) {
                return Err(format!("Missing required field: {key}"));
            }
        }
    }
    for (key, value) in values {
        let field = &fields[key];
        let valid = match field["type"].as_str() {
            Some("string") => value.is_string(),
            Some("boolean") => value.is_boolean(),
            Some("number") => value.is_number(),
            Some("integer") => value.is_i64() || value.is_u64(),
            Some("array") => value.as_array().is_some_and(|a| {
                let choices = enum_values(&field["items"]);
                a.iter().all(|v| v.is_string() && choices.contains(&v))
                    && a.iter().collect::<std::collections::HashSet<_>>().len() == a.len()
                    && !field["minItems"]
                        .as_u64()
                        .is_some_and(|n| a.len() < n as usize)
                    && !field["maxItems"]
                        .as_u64()
                        .is_some_and(|n| a.len() > n as usize)
            }),
            _ => false,
        };
        let choices = enum_values(field);
        if !valid || (!choices.is_empty() && !choices.contains(&value)) {
            return Err(format!("Invalid value for {key}"));
        }
        if let Some(n) = value.as_f64() {
            if field["minimum"].as_f64().is_some_and(|m| n < m)
                || field["maximum"].as_f64().is_some_and(|m| n > m)
            {
                return Err(format!("Value outside range for {key}"));
            }
        }
        if let Some(s) = value.as_str() {
            let len = s.chars().count() as u64;
            if field["minLength"].as_u64().is_some_and(|m| len < m)
                || field["maxLength"].as_u64().is_some_and(|m| len > m)
            {
                return Err(format!("Invalid length for {key}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_provider_choices_and_form_fields() {
        let request = Interaction {
            id: "r".into(),
            turn_id: "t".into(),
            kind: InteractionKind::Permission,
            title: "Run".into(),
            payload: json!({"options":[{"optionId":"once","kind":"allow_once"}]}),
        };
        assert!(request
            .respond(&InteractionResponse::Permission {
                option_id: Some("invented".into())
            })
            .is_err());
        assert!(request
            .respond(&InteractionResponse::Permission {
                option_id: Some("once".into())
            })
            .is_ok());
        let schema = json!({"type":"object","properties":{"choice":{"type":"string","enum":["a","b"]},"count":{"type":"integer","minimum":1}},"required":["choice"]});
        assert!(validate_form(&schema, &json!({"choice":"b","count":2})).is_ok());
        for bad in [
            json!({}),
            json!({"choice":"c"}),
            json!({"choice":"a","count":0}),
            json!({"choice":"a","extra":true}),
        ] {
            assert!(validate_form(&schema, &bad).is_err());
        }
    }
}
