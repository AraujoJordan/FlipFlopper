import { getRecentProjects, openProject, pickProjectFolder, removeRecentProject, type ProjectInfo } from "./ipc";
import { setDraftProject } from "./chat";
import { setPendingPromptSeed, setStore, updateCurrentBranch } from "./store";
import { toast } from "../components/ui";

export async function refreshRecentProjects() {
  try {
    setStore("recentProjects", await getRecentProjects());
  } catch (e) {
    console.error("Failed to load recent projects:", e);
  }
}

/** Open (and scaffold) a project, make it the current one, and aim the next
 *  new session at it. */
export async function openProjectPath(path: string): Promise<ProjectInfo | null> {
  try {
    const info = await openProject(path);
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

/** The new-project wizard finished: open the project and seed the composer
 *  with the brief it produced. */
export function projectCreated(project: ProjectInfo, prompt: string) {
  setStore("currentProject", project);
  setDraftProject(project);
  void updateCurrentBranch();
  void refreshRecentProjects();
  setPendingPromptSeed({ text: prompt, projectPath: project.path });
}
