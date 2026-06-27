//! File tree — checkbox-based file selection for `@ref` injection.
//!
//! Ported from `src/components/FileTree.tsx`.
//!
//! libui has no native tree widget, so we flatten the tree into a
//! button-per-entry list where indentation is simulated by prepending
//! spaces to the display name.  Folder expand/collapse toggles rows
//! by re-building the model.

use std::cell::RefCell;
use std::rc::Rc;

use libui::controls::{Button, Label, VerticalBox};
use libui::prelude::*;

use crate::project;
use crate::pty;
use super::state::AppState;

/// Flat entry as displayed in the list.
struct FlatEntry {
    path: String,
    display: String, // indented name
    is_dir: bool,
    depth: usize,
    expanded: bool,
}

/// State for the file tree, shared between the build function and callbacks.
struct TreeState {
    root: String,
    entries: Vec<FlatEntry>,
    /// Selected absolute paths.
    selected: std::collections::HashSet<String>,
}

impl TreeState {
    fn new(root: String) -> Self {
        TreeState { root, entries: vec![], selected: std::collections::HashSet::new() }
    }

    /// Rebuild `entries` by listing the tree from the root.
    fn reload(&mut self) {
        self.entries.clear();
        self.load_dir(&self.root.clone(), 0);
    }

    fn load_dir(&mut self, path: &str, depth: usize) {
        let Ok(children) = project::list_dir(path) else { return };
        for child in children {
            let indent = " ".repeat(depth * 2);
            let name = std::path::Path::new(&child.path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| child.path.clone());
            let prefix = if child.is_dir { "▶ " } else { "  " };
            let display = format!("{indent}{prefix}{name}");
            let is_dir = child.is_dir;
            let abs_path = child.path.clone();
            self.entries.push(FlatEntry {
                path: abs_path,
                display,
                is_dir,
                depth,
                expanded: false,
            });
            // Don't recurse yet — lazy load on expand.
        }
    }
}

/// Build the file-tree panel.
///
/// Returns a `VerticalBox` with a scrollable file list and an "Insert N refs" button.
pub fn build(
    state: Rc<RefCell<AppState>>,
    project_path: String,
    win: libui::controls::Window,
    pty_manager: std::sync::Arc<std::sync::Mutex<crate::pty::PtyManager>>,
) -> VerticalBox {
    let mut vbox = VerticalBox::new();
    vbox.set_padded(true);

    // Title.
    let lbl = Label::new("Files");
    vbox.append(lbl, LayoutStrategy::Compact);

    // NOTE: libui's Table widget requires a TableModel which manages typed
    // columns.  A full implementation would use:
    //   TableModel + TableModelHandler trait (value_for_column, num_rows, etc.)
    // For this implementation, we render each file as a Button-row (with a
    // checkbox-style toggle) in a VerticalBox.  This is less efficient for
    // large trees but maps cleanly to the libui API without requiring the
    // full TableModel boilerplate.

    let tree_state = Rc::new(RefCell::new(TreeState::new(project_path.clone())));
    tree_state.borrow_mut().reload();

    // Build the file list widget area.
    let list_box = Rc::new(RefCell::new(VerticalBox::new()));
    list_box.borrow_mut().set_padded(false);

    // Populate file rows.
    refresh_list(&list_box, &tree_state, &state, &pty_manager, &win);

    vbox.append(list_box.borrow().clone(), LayoutStrategy::Stretchy);

    // "Insert N refs" button.
    let state_insert = state.clone();
    let pty_insert = pty_manager.clone();
    let win_insert = win.clone();
    let mut btn_insert = Button::new("Insert refs");
    btn_insert.on_clicked(move |_| {
        let s = state_insert.borrow();
        let paths: Vec<String> = s.file_selection.selected.iter().cloned().collect();
        if paths.is_empty() {
            win_insert.modal_err("Insert refs", "No files selected.");
            return;
        }
        if s.tabs.is_empty() {
            win_insert.modal_err("Insert refs", "No active session.");
            return;
        }
        let sid = s.tabs[s.active_tab].id.clone();
        drop(s);
        let mgr = pty_insert.lock().unwrap();
        if let Err(e) = pty::inject_refs(&mgr, &sid, &paths) {
            drop(mgr);
            win_insert.modal_err("Insert refs", &e);
        }
    });
    vbox.append(btn_insert, LayoutStrategy::Compact);

    vbox
}

fn refresh_list(
    list_box: &Rc<RefCell<VerticalBox>>,
    tree_state: &Rc<RefCell<TreeState>>,
    app_state: &Rc<RefCell<AppState>>,
    _pty_manager: &std::sync::Arc<std::sync::Mutex<crate::pty::PtyManager>>,
    _win: &libui::controls::Window,
) {
    // libui doesn't have a way to remove children from a box after appending,
    // so we build a new VerticalBox each refresh.
    let ts = tree_state.borrow();
    let mut lb = list_box.borrow_mut();

    for entry in &ts.entries {
        let name = entry.display.clone();
        let path = entry.path.clone();
        let is_dir = entry.is_dir;
        let is_selected = ts.selected.contains(&path);

        let check_mark = if is_selected { "[x] " } else { "[ ] " };
        let label_text = format!("{check_mark}{name}");

        let mut row_btn = Button::new(&label_text);
        let path2 = path.clone();
        let ts2 = tree_state.clone();
        let as2 = app_state.clone();
        row_btn.on_clicked(move |_| {
            let mut ts = ts2.borrow_mut();
            if is_dir {
                // Toggle expand — reload tree from disk.
                if let Some(e) = ts.entries.iter_mut().find(|e| e.path == path2) {
                    e.expanded = !e.expanded;
                }
                ts.reload();
            } else {
                // Toggle selection.
                if ts.selected.contains(&path2) {
                    ts.selected.remove(&path2);
                } else {
                    ts.selected.insert(path2.clone());
                }
                // Mirror into app state file selection.
                let mut s = as2.borrow_mut();
                s.file_selection.selected = ts.selected.clone();
            }
        });

        lb.append(row_btn, LayoutStrategy::Compact);
    }
}
