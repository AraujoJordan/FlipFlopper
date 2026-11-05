// Pull requests explicitly linked to a conversation. The branch chip in the
// header still shows the checkout's current PR; this list lets a thread carry
// additional references without changing the checkout.
import { createSignal } from "solid-js";
import { readPref, writePref } from "./appPrefs";

export interface LinkedPr {
  number: number;
  title: string;
  url: string;
  state: string;
  is_draft: boolean;
  head_ref_name: string;
  base_ref_name: string;
  added_at: number;
}

const KEY = "flipflopper:linked-prs";
const [links, setLinks] = createSignal<Record<string, LinkedPr[]>>({});

export const linkedPrsFor = (sessionId: string | null | undefined): LinkedPr[] => (sessionId ? links()[sessionId] ?? [] : []);

export async function hydrateLinkedPrs() {
  const saved = await readPref<Record<string, LinkedPr[]>>(KEY, {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  const clean: Record<string, LinkedPr[]> = {};
  for (const [sessionId, list] of Object.entries(saved)) {
    if (!Array.isArray(list)) continue;
    const valid = list.filter((entry): entry is LinkedPr =>
      !!entry && typeof entry === "object" &&
      typeof entry.number === "number" && Number.isFinite(entry.number) &&
      typeof entry.title === "string" && typeof entry.url === "string").slice(0, 20);
    if (valid.length) clean[sessionId] = valid;
  }
  setLinks(clean);
}

function persist(next: Record<string, LinkedPr[]>) {
  setLinks(next);
  writePref(KEY, next);
}

export function linkPr(sessionId: string | null | undefined, pr: Omit<LinkedPr, "added_at">): boolean {
  if (!sessionId) return false;
  const current = links()[sessionId] ?? [];
  if (current.some((entry) => entry.number === pr.number && entry.url === pr.url)) return false;
  persist({ ...links(), [sessionId]: [{ ...pr, added_at: Date.now() }, ...current].slice(0, 20) });
  return true;
}

export function unlinkPr(sessionId: string | null | undefined, number: number, url?: string) {
  if (!sessionId) return;
  const current = links()[sessionId] ?? [];
  const next = current.filter((entry) => entry.number !== number || (url ? entry.url !== url : false));
  const all = { ...links() };
  if (next.length) all[sessionId] = next;
  else delete all[sessionId];
  persist(all);
}

/** Parse `123`, `#123`, or a GitHub pull-request URL. */
export function pullRequestNumber(value: string): number | null {
  const match = /(?:^#?(\d+)$)|(?:\/pull\/(\d+)(?:$|[/?#]))/.exec(value.trim());
  const number = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(number) && number > 0 ? number : null;
}
