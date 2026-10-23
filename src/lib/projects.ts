import { getRecentProjects, openProject, pickProjectFolder, removeRecentProject, type ProjectInfo } from "./ipc";
import { projectName, setDraftProject } from "./chat";
import { hideSidebarProject, restoreSidebarProject } from "./layout";
import { setPendingPromptSeed, setStore, updateCurrentBranch } from "./store";
import { confirmDialog, toast } from "../components/ui";

export async function refreshRecentProjects() {
  try {
    setStore("recentProjects", await getRecentProjects());
  } catch (e) {
    console.error("Failed to load recent projects:", e);
  }
}

/** Inspect a project without adding files, make it current, and aim the next
 *  new session at it. */
export async function openProjectPath(path: string): Promise<ProjectInfo | null> {
  try {
    const info = await openProject(path);
    restoreSidebarProject(path);
    setStore("currentProject", info);
    setDraftProject(info);
    void updateCurrentBranch();
    void refreshRecentProjects();
    return info;
  } catch (e) {
    toast(`Failed to open ${path}: ${String(e)}`, "error");
    return null;
  }
}

export async function pickAndOpenProject(): Promise<ProjectInfo | null> {
  const path = await pickProjectFolder();
  return path ? openProjectPath(path) : null;
}

export async function forgetRecentProject(path: string) {
  try {
    await removeRecentProject(path);
    setStore("recentProjects", (list) => list.filter((p) => p.path !== path));
  } catch (e) {
    toast(`Failed to remove ${path}: ${String(e)}`, "error");
  }
}

/** Remove a project from navigation while retaining its conversations and
 * checkout. Opening its folder again or Undo restores the same project. */
export async function removeSidebarProject(path: string) {
  const name = projectName(path);
  if (!(await confirmDialog(`Remove “${name}” from project lists? Files and conversations are kept. Open the folder again to restore it.`, "Remove project"))) return;
  hideSidebarProject(path);
  toast(`Removed ${name}`, "info", { actionLabel: "Undo", onAction: () => restoreSidebarProject(path) });
}

/** The new-project wizard finished: open the project and seed the composer
 *  with the brief it produced. */
export function projectCreated(project: ProjectInfo, prompt: string) {
  restoreSidebarProject(project.path);
  setStore("currentProject", project);
  setDraftProject(project);
  void updateCurrentBranch();
  void refreshRecentProjects();
  setPendingPromptSeed({ text: prompt, projectPath: project.path });
}
