/** Client-side mirrors of the backend's clone checks, only for previews and quick feedback.
 *  The backend (`project::repository_name` / `validate_clone_url`) stays authoritative. */

/** The folder a clone will use, or `null` when the URL has no repository name. */
export function repositoryNameFromUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  // Drop the scheme and host so "https://host/" has no name.
  const candidate = trimmed.includes("://") ? (trimmed.split("://")[1] ?? "").split("/").slice(1).join("/") : trimmed;
  const last = candidate.split(/[/:]/).pop()?.replace(/\.git$/, "") ?? "";
  const clean = last
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return clean || null;
}

/** Whether a string looks like something `git clone` accepts. */
export function looksLikeCloneUrl(url: string): boolean {
  const value = url.trim();
  if (!value || value.startsWith("-")) return false;
  return /^(https?|ssh|git|file):\/\//.test(value) || /^git@[^:]+:/.test(value) || value.startsWith("/");
}

/** A GitHub-safe repository name derived from a project or folder name. */
export function defaultRepositoryName(projectName: string): string {
  const clean = projectName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  return clean.slice(0, 100) || "repository";
}

/** Mirrors the backend check for GitHub repository names. */
export function isValidRepositoryName(name: string): boolean {
  const value = name.trim();
  return value.length > 0 && value.length <= 100 && !/^[.-]/.test(value) && /^[A-Za-z0-9._-]+$/.test(value);
}
