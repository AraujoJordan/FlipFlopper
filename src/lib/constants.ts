// Cross-cutting literals shared by multiple components. Single source of
// truth so protected-branch checks and the work-branch name don't drift
// independently across App.tsx / components/git/*.

const PROTECTED_BRANCH_NAMES = new Set(["main", "master"]);

/** True for branches the backend refuses to auto-commit/rollback/rename on
 *  (see AGENTS.md "Git And Commit Rules"). Empty string ("no branch
 *  detected") is never protected. */
export function isProtectedBranch(branch: string): boolean {
  return branch !== "" && PROTECTED_BRANCH_NAMES.has(branch);
}

/** Name of the dedicated work branch created off a protected branch. */
export const WORK_BRANCH = "flipflopper/work";
