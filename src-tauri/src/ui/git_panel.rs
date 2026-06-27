//! Git checkpoint panel — port of `src/components/PreviewPane.tsx`.
//!
//! Shows the `ai-work` branch commit log, lets the user commit, roll back,
//! and rename commits.

use std::cell::RefCell;
use std::rc::Rc;

use libui::controls::{Button, HorizontalBox, Label, MultilineEntry, VerticalBox};
use libui::prelude::*;

use crate::git;
use super::state::AppState;

pub fn build(
    ui: &UI,
    state: Rc<RefCell<AppState>>,
    win: libui::controls::Window,
) -> VerticalBox {
    let mut vbox = VerticalBox::new();
    vbox.set_padded(true);

    // ── Header ────────────────────────────────────────────────────────────────
    let mut header = HorizontalBox::new();
    header.set_padded(true);
    let lbl = Label::new("Git checkpoints");
    header.append(lbl, LayoutStrategy::Stretchy);

    // Refresh button.
    let log_entry = Rc::new(RefCell::new(MultilineEntry::new_nonwrapping()));
    let state_refresh = state.clone();
    let log_entry_r = log_entry.clone();
    let win_r = win.clone();
    let mut btn_refresh = Button::new("↻");
    btn_refresh.on_clicked(move |_| {
        let s = state_refresh.borrow();
        if let Some(p) = &s.project_path {
            match git::get_log(p, 20) {
                Ok(entries) => {
                    log_entry_r.borrow_mut().set_value(&format_log(&entries));
                }
                Err(e) => { win_r.modal_err("Git log", &e); }
            }
        }
    });
    header.append(btn_refresh, LayoutStrategy::Compact);
    vbox.append(header, LayoutStrategy::Compact);

    // ── Commit log (read-only multiline text) ─────────────────────────────────
    log_entry.borrow_mut().set_readonly(true);
    {
        // Initial load.
        let s = state.borrow();
        if let Some(p) = &s.project_path {
            if let Ok(entries) = git::get_log(p, 20) {
                log_entry.borrow_mut().set_value(&format_log(&entries));
            }
        }
    }
    vbox.append(log_entry.borrow().clone(), LayoutStrategy::Stretchy);

    // ── Commit composer ───────────────────────────────────────────────────────
    let lbl2 = Label::new("Commit message:");
    vbox.append(lbl2, LayoutStrategy::Compact);

    let msg_entry = Rc::new(RefCell::new(MultilineEntry::new_nonwrapping()));
    vbox.append(msg_entry.borrow().clone(), LayoutStrategy::Compact);

    // "Commit to ai-work" button.
    let state_commit = state.clone();
    let msg_e = msg_entry.clone();
    let win_commit = win.clone();
    let log_commit = log_entry.clone();
    let mut btn_commit = Button::new("Commit to ai-work");
    btn_commit.on_clicked(move |_| {
        let msg = msg_e.borrow().value();
        if msg.trim().is_empty() {
            win_commit.modal_err("Commit", "Commit message is empty.");
            return;
        }
        let s = state_commit.borrow();
        if let Some(p) = &s.project_path {
            // Ensure branch first.
            if let Err(e) = git::ensure_work_branch(p, "ai-work") {
                win_commit.modal_err("Git branch", &e);
                return;
            }
            match git::auto_commit(p, &msg) {
                Ok(_) => {
                    msg_e.borrow_mut().set_value("");
                    if let Ok(entries) = git::get_log(p, 20) {
                        log_commit.borrow_mut().set_value(&format_log(&entries));
                    }
                }
                Err(e) => { win_commit.modal_err("Commit", &e); }
            }
        }
    });
    vbox.append(btn_commit, LayoutStrategy::Compact);

    // ── Rollback button ───────────────────────────────────────────────────────
    let state_rb = state.clone();
    let win_rb = win.clone();
    let log_rb = log_entry.clone();
    let mut btn_rollback = Button::new("Roll back last commit");
    btn_rollback.on_clicked(move |_| {
        let s = state_rb.borrow();
        if let Some(p) = &s.project_path {
            match git::get_log(p, 1) {
                Ok(entries) if !entries.is_empty() => {
                    let sha = entries[0].sha.clone();
                    let p2 = p.clone();
                    drop(s);
                    if let Err(e) = git::rollback(&p2, &sha) {
                        win_rb.modal_err("Rollback", &e);
                    } else if let Ok(entries) = git::get_log(&p2, 20) {
                        log_rb.borrow_mut().set_value(&format_log(&entries));
                    }
                }
                _ => {
                    win_rb.modal_err("Rollback", "No commits to roll back.");
                }
            }
        }
    });
    vbox.append(btn_rollback, LayoutStrategy::Compact);

    // ── Rename last commit button ─────────────────────────────────────────────
    let state_rn = state.clone();
    let win_rn = win.clone();
    let log_rn = log_entry.clone();
    let ui_rn = ui.clone();
    let mut btn_rename = Button::new("Rename last commit...");
    btn_rename.on_clicked(move |_| {
        let s = state_rn.borrow();
        if let Some(p) = &s.project_path {
            match git::get_log(p, 1) {
                Ok(entries) if !entries.is_empty() => {
                    let sha = entries[0].sha.clone();
                    let current_msg = entries[0].message.clone();
                    let p2 = p.clone();
                    drop(s);
                    let new_msg = super::dialogs::prompt(
                        &ui_rn,
                        &win_rn,
                        "Rename commit",
                        "New message",
                        &current_msg,
                    );
                    if let Some(msg) = new_msg {
                        if !msg.trim().is_empty() {
                            if let Err(e) = git::rename_commit(&p2, &sha, &msg) {
                                win_rn.modal_err("Rename commit", &e);
                            } else if let Ok(entries) = git::get_log(&p2, 20) {
                                log_rn.borrow_mut().set_value(&format_log(&entries));
                            }
                        }
                    }
                }
                _ => { win_rn.modal_err("Rename", "No commits found."); }
            }
        }
    });
    vbox.append(btn_rename, LayoutStrategy::Compact);

    vbox
}

fn format_log(entries: &[crate::git::CommitEntry]) -> String {
    entries
        .iter()
        .map(|e| format!("{} {}", &e.sha[..7.min(e.sha.len())], e.message))
        .collect::<Vec<_>>()
        .join("\n")
}
