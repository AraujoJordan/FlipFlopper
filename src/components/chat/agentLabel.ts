import { store } from "../../lib/store";

/** Display name for an agent id, falling back to the id itself. */
export function agentLabel(agentId: string): string {
  return store.agents.find((a) => a.id === agentId)?.name ?? agentId;
}
