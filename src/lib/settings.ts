/** User-adjustable preferences that don't belong in the reactive Solid store.
 *  Kept separate from the per-project cached selections in store.ts, which are
 *  not settings a user would browse or reset. */
import { createSignal } from "solid-js";
import { readLegacyBool, readPref, writePref } from "./appPrefs";
import { setMathRendering } from "./markdownLite";
import { getNetworkProxy, setNetworkProxy, type NetworkProxy } from "./ipc";

const NOTIFY_KEY = "flipflopper:notify-on-finish";
export type NotificationMode = "off" | "notification" | "sound" | "both";
const NOTIFY_MODE_KEY = "flipflopper:notification-mode";
const legacyNotify = readLegacyBool(NOTIFY_KEY, true);
const [notificationModeSignal, setNotificationModeSignal] = createSignal<NotificationMode>(legacyNotify ? "notification" : "off");

/** How a finished or failed session gets your attention while you're elsewhere. */
export const notificationMode = notificationModeSignal;

export function setNotificationMode(mode: NotificationMode) {
  const safe: NotificationMode = mode === "sound" || mode === "both" || mode === "off" ? mode : "notification";
  setNotificationModeSignal(safe);
  writePref(NOTIFY_MODE_KEY, safe);
  writePref(NOTIFY_KEY, safe !== "off");
}

/** Backwards-compatible boolean view for callers that only care whether anything is on. */
export const notifyOnFinish = () => notificationModeSignal() !== "off";

const NOTIFY_UNFOCUSED_KEY = "flipflopper:notify-only-unfocused";
const [notifyOnlyUnfocusedSignal, setNotifyOnlyUnfocusedSignal] = createSignal(false);
/** Notify about finishes only while the app is in the background. */
export const notifyOnlyUnfocused = notifyOnlyUnfocusedSignal;
export function setNotifyOnlyUnfocused(enabled: boolean) {
  setNotifyOnlyUnfocusedSignal(enabled);
  writePref(NOTIFY_UNFOCUSED_KEY, enabled);
}

// ── Fallback model ──
const FALLBACK_MODEL_KEY = "flipflopper:fallback-model";
const [fallbackModelSignal, setFallbackModelSignal] = createSignal("");
/** Optional model offered after a provider usage limit. */
export const fallbackModel = fallbackModelSignal;
export function setFallbackModel(value: string) {
  const clean = value.trim().slice(0, 120);
  setFallbackModelSignal(clean);
  writePref(FALLBACK_MODEL_KEY, clean);
}

// ── Response streaming ──
export type ResponseStreaming = "live" | "finished";
const RESPONSE_STREAMING_KEY = "flipflopper:response-streaming";
const [responseStreamingSignal, setResponseStreamingSignal] = createSignal<ResponseStreaming>("live");
/** Show assistant text while it streams, or wait until the turn finishes. */
export const responseStreaming = responseStreamingSignal;
export function setResponseStreaming(value: ResponseStreaming) {
  const safe: ResponseStreaming = value === "finished" ? "finished" : "live";
  setResponseStreamingSignal(safe);
  writePref(RESPONSE_STREAMING_KEY, safe);
}

// ── Network proxy ──
// The backend adds these variables to every agent, shell and git child. The URL is
// stored as typed (it may contain credentials) and only ever displayed masked.
const PROXY_KEY = "networkProxy";
export const DEFAULT_PROXY: NetworkProxy = { mode: "inherit", url: "", no_proxy: "" };
const [networkProxySignal, setNetworkProxySignal] = createSignal<NetworkProxy>(DEFAULT_PROXY);
const [effectiveProxySignal, setEffectiveProxySignal] = createSignal("");
export const networkProxy = networkProxySignal;
/** The proxy children use right now, credentials masked; empty when traffic goes direct. */
export const effectiveProxy = effectiveProxySignal;

export async function refreshEffectiveProxy() {
  try { setEffectiveProxySignal((await getNetworkProxy()).effective); } catch { /* shown as direct */ }
}

/** Validate in the backend, then persist. Resolves with an error message, or null on success. */
export async function applyNetworkProxy(next: NetworkProxy): Promise<string | null> {
  try {
    const saved = await setNetworkProxy(next);
    setNetworkProxySignal(saved);
    writePref(PROXY_KEY, saved);
    await refreshEffectiveProxy();
    return null;
  } catch (error) {
    return String(error);
  }
}

// ── Auto-archive ("settle") idle sessions ──
const SETTLE_KEY = "flipflopper:settle-days";
const [settleDaysSignal, setSettleDaysSignal] = createSignal(0);
/** Archive sessions untouched for this many days; 0 keeps everything. */
export const settleDays = settleDaysSignal;
export function setSettleDays(days: number) {
  const next = [0, 3, 7, 14, 30].includes(days) ? days : 0;
  setSettleDaysSignal(next);
  writePref(SETTLE_KEY, next);
}

const SETTLE_PR_MERGED_KEY = "flipflopper:settle-pr-merged";
const SETTLE_PR_CLOSED_KEY = "flipflopper:settle-pr-closed";
const SETTLE_KEEP_PR_KEY = "flipflopper:settle-keep-pr";
const [autoSettlePrMergedSignal, setAutoSettlePrMergedSignal] = createSignal(false);
const [autoSettlePrClosedSignal, setAutoSettlePrClosedSignal] = createSignal(false);
const [settleKeepPrSignal, setSettleKeepPrSignal] = createSignal(false);
/** Archive a thread when its checkout's pull request merges. */
export const autoSettlePrMerged = autoSettlePrMergedSignal;
/** Archive a thread when its checkout's pull request closes without merging. */
export const autoSettlePrClosed = autoSettlePrClosedSignal;
/** Keep threads that have a linked pull request out of idle auto-archive. */
export const settleKeepPr = settleKeepPrSignal;
export function setAutoSettlePrMerged(enabled: boolean) {
  setAutoSettlePrMergedSignal(enabled);
  writePref(SETTLE_PR_MERGED_KEY, enabled);
}
export function setAutoSettlePrClosed(enabled: boolean) {
  setAutoSettlePrClosedSignal(enabled);
  writePref(SETTLE_PR_CLOSED_KEY, enabled);
}
export function setSettleKeepPr(enabled: boolean) {
  setSettleKeepPrSignal(enabled);
  writePref(SETTLE_KEEP_PR_KEY, enabled);
}

// ── Worktree branch prefix ──
export const DEFAULT_WORKTREE_PREFIX = "flipflopper/";
const WORKTREE_PREFIX_KEY = "flipflopper:worktree-prefix";
const [worktreePrefixSignal, setWorktreePrefixSignal] = createSignal(DEFAULT_WORKTREE_PREFIX);
/** Prefix for branches created for new worktree sessions; the backend sanitizes it for Git. */
export const worktreePrefix = worktreePrefixSignal;
export function setWorktreePrefix(value: string) {
  const clean = value.trim().slice(0, 60);
  setWorktreePrefixSignal(clean);
  writePref(WORKTREE_PREFIX_KEY, clean);
}

// ── New-thread model defaults ──
const CHAT_DEFAULTS_KEY = "flipflopper:chat-defaults";
const [defaultAgentIdSignal, setDefaultAgentIdSignal] = createSignal<string | null>(null);
const [defaultModelSignal, setDefaultModelSignal] = createSignal<string | null>(null);
export const defaultAgentId = defaultAgentIdSignal;
export const defaultModel = defaultModelSignal;
export function setDefaultAgentId(agentId: string | null) {
  setDefaultAgentIdSignal(agentId || null);
  writePref(CHAT_DEFAULTS_KEY, { agentId: defaultAgentIdSignal(), model: defaultModelSignal() });
}
export function setDefaultModel(model: string | null) {
  setDefaultModelSignal(model?.trim() ? model.trim() : null);
  writePref(CHAT_DEFAULTS_KEY, { agentId: defaultAgentIdSignal(), model: defaultModelSignal() });
}

// ── Automatic worktree cleanup ──
const WORKTREE_CLEANUP_KEY = "flipflopper:worktree-cleanup-days";
const [worktreeCleanupDaysSignal, setWorktreeCleanupDaysSignal] = createSignal(0);
/** Remove archived worktrees idle for this many days after idle-session settling; 0 keeps them. */
export const worktreeCleanupDays = worktreeCleanupDaysSignal;
export function setWorktreeCleanupDays(days: number) {
  const next = [0, 7, 30, 90].includes(days) ? days : 0;
  setWorktreeCleanupDaysSignal(next);
  writePref(WORKTREE_CLEANUP_KEY, next);
}

// ── Clone destination ──
const CLONE_DESTINATION_KEY = "flipflopper:clone-destination";
const [cloneDestinationSignal, setCloneDestinationSignal] = createSignal("");
/** Parent folder the clone dialog starts in; empty means the home folder. */
export const cloneDestination = cloneDestinationSignal;
export function setCloneDestination(path: string) {
  const clean = path.trim().slice(0, 1000);
  setCloneDestinationSignal(clean);
  writePref(CLONE_DESTINATION_KEY, clean);
}

// ── Math rendering ──
const MATH_KEY = "flipflopper:render-math";
const [mathSignal, setMathSignal] = createSignal(true);
/** Typeset `$…$`, `$$…$$`, `\(…\)` and `math` fences in messages. */
export const renderMathEnabled = mathSignal;
export function setRenderMath(enabled: boolean) {
  setMathSignal(enabled);
  setMathRendering(enabled);
  writePref(MATH_KEY, enabled);
}

// ── Composer send behavior ──
export type FollowUpBehavior = "queue" | "steer";
export type SendShortcut = "enter" | "mod+enter";

const FOLLOW_UP_KEY = "flipflopper:follow-up-behavior";
const SEND_SHORTCUT_KEY = "flipflopper:send-shortcut";

const [followUpSignal, setFollowUpSignal] = createSignal<FollowUpBehavior>("queue");
/** What Enter does while the agent is working: queue the message or steer the running turn. */
export const followUpBehavior = followUpSignal;
export function setFollowUpBehavior(value: FollowUpBehavior) {
  setFollowUpSignal(value === "steer" ? "steer" : "queue");
  writePref(FOLLOW_UP_KEY, followUpSignal());
}

const [sendShortcutSignal, setSendShortcutSignal] = createSignal<SendShortcut>("enter");
/** Which key sends a message: plain Enter, or mod+Enter (Enter then inserts a newline). */
export const sendShortcut = sendShortcutSignal;
export function setSendShortcut(value: SendShortcut) {
  setSendShortcutSignal(value === "mod+enter" ? "mod+enter" : "enter");
  writePref(SEND_SHORTCUT_KEY, sendShortcutSignal());
}

// ── Rich text composer ──
const RICH_KEY = "flipflopper:rich-text-composer";const [richTextComposerSignal, setRichTextComposerSignal] = createSignal(true);
/** Style Markdown while writing; the source (markers included) is what gets sent. */
export const richTextComposer = richTextComposerSignal;
export function setRichTextComposer(enabled: boolean) {
  setRichTextComposerSignal(enabled);
  writePref(RICH_KEY, enabled);
}

// ── Thread titles ──
const TITLE_INSTRUCTIONS_KEY = "flipflopper:title-instructions";
const [titleInstructionsSignal, setTitleInstructionsSignal] = createSignal("");
/** Extra instructions for agent-generated conversation titles. */
export const titleInstructions = titleInstructionsSignal;
export function setTitleInstructions(value: string) {
  const clean = value.trim().slice(0, 500);
  setTitleInstructionsSignal(clean);
  writePref(TITLE_INSTRUCTIONS_KEY, clean);
}

// ── Git text ──
const GIT_INSTRUCTIONS_KEY = "flipflopper:git-writing-instructions";
const [gitWritingInstructionsSignal, setGitWritingInstructionsSignal] = createSignal("");
/** Extra instructions for agent-drafted commit messages, PR text and branch names. */
export const gitWritingInstructions = gitWritingInstructionsSignal;
export function setGitWritingInstructions(value: string) {
  const clean = value.trim().slice(0, 500);
  setGitWritingInstructionsSignal(clean);
  writePref(GIT_INSTRUCTIONS_KEY, clean);
}

// ── Preview browser ──
export type PreviewViewport = "desktop" | "tablet" | "phone";
export type LinkTarget = "system" | "preview";
export const PREVIEW_ZOOMS = [75, 100, 125, 150] as const;
const PREVIEW_ZOOM_KEY = "flipflopper:preview-zoom";
const [previewZoomSignal, setPreviewZoomSignal] = createSignal(100);
/** Zoom applied to the preview page (percent). */
export const previewZoom = previewZoomSignal;
export function setPreviewZoom(value: number) {
  const clean = PREVIEW_ZOOMS.includes(value as (typeof PREVIEW_ZOOMS)[number]) ? value : 100;
  setPreviewZoomSignal(clean);
  writePref(PREVIEW_ZOOM_KEY, clean);
}
export type SearchEngine = "google" | "duckduckgo" | "bing" | "custom";
const PREVIEW_VIEWPORT_KEY = "flipflopper:preview-viewport";
const SEARCH_ENGINE_KEY = "flipflopper:search-engine";
const CUSTOM_SEARCH_URL_KEY = "flipflopper:custom-search-url";
const LINK_TARGET_KEY = "flipflopper:link-target";
const SEARCH_TEMPLATES: Record<Exclude<SearchEngine, "custom">, string> = {
  google: "https://www.google.com/search?q={query}",
  duckduckgo: "https://duckduckgo.com/?q={query}",
  bing: "https://www.bing.com/search?q={query}",
};
const [previewViewportSignal, setPreviewViewportSignal] = createSignal<PreviewViewport>("desktop");
const [linkTargetSignal, setLinkTargetSignal] = createSignal<LinkTarget>("system");
/** Where links in messages open: the system browser or the preview pane. */
export const linkTarget = linkTargetSignal;
export function setLinkTarget(value: LinkTarget) {
  setLinkTargetSignal(value === "preview" ? "preview" : "system");
  writePref(LINK_TARGET_KEY, linkTargetSignal());
}
const [searchEngineSignal, setSearchEngineSignal] = createSignal<SearchEngine>("google");
const [customSearchUrlSignal, setCustomSearchUrlSignal] = createSignal("");
/** Default device frame for preview tabs. */
export const previewViewport = previewViewportSignal;
/** Search engine used when the preview address bar receives words, not a URL. */
export const searchEngine = searchEngineSignal;
export const customSearchUrl = customSearchUrlSignal;
export function setPreviewViewport(value: PreviewViewport) {
  setPreviewViewportSignal(value === "tablet" || value === "phone" ? value : "desktop");
  writePref(PREVIEW_VIEWPORT_KEY, previewViewportSignal());
}
export function setSearchEngine(value: SearchEngine) {
  setSearchEngineSignal(value === "duckduckgo" || value === "bing" || value === "custom" ? value : "google");
  writePref(SEARCH_ENGINE_KEY, searchEngineSignal());
}
export function setCustomSearchUrl(value: string) {
  const clean = value.trim().slice(0, 2000);
  setCustomSearchUrlSignal(clean);
  writePref(CUSTOM_SEARCH_URL_KEY, clean);
}
/** Build a search URL from the current engine and query. */
export function searchUrl(query: string): string {
  const engine = searchEngine();
  const template = engine === "custom"
    ? (customSearchUrl().includes("{query}") ? customSearchUrl() : SEARCH_TEMPLATES.google)
    : SEARCH_TEMPLATES[engine];
  return template.replace("{query}", encodeURIComponent(query));
}

// ── Diff appearance ──
export type DiffLayout = "unified" | "split";
export type DiffFileState = "expanded" | "collapsed";
const DIFF_LAYOUT_KEY = "flipflopper:diff-layout";
const DIFF_FILE_STATE_KEY = "flipflopper:diff-file-state";
const DIFF_WHITESPACE_KEY = "flipflopper:diff-ignore-whitespace";
const [diffLayoutSignal, setDiffLayoutSignal] = createSignal<DiffLayout>("unified");
const [diffFileStateSignal, setDiffFileStateSignal] = createSignal<DiffFileState>("expanded");
const [diffIgnoreWhitespaceSignal, setDiffIgnoreWhitespaceSignal] = createSignal(false);
/** Default side-by-side or inline diff layout. */
export const diffLayout = diffLayoutSignal;
/** Whether review files start expanded or folded before you open them. */
export const diffFileState = diffFileStateSignal;
/** Hide whitespace-only changes in review diffs. */
export const diffIgnoreWhitespace = diffIgnoreWhitespaceSignal;
export function setDiffLayout(value: DiffLayout) {
  setDiffLayoutSignal(value === "split" ? "split" : "unified");
  writePref(DIFF_LAYOUT_KEY, diffLayoutSignal());
}
export function setDiffFileState(value: DiffFileState) {
  setDiffFileStateSignal(value === "collapsed" ? "collapsed" : "expanded");
  writePref(DIFF_FILE_STATE_KEY, diffFileStateSignal());
}
export function setDiffIgnoreWhitespace(value: boolean) {
  setDiffIgnoreWhitespaceSignal(value);
  writePref(DIFF_WHITESPACE_KEY, value);
}

// ── Time display ──
export type TimestampFormat = "relative" | "absolute";const TIMESTAMP_FORMAT_KEY = "flipflopper:timestamp-format";
const [timestampFormatSignal, setTimestampFormatSignal] = createSignal<TimestampFormat>("relative");
/** Relative ("5m") or absolute ("Nov 4, 14:32") session timestamps. */
export const timestampFormat = timestampFormatSignal;
export function setTimestampFormat(value: TimestampFormat) {
  setTimestampFormatSignal(value === "absolute" ? "absolute" : "relative");
  writePref(TIMESTAMP_FORMAT_KEY, timestampFormatSignal());
}

// ── Compact idle threads ──
const COMPACT_IDLE_KEY = "flipflopper:compact-idle-threads";
const [compactIdleThreadsSignal, setCompactIdleThreadsSignal] = createSignal(false);
/** Hide secondary metadata on idle thread rows. */
export const compactIdleThreads = compactIdleThreadsSignal;
export function setCompactIdleThreads(value: boolean) {
  setCompactIdleThreadsSignal(value);
  writePref(COMPACT_IDLE_KEY, value);
}

// ── Thread confirmations ──
export type ConfirmationKey = "archive" | "unpin" | "delete";
export interface ConfirmationPrefs { archive: boolean; unpin: boolean; delete: boolean }
const CONFIRMATIONS_KEY = "flipflopper:thread-confirmations";
const [confirmationsSignal, setConfirmationsSignal] = createSignal<ConfirmationPrefs>({ archive: false, unpin: false, delete: true });
/** Ask before unpinning, archiving or deleting a thread. */
export const confirmations = confirmationsSignal;
export function setConfirmation(key: ConfirmationKey, value: boolean) {
  setConfirmationsSignal((current) => ({ ...current, [key]: value }));
  writePref(CONFIRMATIONS_KEY, confirmationsSignal());
}

// ── Secrets ──
const MASK_KEY = "flipflopper:mask-secrets";
const [maskSecretsSignal, setMaskSecretsSignal] = createSignal(true);
/** Draw API keys, tokens and passwords masked in the conversation (display only). */
export const maskSecretsEnabled = maskSecretsSignal;
export function setMaskSecretsEnabled(enabled: boolean) {
  setMaskSecretsSignal(enabled);
  writePref(MASK_KEY, enabled);
}

// ── SnapShots ──
const SNAPSHOTS_KEY = "flipflopper:snapshots-enabled";
const SNAPSHOT_TEXT_KEY = "flipflopper:snapshot-include-text";
const SNAPSHOT_SOUND_KEY = "flipflopper:snapshot-sound";
const SNAPSHOT_FLASH_KEY = "flipflopper:snapshot-flash";
const SNAPSHOT_ANIMATE_KEY = "flipflopper:snapshot-animate";
const [snapshotsEnabledSignal, setSnapshotsEnabledSignal] = createSignal(true);
const [snapshotIncludeTextSignal, setSnapshotIncludeTextSignal] = createSignal(true);
const [snapshotSoundSignal, setSnapshotSoundSignal] = createSignal<"off" | "whoosh" | "click">("whoosh");
const [snapshotFlashSignal, setSnapshotFlashSignal] = createSignal(true);
const [snapshotAnimateSignal, setSnapshotAnimateSignal] = createSignal(true);
/** Allow the composer's SnapShot action to capture a window into an attachment. */
export const snapshotsEnabled = snapshotsEnabledSignal;
/** Include app/window/accessibility text with SnapShots when the OS permits it. */
export const snapshotIncludeText = snapshotIncludeTextSignal;
/** Feedback played after a SnapShot is delivered to the draft. */
export const snapshotSound = snapshotSoundSignal;
export const snapshotFlash = snapshotFlashSignal;
export const snapshotAnimate = snapshotAnimateSignal;
export function setSnapshotsEnabled(enabled: boolean) {
  setSnapshotsEnabledSignal(enabled);
  writePref(SNAPSHOTS_KEY, enabled);
}
export function setSnapshotIncludeText(enabled: boolean) {
  setSnapshotIncludeTextSignal(enabled);
  writePref(SNAPSHOT_TEXT_KEY, enabled);
}
export function setSnapshotSound(value: "off" | "whoosh" | "click") {
  setSnapshotSoundSignal(value);
  writePref(SNAPSHOT_SOUND_KEY, value);
}
export function setSnapshotFlash(enabled: boolean) {
  setSnapshotFlashSignal(enabled);
  writePref(SNAPSHOT_FLASH_KEY, enabled);
}
export function setSnapshotAnimate(enabled: boolean) {
  setSnapshotAnimateSignal(enabled);
  writePref(SNAPSHOT_ANIMATE_KEY, enabled);
}

export async function hydrateSettings() {
  const savedMode = await readPref<NotificationMode>(NOTIFY_MODE_KEY, notificationModeSignal());
  setNotificationModeSignal(savedMode === "sound" || savedMode === "both" || savedMode === "off" ? savedMode : "notification");
  setNotifyOnlyUnfocusedSignal((await readPref(NOTIFY_UNFOCUSED_KEY, false)) === true);
  setResponseStreamingSignal((await readPref<ResponseStreaming>(RESPONSE_STREAMING_KEY, "live")) === "finished" ? "finished" : "live");
  setFallbackModelSignal(String(await readPref(FALLBACK_MODEL_KEY, "") ?? "").trim().slice(0, 120));
  setMaskSecretsSignal(await readPref(MASK_KEY, true));
  setSnapshotsEnabledSignal(await readPref(SNAPSHOTS_KEY, true));
  setSnapshotIncludeTextSignal(await readPref(SNAPSHOT_TEXT_KEY, true));
  const sound = await readPref<string>(SNAPSHOT_SOUND_KEY, "whoosh");
  setSnapshotSoundSignal(sound === "off" || sound === "click" ? sound : "whoosh");
  setSnapshotFlashSignal(await readPref(SNAPSHOT_FLASH_KEY, true));
  setSnapshotAnimateSignal(await readPref(SNAPSHOT_ANIMATE_KEY, true));
  setTimestampFormatSignal((await readPref<TimestampFormat>(TIMESTAMP_FORMAT_KEY, "relative")) === "absolute" ? "absolute" : "relative");
  setCompactIdleThreadsSignal(await readPref(COMPACT_IDLE_KEY, false));
  const confirmations = { archive: false, unpin: false, delete: true, ...(await readPref<Partial<ConfirmationPrefs>>(CONFIRMATIONS_KEY, {})) };
  setConfirmationsSignal(confirmations);
  setRenderMath(await readPref(MATH_KEY, true));
  setRichTextComposerSignal(await readPref(RICH_KEY, true));
  setDiffLayoutSignal((await readPref<DiffLayout>(DIFF_LAYOUT_KEY, "unified")) === "split" ? "split" : "unified");
  setDiffFileStateSignal((await readPref<DiffFileState>(DIFF_FILE_STATE_KEY, "expanded")) === "collapsed" ? "collapsed" : "expanded");
  setDiffIgnoreWhitespaceSignal(await readPref(DIFF_WHITESPACE_KEY, false));
  const viewport = await readPref<PreviewViewport>(PREVIEW_VIEWPORT_KEY, "desktop");
  setPreviewViewportSignal(viewport === "tablet" || viewport === "phone" ? viewport : "desktop");
  setPreviewZoomSignal(await readPref(PREVIEW_ZOOM_KEY, 100));
  setLinkTargetSignal((await readPref<LinkTarget>(LINK_TARGET_KEY, "system")) === "preview" ? "preview" : "system");
  const engine = await readPref<SearchEngine>(SEARCH_ENGINE_KEY, "google");
  setSearchEngineSignal(engine === "duckduckgo" || engine === "bing" || engine === "custom" ? engine : "google");
  setCustomSearchUrlSignal(await readPref(CUSTOM_SEARCH_URL_KEY, ""));
  setTitleInstructionsSignal(await readPref(TITLE_INSTRUCTIONS_KEY, ""));
  setGitWritingInstructionsSignal(await readPref(GIT_INSTRUCTIONS_KEY, ""));
  setSettleDaysSignal(await readPref(SETTLE_KEY, 0));
  setAutoSettlePrMergedSignal(await readPref(SETTLE_PR_MERGED_KEY, false));
  setAutoSettlePrClosedSignal(await readPref(SETTLE_PR_CLOSED_KEY, false));
  setSettleKeepPrSignal(await readPref(SETTLE_KEEP_PR_KEY, false));
  setWorktreePrefixSignal(await readPref(WORKTREE_PREFIX_KEY, DEFAULT_WORKTREE_PREFIX));
  setCloneDestinationSignal(await readPref(CLONE_DESTINATION_KEY, ""));
  const chatDefaults = await readPref<{ agentId?: unknown; model?: unknown }>(CHAT_DEFAULTS_KEY, { agentId: null, model: null })
    .catch(() => ({ agentId: null as unknown, model: null as unknown }));
  setDefaultAgentIdSignal(typeof chatDefaults.agentId === "string" && chatDefaults.agentId ? chatDefaults.agentId : null);
  setDefaultModelSignal(typeof chatDefaults.model === "string" && chatDefaults.model ? chatDefaults.model : null);
  const cleanupDays = await readPref(WORKTREE_CLEANUP_KEY, 0);
  setWorktreeCleanupDaysSignal([7, 30, 90].includes(cleanupDays) ? cleanupDays : 0);
  setFollowUpSignal((await readPref<FollowUpBehavior>(FOLLOW_UP_KEY, "queue")) === "steer" ? "steer" : "queue");
  setSendShortcutSignal((await readPref<SendShortcut>(SEND_SHORTCUT_KEY, "enter")) === "mod+enter" ? "mod+enter" : "enter");
  const saved = { ...DEFAULT_PROXY, ...(await readPref<Partial<NetworkProxy>>(PROXY_KEY, {})) };
  // A stale invalid saved value must not block startup: fall back to inheriting the shell's proxy.
  if (await applyNetworkProxy(saved) !== null) await applyNetworkProxy(DEFAULT_PROXY);
}

// ── Settings search ──

export type SettingsSection = "general" | "chat" | "scripts" | "worktrees" | "source" | "browser" | "diffs" | "appearance" | "agents" | "network" | "shortcuts" | "about";
export interface SettingsEntry { title: string; section: SettingsSection; keywords: string }

/** The searchable settings rows. `title` matches the row's visible title so a result can scroll to it. */
export const SETTINGS_INDEX: SettingsEntry[] = [
  { title: "Default permissions", section: "general", keywords: "mode manual auto edit plan ask permissions approve" },
  { title: "Session permissions", section: "general", keywords: "mode manual auto edit plan ask permissions approve" },
  { title: "YOLO (auto-approve)", section: "general", keywords: "yolo auto approve tools dangerous" },
  { title: "Default editor", section: "general", keywords: "editor vscode cursor zed open file link line ide" },
  { title: "Removed projects", section: "general", keywords: "removed hidden projects restore archive" },
  { title: "Import CLI sessions", section: "general", keywords: "import claude codex history terminal sessions" },
  { title: "Notifications", section: "general", keywords: "notify finish alert system" },
  { title: "Timestamps", section: "general", keywords: "time clock relative absolute date ago format" },
  { title: "Only in the background", section: "general", keywords: "notify focus background window unfocused alert" },
  { title: "Working group", section: "general", keywords: "sidebar group running working waiting fold" },
  { title: "Compact idle threads", section: "general", keywords: "sidebar compact dense idle threads metadata" },
  { title: "Thread confirmations", section: "general", keywords: "confirm archive unpin delete thread safety prompt" },
  { title: "Archive idle sessions", section: "general", keywords: "settle archive idle old days cleanup" },
  { title: "Usage", section: "general", keywords: "tokens cost spend dashboard price" },
  { title: "Secrets", section: "general", keywords: "mask api key token password redact privacy screen share" },
  { title: "SnapShots", section: "general", keywords: "screenshot capture window snapshot attach image accessibility app text controls ocr" },
  { title: "Project scripts", section: "scripts", keywords: "script action command run terminal test build" },
  { title: "Send shortcut", section: "chat", keywords: "enter send submit keyboard newline multiline compose" },
  { title: "Follow-up behavior", section: "chat", keywords: "queue steer interrupt follow up while running working" },
  { title: "Thread title instructions", section: "chat", keywords: "title name generation rename agent instructions length identifier" },
  { title: "New thread defaults", section: "chat", keywords: "default agent model new thread new session" },
  { title: "Git writing style", section: "worktrees", keywords: "commit message pull request title body branch name generate conventional commits style" },
  { title: "Worktree cleanup", section: "worktrees", keywords: "worktree cleanup remove archived idle days dirty discard branches" },
  { title: "Snooze options", section: "chat", keywords: "snooze postpone later remind menu presets hour tomorrow weekday" },
  { title: "Branch prefix", section: "worktrees", keywords: "worktree branch prefix git name naming session isolated" },
  { title: "Default clone folder", section: "worktrees", keywords: "clone destination folder repository add project starts in" },
  { title: "Automatic worktree cleanup", section: "worktrees", keywords: "worktree cleanup delete automatic archive idle disk" },
  { title: "Automatically pull", section: "source", keywords: "pull fetch upstream fast forward auto source control git" },
  { title: "Browser profiles", section: "browser", keywords: "browser cookies profile preview import firefox netscape signed in session" },
  { title: "Default viewport", section: "browser", keywords: "browser preview desktop tablet phone frame size responsive" },
  { title: "Preview zoom", section: "browser", keywords: "browser preview zoom scale size percent" },
  { title: "Open links in", section: "browser", keywords: "browser link target system preview open external markdown" },
  { title: "Default browser", section: "browser", keywords: "browser default http https system settings macos links" },
  { title: "Search engine", section: "browser", keywords: "browser search google duckduckgo bing address bar query" },
  { title: "Diff layout", section: "diffs", keywords: "diff unified split side by side inline review" },
  { title: "Diff files start", section: "diffs", keywords: "diff expanded collapsed folded review file state" },
  { title: "Ignore whitespace", section: "diffs", keywords: "diff whitespace spaces tabs formatting ignore review" },
  { title: "Thread details", section: "appearance", keywords: "details card popover header workspace branch usage context rows hide" },
  { title: "Rich text composer", section: "chat", keywords: "markdown style bold italic code list quote formatting rich text" },
  { title: "Theme", section: "appearance", keywords: "light dark system color scheme" },
  { title: "Motion", section: "appearance", keywords: "animation reduce reduced off transitions" },
  { title: "Zoom", section: "appearance", keywords: "scale interface size bigger smaller" },
  { title: "Render math", section: "appearance", keywords: "latex math formula equation katex mathml" },
  { title: "Accent color", section: "appearance", keywords: "accent tint color highlight vscode theme import" },
  { title: "Custom theme", section: "appearance", keywords: "theme palette colors background surface foreground accent create editor" },
  { title: "Fonts", section: "appearance", keywords: "font family typeface interface code monospace" },
  { title: "Code size", section: "appearance", keywords: "font size code terminal diff scale" },
  { title: "Proxy", section: "network", keywords: "proxy http https socks network vpn inherit" },
  { title: "Proxy URL", section: "network", keywords: "proxy url host port credentials" },
  { title: "Bypass hosts", section: "network", keywords: "no_proxy bypass hosts domains" },
  { title: "Explain tab model", section: "agents", keywords: "explain model provider summary" },
  { title: "Keyboard shortcuts", section: "shortcuts", keywords: "shortcuts keys bindings keyboard hotkeys customize rebind" },
];

/** Entries matching every word of `query` in the title or keywords; title hits first, then original order. */
export function searchSettings(index: readonly SettingsEntry[], query: string): SettingsEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored = index.flatMap((entry, order) => {
    const title = entry.title.toLowerCase();
    const haystack = `${title} ${entry.keywords}`;
    if (!words.every((w) => haystack.includes(w))) return [];
    return [{ entry, order, rank: words.every((w) => title.includes(w)) ? 0 : 1 }];
  });
  return scored.sort((a, b) => a.rank - b.rank || a.order - b.order).map((s) => s.entry);
}
