# Security Policy

## Supported Versions

Only the latest GitHub release is supported. FlipFlopper doesn't maintain
LTS/backport branches; if you're on an older build, update first and confirm
the issue still reproduces.

## Reporting a Vulnerability

**Preferred:** use GitHub's private vulnerability reporting for this repo
(the "Report a vulnerability" button under the repo's **Security** tab). This
opens a private advisory only visible to the maintainer, so details aren't
exposed publicly while a fix is worked out.

**Fallback:** if you can't use GitHub's flow, email
**jordanjr.92@gmail.com** with a description of the issue, steps to
reproduce, and impact. Please don't open a public issue for anything that
could be actively exploited (e.g. arbitrary command execution via the PTY
bridge, path traversal in the file/editor commands, or IPC boundary bypass).

This is a small, single-maintainer project, so there's no guaranteed SLA, but
security reports get priority over regular issues.

## Scope Notes

FlipFlopper runs real PTY sessions and shells out to `git` and other local
tools by design (it's a desktop cockpit for CLI coding agents). Reports about
"the app can run shell commands" without a concrete escalation beyond what
the user already has on their own machine are expected behavior, not a
vulnerability. Reports about the Tauri IPC boundary, the file-system path
safety checks in `editor.rs`, or anything that lets a remote/untrusted source
influence what gets executed are exactly what this policy is for.
