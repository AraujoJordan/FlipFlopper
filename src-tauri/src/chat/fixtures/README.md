# ACP regression fixtures

`acp-agent.mjs` is a deterministic local ACP peer for SDK transport/lifecycle
tests. It exercises replay, token bursts, stderr backpressure, native config
changes, permission/form/question/plan/URL requests, protocol authentication,
disconnect, images and a deliberately unresponsive child process tree. It makes
no network or model calls. Prepare the bundled Node with `npm run prepare:agents`
before running `cargo test --lib`.

`acp-claude.jsonl` was recorded on 2026-10-22 using Claude Code 2.1.308 and
`@agentclientprotocol/claude-agent-acp` 0.94.0 (ACP v1): initialization, session
metadata and a no-tools prompt asking for `FLIPFLOPPER_ACP_OK`. Session IDs and
the disposable cwd are replaced; `_meta` is omitted and thought chunks are not
recorded. No existing user conversation was loaded.

`acp-cursor.jsonl` is a real initialization response from Cursor CLI
2026.07.01-41b2de7, recorded the same day. It contains capabilities only, with no
login or model call. Authenticated Cursor traffic must be recorded separately
once that CLI's ACP authentication succeeds.

Real-provider smoke tests are opt-in and use existing CLI credentials plus real
model calls in disposable directories:

```sh
cargo test --lib authenticated_claude_prompt_and_resume -- --ignored --nocapture
cargo test --lib authenticated_cursor_prompt_and_resume -- --ignored --nocapture
```
