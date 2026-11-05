// Auto-settle threads when the checkout's pull request reaches a terminal
// state. This mirrors T3's PR-based settle rules while keeping the existing
// per-thread opt-out (SessionMeta.settle_disabled) and idle auto-archive.
import { archiveSessions, chat, isRunning, pendingInputCount } from "./chat";
import { registerPrStatusObserver } from "./prStatus";
import { autoSettlePrClosed, autoSettlePrMerged } from "./settings";
import { toast } from "../components/ui";

const handled = new Map<string, string>();

registerPrStatusObserver((cwd, status) => {
  if (!status) return;
  const state = status.state.toUpperCase();
  if (state === "MERGED" ? !autoSettlePrMerged() : state === "CLOSED" ? !autoSettlePrClosed() : true) return;
  const key = `${status.number}:${state}`;
  if (handled.get(cwd) === key) return;
  handled.set(cwd, key);
  const ids = chat.sessions
    .filter((session) => !session.archived && !session.pinned && !session.hidden && !session.settle_disabled)
    .filter((session) => (session.worktree?.path ?? session.cwd ?? session.project_path) === cwd)
    .filter((session) => !isRunning(session.id) && pendingInputCount(session.id) === 0)
    .map((session) => session.id);
  if (!ids.length) return;
  void archiveSessions(ids, true).then((changed) => {
    if (changed > 0) toast(`Archived ${changed} thread${changed === 1 ? "" : "s"} after pull request #${status.number} ${state.toLowerCase()}`, "info");
  });
});
