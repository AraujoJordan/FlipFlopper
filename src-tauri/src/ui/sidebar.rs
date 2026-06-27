//! Sidebar — project picker + recent projects list.
//!
//! Ported from `src/components/Sidebar.tsx`.
//! File-tree embedding is handled in `app.rs` by appending `file_tree::build()`
//! below the sidebar in the left panel.

use std::cell::RefCell;
use std::rc::Rc;

use libui::controls::{Button, Label, VerticalBox};
use libui::prelude::*;

use crate::project;
use super::state::AppState;

/// Build the sidebar widget.
///
/// Returns a `VerticalBox` containing the project header, Open button, and
/// a recents list.  The caller owns the shared `state` reference.
pub fn build(
    state: Rc<RefCell<AppState>>,
    win: libui::controls::Window,
    on_project_opened: impl Fn(String) + 'static,
) -> VerticalBox {
    let mut vbox = VerticalBox::new();
    vbox.set_padded(true);

    // ── Header label ─────────────────────────────────────────────────────────
    let header = Label::new("FlipFlopper");
    vbox.append(header, LayoutStrategy::Compact);

    // ── "Open project" button ─────────────────────────────────────────────────
    let state_open = state.clone();
    let on_open = Rc::new(on_project_opened);
    let on_open2 = on_open.clone();
    let win2 = win.clone();
    let mut btn_open = Button::new("Open project...");
    btn_open.on_clicked(move |_| {
        // Use libui native folder dialog.
        if let Some(path) = win2.open_folder() {
            let path_str = path.to_string_lossy().to_string();
            match project::scaffold(&path_str) {
                Ok(info) => {
                    project::add_recent_project(&info);
                    {
                        let mut s = state_open.borrow_mut();
                        s.project_path = Some(path_str.clone());
                        s.project_info = Some(info.clone());
                        s.recent_projects = project::get_recent_projects();
                    }
                    on_open2(path_str);
                }
                Err(e) => {
                    win2.modal_err("Open project", &e);
                }
            }
        }
    });
    vbox.append(btn_open, LayoutStrategy::Compact);

    // ── Recents ───────────────────────────────────────────────────────────────
    let recent_label = Label::new("Recent projects:");
    vbox.append(recent_label, LayoutStrategy::Compact);

    // Build one button per recent project.
    let recents = project::get_recent_projects();
    {
        let mut s = state.borrow_mut();
        s.recent_projects = recents.clone();
    }

    for proj in recents {
        let name = proj.name.clone();
        let path = proj.path.clone();
        let state_r = state.clone();
        let on_open_r = on_open.clone();
        let win_r = win.clone();
        let mut btn = Button::new(&name);
        btn.on_clicked(move |_| {
            match project::scaffold(&path) {
                Ok(info) => {
                    project::add_recent_project(&info);
                    {
                        let mut s = state_r.borrow_mut();
                        s.project_path = Some(path.clone());
                        s.project_info = Some(info.clone());
                    }
                    on_open_r(path.clone());
                }
                Err(e) => {
                    win_r.modal_err("Open project", &e);
                }
            }
        });
        vbox.append(btn, LayoutStrategy::Compact);
    }

    vbox
}
