//! FlipFlopper library root.
//!
//! Previously contained the Tauri command wrappers and Builder.  Those are
//! gone; the entry point is now `ui::app::run()` called from `main.rs`.
//!
//! All business logic modules remain unchanged:

mod agents;
mod git;
mod handoff;
mod project;
mod pty;
mod tools;
mod ui;

/// Start the libui application.  Called from `main.rs`.
pub fn run() {
    ui::app::run();
}
