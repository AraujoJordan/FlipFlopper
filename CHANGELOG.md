# Changelog

## 0.1.4 - 2026-07-05

### Added

- Added richer CodeMirror editor intelligence backed by the native LSP bridge, including completions, completion detail resolution, signature help, hover, definitions, references, diagnostics, and document lifecycle IPC.
- Added an editor context window and usage model so agents can receive selected files, line ranges, and attached context more reliably.
- Added a bottom terminal panel with clearer run, validation, and install terminal controls.
- Added dedicated `AgentWorkspace`, `BranchIndicator`, and `YoloButton` components to keep the main app shell smaller and easier to evolve.
- Added `markdownLite` rendering utilities for compact, safe in-app markdown display.
- Added the bundled FlipFlopper icon asset used by the refreshed empty states.

### Changed

- Improved the agent empty state, prompt context flow, and attach-line/block behavior.
- Improved the file tree context menu and right-click affordances.
- Improved git panel layout and review-related controls.
- Improved terminal tab handling, xterm event wiring, and PTY status presentation.
- Refined shared UI primitives and global styling for denser desktop workbench workflows.
- Updated repository agent instructions and removed stale refactor planning documents.

### Fixed

- Hardened backend editor, project, git, handoff, and review helpers around project-relative paths and tolerant parsing.
- Smoothed IPC typing across frontend/backend boundaries for editor, LSP, terminal, and tool commands.

### Removed

- Removed obsolete planning documentation that no longer described the active Tauri/Solid implementation.
