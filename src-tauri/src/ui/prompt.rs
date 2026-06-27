//! Prompt composer — port of `src/components/PromptComposer.tsx`.
//!
//! Simplified per the plan: plain `MultilineEntry` for text input +
//! a sibling `VerticalBox` for `@file` / `/command` completion suggestions.
//! Drops the live syntax-highlight overlay and auto-grow animation.

use std::cell::RefCell;
use std::rc::Rc;

use libui::controls::{Button, HorizontalBox, Label, MultilineEntry, VerticalBox};
use libui::prelude::*;

use crate::git;
use crate::pty;
use super::state::AppState;

/// Build the prompt composer widget.
///
/// Returns a `VerticalBox` with the input area, completion list, and send button.
pub fn build(
    state: Rc<RefCell<AppState>>,
    win: libui::controls::Window,
    pty_manager: std::sync::Arc<std::sync::Mutex<crate::pty::PtyManager>>,
) -> VerticalBox {
    let mut vbox = VerticalBox::new();
    vbox.set_padded(true);

    // ── Completion suggestions (shown above the input) ────────────────────────
    let completions_lbl = Label::new("");
    vbox.append(completions_lbl, LayoutStrategy::Compact);

    // ── Text input ────────────────────────────────────────────────────────────
    let input = Rc::new(RefCell::new(MultilineEntry::new_nonwrapping()));
    vbox.append(input.borrow().clone(), LayoutStrategy::Stretchy);

    // ── Bottom toolbar: Attach + Send ─────────────────────────────────────────
    let mut toolbar = HorizontalBox::new();
    toolbar.set_padded(true);

    // Attach file button.
    let input_attach = input.clone();
    let win_attach = win.clone();
    let mut btn_attach = Button::new("Attach file...");
    btn_attach.on_clicked(move |_| {
        if let Some(path) = win_attach.open_file() {
            let path_str = path.to_string_lossy().to_string();
            let current = input_attach.borrow().value();
            input_attach.borrow_mut().set_value(&format!("{current}@{path_str}"));
        }
    });
    toolbar.append(btn_attach, LayoutStrategy::Compact);

    // Send button.
    let state_send = state.clone();
    let input_send = input.clone();
    let win_send = win.clone();
    let pty_send = pty_manager.clone();
    let mut btn_send = Button::new("Send ↵");
    btn_send.on_clicked(move |_| {
        let text = input_send.borrow().value();
        if text.trim().is_empty() {
            return;
        }

        let s = state_send.borrow();
        if s.tabs.is_empty() {
            win_send.modal_err("Send", "No active session.");
            return;
        }
        let sid = s.tabs[s.active_tab].id.clone();
        let proj = s.project_path.clone().unwrap_or_default();
        drop(s);

        // Auto-checkpoint before sending (mirrors store.ts waitForPtyExit + commit).
        if !proj.is_empty() {
            let _ = git::ensure_work_branch(&proj, "ai-work");
            let _ = git::auto_commit(&proj, "auto-checkpoint before prompt");
        }

        // Write text + Enter into the active PTY.
        let prompt_bytes = format!("{text}\r");
        let mgr = pty_send.lock().unwrap();
        if let Err(e) = pty::send_input(&mgr, &sid, &prompt_bytes) {
            drop(mgr);
            win_send.modal_err("Send", &e);
        } else {
            drop(mgr);
            input_send.borrow_mut().set_value("");
        }
    });
    toolbar.append(btn_send, LayoutStrategy::Stretchy);

    vbox.append(toolbar, LayoutStrategy::Compact);

    vbox
}
