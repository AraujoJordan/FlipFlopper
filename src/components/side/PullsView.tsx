import { Component, For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commentOnPullRequest, createPullRequest, generateGitText, generatePullRequestGuide, listPullRequests, mergePullRequest, pullRequestDetail, pullRequestFiles, setPullRequestOpen, submitPullRequestReview, addPullRequestLabels, addPullRequestReviewers, reactToPullRequest, setPullRequestAutoMerge, updatePullRequest, setPullRequestDraft, updatePullRequestBranch, checkoutPullRequest, revertPullRequest, type PendingReviewComment, type PrCheck, type PrDetail, type PrFileEntry, type PrFiles, type PrReviewComment, type PrReviewGuide, type PrSummary, type PrTimelineItem } from "../../lib/ipc";
import { chat, reviewPullRequest } from "../../lib/chat";
import { effectiveRoot, store, bumpGitStatus } from "../../lib/store";
import { writeClipboardText } from "../../lib/native";
import { Icon, type IconName } from "../shell/Icon";
import { Menu, MenuDivider, MenuItem, MenuLabel, Spinner, confirmDialog, toast } from "../ui";
import Markdown from "../chat/Markdown";
import { indexFileHunks } from "../../lib/diffModel";
import { gitWritingInstructions } from "../../lib/settings";
import { isPrFileViewed, prFileKey, setPrFileViewed } from "../../lib/prViewed";
import { addComposerContext } from "../../lib/composerContexts";
import { linkPr } from "../../lib/linkedPrs";
import { openFileInViewer } from "../../lib/fileViewer";
import { runAction } from "../../lib/shortcuts";

type PullState = "open" | "closed" | "all";
type PrTab = "overview" | "guide" | "checks" | "commits" | "files" | "activity";

const TABS: { id: PrTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "guide", label: "Guide" },
  { id: "checks", label: "Checks" },
  { id: "commits", label: "Commits" },
  { id: "files", label: "Files" },
  { id: "activity", label: "Activity" },
];

const relative = (iso: string): string => {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(ts).toLocaleDateString();
};

const checksTone = (checks: PrSummary["checks"]): "pass" | "fail" | "pending" | "none" => {
  if (checks.failing > 0) return "fail";
  if (checks.pending > 0) return "pending";
  return checks.passing > 0 ? "pass" : "none";
};

const stateTone = (pr: PrSummary): string =>
  pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.is_draft ? "draft" : "open";

const stateLabel = (pr: PrSummary): string =>
  pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.is_draft ? "Draft" : "Open";

/** PRs chained by base/head branches, returned bottom (base) to top (head). */
function pullRequestStack(all: readonly PrSummary[], pr: PrSummary): PrSummary[] {
  const byHead = new Map(all.map((entry) => [entry.head_ref_name, entry]));
  const seen = new Set<number>([pr.number]);
  const chain: PrSummary[] = [pr];
  let base = pr.base_ref_name;
  while (base) {
    const lower = byHead.get(base);
    if (!lower || seen.has(lower.number)) break;
    chain.unshift(lower);
    seen.add(lower.number);
    base = lower.base_ref_name;
  }
  let head = pr.head_ref_name;
  while (head) {
    const upper = all.find((entry) => entry.base_ref_name === head && !seen.has(entry.number));
    if (!upper) break;
    chain.push(upper);
    seen.add(upper.number);
    head = upper.head_ref_name;
  }
  return chain.length > 1 ? chain : [];
}

const checkTone = (check: PrCheck): "pass" | "fail" | "pending" => {
  const value = (check.conclusion || check.status || "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value)) return "pass";
  if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"].includes(value)) return "fail";
  return "pending";
};

const checkLabel = (check: PrCheck): string => {
  const tone = checkTone(check);
  if (tone === "pass") return "Passed";
  if (tone === "fail") return check.conclusion ? check.conclusion.replace(/_/g, " ").toLowerCase() : "Failed";
  if (check.status === "IN_PROGRESS") return "Running";
  if (check.status === "QUEUED") return "Queued";
  return "Waiting";
};

const checkIcon = (check: PrCheck): IconName => checkTone(check) === "pass" ? "check" : checkTone(check) === "fail" ? "x" : "history";

const reviewLabel = (value: string): string | null =>
  value === "APPROVED" ? "Approved" : value === "CHANGES_REQUESTED" ? "Changes requested" : value === "REVIEW_REQUIRED" ? "Review required" : null;

/** GitHub pull requests for the open checkout, with checks, commits, files and activity.
 *  Read-only; reviewing a PR starts a worktree-backed Ask session. */
const PullsView: Component = () => {
  const [state, setState] = createSignal<PullState>("open");
  const [selected, setSelected] = createSignal<number | null>(null);
  const [tab, setTab] = createSignal<PrTab>("overview");
  const [guides, setGuides] = createSignal<Record<number, PrReviewGuide>>({});
  const [guideBusy, setGuideBusy] = createSignal(false);
  const [guideError, setGuideError] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [draftFilter, setDraftFilter] = createSignal<"all" | "drafts" | "ready">("all");
  const [checkFilter, setCheckFilter] = createSignal<"all" | "failing" | "pending" | "passing">("all");
  const [reviewFilter, setReviewFilter] = createSignal<"all" | "approved" | "changes" | "required">("all");
  const [filterMenu, setFilterMenu] = createSignal(false);
  let filterAnchor: HTMLButtonElement | undefined;
  const [refresh, setRefresh] = createSignal(0);
  const [mergeMenu, setMergeMenu] = createSignal(false);
  const [comment, setComment] = createSignal("");
  const [posting, setPosting] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal("");
  const [newBody, setNewBody] = createSignal("");
  const [newBase, setNewBase] = createSignal("");
  const [newDraft, setNewDraft] = createSignal(false);
  const [creatingBusy, setCreatingBusy] = createSignal(false);
  const [generatingText, setGeneratingText] = createSignal(false);
  const [drafts, setDrafts] = createSignal<PendingReviewComment[]>([]);
  const [commenting, setCommenting] = createSignal<{ path: string; line: number; side: "LEFT" | "RIGHT" } | null>(null);
  const [commentText, setCommentText] = createSignal("");
  const [reviewBody, setReviewBody] = createSignal("");
  const [reviewEvent, setReviewEvent] = createSignal<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [submittingReview, setSubmittingReview] = createSignal(false);
  const [expandedFiles, setExpandedFiles] = createSignal<ReadonlySet<string>>(new Set());
  const [hideViewed, setHideViewed] = createSignal(false);
  const [stackOpen, setStackOpen] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [editTitle, setEditTitle] = createSignal("");
  const [editBody, setEditBody] = createSignal("");
  const [metaBusy, setMetaBusy] = createSignal(false);
  const [reviewerDraft, setReviewerDraft] = createSignal("");
  const [labelDraft, setLabelDraft] = createSignal("");
  createEffect(on(() => detail()?.value?.summary.number, () => {
    const current = detail()?.value;
    if (!current) return;
    setEditTitle(current.summary.title);
    setEditBody(current.body);
    setEditing(false);
  }));
  let mergeAnchor: HTMLButtonElement | undefined;

  const root = () => effectiveRoot();

  const [list, { refetch: refetchList }] = createResource(
    () => {
      const path = root();
      return path ? { path, state: state(), refresh: refresh() } : null;
    },
    async (key) => {
      try {
        return { items: await listPullRequests(key.path, key.state), error: null as string | null };
      } catch (error) {
        return { items: [] as PrSummary[], error: String(error) };
      }
    },
  );

  const [detail, { refetch: refetchDetail }] = createResource(
    () => {
      const path = root();
      const number = selected();
      return path && number ? { path, number, refresh: refresh() } : null;
    },
    async (key) => {
      try {
        return { value: await pullRequestDetail(key.path, key.number), error: null as string | null };
      } catch (error) {
        return { value: null as PrDetail | null, error: String(error) };
      }
    },
  );

  const [allPrs] = createResource(
    () => {
      const path = root();
      const number = selected();
      return path && number ? { path, refresh: refresh() } : null;
    },
    async (key) => {
      try { return await listPullRequests(key.path, "all"); } catch { return [] as PrSummary[]; }
    },
  );
  const stack = createMemo(() => {
    const pr = detail()?.value?.summary;
    return pr ? pullRequestStack(allPrs() ?? list()?.items ?? [], pr) : [];
  });
  const stackPosition = () => {
    const number = detail()?.value?.summary.number;
    return number ? stack().findIndex((layer) => layer.number === number) + 1 : 0;
  };
  const rowStack = (pr: PrSummary) => pullRequestStack(list()?.items ?? [], pr);
  const rowStackInfo = (pr: PrSummary) => {
    const chain = rowStack(pr);
    const position = chain.findIndex((layer) => layer.number === pr.number) + 1;
    return chain.length > 1 ? { position, size: chain.length } : null;
  };

  const [files, { refetch: refetchFiles }] = createResource(
    () => {
      const path = root();
      const number = selected();
      return path && number && tab() === "files" ? { path, number, refresh: refresh() } : null;
    },
    async (key) => {
      try {
        return { value: await pullRequestFiles(key.path, key.number), error: null as string | null };
      } catch (error) {
        return { value: null as PrFiles | null, error: String(error) };
      }
    },
  );

  createEffect(on(() => root(), () => { setSelected(null); setFilter(""); setRefresh(0); }));
  createEffect(on(selected, () => {
    setTab("overview");
    setGuideError("");
    setStackOpen(false);
    setDrafts([]);
    setCommenting(null);
    setCommentText("");
    setReviewBody("");
    setReviewEvent("COMMENT");
  }));
  createEffect(on(() => files()?.value, (data) => {
    if (data) setExpandedFiles(new Set(data.files.slice(0, 3).map((file) => file.filename)));
  }));

  const reload = () => {
    setRefresh((value) => value + 1);
    void refetchList();
    if (selected()) void refetchDetail();
    if (selected() && tab() === "files") void refetchFiles();
  };

  const guide = () => { const number = selected(); return number ? guides()[number] ?? null : null; };
  const writeGuide = async () => {
    const path = root();
    const number = selected();
    if (!path || !number || guideBusy()) return;
    setGuideBusy(true);
    setGuideError("");
    try {
      const result = await generatePullRequestGuide(path, number);
      setGuides((current) => ({ ...current, [number]: result }));
    } catch (error) {
      setGuideError(String(error));
    } finally {
      setGuideBusy(false);
    }
  };
  const citeGuideStop = (stop: PrReviewGuide["stops"][number], index: number) => {
    const pr = detail()?.value;
    if (!pr) return;
    addComposerContext({
      kind: "review",
      label: `PR #${pr.summary.number} · ${stop.title}`,
      detail: [
        `Pull request #${pr.summary.number}: ${pr.summary.title}`,
        pr.summary.url,
        `Review guide stop ${index + 1} (${stop.kind || "review"}): ${stop.title}`,
        stop.summary,
        stop.path ? `Location: ${stop.path}${stop.line ? `:${stop.line}` : ""}` : "",
        stop.excerpt ? `Excerpt:\n${stop.excerpt}` : "",
      ].filter(Boolean).join("\n"),
    });
    runAction("focus-prompt");
    toast("Review stop added to the composer", "info");
  };

  const filtered = () => {
    const query = filter().trim().toLowerCase();
    const items = list()?.items ?? [];
    return items.filter((pr) => {
      if (query && !(pr.title.toLowerCase().includes(query) || String(pr.number).includes(query)
        || pr.author.toLowerCase().includes(query) || pr.head_ref_name.toLowerCase().includes(query)
        || pr.base_ref_name.toLowerCase().includes(query))) return false;
      const draft = draftFilter();
      if (draft === "drafts" && !pr.is_draft) return false;
      if (draft === "ready" && pr.is_draft) return false;
      const checks = checksTone(pr.checks);
      if (checkFilter() === "failing" && checks !== "fail") return false;
      if (checkFilter() === "pending" && checks !== "pending") return false;
      if (checkFilter() === "passing" && checks !== "pass") return false;
      const review = reviewFilter();
      if (review === "approved" && pr.review_decision !== "APPROVED") return false;
      if (review === "changes" && pr.review_decision !== "CHANGES_REQUESTED") return false;
      if (review === "required" && pr.review_decision !== "REVIEW_REQUIRED") return false;
      return true;
    });
  };
  const activeFilters = () => [draftFilter() !== "all", checkFilter() !== "all", reviewFilter() !== "all"].filter(Boolean).length;

  const copyLink = (url: string) => void writeClipboardText(url, "pull request link").then(() => toast("Copied pull request link", "success"));

  const openReview = async (number: number) => {
    const started = await reviewPullRequest(String(number));
    if (started) setSelected(null);
  };

  const merge = async (method: "squash" | "merge" | "rebase") => {
    setMergeMenu(false);
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path) return;
    const label = method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Create a merge commit";
    if (!(await confirmDialog(`${label} #${pr.summary.number} on GitHub?\n\nThis merges the pull request and deletes its remote branch. It cannot be undone here.`, { confirmLabel: label, danger: true }))) return;
    try {
      await mergePullRequest(path, pr.summary.number, method, true);
      toast(`#${pr.summary.number} merged`, "success");
      reload();
    } catch (error) {
      toast(`Couldn't merge: ${String(error)}`, "error");
    }
  };

  const mergeStack = async (method: "squash" | "merge" | "rebase") => {
    setMergeMenu(false);
    const path = root();
    const layers = stack().filter((layer) => layer.state === "OPEN");
    if (!path || layers.length < 2) return;
    if (!(await confirmDialog(
      `Merge ${layers.length} stacked pull requests, starting from the base?\n\n${layers.map((layer) => `#${layer.number} ${layer.title}`).join("\n")}\n\nEach merge deletes its remote branch. This cannot be undone here.`,
      { confirmLabel: `Merge ${layers.length} pull requests`, danger: true },
    ))) return;
    try {
      for (const layer of layers) await mergePullRequest(path, layer.number, method, true);
      toast(`Merged ${layers.length} stacked pull requests`, "success");
      reload();
    } catch (error) {
      toast(`Couldn't merge the stack: ${String(error)}`, "error");
    }
  };

  const enableAutoMerge = async (method: "squash" | "merge" | "rebase" = "squash") => {
    setMergeMenu(false);
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path) return;
    try {
      await setPullRequestAutoMerge(path, pr.summary.number, method);
      toast(`Auto-merge enabled for #${pr.summary.number}`, "success");
      reload();
    } catch (error) {
      toast(`Couldn't enable auto-merge: ${String(error)}`, "error");
    }
  };

  const toggleOpen = async () => {
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path) return;
    const open = pr.summary.state === "CLOSED";
    if (!(await confirmDialog(`${open ? "Reopen" : "Close"} #${pr.summary.number} on GitHub?`, { confirmLabel: open ? "Reopen" : "Close", danger: !open }))) return;
    try {
      await setPullRequestOpen(path, pr.summary.number, open);
      toast(open ? `#${pr.summary.number} reopened` : `#${pr.summary.number} closed`, "success");
      reload();
    } catch (error) {
      toast(`Couldn't ${open ? "reopen" : "close"} the pull request: ${String(error)}`, "error");
    }
  };

  const toggleDraft = async () => {
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path) return;
    const draft = !pr.summary.is_draft;
    try {
      await setPullRequestDraft(path, pr.summary.number, draft);
      toast(draft ? `#${pr.summary.number} converted to a draft` : `#${pr.summary.number} is ready for review`, "success");
      reload();
    } catch (error) {
      toast(`Couldn't change the draft state: ${String(error)}`, "error");
    }
  };

  const updateBranch = async () => {
    setMergeMenu(false);
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path) return;
    try {
      await updatePullRequestBranch(path, pr.summary.number);
      toast(`Updated #${pr.summary.number} from its base branch`, "success");
      reload();
    } catch (error) {
      toast(`Couldn't update the branch: ${String(error)}`, "error");
    }
  };

  const checkOut = async () => {
    setMergeMenu(false);
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path) return;
    if (!(await confirmDialog(`Check out #${pr.summary.number} in this checkout?\n\nThe current branch changes to ${pr.summary.head_ref_name}. Uncommitted changes may block the checkout.`, { confirmLabel: "Check out" }))) return;
    try {
      const result = await checkoutPullRequest(path, pr.summary.number);
      toast(result || `Checked out #${pr.summary.number}`, "success");
      bumpGitStatus();
      reload();
    } catch (error) {
      toast(`Couldn't check out the pull request: ${String(error)}`, "error");
    }
  };

  const revert = async () => {
    setMergeMenu(false);
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path) return;
    if (!(await confirmDialog(`Create a revert pull request for #${pr.summary.number}?\n\nGitHub creates a new draft pull request that reverses this merge.`, { confirmLabel: "Create revert", danger: true }))) return;
    try {
      const created = await revertPullRequest(path, pr.summary.number, true);
      toast(`Opened revert #${created.number}`, "success");
      reload();
    } catch (error) {
      toast(`Couldn't create the revert: ${String(error)}`, "error");
    }
  };

  const createNew = async (event: Event) => {
    event.preventDefault();
    const path = root();
    const title = newTitle().trim();
    if (!path || !title || creatingBusy()) return;
    setCreatingBusy(true);
    try {
      const created = await createPullRequest(path, title, newBody(), newBase().trim(), newDraft());
      toast(`Opened pull request #${created.number}`, "success");
      setCreating(false);
      setNewTitle("");
      setNewBody("");
      setNewBase("");
      setNewDraft(false);
      setRefresh((value) => value + 1);
      await refetchList();
      setSelected(created.number);
    } catch (error) {
      toast(`Couldn't create the pull request: ${String(error)}`, "error");
    } finally {
      setCreatingBusy(false);
    }
  };

  const draftPullRequest = async () => {
    const path = root();
    if (!path || generatingText()) return;
    setGeneratingText(true);
    try {
      const text = await generateGitText("pr", path, gitWritingInstructions());
      const newline = text.indexOf("\n");
      setNewTitle((newline < 0 ? text : text.slice(0, newline)).replace(/^#+\s*/, "").trim().slice(0, 200));
      setNewBody(newline < 0 ? "" : text.slice(newline).replace(/^\n+/, "").trim());
    } catch (error) {
      toast(`Couldn't draft the pull request: ${String(error)}`, "error");
    } finally {
      setGeneratingText(false);
    }
  };

  const saveEdits = async (event: Event) => {
    event.preventDefault();
    const path = root();
    const number = detail()?.value?.summary.number;
    if (!path || !number || metaBusy()) return;
    setMetaBusy(true);
    try {
      await updatePullRequest(path, number, editTitle(), editBody());
      toast("Pull request updated", "success");
      setEditing(false);
      await refetchDetail();
      await refetchList();
    } catch (error) {
      toast(`Couldn't update the pull request: ${String(error)}`, "error");
    } finally {
      setMetaBusy(false);
    }
  };

  const addReviewer = async (event: Event) => {
    event.preventDefault();
    const path = root();
    const number = detail()?.value?.summary.number;
    if (!path || !number || !reviewerDraft().trim() || metaBusy()) return;
    setMetaBusy(true);
    try {
      await addPullRequestReviewers(path, number, [reviewerDraft()]);
      setReviewerDraft("");
      toast("Reviewer added", "success");
      await refetchDetail();
    } catch (error) {
      toast(`Couldn't add the reviewer: ${String(error)}`, "error");
    } finally {
      setMetaBusy(false);
    }
  };

  const addLabel = async (event: Event) => {
    event.preventDefault();
    const path = root();
    const number = detail()?.value?.summary.number;
    if (!path || !number || !labelDraft().trim() || metaBusy()) return;
    setMetaBusy(true);
    try {
      await addPullRequestLabels(path, number, [labelDraft()]);
      setLabelDraft("");
      toast("Label added", "success");
      await refetchDetail();
    } catch (error) {
      toast(`Couldn't add the label: ${String(error)}`, "error");
    } finally {
      setMetaBusy(false);
    }
  };

  const react = async (reaction: string) => {
    const path = root();
    const number = detail()?.value?.summary.number;
    if (!path || !number || metaBusy()) return;
    setMetaBusy(true);
    try {
      await reactToPullRequest(path, number, reaction);
    } catch (error) {
      toast(`Couldn't add the reaction: ${String(error)}`, "error");
    } finally {
      setMetaBusy(false);
    }
  };

  const lineOf = (comment: PrReviewComment) => comment.line ?? comment.original_line;  const commentsAt = (path: string, line: number, side: "LEFT" | "RIGHT") =>
    (files()?.value?.comments ?? []).filter((entry) =>
      entry.path === path && lineOf(entry) === line && (!entry.side || entry.side === side));
  const draftsAt = (path: string, line: number, side: "LEFT" | "RIGHT") =>
    drafts().filter((entry) => entry.path === path && entry.line === line && entry.side === side);

  const toggleFile = (path: string) => {
    setExpandedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const beginComment = (path: string, line: number, side: "LEFT" | "RIGHT") => {
    setCommenting({ path, line, side });
    setCommentText("");
  };

  const addDraft = () => {
    const target = commenting();
    const body = commentText().trim();
    if (!target || !body) return;
    setDrafts((current) => [...current, { path: target.path, line: target.line, side: target.side, body }]);
    setCommenting(null);
    setCommentText("");
  };

  const removeDraft = (index: number) => setDrafts((current) => current.filter((_, at) => at !== index));

  const submitReview = async () => {
    const pr = detail()?.value;
    const path = root();
    if (!pr || !path || submittingReview()) return;
    if (reviewEvent() !== "APPROVE" && !reviewBody().trim() && drafts().length === 0) {
      toast("Write a review summary or add a line comment first.", "info");
      return;
    }
    setSubmittingReview(true);
    try {
      const result = await submitPullRequestReview(path, pr.summary.number, reviewEvent(), reviewBody(), drafts());
      toast(result.url ? "Review submitted" : "Review submitted on GitHub", "success");
      setDrafts([]);
      setReviewBody("");
      setReviewEvent("COMMENT");
      reload();
    } catch (error) {
      toast(`Couldn't submit the review: ${String(error)}`, "error");
    } finally {
      setSubmittingReview(false);
    }
  };

  const postComment = async () => {
    const pr = detail()?.value;
    const path = root();
    const body = comment().trim();
    if (!pr || !path || !body || posting()) return;
    setPosting(true);
    try {
      await commentOnPullRequest(path, pr.summary.number, body);
      setComment("");
      toast("Comment posted", "success");
      reload();
    } catch (error) {
      toast(`Couldn't post the comment: ${String(error)}`, "error");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div class="pulls-view">
      <Show
        when={selected()}
        fallback={
          <>
            <div class="pulls-toolbar">
              <div class="pulls-search">
                <Icon name="search" size={14} />
                <input class="ui-field" type="search" aria-label="Filter pull requests" placeholder="Filter pull requests" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} />
              </div>
              <button ref={filterAnchor} type="button" class="ui-btn ui-btn-ghost" aria-haspopup="menu" aria-expanded={filterMenu()} onClick={() => setFilterMenu((open) => !open)}>
                <Icon name="list" size={13} /> Filter{activeFilters() ? ` · ${activeFilters()}` : ""}
              </button>
              <Menu open={filterMenu()} onClose={() => setFilterMenu(false)} anchorRef={filterAnchor} align="right" width={250}>
                <MenuLabel>Draft state</MenuLabel>
                <MenuItem onSelect={() => setDraftFilter("all")}><Icon name={draftFilter() === "all" ? "check" : "remove"} size={14} /> All pull requests</MenuItem>
                <MenuItem onSelect={() => setDraftFilter("drafts")}><Icon name={draftFilter() === "drafts" ? "check" : "remove"} size={14} /> Drafts only</MenuItem>
                <MenuItem onSelect={() => setDraftFilter("ready")}><Icon name={draftFilter() === "ready" ? "check" : "remove"} size={14} /> Ready for review</MenuItem>
                <MenuDivider />
                <MenuLabel>Checks</MenuLabel>
                <For each={[{ id: "all", label: "Any checks" }, { id: "failing", label: "Failing" }, { id: "pending", label: "Pending" }, { id: "passing", label: "Passing" }] as { id: "all" | "failing" | "pending" | "passing"; label: string }[]}>
                  {(choice) => <MenuItem onSelect={() => setCheckFilter(choice.id)}><Icon name={checkFilter() === choice.id ? "check" : "remove"} size={14} /> {choice.label}</MenuItem>}
                </For>
                <MenuDivider />
                <MenuLabel>Review</MenuLabel>
                <For each={[{ id: "all", label: "Any review" }, { id: "approved", label: "Approved" }, { id: "changes", label: "Changes requested" }, { id: "required", label: "Review required" }] as { id: "all" | "approved" | "changes" | "required"; label: string }[]}>
                  {(choice) => <MenuItem onSelect={() => setReviewFilter(choice.id)}><Icon name={reviewFilter() === choice.id ? "check" : "remove"} size={14} /> {choice.label}</MenuItem>}
                </For>
              </Menu>
              <div class="seg" role="group" aria-label="Pull request state">
                <For each={["open", "closed", "all"] as PullState[]}>
                  {(value) => <button type="button" class="seg-btn" classList={{ "seg-on": state() === value }} onClick={() => setState(value)}>{value === "open" ? "Open" : value === "closed" ? "Closed" : "All"}</button>}
                </For>
              </div>
              <button type="button" class="icon-btn" onClick={reload} title="Refresh pull requests" aria-label="Refresh pull requests">
                <Show when={list.loading} fallback={<Icon name="refresh" size={14} />}><Spinner size={12} /></Show>
              </button>
              <button type="button" class="icon-btn" onClick={() => { setCreating(true); setSelected(null); }} title="New pull request" aria-label="New pull request" disabled={!root()}>
                <Icon name="plus" size={15} />
              </button>
            </div>

            <Show when={root()} fallback={<div class="pane-empty"><Icon name="merge" size={28} /><p>Open a project to see its pull requests.</p></div>}>
              <Show when={!creating()} fallback={
                <form class="pulls-create" onSubmit={createNew}>
                  <div class="pulls-create-head">
                    <Icon name="merge" size={18} />
                    <div>
                      <strong>New pull request</strong>
                      <span>From <code>{store.currentBranch || "the current branch"}</code> to the repository's base branch.</span>
                    </div>
                  </div>
                  <label class="pulls-create-field">
                    <span>Title</span>
                    <input class="ui-field" required value={newTitle()} onInput={(event) => setNewTitle(event.currentTarget.value)} placeholder="What does this change?" />
                  </label>
                  <label class="pulls-create-field">
                    <span>Description</span>
                    <textarea class="ui-field" rows={7} value={newBody()} onInput={(event) => setNewBody(event.currentTarget.value)} placeholder="Summary, test plan, screenshots…" />
                  </label>
                  <label class="pulls-create-field">
                    <span>Base branch</span>
                    <input class="ui-field" value={newBase()} onInput={(event) => setNewBase(event.currentTarget.value)} placeholder="Repository default (usually main)" />
                  </label>
                  <label class="pulls-create-draft">
                    <input type="checkbox" checked={newDraft()} onChange={(event) => setNewDraft(event.currentTarget.checked)} />
                    <span>Create as a draft</span>
                  </label>
                  <div class="pulls-create-actions">
                    <button type="button" class="ui-btn ui-btn-outline" disabled={generatingText() || creatingBusy()} onClick={() => void draftPullRequest()} title="Draft a title and description from the changes">
                      <Show when={generatingText()} fallback={<><Icon name="sparkle" size={12} /> Generate</>}><Spinner size={11} /> Drafting…</Show>
                    </button>
                    <button type="button" class="ui-btn ui-btn-ghost" disabled={creatingBusy()} onClick={() => setCreating(false)}>Cancel</button>
                    <button type="submit" class="ui-btn ui-btn-solid" disabled={!newTitle().trim() || creatingBusy()}>
                      <Show when={creatingBusy()} fallback={<><Icon name="merge" size={13} /> Create pull request</>}><Spinner size={12} /> Creating…</Show>
                    </button>
                  </div>
                  <p class="pulls-muted">The branch must be published first. Use Push in Changes if GitHub reports no commits.</p>
                </form>
              }>
              <Show when={list()?.error} fallback={
                <Show when={!list.loading || !!list()} fallback={<div class="pane-empty"><Spinner size={18} /><p>Loading pull requests…</p></div>}>
                  <Show when={filtered().length > 0} fallback={
                    <div class="pane-empty">
                      <Icon name="merge" size={28} />
                      <p>{filter().trim() ? "No pull requests match this filter." : state() === "open" ? "No open pull requests." : "No pull requests here."}</p>
                      <p class="pane-empty-sub">Pull requests come from the GitHub CLI and the repository's remote.</p>
                      <Show when={!store.currentProject?.is_git}><p class="pane-empty-sub">This project is not a Git checkout.</p></Show>
                    </div>
                  }>
                    <div class="pulls-list" role="list">
                      <For each={filtered()}>
                        {(pr) => (
                          <button type="button" role="listitem" class="pulls-row" onClick={() => setSelected(pr.number)}>
                            <span class="pulls-state" data-tone={stateTone(pr)} title={stateLabel(pr)}><Icon name={pr.state === "MERGED" ? "check" : pr.state === "CLOSED" ? "x" : "merge"} size={13} /></span>
                            <span class="pulls-row-main">
                              <span class="pulls-row-title"><span class="pulls-number">#{pr.number}</span>{pr.title}</span>
                              <Show when={pr.labels.length > 0}>
                                <span class="pulls-labels">
                                  <For each={pr.labels.slice(0, 3)}>{(label) => <span class="pulls-label">{label}</span>}</For>
                                  <Show when={pr.labels.length > 3}><span class="pulls-label">+{pr.labels.length - 3}</span></Show>
                                </span>
                              </Show>
                              <span class="pulls-row-meta">
                                <span>{pr.author}</span>
                                <span class="pulls-branch"><Icon name="gitBranch" size={10} />{pr.head_ref_name || "?"} → {pr.base_ref_name || "?"}</span>
                                <Show when={pr.changed_files > 0}><span>{pr.changed_files} file{pr.changed_files === 1 ? "" : "s"}</span></Show>
                              </span>
                            </span>
                            <span class="pulls-row-side">
                              <Show when={rowStackInfo(pr)}>
                                {(info) => <span class="pulls-stack-count" title={`Stack ${info().position} of ${info().size}`}><Icon name="layers" size={10} />{info().position}/{info().size}</span>}
                              </Show>
                              <span class="pulls-checks" data-tone={checksTone(pr.checks)} title={`${pr.checks.passing} passing · ${pr.checks.failing} failing · ${pr.checks.pending} pending`}>
                                <span class="pulls-check-dot" />
                                <span>{checksTone(pr.checks) === "none" ? "No checks" : `${pr.checks.passing}/${pr.checks.passing + pr.checks.failing + pr.checks.pending}`}</span>
                              </span>
                              <Show when={reviewLabel(pr.review_decision)}>{(label) => <span class="pulls-review" data-tone={pr.review_decision.toLowerCase()}>{label()}</span>}</Show>
                              <span class="pulls-ago">{relative(pr.updated_at)}</span>
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              }>
                {(error) => (
                  <div class="pane-empty pulls-error">
                    <Icon name="alert" size={26} />
                    <p>Couldn't load pull requests.</p>
                    <p class="pane-empty-sub">{error()}</p>
                    <button type="button" class="ui-btn ui-btn-outline" onClick={reload}>Try again</button>
                  </div>
                )}
              </Show>
              </Show>
            </Show>
          </>
        }
      >
        {(number) => (
          <>
            <div class="pulls-toolbar pulls-detail-toolbar">
              <button type="button" class="icon-btn" onClick={() => setSelected(null)} title="Back to pull requests" aria-label="Back to pull requests"><Icon name="arrowLeft" size={15} /></button>
              <span class="pulls-detail-number">#{number()}</span>
              <button type="button" class="icon-btn" onClick={reload} title="Refresh" aria-label="Refresh pull request"><Show when={detail.loading} fallback={<Icon name="refresh" size={14} />}><Spinner size={12} /></Show></button>
              <Show when={detail()?.value}>
                {(loaded) => (
                  <>
                    <button type="button" class="icon-btn" onClick={() => copyLink(loaded().summary.url)} title="Copy link" aria-label="Copy pull request link"><Icon name="copy" size={14} /></button>
                    <button type="button" class="icon-btn" onClick={() => void openUrl(loaded().summary.url).catch((error) => toast(String(error), "error"))} title="Open on GitHub" aria-label="Open on GitHub"><Icon name="external" size={14} /></button>
                  </>
                )}
              </Show>
            </div>

            <Show when={detail()?.error} fallback={
              <Show when={detail()?.value} fallback={<div class="pane-empty"><Spinner size={18} /><p>Loading pull request…</p></div>}>
                {(pr) => (
                  <div class="pulls-detail">
                    <div class="pulls-detail-head">
                      <div class="pulls-title-line">
                        <span class="pulls-state" data-tone={stateTone(pr().summary)} title={stateLabel(pr().summary)}><Icon name={pr().summary.state === "MERGED" ? "check" : pr().summary.state === "CLOSED" ? "x" : "merge"} size={13} /></span>
                        <h2 class="pulls-title">{pr().summary.title}</h2>
                      </div>
                      <div class="pulls-detail-meta">
                        <span class="pulls-badge" data-tone={stateTone(pr().summary)}>{stateLabel(pr().summary)}</span>
                        <Show when={reviewLabel(pr().summary.review_decision)}>{(label) => <span class="pulls-badge" data-tone={pr().summary.review_decision.toLowerCase()}>{label()}</span>}</Show>
                        <span><strong>{pr().summary.author || "someone"}</strong> wants to merge</span>
                        <span class="pulls-branch"><Icon name="gitBranch" size={11} />{pr().summary.head_ref_name || "?"} → {pr().summary.base_ref_name || "?"}</span>
                        <span class="pulls-stat-add">+{pr().summary.additions}</span>
                        <span class="pulls-stat-del">−{pr().summary.deletions}</span>
                        <span>{pr().summary.changed_files} file{pr().summary.changed_files === 1 ? "" : "s"}</span>
                        <Show when={pr().summary.labels.length > 0}>
                          <span class="pulls-labels">
                            <For each={pr().summary.labels.slice(0, 4)}>{(label) => <span class="pulls-label">{label}</span>}</For>
                            <Show when={pr().summary.labels.length > 4}><span class="pulls-label">+{pr().summary.labels.length - 4}</span></Show>
                          </span>
                        </Show>
                        <Show when={stack().length > 1}>
                          <button type="button" class="pulls-stack-badge" aria-expanded={stackOpen()} onClick={() => setStackOpen((value) => !value)}>
                            <Icon name="layers" size={11} /> Stack {stackPosition()}/{stack().length}
                          </button>
                        </Show>
                        <Show when={pr().reviewers.length > 0}>
                          <span class="pulls-reviewers" title="Reviewers">Reviewers: {pr().reviewers.join(", ")}</span>
                        </Show>
                      </div>
                    </div>

                    <div class="pulls-detail-actions">
                      <button type="button" class="ui-btn ui-btn-outline" onClick={() => void openReview(pr().summary.number)}>
                        <Icon name="sparkle" size={13} /> Review in new session
                      </button>
                      <button type="button" class="ui-btn ui-btn-ghost" onClick={() => {
                        addComposerContext({
                          kind: "pr",
                          label: `PR #${pr().summary.number} · ${pr().summary.title}`,
                          detail: `${pr().summary.title}\n${pr().summary.url}\n\n${pr().body}`.slice(0, 8000),
                        });
                        runAction("focus-prompt");
                        toast("Pull request added to the composer", "info");
                      }}>
                        <Icon name="message" size={13} /> Cite
                      </button>
                      <Show when={chat.activeId}>
                        <button type="button" class="ui-btn ui-btn-ghost" onClick={() => {
                          const added = linkPr(chat.activeId, {
                            number: pr().summary.number,
                            title: pr().summary.title,
                            url: pr().summary.url,
                            state: pr().summary.state,
                            is_draft: pr().summary.is_draft,
                            head_ref_name: pr().summary.head_ref_name,
                            base_ref_name: pr().summary.base_ref_name,
                          });
                          toast(added ? `Linked #${pr().summary.number} to this thread` : "That pull request is already linked", added ? "success" : "info");
                        }}>
                          <Icon name="link" size={13} /> Link to thread
                        </button>
                      </Show>
                      <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void openUrl(`${pr().summary.url}/files`).catch((error) => toast(String(error), "error"))}>
                        <Icon name="diff" size={13} /> View diff on GitHub
                      </button>
                      <Show when={pr().summary.state === "OPEN"}>
                        <button type="button" class="ui-btn ui-btn-ghost" onClick={() => setEditing((value) => !value)}>
                          <Icon name="pencil" size={13} /> {editing() ? "Close editor" : "Edit"}
                        </button>
                        <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void toggleDraft()}>
                          <Icon name={pr().summary.is_draft ? "eye" : "document"} size={13} /> {pr().summary.is_draft ? "Ready for review" : "Convert to draft"}
                        </button>
                      </Show>
                      <Show when={pr().summary.state === "OPEN"}>
                        <button ref={mergeAnchor} type="button" class="ui-btn ui-btn-outline" aria-haspopup="menu" aria-expanded={mergeMenu()} onClick={() => setMergeMenu((value) => !value)}>
                          <Icon name="merge" size={13} /> Merge <Icon name="chevronDown" size={11} />
                        </button>
                        <Menu open={mergeMenu()} onClose={() => setMergeMenu(false)} anchorRef={mergeAnchor} align="right" width={240}>
                          <MenuLabel>Merge on GitHub</MenuLabel>
                          <MenuItem onSelect={() => void merge("squash")}><Icon name="merge" size={15} /> Squash and merge</MenuItem>
                          <MenuItem onSelect={() => void merge("merge")}><Icon name="merge" size={15} /> Create a merge commit</MenuItem>
                          <MenuItem onSelect={() => void merge("rebase")}><Icon name="merge" size={15} /> Rebase and merge</MenuItem>
                          <MenuItem onSelect={() => void enableAutoMerge("squash")}><Icon name="history" size={15} /> Auto-merge when ready</MenuItem>
                          <MenuItem onSelect={() => void updateBranch()}><Icon name="refresh" size={15} /> Update branch from base</MenuItem>
                          <MenuItem onSelect={() => void checkOut()}><Icon name="gitBranch" size={15} /> Check out in this project</MenuItem>
                          <Show when={stack().filter((layer) => layer.state === "OPEN").length > 1}>
                            <MenuDivider />
                            <MenuItem onSelect={() => void mergeStack("squash")}><Icon name="layers" size={15} /> Merge stack ({stack().filter((layer) => layer.state === "OPEN").length})</MenuItem>
                          </Show>
                          <MenuDivider />
                          <MenuItem onSelect={() => { setMergeMenu(false); void toggleOpen(); }}><Icon name="x" size={15} /> Close pull request</MenuItem>
                        </Menu>
                      </Show>
                      <Show when={pr().summary.state === "CLOSED"}>
                        <button type="button" class="ui-btn ui-btn-outline" onClick={() => void toggleOpen()}>
                          <Icon name="refresh" size={13} /> Reopen
                        </button>
                      </Show>
                      <Show when={pr().summary.state === "MERGED"}>
                        <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void revert()}>
                          <Icon name="refresh" size={13} /> Revert
                        </button>
                      </Show>
                      <span class="pulls-mergeability" data-tone={pr().mergeable === "CONFLICTING" ? "fail" : pr().mergeable === "MERGEABLE" ? "pass" : "pending"}>
                        {pr().mergeable === "CONFLICTING" ? "Has conflicts" : pr().mergeable === "MERGEABLE" ? `Ready to merge${pr().merge_state_status && pr().merge_state_status !== "CLEAN" ? ` · ${pr().merge_state_status.toLowerCase().replace(/_/g, " ")}` : ""}` : "Mergeability unknown"}
                      </span>
                    </div>

                    <Show when={stackOpen() && stack().length > 1}>
                      <div class="pulls-stack">
                        <div class="pulls-stack-head">
                          <span>Stack · based on <code>{stack()[0]?.base_ref_name || "base"}</code></span>
                          <button type="button" class="icon-btn" title="Close stack" aria-label="Close stack" onClick={() => setStackOpen(false)}><Icon name="x" size={12} /></button>
                        </div>
                        <For each={stack()}>
                          {(layer, index) => (
                            <button type="button" class="pulls-stack-layer" classList={{ "pulls-stack-layer-current": layer.number === pr().summary.number }}
                              onClick={() => { setSelected(layer.number); setStackOpen(false); }}>
                              <span class="pulls-stack-index">{index() + 1}</span>
                              <span class="pulls-state" data-tone={stateTone(layer)}><Icon name={layer.state === "MERGED" ? "check" : layer.state === "CLOSED" ? "x" : "merge"} size={11} /></span>
                              <span class="pulls-stack-title">#{layer.number} {layer.title}</span>
                              <span class="pulls-stack-state">{stateLabel(layer)}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>

                    <Show when={editing()}>
                      <form class="pulls-edit" onSubmit={saveEdits}>
                        <label class="pulls-create-field">
                          <span>Title</span>
                          <input class="ui-field" required value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} />
                        </label>
                        <label class="pulls-create-field">
                          <span>Description</span>
                          <textarea class="ui-field" rows={6} value={editBody()} onInput={(event) => setEditBody(event.currentTarget.value)} />
                        </label>
                        <div class="pulls-create-actions">
                          <button type="button" class="ui-btn ui-btn-ghost" disabled={metaBusy()} onClick={() => setEditing(false)}>Cancel</button>
                          <button type="submit" class="ui-btn ui-btn-solid" disabled={metaBusy() || !editTitle().trim()}>
                            <Show when={metaBusy()} fallback={<><Icon name="check" size={13} /> Save changes</>}><Spinner size={11} /> Saving…</Show>
                          </button>
                        </div>
                      </form>
                    </Show>

                    <div class="pulls-meta-tools">
                      <form class="pulls-meta-form" onSubmit={addReviewer}>
                        <input class="ui-field" aria-label="Add reviewer" placeholder="Add reviewer" value={reviewerDraft()} onInput={(event) => setReviewerDraft(event.currentTarget.value)} />
                        <button type="submit" class="ui-btn ui-btn-ghost" disabled={metaBusy() || !reviewerDraft().trim()}>Reviewer</button>
                      </form>
                      <form class="pulls-meta-form" onSubmit={addLabel}>
                        <input class="ui-field" aria-label="Add label" placeholder="Add label" value={labelDraft()} onInput={(event) => setLabelDraft(event.currentTarget.value)} />
                        <button type="submit" class="ui-btn ui-btn-ghost" disabled={metaBusy() || !labelDraft().trim()}>Label</button>
                      </form>
                      <div class="pulls-reactions" role="group" aria-label="React to pull request">
                        <For each={[{ emoji: "👍", value: "+1", label: "Thumbs up" }, { emoji: "🎉", value: "hooray", label: "Hooray" }, { emoji: "❤️", value: "heart", label: "Heart" }, { emoji: "🚀", value: "rocket", label: "Rocket" }]}>
                          {(reaction) => <button type="button" class="pulls-reaction" title={reaction.label} aria-label={reaction.label} disabled={metaBusy()} onClick={() => void react(reaction.value)}>{reaction.emoji}</button>}
                        </For>
                      </div>
                    </div>

                    <div class="pulls-tabs" role="tablist" aria-label="Pull request sections">
                      <For each={TABS}>
                        {(entry) => (
                          <button type="button" role="tab" aria-selected={tab() === entry.id} class="pulls-tab" classList={{ "pulls-tab-on": tab() === entry.id }} onClick={() => setTab(entry.id)}>
                            {entry.label}
                            <Show when={entry.id === "checks" && pr().checks.length > 0}><span class="pulls-tab-count">{pr().checks.length}</span></Show>
                            <Show when={entry.id === "guide" && guide()?.stops.length}><span class="pulls-tab-count">{guide()!.stops.length}</span></Show>
                            <Show when={entry.id === "commits" && pr().commits.length > 0}><span class="pulls-tab-count">{pr().commits.length}</span></Show>
                            <Show when={entry.id === "files" && pr().files.length > 0}><span class="pulls-tab-count">{pr().files.length}</span></Show>
                            <Show when={entry.id === "activity" && pr().timeline.length > 0}><span class="pulls-tab-count">{pr().timeline.length}</span></Show>
                          </button>
                        )}
                      </For>
                    </div>

                    <div class="pulls-detail-body">
                      <Show when={tab() === "overview"}>
                        <Show when={pr().body.trim()} fallback={<p class="pulls-muted">No description.</p>}>
                          <div class="pulls-markdown"><Markdown text={pr().body} /></div>
                        </Show>
                      </Show>

                      <Show when={tab() === "guide"}>
                        <Show when={guideBusy()} fallback={
                          <Show when={guide()} fallback={
                            <div class="pane-empty" style={{ padding: "24px 12px" }}>
                              <Icon name="clipboard" size={26} />
                              <p>{guideError() ? "Could not write a review guide." : "No review guide yet."}</p>
                              <p class="pane-empty-sub">
                                {guideError() || "A guide is a tour of the change: stops through the code in reading order, with the calls only a maintainer can make."}
                              </p>
                              <button type="button" class="ui-btn ui-btn-outline" disabled={guideBusy()} onClick={() => void writeGuide()}>
                                {guideError() ? "Try again" : "Write guide"}
                              </button>
                            </div>
                          }>
                            {(written) => (
                              <div class="pulls-guide">
                                <div class="pulls-guide-head">
                                  <div>
                                    <h3>{written().title}</h3>
                                    <p class="pulls-muted">{written().summary}</p>
                                  </div>
                                  <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void writeGuide()}>Rewrite</button>
                                </div>
                                <For each={written().stops}>
                                  {(stop, index) => (
                                    <article class="pulls-guide-stop">
                                      <div class="pulls-guide-stop-head">
                                        <span class="pulls-guide-kind">{stop.kind || "review"}</span>
                                        <h4>{index() + 1}. {stop.title}</h4>
                                      </div>
                                      <p>{stop.summary}</p>
                                      <Show when={stop.excerpt}>
                                        {(excerpt) => <pre class="pulls-guide-excerpt">{excerpt()}</pre>}
                                      </Show>
                                      <div class="pulls-guide-actions">
                                        <Show when={stop.path}>
                                          {(path) => (
                                            <button type="button" class="ui-btn ui-btn-ghost" onClick={() => void openFileInViewer(path(), stop.line ?? undefined)}>
                                              <Icon name="file" size={12} /> {path()}{stop.line ? `:${stop.line}` : ""}
                                            </button>
                                          )}
                                        </Show>
                                        <button type="button" class="ui-btn ui-btn-ghost" onClick={() => citeGuideStop(stop, index())}>
                                          <Icon name="message" size={12} /> Ask about this stop
                                        </button>
                                      </div>
                                    </article>
                                  )}
                                </For>
                              </div>
                            )}
                          </Show>
                        }>
                          <div class="pane-empty" style={{ padding: "28px 12px" }}>
                            <Spinner size={18} />
                            <p>Writing a review guide…</p>
                            <p class="pane-empty-sub">Reading the diff in a headless agent session.</p>
                          </div>
                        </Show>
                      </Show>

                      <Show when={tab() === "checks"}>
                        <Show when={pr().checks.length > 0} fallback={<p class="pulls-muted">No checks reported for this pull request.</p>}>
                          <For each={pr().checks}>
                            {(check) => (
                              <div class="pulls-check-row" data-tone={checkTone(check)}>
                                <Icon name={checkIcon(check)} size={14} />
                                <span class="pulls-check-name">{check.name}</span>
                                <span class="pulls-check-state">{checkLabel(check)}</span>
                                <Show when={check.url}>
                                  {(url) => <button type="button" class="icon-btn" title="Open check details" aria-label="Open check details" onClick={() => void openUrl(url()).catch((error) => toast(String(error), "error"))}><Icon name="external" size={12} /></button>}
                                </Show>
                              </div>
                            )}
                          </For>
                        </Show>
                      </Show>

                      <Show when={tab() === "commits"}>
                        <Show when={pr().commits.length > 0} fallback={<p class="pulls-muted">No commits.</p>}>
                          <For each={pr().commits}>
                            {(commit) => (
                              <div class="pulls-commit-row">
                                <span class="pulls-commit-oid">{commit.oid.slice(0, 7)}</span>
                                <span class="pulls-commit-main"><span class="pulls-commit-headline">{commit.headline}</span><span class="pulls-commit-meta">{commit.author} · {relative(commit.committed_at)}</span></span>
                              </div>
                            )}
                          </For>
                        </Show>
                      </Show>

                      <Show when={tab() === "files"}>
                        <Show when={files()?.error} fallback={
                          <Show when={files()?.value} fallback={<div class="pane-empty" style={{ padding: "20px 0" }}><Spinner size={16} /><p>Loading changed files…</p></div>}>
                            {(data) => (
                              <div class="pulls-files">
                                <div class="pulls-files-head">
                                  <span>{data().files.length} changed file{data().files.length === 1 ? "" : "s"}</span>
                                  <span class="pulls-muted">{data().files.filter((file) => isPrFileViewed(prFileKey(pr().summary.number, file.filename))).length} viewed</span>
                                  <label class="pulls-muted pulls-viewed-filter"><input type="checkbox" checked={hideViewed()} onChange={(event) => setHideViewed(event.currentTarget.checked)} /> Hide viewed</label>
                                  <span class="pulls-muted">Click a line number to comment.</span>
                                  <button type="button" class="icon-btn" title="Refresh files and comments" aria-label="Refresh files and comments" onClick={() => void refetchFiles()}><Icon name="refresh" size={13} /></button>
                                </div>
                                <Show when={data().files.length > 0} fallback={<p class="pulls-muted">No changed files.</p>}>
                                  <For each={data().files.filter((file) => !hideViewed() || !isPrFileViewed(prFileKey(pr().summary.number, file.filename)))}>
                                    {(file: PrFileEntry) => (
                                      <div class="pulls-file">
                                        <div class="pulls-file-head-row">
                                          <button type="button" class="pulls-file-head" onClick={() => toggleFile(file.filename)} aria-expanded={expandedFiles().has(file.filename)}>
                                            <Icon name="chevronRight" size={11} style={{ transform: expandedFiles().has(file.filename) ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} />
                                            <Icon name="file" size={13} />
                                            <span class="pulls-file-path">{file.filename}</span>
                                            <Show when={file.previous_filename}><span class="pulls-file-renamed">from {file.previous_filename}</span></Show>
                                            <span class="pulls-file-status">{file.status}</span>
                                            <span class="pulls-stat-add">+{file.additions}</span>
                                            <span class="pulls-stat-del">−{file.deletions}</span>
                                          </button>
                                          <button
                                            type="button"
                                            class="pulls-file-viewed"
                                            classList={{ "pulls-file-viewed-on": isPrFileViewed(prFileKey(pr().summary.number, file.filename)) }}
                                            aria-pressed={isPrFileViewed(prFileKey(pr().summary.number, file.filename))}
                                            title={isPrFileViewed(prFileKey(pr().summary.number, file.filename)) ? "Mark this file unviewed" : "Mark this file viewed"}
                                            onClick={() => setPrFileViewed(prFileKey(pr().summary.number, file.filename), !isPrFileViewed(prFileKey(pr().summary.number, file.filename)))}
                                          >
                                            {isPrFileViewed(prFileKey(pr().summary.number, file.filename)) ? "Viewed" : "Mark viewed"}
                                          </button>
                                        </div>
                                        <Show when={expandedFiles().has(file.filename)}>
                                          <Show when={file.diff && indexFileHunks(file.diff).hunks.length > 0} fallback={
                                            <div class="pulls-patch-empty">{file.patch ? "This patch has no line-numbered hunks." : "No textual diff (binary or rename-only file)."} <button type="button" class="link-btn" onClick={() => void openUrl(`${pr().summary.url}/files`).catch((error) => toast(String(error), "error"))}>View on GitHub</button></div>
                                          }>
                                            <For each={indexFileHunks(file.diff!).hunks}>
                                              {(hunk) => (
                                                <div class="pulls-patch">
                                                  <div class="pulls-patch-head">{hunk.header}</div>
                                                  <For each={hunk.lines}>
                                                    {(entry) => {
                                                      const oldLine = entry.line.old_lineno;
                                                      const newLine = entry.line.new_lineno;
                                                      const side = (): "LEFT" | "RIGHT" => entry.line.kind === "del" ? "LEFT" : "RIGHT";
                                                      const target = (): number | null => side() === "LEFT" ? oldLine : newLine;
                                                      const existing = () => {
                                                        const line = target();
                                                        return line === null ? [] : commentsAt(file.filename, line, side());
                                                      };
                                                      const pending = () => {
                                                        const line = target();
                                                        return line === null ? [] : draftsAt(file.filename, line, side());
                                                      };
                                                      return (
                                                        <>
                                                          <div class="pulls-patch-line" data-kind={entry.line.kind}>
                                                            <button type="button" class="pulls-patch-no" disabled={oldLine === null} title={oldLine === null ? undefined : "Comment on the deleted line"} onClick={() => oldLine !== null && beginComment(file.filename, oldLine, "LEFT")}>{oldLine ?? ""}</button>
                                                            <button type="button" class="pulls-patch-no" disabled={newLine === null} title={newLine === null ? undefined : "Comment on this line"} onClick={() => newLine !== null && beginComment(file.filename, newLine, "RIGHT")}>{newLine ?? ""}</button>
                                                            <span class="pulls-patch-sigil">{entry.line.kind === "add" ? "+" : entry.line.kind === "del" ? "−" : " "}</span>
                                                            <code>{entry.line.content || " "}</code>
                                                          </div>
                                                          <For each={existing()}>
                                                            {(item) => (
                                                              <div class="pulls-inline-comment">
                                                                <div class="pulls-inline-head">
                                                                  <strong>{item.author || "someone"}</strong>
                                                                  <span>{relative(item.created_at)}</span>
                                                                  <Show when={item.url}>{(url) => <button type="button" class="icon-btn" title="Open this comment on GitHub" aria-label="Open this comment on GitHub" onClick={() => void openUrl(url()).catch((error) => toast(String(error), "error"))}><Icon name="external" size={11} /></button>}</Show>
                                                                </div>
                                                                <div class="pulls-markdown"><Markdown text={item.body} /></div>
                                                              </div>
                                                            )}
                                                          </For>
                                                          <For each={pending()}>
                                                            {(draft, index) => {
                                                              const globalIndex = () => drafts().indexOf(draft);
                                                              return (
                                                                <div class="pulls-inline-comment pulls-inline-draft">
                                                                  <div class="pulls-inline-head"><strong>Pending review</strong><span>{file.filename}:{target()}</span>
                                                                    <button type="button" class="icon-btn" title="Remove draft comment" aria-label="Remove draft comment" onClick={() => removeDraft(globalIndex() >= 0 ? globalIndex() : index())}><Icon name="x" size={11} /></button>
                                                                  </div>
                                                                  <div class="pulls-markdown"><Markdown text={draft.body} /></div>
                                                                </div>
                                                              );
                                                            }}
                                                          </For>
                                                          <Show when={commenting()?.path === file.filename && commenting()?.line === target() && commenting()?.side === side()}>
                                                            <div class="pulls-inline-compose">
                                                              <textarea class="ui-field" rows={3} autofocus aria-label="Line comment" placeholder={`Comment on ${file.filename}:${target()}`} value={commentText()} onInput={(event) => setCommentText(event.currentTarget.value)} />
                                                              <div class="pulls-inline-actions">
                                                                <span class="pulls-muted">Adds to this review only; nothing is sent until you submit.</span>
                                                                <button type="button" class="ui-btn ui-btn-ghost" onClick={() => { setCommenting(null); setCommentText(""); }}>Cancel</button>
                                                                <button type="button" class="ui-btn ui-btn-outline" disabled={!commentText().trim()} onClick={addDraft}>Add to review</button>
                                                              </div>
                                                            </div>
                                                          </Show>
                                                        </>
                                                      );
                                                    }}
                                                  </For>
                                                </div>
                                              )}
                                            </For>
                                          </Show>
                                        </Show>
                                      </div>
                                    )}
                                  </For>
                                </Show>

                                <div class="pulls-review-box">
                                  <div class="pulls-review-box-head">
                                    <Icon name="check" size={14} />
                                    <strong>Review</strong>
                                    <span>{drafts().length === 0 ? "No line comments yet" : `${drafts().length} line comment${drafts().length === 1 ? "" : "s"}`}</span>
                                  </div>
                                  <For each={drafts()}>
                                    {(draft, index) => (
                                      <div class="pulls-review-draft">
                                        <code>{draft.path}:{draft.line}</code>
                                        <span>{draft.body}</span>
                                        <button type="button" class="icon-btn" title="Remove draft" aria-label="Remove draft" onClick={() => removeDraft(index())}><Icon name="x" size={11} /></button>
                                      </div>
                                    )}
                                  </For>
                                  <textarea class="ui-field" rows={2} aria-label="Review summary" placeholder="Leave a review summary (optional for a comment or approval)…" value={reviewBody()} onInput={(event) => setReviewBody(event.currentTarget.value)} />
                                  <div class="pulls-review-actions">
                                    <div class="seg" role="group" aria-label="Review action">
                                      <For each={[{ id: "COMMENT", label: "Comment" }, { id: "APPROVE", label: "Approve" }, { id: "REQUEST_CHANGES", label: "Request changes" }] as const}>
                                        {(option) => <button type="button" class="seg-btn" classList={{ "seg-on": reviewEvent() === option.id }} aria-pressed={reviewEvent() === option.id} onClick={() => setReviewEvent(option.id)}>{option.label}</button>}
                                      </For>
                                    </div>
                                    <button type="button" class="ui-btn ui-btn-outline" disabled={submittingReview() || (reviewEvent() !== "APPROVE" && !reviewBody().trim() && drafts().length === 0)} onClick={() => void submitReview()}>
                                      <Show when={submittingReview()} fallback={<><Icon name="arrowUp" size={13} /> Submit review</>}><Spinner size={12} /> Submitting…</Show>
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </Show>
                        }>
                          {(error) => (
                            <div class="pane-empty pulls-error" style={{ padding: "20px 0" }}>
                              <Icon name="alert" size={24} />
                              <p>Couldn't load changed files.</p>
                              <p class="pane-empty-sub">{error()}</p>
                              <button type="button" class="ui-btn ui-btn-outline" onClick={() => void refetchFiles()}>Try again</button>
                            </div>
                          )}
                        </Show>
                      </Show>

                      <Show when={tab() === "activity"}>
                        <div class="pulls-comment">
                          <textarea class="ui-field" rows={3} aria-label="Comment on this pull request" placeholder="Leave a comment on GitHub…" value={comment()} onInput={(event) => setComment(event.currentTarget.value)} />
                          <div class="pulls-comment-actions">
                            <span class="pulls-muted">Posts with your GitHub CLI account.</span>
                            <button type="button" class="ui-btn ui-btn-outline" disabled={!comment().trim() || posting()} onClick={() => void postComment()}>
                              <Show when={posting()} fallback={<><Icon name="message" size={13} /> Comment</>}><Spinner size={12} /> Posting…</Show>
                            </button>
                          </div>
                        </div>
                        <Show when={pr().timeline.length > 0} fallback={<p class="pulls-muted">No comments or reviews yet.</p>}>
                          <For each={pr().timeline}>
                            {(item: PrTimelineItem) => (
                              <article class="pulls-activity">
                                <div class="pulls-activity-head">
                                  <Icon name={item.kind === "review" ? "check" : "message"} size={13} />
                                  <strong>{item.author || "someone"}</strong>
                                  <span class="pulls-activity-verb">{item.kind === "review" ? `reviewed${item.state ? ` · ${item.state.toLowerCase().replace(/_/g, " ")}` : ""}` : "commented"}</span>
                                  <span class="pulls-ago">{relative(item.created_at)}</span>
                                </div>
                                <Show when={item.body.trim()} fallback={<p class="pulls-muted">{item.kind === "review" ? "No review comment." : "No comment text."}</p>}>
                                  <div class="pulls-markdown"><Markdown text={item.body} /></div>
                                </Show>
                              </article>
                            )}
                          </For>
                        </Show>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            }>
              {(error) => (
                <div class="pane-empty pulls-error">
                  <Icon name="alert" size={26} />
                  <p>Couldn't load this pull request.</p>
                  <p class="pane-empty-sub">{error()}</p>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button type="button" class="ui-btn ui-btn-outline" onClick={reload}>Try again</button>
                    <button type="button" class="ui-btn ui-btn-ghost" onClick={() => setSelected(null)}>Back</button>
                  </div>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

export default PullsView;
