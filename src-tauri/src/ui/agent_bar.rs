//! Agent bar — tab strip + agent picker + launch/handoff/install logic.
//!
//! Ported from `src/components/AgentBar.tsx`.
//!
//! libui `TabGroup` handles body switching.  The custom tab header row
//! (icon, close ×, session colour, "+") is a `HorizontalBox` of buttons
//! placed above the `TabGroup`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use libui::controls::{Area, Button, HorizontalBox, TabGroup, VerticalBox};
use libui::prelude::*;

use crate::agents::AgentInfo;
use crate::handoff;
use crate::pty::{self, PtyManager};
use crate::tools;
use super::state::{session_color, AppState, TabState};
use super::terminal::TerminalAreaHandler;

/// Build the agent bar + terminal area container.
///
/// `areas` is a shared map (session_id → Area) used by the `on_tick` closure
/// in `app.rs` to call `queue_redraw_all()` when new PTY bytes arrive.
pub fn build(
    state: Rc<RefCell<AppState>>,
    win: libui::controls::Window,
    pty_manager: Arc<Mutex<PtyManager>>,
    areas: Rc<RefCell<HashMap<String, Area>>>,
) -> VerticalBox {
    let mut outer = VerticalBox::new();
    outer.set_padded(false);

    // ── Custom tab header row ─────────────────────────────────────────────────
    let mut header = HorizontalBox::new();
    header.set_padded(true);

    // TabGroup body — pages added dynamically via launch_agent.
    let tabs = Rc::new(RefCell::new(TabGroup::new()));

    // ── "+" new tab button ────────────────────────────────────────────────────
    let state_new = state.clone();
    let win_new = win.clone();
    let pty_new = pty_manager.clone();
    let tabs_new = tabs.clone();
    let areas_new = areas.clone();
    let mut btn_new = Button::new("+");
    btn_new.on_clicked(move |_| {
        let s = state_new.borrow();
        let agents = s.agents.clone();
        let proj = s.project_path.clone().unwrap_or_default();
        drop(s);

        if proj.is_empty() {
            win_new.modal_err("New tab", "Open a project first.");
            return;
        }

        // Pick the first installed agent automatically.
        // TODO: show a selection dialog with all agents.
        let installed: Vec<AgentInfo> = agents.into_iter().filter(|a| a.installed).collect();
        if installed.is_empty() {
            win_new.modal_err("New tab", "No agents installed.\nInstall an agent first.");
            return;
        }
        launch_agent(
            &state_new,
            &win_new,
            &pty_new,
            &mut tabs_new.borrow_mut(),
            &areas_new,
            &installed[0],
            &proj,
        );
    });
    header.append(btn_new, LayoutStrategy::Compact);

    // ── Hand off button ────────────────────────────────────────────────────────
    let state_ho = state.clone();
    let win_ho = win.clone();
    let pty_ho = pty_manager.clone();
    let tabs_ho = tabs.clone();
    let areas_ho = areas.clone();
    let mut btn_handoff = Button::new("Hand off ▾");
    btn_handoff.on_clicked(move |_| {
        let s = state_ho.borrow();
        if s.tabs.is_empty() {
            win_ho.modal_err("Handoff", "No active session.");
            return;
        }
        let from_agent = s.tabs[s.active_tab].agent_id.clone();
        let proj = s.project_path.clone().unwrap_or_default();
        let candidates = super::state::rank_continue_candidates(&s.agents, &s.mru, &from_agent);
        let color = s.tabs[s.active_tab].color.clone();
        drop(s);

        if candidates.is_empty() {
            win_ho.modal_err("Handoff", "No continuation candidates available.");
            return;
        }

        let to = candidates[0].clone();
        match handoff::continue_launch(&proj, &from_agent, &to.id) {
            Ok(launch) => {
                let mgr = pty_ho.lock().unwrap();
                match pty::spawn_shell_command(&mgr, &launch.label, &launch.command, &proj) {
                    Ok((sid, rx)) => {
                        drop(mgr);
                        let tab = TabState::new(
                            sid.clone(),
                            to.id.clone(),
                            proj.clone(),
                            launch.label.clone(),
                            color,
                            rx,
                        );
                        let label = tab.label.clone();
                        {
                            let mut s = state_ho.borrow_mut();
                            s.tabs.push(tab);
                            s.active_tab = s.tabs.len() - 1;
                            s.persist_workspace();
                        }
                        // Create terminal Area for the new handoff tab.
                        let handler = TerminalAreaHandler {
                            session_id: sid.clone(),
                            state: state_ho.clone(),
                            pty_manager: pty_ho.clone(),
                        };
                        let area = Area::new(Box::new(handler));
                        areas_ho.borrow_mut().insert(sid, area.clone());
                        tabs_ho.borrow_mut().append(&label, area);
                    }
                    Err(e) => { win_ho.modal_err("Handoff", &e); }
                }
            }
            Err(e) => { win_ho.modal_err("Handoff", &e); }
        }
    });
    header.append(btn_handoff, LayoutStrategy::Compact);

    outer.append(header, LayoutStrategy::Compact);
    outer.append(tabs.borrow().clone(), LayoutStrategy::Stretchy);

    outer
}

/// Launch a new agent tab — spawn PTY, create TabState + Area, add to TabGroup.
fn launch_agent(
    state: &Rc<RefCell<AppState>>,
    win: &libui::controls::Window,
    pty_manager: &Arc<Mutex<PtyManager>>,
    tabs: &mut TabGroup,
    areas: &Rc<RefCell<HashMap<String, Area>>>,
    agent: &AgentInfo,
    project_path: &str,
) {
    // Install if not present.
    if !agent.installed {
        if let Some(install_cmd) = tools::install_command(&agent.id) {
            let mgr = pty_manager.lock().unwrap();
            let label = format!("install:{}", agent.id);
            match pty::spawn_shell_command(&mgr, &label, &install_cmd, project_path) {
                Ok((sid, rx)) => {
                    drop(mgr);
                    let color = session_color(&sid).to_string();
                    let tab = TabState::new(
                        sid.clone(),
                        agent.id.clone(),
                        project_path.to_string(),
                        label.clone(),
                        color,
                        rx,
                    );
                    {
                        let mut s = state.borrow_mut();
                        s.tabs.push(tab);
                        s.active_tab = s.tabs.len() - 1;
                        s.persist_workspace();
                    }
                    let handler = TerminalAreaHandler {
                        session_id: sid.clone(),
                        state: state.clone(),
                        pty_manager: pty_manager.clone(),
                    };
                    let area = Area::new(Box::new(handler));
                    areas.borrow_mut().insert(sid, area.clone());
                    tabs.append(&label, area);
                }
                Err(e) => { win.modal_err("Install agent", &e); }
            }
            return;
        }
    }

    let mgr = pty_manager.lock().unwrap();
    match pty::spawn_session(&mgr, &agent.id, project_path) {
        Ok((sid, rx)) => {
            drop(mgr);
            let color = session_color(&sid).to_string();
            let tab = TabState::new(
                sid.clone(),
                agent.id.clone(),
                project_path.to_string(),
                agent.name.clone(),
                color,
                rx,
            );
            let label = tab.label.clone();
            {
                let mut s = state.borrow_mut();
                s.tabs.push(tab);
                s.active_tab = s.tabs.len() - 1;
                s.persist_workspace();
            }
            let handler = TerminalAreaHandler {
                session_id: sid.clone(),
                state: state.clone(),
                pty_manager: pty_manager.clone(),
            };
            let area = Area::new(Box::new(handler));
            areas.borrow_mut().insert(sid, area.clone());
            tabs.append(&label, area);
        }
        Err(e) => { win.modal_err("Launch agent", &e); }
    }
}

/// Install a tool and show its output in a new PTY tab.
pub fn install_tool(
    state: &Rc<RefCell<AppState>>,
    win: &libui::controls::Window,
    pty_manager: &Arc<Mutex<PtyManager>>,
    tabs: &mut TabGroup,
    areas: &Rc<RefCell<HashMap<String, Area>>>,
    tool_id: &str,
    project_path: &str,
) {
    let Some(cmd) = tools::install_command(tool_id) else {
        win.modal_err("Install tool", &format!("No install command for '{tool_id}'."));
        return;
    };
    let label = format!("install:{tool_id}");
    let mgr = pty_manager.lock().unwrap();
    match pty::spawn_shell_command(&mgr, &label, &cmd, project_path) {
        Ok((sid, rx)) => {
            drop(mgr);
            let color = session_color(&sid).to_string();
            let tab = TabState::new(
                sid.clone(),
                tool_id.to_string(),
                project_path.to_string(),
                label.clone(),
                color,
                rx,
            );
            {
                let mut s = state.borrow_mut();
                s.tabs.push(tab);
                s.active_tab = s.tabs.len() - 1;
                s.persist_workspace();
            }
            let handler = TerminalAreaHandler {
                session_id: sid.clone(),
                state: state.clone(),
                pty_manager: pty_manager.clone(),
            };
            let area = Area::new(Box::new(handler));
            areas.borrow_mut().insert(sid, area.clone());
            tabs.append(&label, area);
        }
        Err(e) => { win.modal_err("Install tool", &e); }
    }
}
