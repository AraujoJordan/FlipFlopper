import { Component, For, Index, Show, Switch, Match, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Icon } from "../shell/Icon";
import { Spinner, toast } from "../ui";
import { getFileIcon } from "../../lib/fileIcons";
import { listWorkspaceArchive, listWorkspaceDir, openAttachment, prepareAttachmentPreview, readWorkspaceFile, readWorkspaceOffice, saveWorkspaceFileCopy, searchPromptFiles, type ArchiveEntry, type FileEntry } from "../../lib/ipc";
import { effectiveRoot, setPendingPromptSeed } from "../../lib/store";
import { closeViewer, openFileInViewer, viewerTarget } from "../../lib/fileViewer";
import { langForPath } from "../../lib/diffModel";
import { highlightLines, buildPreviewDocument } from "../../lib/markdownLite";
import { openConversationFile } from "../../lib/attachments";
import { openInPreferred } from "../../lib/openIn";
import { addComposerContext } from "../../lib/composerContexts";
import { writeClipboardText } from "../../lib/native";
import Markdown from "../chat/Markdown";
import FindBar from "../chat/FindBar";
import { runAction } from "../../lib/shortcuts";

const formatSize = (size: number) => (size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`);

const INLINE_MEDIA = /\.(png|jpe?g|gif|webp|avif|bmp|ico|mp4|webm|mov|m4v|ogv|mkv|avi|mp3|wav|ogg|flac|m4a|aac|opus|pdf)$/i;
const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
const MARKDOWN_FILE = /\.(md|mdx|markdown)$/i;
const TABLE_FILE = /\.(csv|tsv)$/i;
const OFFICE_FILE = /\.(docx|xlsx|pptx)$/i;
const ARCHIVE_FILE = /\.(zip|jar|war)$/i;
const HTML_FILE = /\.(html?|xhtml)$/i;
const NOTEBOOK_FILE = /\.ipynb$/i;

type NotebookCell = {
  cell_type?: string;
  source?: string | string[];
  outputs?: { text?: string | string[]; data?: Record<string, string | string[]> }[];
};

const notebookText = (value: unknown): string => Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "";

/** Jupyter notebooks are JSON; malformed or very unusual files fall back to the source view. */
function parseNotebook(text: string): NotebookCell[] | null {
  try {
    const parsed = JSON.parse(text) as { cells?: unknown };
    if (!Array.isArray(parsed.cells)) return null;
    return parsed.cells.slice(0, 300).filter((cell): cell is NotebookCell => !!cell && typeof cell === "object");
  } catch { return null; }
}

const notebookOutput = (output: NonNullable<NotebookCell["outputs"]>[number]): string =>
  notebookText(output.text) || notebookText(output.data?.["text/plain"]);

const previewScheme = (): "light" | "dark" => {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark" || forced === "light") return forced;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const fontFormat = (path: string | undefined): string => {
  const lower = path?.toLowerCase() ?? "";
  if (lower.endsWith(".woff2")) return "woff2";
  if (lower.endsWith(".woff")) return "woff";
  if (lower.endsWith(".otf")) return "opentype";
  return "truetype";
};

/** Spreadsheet column labels past Z (AA, AB, …) for the extracted worksheet header. */
function columnLabel(index: number): string {
  let label = "";
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

/** Small quoted-field parser for CSV/TSV previews; capped so a huge export cannot stall the pane. */
function parseDelimited(text: string, delimiter: string, maxRows = 2000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= maxRows) break;
    } else if (char !== "\r") field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** One folder level of the tree. Folders load their children when first opened. */
const TreeLevel: Component<{ root: string; dir: string; depth: number; entries: FileEntry[]; expanded: ReadonlySet<string>; children: Record<string, FileEntry[] | "loading" | "error">; onToggle: (entry: FileEntry) => void }> = (props) => (
  <For each={props.entries}>
    {(entry) => (
      <>
        <button type="button" class="files-row" style={{ "padding-left": `${10 + props.depth * 14}px` }} title={entry.path}
          aria-expanded={entry.is_dir ? props.expanded.has(entry.path) : undefined}
          onClick={() => (entry.is_dir ? props.onToggle(entry) : void openFileInViewer(entry.path))}>
          <Show when={entry.is_dir} fallback={<span style={{ width: "12px", flex: "none" }} />}>
            <Icon name="chevronRight" size={11} style={{ transform: props.expanded.has(entry.path) ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast)" }} />
          </Show>
          <Icon name={entry.is_dir ? "folder" : getFileIcon(entry.name)} size={14} />
          <span class="files-name">{entry.name}</span>
        </button>
        <Show when={entry.is_dir && props.expanded.has(entry.path)}>
          <Show when={Array.isArray(props.children[entry.path])} fallback={
            <div class="files-note" style={{ "padding-left": `${24 + props.depth * 14}px` }}>{props.children[entry.path] === "error" ? "Couldn't open this folder." : "Loading…"}</div>
          }>
            <TreeLevel root={props.root} dir={entry.path} depth={props.depth + 1} entries={props.children[entry.path] as FileEntry[]} expanded={props.expanded} children={props.children} onToggle={props.onToggle} />
          </Show>
        </Show>
      </>
    )}
  </For>
);

/** Read-only browser for the open checkout: a folder tree, a name filter, and a syntax-highlighted viewer
 *  that scrolls to and flashes a target line. Nothing here edits files. */
const FilesView: Component = () => {
  const root = () => effectiveRoot();
  const [rootEntries, setRootEntries] = createSignal<FileEntry[] | "loading" | "error">("loading");
  const [children, setChildren] = createSignal<Record<string, FileEntry[] | "loading" | "error">>({});
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = createSignal("");

  createEffect(on(root, (r) => {
    setChildren({}); setExpanded(new Set<string>()); setRootEntries("loading");
    if (!r) { setRootEntries([]); return; }
    listWorkspaceDir(r, "").then(setRootEntries).catch(() => setRootEntries("error"));
  }));

  const toggle = (entry: FileEntry) => {
    const r = root();
    if (!r) return;
    const open = new Set(expanded());
    if (open.delete(entry.path)) { setExpanded(open); return; }
    open.add(entry.path);
    setExpanded(open);
    if (!Array.isArray(children()[entry.path])) {
      setChildren((c) => ({ ...c, [entry.path]: "loading" }));
      listWorkspaceDir(r, entry.path).then((list) => setChildren((c) => ({ ...c, [entry.path]: list }))).catch(() => setChildren((c) => ({ ...c, [entry.path]: "error" })));
    }
  };

  const [matches] = createResource(() => (filter().trim() && root() ? { root: root()!, query: filter().trim() } : null), (k) => searchPromptFiles(k.root, k.query, 40).catch(() => [] as FileEntry[]));

  // ── Viewer ──
  const target = viewerTarget;
  const [file] = createResource(() => { const t = target(); const r = root(); return t && r ? { t, r } : null; }, async ({ t, r }) => {
    try { return await readWorkspaceFile(r, t.path); } catch (error) { return { error: String(error) }; }
  });
  const ready = () => { const f = file(); return f && !("error" in f) ? f : null; };
  const isOffice = () => OFFICE_FILE.test(target()?.path ?? "");
  const isArchive = () => ARCHIVE_FILE.test(target()?.path ?? "");
  const [office] = createResource(
    () => { const t = target(); const r = root(); return t && r && OFFICE_FILE.test(t.path) ? { t, r } : null; },
    async ({ t, r }) => {
      try { return await readWorkspaceOffice(r, t.path); } catch (error) { return { error: String(error) }; }
    },
  );
  const officeReady = () => { const preview = office(); return preview && !("error" in preview) ? preview : null; };
  const [archive] = createResource(
    () => { const t = target(); const r = root(); return t && r && ARCHIVE_FILE.test(t.path) ? { t, r } : null; },
    async ({ t, r }) => {
      try { return await listWorkspaceArchive(r, t.path); } catch (error) { return { error: String(error) }; }
    },
  );
  const archiveEntries = (): ArchiveEntry[] | null => Array.isArray(archive()) ? archive() as ArchiveEntry[] : null;
  const [activeSheet, setActiveSheet] = createSignal(0);
  const activeOfficeSheet = () => officeReady()?.sheets[activeSheet()] ?? officeReady()?.sheets[0] ?? null;
  const officeSlides = createMemo(() => {
    const preview = officeReady();
    if (!preview || preview.kind !== "pptx") return [] as { title: string; text: string }[];
    return preview.text.split(/\n(?=# Slide \d+\n?)/).filter(Boolean).map((block) => {
      const heading = block.match(/^# Slide (\d+)\n?/);
      return heading ? { title: `Slide ${heading[1]}`, text: block.slice(heading[0].length) } : { title: "Slide", text: block };
    });
  });
  const officePlainText = () => {
    const preview = officeReady();
    if (!preview) return "";
    if (preview.kind !== "xlsx") return preview.text;
    return preview.sheets.map((sheet) => `# ${sheet.name}\n${sheet.rows.map((row) => row.join("\t")).join("\n")}`).join("\n\n");
  };
  const selectLine = (line: number, event: MouseEvent) => {
    const current = lineSelection();
    if (event.shiftKey && current) setLineSelection({ start: Math.min(current.start, line), end: Math.max(current.end, line) });
    else setLineSelection({ start: line, end: line });
  };
  const addLineComment = () => {
    const selection = lineSelection();
    const text = ready()?.text;
    const path = target()?.path;
    if (!selection || text == null || !path) return;
    const selected = text.split("\n").slice(selection.start - 1, selection.end).join("\n");
    addComposerContext({
      kind: "review",
      label: `${path}:${selection.start}${selection.end > selection.start ? `-${selection.end}` : ""}`,
      detail: `File: ${path}\nLines: ${selection.start}${selection.end > selection.start ? `-${selection.end}` : ""}\n\nSelected code:\n\`\`\`\n${selected}\n\`\`\``,
    });
    runAction("focus-prompt");
    toast("Line comment added to the composer", "info");
    setLineSelection(null);
  };
  const language = createMemo(() => langForPath(target()?.path));
  const lines = createMemo(() => { const f = ready(); return f?.text != null ? highlightLines(f.text, language()) : []; });
  const absolute = () => ready()?.path ?? (root() && target() ? `${root()}/${target()!.path}` : "");
  const segments = createMemo(() => target()?.path.split("/").filter(Boolean) ?? []);
  const browseTo = (index: number) => {
    const parts = segments().slice(0, index + 1);
    setExpanded((current) => {
      const next = new Set(current);
      for (let depth = 0; depth < parts.length; depth++) next.add(parts.slice(0, depth + 1).join("/"));
      return next;
    });
    closeViewer();
  };
  const [markdownPreview, setMarkdownPreview] = createSignal(true);
  const [htmlPreview, setHtmlPreview] = createSignal(true);
  const [notebookPreview, setNotebookPreview] = createSignal(true);
  const [wrapLines, setWrapLines] = createSignal(false);
  const [lineSelection, setLineSelection] = createSignal<{ start: number; end: number } | null>(null);
  const isMarkdown = () => MARKDOWN_FILE.test(target()?.path ?? "");
  const isTable = () => TABLE_FILE.test(target()?.path ?? "");
  const isMermaid = () => /\.(mmd|mermaid)$/i.test(target()?.path ?? "");
  const isHtml = () => HTML_FILE.test(target()?.path ?? "");
  const isNotebook = () => NOTEBOOK_FILE.test(target()?.path ?? "");
  const markdownText = () => isMermaid() ? `\`\`\`mermaid\n${ready()?.text ?? ""}\n\`\`\`` : ready()?.text ?? "";
  const notebook = createMemo(() => isNotebook() ? parseNotebook(ready()?.text ?? "") : null);
  const previewOn = () => isHtml() ? htmlPreview() : isNotebook() ? notebookPreview() : markdownPreview();
  const togglePreview = () => {
    if (isHtml()) setHtmlPreview((value) => !value);
    else if (isNotebook()) setNotebookPreview((value) => !value);
    else setMarkdownPreview((value) => !value);
  };
  createEffect(on(target, () => {
    setMarkdownPreview(true); setHtmlPreview(true); setNotebookPreview(true); setWrapLines(false); setActiveSheet(0); setLineSelection(null);
  }));
  const table = createMemo(() => {
    if (!isTable()) return [];
    const delimiter = target()?.path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    return parseDelimited(ready()?.text ?? "", delimiter).map((row) => row.slice(0, 40));
  });
  const [prepared] = createResource(
    () => { const f = ready(); return f && (INLINE_MEDIA.test(f.path) || FONT_FILE.test(f.path)) ? f.path : null; },
    async (path) => prepareAttachmentPreview(path).catch(() => null),
  );
  const mediaUrl = () => { const source = prepared(); return source ? `${convertFileSrc(source.path)}?v=${source.size}` : null; };
  let scroller: HTMLDivElement | undefined;
  createEffect(() => {
    const t = target();
    if (!t || !ready() || !scroller) return;
    void lines();
    queueMicrotask(() => {
      const row = t.line ? scroller?.querySelector<HTMLElement>(`[data-line="${t.line}"]`) : null;
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.animate?.([{ background: "rgba(var(--accent-rgb), .35)" }, { background: "transparent" }], { duration: 1800 });
      } else if (scroller) scroller.scrollTop = 0;
    });
  });

  return (
    <div class="files-view">
      <Show when={target()} fallback={
        <>
          <div class="files-bar">
            <input class="ui-field" type="search" aria-label="Filter files" placeholder="Filter files by name" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
          </div>
          <div class="files-tree" role="tree" aria-label="Project files">
            <Show when={root()} fallback={<div class="files-note">Open a project to browse its files.</div>}>
              <Show when={filter().trim()} fallback={
                <Show when={Array.isArray(rootEntries())} fallback={<div class="files-note">{rootEntries() === "error" ? "Couldn't read this folder." : "Loading…"}</div>}>
                  <TreeLevel root={root()!} dir="" depth={0} entries={rootEntries() as FileEntry[]} expanded={expanded()} children={children()} onToggle={toggle} />
                </Show>
              }>
                <Show when={!matches.loading} fallback={<div class="files-note">Searching…</div>}>
                  <For each={matches() ?? []} fallback={<div class="files-note">No files match “{filter().trim()}”.</div>}>
                    {(entry) => (
                      <button type="button" class="files-row" title={entry.path} onClick={() => (entry.is_dir ? (setFilter(""), toggle(entry)) : void openFileInViewer(entry.path))}>
                        <Icon name={entry.is_dir ? "folder" : getFileIcon(entry.name)} size={14} />
                        <span class="files-name">{entry.name}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </div>
        </>
      }>
        <div class="files-bar files-bar-viewer">
          <button type="button" class="icon-btn" onClick={closeViewer} title="Back to files" aria-label="Back to files"><Icon name="arrowLeft" size={15} /></button>
          <nav class="files-crumbs" aria-label="File location" title={target()!.path}>
            <button type="button" class="files-crumb" onClick={() => closeViewer()}>Files</button>
            <For each={segments()}>
              {(segment, index) => (
                <>
                  <span class="files-crumb-sep">/</span>
                  <button type="button" class="files-crumb" disabled={index() === segments().length - 1} onClick={() => browseTo(index())}>{segment}</button>
                </>
              )}
            </For>
          </nav>
          <Show when={ready()}>{(f) => <span class="files-meta">{formatSize(f().size)}</span>}</Show>
          <Show when={isMarkdown() || isMermaid() || isHtml() || isNotebook()}>
            <button type="button" class="ui-btn ui-btn-ghost" onClick={togglePreview} title={previewOn() ? "Show source" : "Preview"}>
              {previewOn() ? "Source" : "Preview"}
            </button>
          </Show>
          <Show when={ready()?.text != null && !isTable()}>
            <button type="button" class="icon-btn" title={wrapLines() ? "Don't wrap lines" : "Wrap lines"} aria-label={wrapLines() ? "Don't wrap lines" : "Wrap lines"}
              aria-pressed={wrapLines()} onClick={() => setWrapLines((value) => !value)}><Icon name="wrap" size={14} /></button>
          </Show>
          <Show when={ready()?.text != null}>
            <button type="button" class="icon-btn" title="Find in file" aria-label="Find in file" onClick={() => runAction("find-in-file")}><Icon name="search" size={14} /></button>
            <button type="button" class="icon-btn" title="Copy contents" aria-label="Copy contents"
              onClick={() => void writeClipboardText(ready()!.text ?? "").then(() => toast("Copied file contents", "success"))}><Icon name="copy" size={14} /></button>
          </Show>
          <Show when={officePlainText()}>
            <button type="button" class="icon-btn" title="Copy extracted text" aria-label="Copy extracted text"
              onClick={() => void writeClipboardText(officePlainText()).then(() => toast("Copied extracted text", "success"))}><Icon name="copy" size={14} /></button>
          </Show>
          <button type="button" class="icon-btn" title="Mention in composer" aria-label="Mention in composer"
            onClick={() => { setPendingPromptSeed({ text: `@${target()!.path} ` }); toast("Added the file to the composer", "info"); }}><Icon name="message" size={14} /></button>
          <button type="button" class="icon-btn" title="Save a copy…" aria-label="Save a copy"
            onClick={() => void (async () => {
              try {
                const saved = await saveWorkspaceFileCopy(root()!, target()!.path);
                if (saved) toast("Saved a copy", "success");
              } catch (error) { toast(`Couldn't save a copy: ${String(error)}`, "error"); }
            })()}><Icon name="download" size={14} /></button>
          <button type="button" class="icon-btn" title="Copy path" aria-label="Copy path" onClick={() => void writeClipboardText(target()!.path).then(() => toast("Copied path", "success"))}><Icon name="copy" size={14} /></button>
          <button type="button" class="icon-btn" title="Open in editor" aria-label="Open in editor"
            onClick={() => void (async () => { if (!(await openInPreferred(absolute(), target()!.line))) await openConversationFile(absolute(), target()!.line).catch((error) => toast(String(error), "error")); })()}><Icon name="external" size={14} /></button>
        </div>
        <div class="files-code" ref={scroller}>
          <FindBar scroller={() => scroller} hasEarlier={() => false} showAll={() => {}} shortcut="find-in-file" label="file" placeholder="Find in file" enabled={() => !!target() && ready()?.text != null} resetOnSessionChange={false} highlightKey="find-file" />
          <Show when={!file.loading} fallback={<div class="files-note"><Spinner size={14} /> Opening…</div>}>
            <Show when={isOffice()}>
              <Show when={!office.loading} fallback={<div class="files-note"><Spinner size={14} /> Reading Office preview…</div>}>
                <Show when={officeReady()} fallback={
                  <div class="files-note" role="alert">
                    {(office() as { error: string } | undefined)?.error ?? "This Office document could not be previewed."}
                    <button type="button" class="ui-btn ui-btn-outline" onClick={() => void openAttachment(absolute()).catch((error) => toast(String(error), "error"))}>Open in default app</button>
                  </div>
                }>
                  {(preview) => (
                    <Switch>
                      <Match when={preview().kind === "xlsx"}>
                        <div class="files-office files-office-sheet">
                          <Show when={preview().sheets.length > 1}>
                            <div class="files-sheet-tabs" role="tablist" aria-label="Worksheets">
                              <For each={preview().sheets}>
                                {(sheet, index) => (
                                  <button type="button" role="tab" aria-selected={activeSheet() === index()} class="files-sheet-tab"
                                    classList={{ active: activeSheet() === index() }} onClick={() => setActiveSheet(index())}>{sheet.name}</button>
                                )}
                              </For>
                            </div>
                          </Show>
                          <Show when={activeOfficeSheet()} fallback={<div class="files-note">This workbook has no readable sheets.</div>}>
                            {(sheet) => (
                              <div class="files-table-wrap">
                                <div class="files-sheet-meta">{sheet().name} · {sheet().rows.length} row{sheet().rows.length === 1 ? "" : "s"} · up to 40 columns</div>
                                <Show when={sheet().rows.length > 0} fallback={<div class="files-note">This worksheet is empty.</div>}>
                                  <table class="files-table files-office-table">
                                    <thead><tr><For each={sheet().rows[0] ?? []}>{(cell, index) => <th>{cell || columnLabel(index())}</th>}</For></tr></thead>
                                    <tbody><For each={sheet().rows.slice(1)}>{(row) => <tr><For each={row}>{(cell) => <td>{cell}</td>}</For></tr>}</For></tbody>
                                  </table>
                                </Show>
                              </div>
                            )}
                          </Show>
                        </div>
                      </Match>
                      <Match when={preview().kind === "pptx"}>
                        <div class="files-office files-office-slides">
                          <div class="files-office-note">Text-only preview · {officeSlides().length} slide{officeSlides().length === 1 ? "" : "s"}</div>
                          <For each={officeSlides()} fallback={<div class="files-note">This presentation has no readable slide text.</div>}>
                            {(slide) => (
                              <article class="files-slide">
                                <h3>{slide.title}</h3>
                                <Show when={slide.text.trim()} fallback={<p class="files-slide-empty">No text on this slide.</p>}>
                                  <div class="files-office-text">{slide.text}</div>
                                </Show>
                              </article>
                            )}
                          </For>
                        </div>
                      </Match>
                      <Match when={true}>
                        <div class="files-office files-office-doc">
                          <div class="files-office-note">Text-only preview · formatting and layout stay in the original file</div>
                          <Show when={preview().text} fallback={<div class="files-note">This document has no readable text.</div>}>
                            <div class="files-office-text">{preview().text}</div>
                          </Show>
                        </div>
                      </Match>
                    </Switch>
                  )}
                </Show>
              </Show>
            </Show>
            <Show when={isArchive()}>
              <Show when={!archive.loading} fallback={<div class="files-note"><Spinner size={14} /> Reading archive…</div>}>
                <Show when={archiveEntries()} fallback={
                  <div class="files-note" role="alert">
                    {(archive() as { error: string } | undefined)?.error ?? "This archive could not be read."}
                    <button type="button" class="ui-btn ui-btn-outline" onClick={() => void openAttachment(absolute()).catch((error) => toast(String(error), "error"))}>Open in default app</button>
                  </div>
                }>
                  {(entries) => (
                    <div class="files-archive">
                      <div class="files-office-note">{entries().length} entr{entries().length === 1 ? "y" : "ies"} · read-only listing, files are not extracted</div>
                      <Show when={entries().length > 0} fallback={<div class="files-note">This archive is empty.</div>}>
                        <div class="files-table-wrap">
                          <table class="files-table files-archive-table">
                            <thead><tr><th>Name</th><th>Size</th><th>Compressed</th></tr></thead>
                            <tbody>
                              <For each={entries()}>
                                {(entry) => (
                                  <tr>
                                    <td class="files-archive-name"><Icon name={entry.is_dir ? "folder" : "file"} size={13} /> <span>{entry.name}</span></td>
                                    <td>{entry.is_dir ? "—" : formatSize(entry.size)}</td>
                                    <td>{entry.is_dir ? "—" : formatSize(entry.compressed)}</td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </Show>
            </Show>
            <Show when={!isOffice() && file() && "error" in file()!}>
              <div class="files-note" role="alert">{(file() as { error: string }).error}</div>
            </Show>
            <Show when={prepared.loading}><div class="files-note"><Spinner size={13} /> Preparing preview…</div></Show>
            <Show when={prepared()}>
              {(source) => (
                <Switch>
                  <Match when={source().kind === "image"}>
                    <div class="files-media-wrap"><img class="files-media" src={mediaUrl()!} alt={target()!.path} /></div>
                  </Match>
                  <Match when={source().kind === "video"}>
                    <div class="files-media-wrap"><video class="files-media" src={mediaUrl()!} controls /></div>
                  </Match>
                  <Match when={source().kind === "audio"}>
                    <div class="files-media-wrap files-audio"><audio src={mediaUrl()!} controls /></div>
                  </Match>
                  <Match when={source().kind === "pdf"}>
                    <iframe class="files-pdf" src={mediaUrl()!} title={target()!.path} />
                  </Match>
                  <Match when={source().kind === "font"}>
                    <div class="files-font">
                      <style>{`@font-face{font-family:"flipflopper-font-preview";src:url("${mediaUrl()}") format("${fontFormat(target()?.path)}");font-display:swap}`}</style>
                      <div class="files-office-note">Font preview · {formatSize(source().size)}</div>
                      <div class="files-font-sample" style={{ "font-family": "flipflopper-font-preview" }}>
                        <div class="files-font-pangram">The quick brown fox jumps over the lazy dog.</div>
                        <div class="files-font-alphabet">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />0123456789 !?&amp;@#%</div>
                        <div class="files-font-sizes">
                          <div style={{ "font-size": "12px" }}>12 px · The quick brown fox</div>
                          <div style={{ "font-size": "18px" }}>18 px · The quick brown fox</div>
                          <div style={{ "font-size": "28px" }}>28 px · The quick brown fox</div>
                          <div style={{ "font-size": "44px" }}>44 px · The quick brown fox</div>
                        </div>
                      </div>
                    </div>
                  </Match>
                </Switch>
              )}
            </Show>
            <Show when={!prepared() && !prepared.loading && ready()?.text != null && isHtml() && htmlPreview()}>
              <div class="files-html-wrap">
                <iframe class="files-html" sandbox="allow-scripts" referrerpolicy="no-referrer"
                  title={target()!.path} srcdoc={buildPreviewDocument(ready()?.text ?? "", previewScheme())} />
              </div>
            </Show>
            <Show when={!prepared() && !prepared.loading && ready()?.text != null && isNotebook() && notebookPreview()}>
              <Show when={notebook()} fallback={
                <div class="files-note" role="alert">
                  This notebook could not be parsed. <button type="button" class="ui-btn ui-btn-ghost" onClick={() => setNotebookPreview(false)}>Show source</button>
                </div>
              }>
                {(cells) => (
                  <div class="files-notebook">
                    <div class="files-office-note">Notebook preview · {cells().length} cell{cells().length === 1 ? "" : "s"}</div>
                    <For each={cells()}>
                      {(cell) => (
                        <Show when={cell.cell_type === "markdown" || cell.cell_type === "code"} fallback={null}>
                          <article class="files-notebook-cell">
                            <div class="files-notebook-kind">{cell.cell_type}</div>
                            <Show when={cell.cell_type === "markdown"} fallback={
                              <>
                                <pre class="files-notebook-code">{notebookText(cell.source)}</pre>
                                <For each={(cell.outputs ?? []).map(notebookOutput).filter(Boolean)}>
                                  {(output) => <pre class="files-notebook-output">{output}</pre>}
                                </For>
                              </>
                            }>
                              <div class="files-notebook-markdown"><Markdown text={notebookText(cell.source)} /></div>
                            </Show>
                          </article>
                        </Show>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </Show>
            <Show when={!prepared() && !prepared.loading && ready()?.text != null && !(isHtml() && htmlPreview()) && !(isNotebook() && notebookPreview())}>
              <Show when={(isMarkdown() || isMermaid()) && markdownPreview()} fallback={
                <Show when={isTable()} fallback={
                  <>
                    <Show when={ready()?.truncated}><div class="files-note">Showing the first {formatSize(512 * 1024)} of this file.</div></Show>
                    <pre class="files-pre hljs" classList={{ "files-wrap": wrapLines() }}>
                      <Index each={lines()}>
                        {(html, i) => (
                          <div class="file-line" data-line={i + 1} classList={{ "file-line-selected": !!lineSelection() && i + 1 >= lineSelection()!.start && i + 1 <= lineSelection()!.end }}>
                            <span class="file-ln" title="Comment on this line (Shift-click for a range)" onClick={(event) => { event.stopPropagation(); selectLine(i + 1, event); }}>{i + 1}</span>
                            <span class="file-code" innerHTML={html() || " "} />
                          </div>
                        )}
                      </Index>
                    </pre>
                    <Show when={lineSelection()}>
                      {(selection) => (
                        <div class="files-line-comment-bar">
                          <span>Lines {selection().start}{selection().end > selection().start ? `–${selection().end}` : ""}</span>
                          <button type="button" class="ui-btn ui-btn-solid" onClick={addLineComment}><Icon name="message" size={12} /> Add comment</button>
                          <button type="button" class="ui-btn ui-btn-ghost" onClick={() => setLineSelection(null)}>Clear</button>
                        </div>
                      )}
                    </Show>
                  </>
                }>
                  <div class="files-table-wrap">
                    <Show when={table().length > 0} fallback={<div class="files-note">This table is empty.</div>}>
                      <table class="files-table">
                        <thead><tr><For each={table()[0]}>{(cell) => <th>{cell}</th>}</For></tr></thead>
                        <tbody><For each={table().slice(1)}>{(row) => <tr><For each={row}>{(cell) => <td>{cell}</td>}</For></tr>}</For></tbody>
                      </table>
                    </Show>
                  </div>
                </Show>
              }>
                <div class="files-markdown"><Markdown text={markdownText()} /></div>
              </Show>
            </Show>
            <Show when={!isOffice() && !isArchive() && !prepared() && !prepared.loading && ready()?.binary && ready()?.text == null}>
              <div class="files-note">
                This is a binary file ({formatSize(ready()!.size)}), so it can't be previewed here.
                <button type="button" class="ui-btn ui-btn-outline" onClick={() => void openAttachment(absolute()).catch((error) => toast(String(error), "error"))}>Open in default app</button>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default FilesView;
