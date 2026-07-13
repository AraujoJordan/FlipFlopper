import { Component, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createProject, pickProjectFolder, type ProjectInfo } from "../lib/ipc";
import { Button, Spinner, toast } from "./ui";

type CategoryId = "mobile" | "web" | "backend" | "game2d" | "game3d" | "desktop" | "cli" | "custom";
type Detail = { label: string; options: string[] };
type Category = { id: CategoryId; name: string; tagline: string; accent: string; stacks: string[]; details: Detail[] };

const CATEGORIES: Category[] = [
  { id: "mobile", name: "Mobile app", tagline: "Pocket-sized, platform-native experiences", accent: "#ff8a65", stacks: ["Kotlin Multiplatform + Compose", "Android · Kotlin + Compose", "iOS · Swift + SwiftUI", "Flutter", "React Native", "Custom"], details: [{ label: "Targets", options: ["Android", "iOS", "Phone", "Tablet"] }, { label: "UI strategy", options: ["Shared UI", "Platform-specific UI"] }] },
  { id: "web", name: "Web frontend", tagline: "Fast interfaces for browsers and the edge", accent: "#4dd0e1", stacks: ["React", "SolidJS", "Vue", "SvelteKit", "Angular", "Vanilla TypeScript", "Custom"], details: [{ label: "Rendering", options: ["SPA", "SSR", "Static site"] }, { label: "Styling", options: ["CSS modules", "Tailwind", "Design system", "Plain CSS"] }] },
  { id: "backend", name: "Backend / API", tagline: "Services, data, jobs, and integrations", accent: "#81c784", stacks: ["Node.js + TypeScript", "Rust", "Go", "Python", "Java / Kotlin", ".NET", "Custom"], details: [{ label: "Interface", options: ["REST", "GraphQL", "gRPC", "Events / queues"] }, { label: "Data", options: ["PostgreSQL", "SQLite", "MongoDB", "No database"] }] },
  { id: "game2d", name: "2D game", tagline: "Sprites, stories, puzzles, and play", accent: "#ffd54f", stacks: ["Godot", "Unity", "Phaser", "Defold", "Custom engine"], details: [{ label: "Targets", options: ["Desktop", "Mobile", "Web", "Console"] }, { label: "Art direction", options: ["Pixel art", "Vector", "Painted"] }] },
  { id: "game3d", name: "3D game", tagline: "Worlds with depth, motion, and atmosphere", accent: "#ba68c8", stacks: ["Godot", "Unity", "Unreal Engine", "Bevy", "Three.js / Babylon.js", "Custom engine"], details: [{ label: "Targets", options: ["Desktop", "Mobile", "Web", "Console"] }, { label: "Play", options: ["Single-player", "Multiplayer"] }] },
  { id: "desktop", name: "Desktop app", tagline: "Focused tools that live on the workstation", accent: "#64b5f6", stacks: ["Tauri", "Electron", "Compose Multiplatform", "SwiftUI / AppKit", "WinUI / .NET", "Flutter", "Custom"], details: [{ label: "Platforms", options: ["macOS", "Windows", "Linux"] }, { label: "Distribution", options: ["App stores", "Direct download", "Internal"] }] },
  { id: "cli", name: "CLI / dev tool", tagline: "Sharp utilities for terminals and automation", accent: "#90a4ae", stacks: ["Rust", "Go", "Node.js + TypeScript", "Python", "Shell", "Custom"], details: [{ label: "Experience", options: ["Commands", "Interactive TUI", "Both"] }, { label: "Platforms", options: ["macOS", "Windows", "Linux"] }] },
  { id: "custom", name: "Something else", tagline: "Start with a blank technical canvas", accent: "#f06292", stacks: ["Custom"], details: [{ label: "Priorities", options: ["Fast prototype", "Production-ready", "Learning project"] }] },
];

function ProjectArt(props: { id: CategoryId; accent: string }) {
  return <svg viewBox="0 0 180 110" aria-hidden="true" class="new-project-art">
    <defs><linearGradient id={`g-${props.id}`} x1="0" y1="0" x2="1" y2="1"><stop stop-color={props.accent} stop-opacity=".95"/><stop offset="1" stop-color={props.accent} stop-opacity=".15"/></linearGradient></defs>
    <circle cx="142" cy="22" r="30" fill={props.accent} opacity=".1"/><path d="M18 83C43 43 71 35 95 56s42 20 68-12v54H18Z" fill={`url(#g-${props.id})`} opacity=".22"/>
    <Show when={props.id === "mobile"}><rect x="67" y="13" width="47" height="82" rx="10" fill="none" stroke={props.accent} stroke-width="5"/><path d="M82 22h17M86 85h9" stroke={props.accent} stroke-width="4" stroke-linecap="round"/></Show>
    <Show when={props.id === "web"}><rect x="28" y="20" width="125" height="73" rx="8" fill="none" stroke={props.accent} stroke-width="4"/><path d="M28 38h125M40 29h2m8 0h2m8 0h2M44 54h44M44 67h66M44 80h34" stroke={props.accent} stroke-width="4" stroke-linecap="round"/></Show>
    <Show when={props.id === "backend"}><For each={[25,50,75]}>{(y) => <><ellipse cx="90" cy={y} rx="48" ry="12" fill="#14161d" stroke={props.accent} stroke-width="4"/><path d={`M42 ${y}v14c0 7 22 12 48 12s48-5 48-12V${y}`} fill="none" stroke={props.accent} stroke-width="4"/></>}</For></Show>
    <Show when={props.id === "game2d"}><path d="M38 75h22V53h22V31h22v22h22v22h22" fill="none" stroke={props.accent} stroke-width="7" stroke-linejoin="round"/><rect x="70" y="60" width="15" height="15" fill={props.accent}/></Show>
    <Show when={props.id === "game3d"}><path d="m90 15 52 29v47L90 103 38 74V32Z" fill="none" stroke={props.accent} stroke-width="4"/><path d="m38 32 52 29 52-17M90 61v42" fill="none" stroke={props.accent} stroke-width="4"/></Show>
    <Show when={props.id === "desktop"}><rect x="25" y="18" width="130" height="70" rx="6" fill="none" stroke={props.accent} stroke-width="4"/><path d="M68 101h44M82 88l-4 13m20-13 4 13" stroke={props.accent} stroke-width="5" stroke-linecap="round"/></Show>
    <Show when={props.id === "cli"}><rect x="22" y="20" width="136" height="72" rx="8" fill="none" stroke={props.accent} stroke-width="4"/><path d="m43 46 16 13-16 13m29 0h38" stroke={props.accent} stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></Show>
    <Show when={props.id === "custom"}><path d="M90 15v80M50 34l80 42m0-42L50 76" stroke={props.accent} stroke-width="7" stroke-linecap="round"/><circle cx="90" cy="55" r="18" fill="#14161d" stroke={props.accent} stroke-width="5"/></Show>
  </svg>;
}

export function buildProjectPrompt(category: Category, stack: string, customStack: string, answers: Record<string, string[]>, name: string, path: string) {
  const technology = stack === "Custom" || stack === "Custom engine" ? customStack.trim() || stack : stack;
  const details = Object.entries(answers).filter(([, values]) => values.length > 0);
  return [`Create a new ${category.name.toLowerCase()} project.`, "", "## Stack", `- Framework/engine: ${technology}`, ...details.flatMap(([label, values]) => [`- ${label}: ${values.join(", ")}`]), "", "## Project", `- Name: ${name}`, `- Location: ${path}`, "", "## Build", "Describe what you want this project to do:"].join("\n");
}

const NewProjectWizard: Component<{ open: boolean; onClose: () => void; onCreated: (project: ProjectInfo, prompt: string) => void }> = (props) => {
  const [step, setStep] = createSignal(0);
  const [categoryId, setCategoryId] = createSignal<CategoryId | null>(null);
  const [stack, setStack] = createSignal("");
  const [customStack, setCustomStack] = createSignal("");
  const [answers, setAnswers] = createSignal<Record<string, string[]>>({});
  const [name, setName] = createSignal("");
  const [parent, setParent] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let shellRef: HTMLDivElement | undefined;
  const category = createMemo(() => CATEGORIES.find((item) => item.id === categoryId()) ?? null);
  const targetPath = createMemo(() => parent() && name().trim() ? `${parent().replace(/[\\/]$/, "")}/${name().trim()}` : "");
  const needsCustomStack = createMemo(() => stack().startsWith("Custom"));
  const canContinue = createMemo(() => step() === 0 ? !!category() : step() === 1 ? !!stack() && (!needsCustomStack() || !!customStack().trim()) : step() === 2 ? true : step() === 3 ? !!name().trim() && !!parent() : true);
  createEffect(() => { if (props.open) queueMicrotask(() => shellRef?.focus()); });

  function reset() { setStep(0); setCategoryId(null); setStack(""); setCustomStack(""); setAnswers({}); setName(""); setParent(""); }
  function close() { if (!busy()) { props.onClose(); reset(); } }
  function chooseCategory(id: CategoryId) { setCategoryId(id); setStack(""); setCustomStack(""); setAnswers({}); }
  function toggleDetail(label: string, option: string) { setAnswers((current) => { const values = current[label] ?? []; return { ...current, [label]: values.includes(option) ? values.filter((v) => v !== option) : [...values, option] }; }); }
  async function chooseParent() { const path = await pickProjectFolder(); if (path) setParent(path); }
  async function finish() {
    const selected = category(); if (!selected || !targetPath()) return;
    setBusy(true);
    try {
      const project = await createProject(parent(), name().trim());
      props.onCreated(project, buildProjectPrompt(selected, stack(), customStack(), answers(), name().trim(), project.path));
      reset();
    } catch (error) { toast(`Failed to create project: ${String(error)}`, "error"); }
    finally { setBusy(false); }
  }

  const titles = ["What are we making?", "Choose the foundation", "Shape the project", "Give it a home", "Ready for the first prompt"];
  return <Show when={props.open}><div class="new-project-overlay" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
    <div ref={shellRef} tabindex={-1} class="new-project-shell" role="dialog" aria-modal="true" aria-label="Create new project">
      <header class="new-project-header"><div><span class="new-project-kicker">NEW PROJECT</span><h1>{titles[step()]}</h1></div><button class="new-project-close" onclick={close} aria-label="Close wizard">×</button></header>
      <div class="new-project-progress"><For each={titles}>{(_, index) => <span classList={{ active: index() <= step() }}/>}</For></div>
      <main class="new-project-body">
        <Show when={step() === 0}><div class="new-project-card-grid"><For each={CATEGORIES}>{(item) => <button class="new-project-category" classList={{ selected: categoryId() === item.id }} style={{ "--project-accent": item.accent }} onclick={() => chooseCategory(item.id)}><ProjectArt id={item.id} accent={item.accent}/><span class="new-project-category-name">{item.name}</span><span class="new-project-category-tagline">{item.tagline}</span></button>}</For></div></Show>
        <Show when={step() === 1 && category()}>{(selected) => <div class="new-project-stack-layout"><div class="new-project-hero" style={{ "--project-accent": selected().accent }}><ProjectArt id={selected().id} accent={selected().accent}/><h2>{selected().name}</h2><p>{selected().tagline}</p></div><div class="new-project-stack-grid"><For each={selected().stacks}>{(item) => <button class="new-project-stack-card" classList={{ selected: stack() === item }} onclick={() => setStack(item)}><span>{item}</span><small>{item.startsWith("Custom") ? "Bring your own technology" : "Start with this stack"}</small></button>}</For><Show when={needsCustomStack()}><label class="new-project-field wide"><span>Technology or engine</span><input autofocus value={customStack()} onInput={(e) => setCustomStack(e.currentTarget.value)} placeholder="e.g. Elixir + Phoenix"/></label></Show></div></div>}</Show>
        <Show when={step() === 2 && category()}>{(selected) => <div class="new-project-details"><p>Select everything that matters. You can leave any group blank.</p><For each={selected().details}>{(detail) => <section><h3>{detail.label}</h3><div class="new-project-chip-row"><For each={detail.options}>{(option) => <button classList={{ selected: (answers()[detail.label] ?? []).includes(option) }} onclick={() => toggleDetail(detail.label, option)}>{option}</button>}</For></div></section>}</For></div>}</Show>
        <Show when={step() === 3}><div class="new-project-location"><div class="new-project-folder-art" aria-hidden="true"><span class="folder-plus-art" /></div><div class="new-project-location-fields"><label class="new-project-field"><span>Project name</span><input autofocus value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="my-new-project"/></label><label class="new-project-field"><span>Parent folder</span><button class="new-project-folder-button" onclick={chooseParent}>{parent() || "Choose a parent folder…"}</button></label><Show when={targetPath()}><div class="new-project-path-preview"><span>WILL CREATE</span>{targetPath()}</div></Show></div></div></Show>
        <Show when={step() === 4 && category()}>{(selected) => <div class="new-project-review"><div class="new-project-review-art" style={{ "--project-accent": selected().accent }}><ProjectArt id={selected().id} accent={selected().accent}/></div><div><span class="new-project-kicker">PROJECT BRIEF</span><h2>{name()}</h2><dl><dt>Type</dt><dd>{selected().name}</dd><dt>Stack</dt><dd>{needsCustomStack() ? customStack() : stack()}</dd><dt>Location</dt><dd>{targetPath()}</dd><For each={Object.entries(answers()).filter(([, v]) => v.length)}>{([label, values]) => <><dt>{label}</dt><dd>{values.join(", ")}</dd></>}</For></dl><p class="new-project-review-note">FlipFlopper will create the folder and prepare an editable brief in the prompt field. Your agent will generate the actual project.</p></div></div>}</Show>
      </main>
      <footer class="new-project-footer"><button class="new-project-back" onclick={() => step() === 0 ? close() : setStep(step() - 1)} disabled={busy()}>{step() === 0 ? "Cancel" : "Back"}</button><span>Step {step() + 1} of {titles.length}</span><Button variant="solid" onClick={() => step() === 4 ? void finish() : setStep(step() + 1)} disabled={!canContinue() || busy()}><Show when={busy()}><Spinner size={12}/></Show>{step() === 4 ? "Create project" : "Continue"}</Button></footer>
    </div>
  </div></Show>;
};

export default NewProjectWizard;
