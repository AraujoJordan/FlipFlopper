//! Main application window — replaces `src/App.tsx`.
//!
//! Three-pane layout using `HorizontalBox`:
//!   left (sidebar + file tree) | center (agent bar + terminals) | right (git panel)
//!
//! PTY events are drained on every `EventLoop::on_tick` (run_delay 16 ms).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use libui::controls::{Area, Group, HorizontalBox, VerticalBox, Window, WindowType};
use libui::prelude::*;

use crate::agents;
use crate::project;
use crate::pty::{PtyEvent, PtyManager};
use crate::tools;
use super::state::{AppState, load_workspace};
use super::{agent_bar, file_tree, git_panel, prompt, sidebar};

/// Build and run the full libui application.
pub fn run() {
    let ui = UI::init().expect("Failed to initialise libui");

    // ── Shared app state ──────────────────────────────────────────────────────
    let state: Rc<RefCell<AppState>> = Rc::new(RefCell::new(AppState::new()));

    // ── Shared PTY manager (Arc for Send to reader threads) ───────────────────
    let pty_manager: Arc<Mutex<PtyManager>> = Arc::new(Mutex::new(PtyManager::new()));

    // ── Area map: session_id → Area (for queue_redraw_all on new PTY data) ────
    let areas: Rc<RefCell<HashMap<String, Area>>> = Rc::new(RefCell::new(HashMap::new()));

    // ── Main window ───────────────────────────────────────────────────────────
    let mut win = Window::new(&ui, "FlipFlopper", 1440, 900, WindowType::HasMenubar);
    win.set_margined(false);

    // ── Load initial data ─────────────────────────────────────────────────────
    {
        let mut s = state.borrow_mut();
        s.agents = agents::list_agents();
        s.tools = tools::list_tools();
        s.recent_projects = project::get_recent_projects();
    }

    // ── Top-level HorizontalBox (left | center | right) ───────────────────────
    let mut hbox = HorizontalBox::new();
    hbox.set_padded(false);

    // ── Left panel: sidebar + file tree ──────────────────────────────────────
    let mut left = VerticalBox::new();
    left.set_padded(true);

    // File-tree slot: a Group so we can swap its single child when the project
    // changes (Group::set_child replaces the contents without needing to remove
    // from a VerticalBox, which libui doesn't support).
    let ft_slot = Rc::new(RefCell::new(Group::new("")));
    ft_slot.borrow_mut().set_margined(false);

    // Populate with the restored project's tree (if any), else an empty box.
    {
        let s = state.borrow();
        if let Some(ref proj) = s.project_path.clone() {
            let ft = file_tree::build(
                state.clone(),
                proj.clone(),
                win.clone(),
                pty_manager.clone(),
            );
            ft_slot.borrow_mut().set_child(ft);
        } else {
            ft_slot.borrow_mut().set_child(VerticalBox::new());
        }
    }

    // Build sidebar, passing a callback that rebuilds the file-tree slot.
    let ft_slot_cb = ft_slot.clone();
    let state_ft = state.clone();
    let win_ft = win.clone();
    let pty_ft = pty_manager.clone();

    let sidebar_widget = sidebar::build(
        state.clone(),
        win.clone(),
        move |path| {
            let new_ft = file_tree::build(
                state_ft.clone(),
                path,
                win_ft.clone(),
                pty_ft.clone(),
            );
            ft_slot_cb.borrow_mut().set_child(new_ft);
        },
    );
    left.append(sidebar_widget, LayoutStrategy::Compact);
    left.append(ft_slot.borrow().clone(), LayoutStrategy::Stretchy);

    hbox.append(left, LayoutStrategy::Compact);

    // ── Center panel: agent bar + terminal areas ──────────────────────────────
    let center = agent_bar::build(
        state.clone(),
        win.clone(),
        pty_manager.clone(),
        areas.clone(),
    );
    hbox.append(center, LayoutStrategy::Stretchy);

    // ── Right panel: git checkpoint panel ────────────────────────────────────
    let right = git_panel::build(&ui, state.clone(), win.clone());
    hbox.append(right, LayoutStrategy::Compact);

    // ── Prompt composer at the bottom ─────────────────────────────────────────
    let mut main_layout = VerticalBox::new();
    main_layout.set_padded(false);
    main_layout.append(hbox, LayoutStrategy::Stretchy);

    let prompt_widget = prompt::build(state.clone(), win.clone(), pty_manager.clone());
    main_layout.append(prompt_widget, LayoutStrategy::Compact);

    win.set_child(main_layout);
    win.show();

    // ── Window close callback ─────────────────────────────────────────────────
    let state_close = state.clone();
    let ui_close = ui.clone();
    win.on_closing(&ui, move |_| {
        state_close.borrow().persist_workspace();
        ui_close.quit();
    });

    // ── Workspace restore ────────────────────────────────────────────────────
    let snapshot = load_workspace();
    if let Some(proj_path) = snapshot.project_path {
        if std::path::Path::new(&proj_path).exists() {
            if let Ok(info) = project::scaffold(&proj_path) {
                let mut s = state.borrow_mut();
                s.project_path = Some(proj_path.clone());
                s.project_info = Some(info);
            }
        }
    }

    // ── Event loop: drain PTY channels every ~16 ms ───────────────────────────
    let mut event_loop = ui.event_loop();
    let state_tick = state.clone();
    let areas_tick = areas.clone();

    event_loop.on_tick(move || {
        let mut s = state_tick.borrow_mut();
        let areas_map = areas_tick.borrow();

        for tab in s.tabs.iter_mut() {
            let mut got_data = false;
            loop {
                match tab.receiver.try_recv() {
                    Ok(PtyEvent::Data(bytes)) => {
                        tab.parser.advance(&mut tab.term, bytes.as_bytes());
                        got_data = true;
                        tab.dirty = true;
                    }
                    Ok(PtyEvent::Exit) => {
                        tab.exited = true;
                        tab.dirty = true;
                        break;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        tab.exited = true;
                        break;
                    }
                }
            }

            if got_data {
                if let Some(area) = areas_map.get(&tab.id) {
                    area.queue_redraw_all();
                }
            }
        }
    });

    event_loop.run_delay(16);
}
