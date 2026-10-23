import { useValueMotion } from "../ui";
import { Component, For, Show, Switch, Match, createSignal, createEffect } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { FormField, InteractionResponse } from "../../lib/ipc";
import { interactionIsLive, respondToAgent, type InteractionBlock } from "../../lib/chat";
import { toast } from "../ui";
import Markdown from "./Markdown";

/** The transcript owns request history; the backend is the authority for which
 * request is still actionable. Local signals here are only an unsent form. */
const AgentInteraction: Component<{ block: InteractionBlock; sessionId: string }> = (props) => {
  const request = () => props.block.request;
  const payload = () => request().payload;
  const [submitted, setSubmitted] = createSignal(false);
  const active = () => !submitted() && !props.block.outcome && interactionIsLive(props.sessionId, request().id);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [values, setValues] = createSignal<Record<string, unknown>>({});
  const [answers, setAnswers] = createSignal<Record<string, string[]>>({});
  let section: HTMLDivElement | undefined;
  let focused = false;
  useValueMotion(() => section?.querySelector<HTMLElement>(".agent-request-outcome") ?? section, () => props.block.outcome ?? (busy() ? "sending" : active() ? "waiting" : "historical"));
  createEffect(() => {
    if (!active() || focused) return;
    focused = true;
    const defaults: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(payload().requestedSchema?.properties ?? {})) {
      if (field.default !== undefined) defaults[name] = field.default;
      else if (field.type === "boolean") defaults[name] = false;
    }
    setValues(defaults);
    queueMicrotask(() => section?.focus({ preventScroll: true }));
  });
  const setField = (name: string, value: unknown) => setValues((v) => ({ ...v, [name]: value }));
  const choices = (field: FormField) => field.enum ?? field.oneOf?.map((o) => o.const) ?? [];

  async function send(response: InteractionResponse) {
    if (!active() || busy()) return;
    setBusy(true); setError("");
    try {
      if (await respondToAgent(props.sessionId, request(), response)) setSubmitted(true);
      else setError("The response was not accepted. Review the fields and try again.");
    }
    finally { setBusy(false); }
  }
  async function openAuthentication() {
    const url = payload().url;
    try {
      if (!url || new URL(url).protocol !== "https:") return;
      await openUrl(url);
      await send({ kind: "url", action: "accept" });
    } catch (error) { toast(`Could not open authentication page: ${String(error)}`, "error"); }
  }
  function answer(questionId: string, option: string, multiple: boolean, checked: boolean) {
    setAnswers((all) => ({ ...all, [questionId]: multiple ? checked ? [...(all[questionId] ?? []), option] : (all[questionId] ?? []).filter((id) => id !== option) : [option] }));
  }
  return (
    <div class="agent-request" data-motion-id={request().id} classList={{ "agent-request-pending": active() }} ref={section} tabIndex={-1} role="group" aria-label={request().title}>
      <div class="agent-request-head"><strong>{request().title}</strong><span role="status">{active() ? "Needs input" : props.block.outcome ?? (submitted() ? "Response sent" : "No longer active")}</span></div>
      <Show when={payload().message && payload().message !== request().title}><Markdown text={payload().message!} /></Show>
      <Switch>
        <Match when={request().kind === "permission"}>
          <Show when={payload().toolCall?.rawInput}><pre class="agent-request-details">{JSON.stringify(payload().toolCall?.rawInput, null, 2)}</pre></Show>
          <Show when={active()}><div class="agent-request-actions">
            <For each={payload().options}>{(option) => <button type="button" class="ui-btn ui-btn-outline" disabled={busy()} onClick={() => void send({ kind: "permission", option_id: option.optionId })}>{option.name}</button>}</For>
            <button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void send({ kind: "permission", option_id: null })}>Cancel</button>
          </div></Show>
        </Match>
        <Match when={request().kind === "plan"}>
          <Show when={payload().overview}><p>{payload().overview}</p></Show>
          <Markdown text={payload().plan ?? "Review the agent’s proposed plan."} />
          <Show when={active()}><div class="agent-request-actions">
            <button type="button" class="ui-btn ui-btn-solid" disabled={busy()} onClick={() => void send({ kind: "plan", accepted: true, reason: null })}>Approve and build</button>
            <input class="ui-field" aria-label="Requested plan changes" placeholder="Changes to request" value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
            <button type="button" class="ui-btn ui-btn-outline" disabled={busy()} onClick={() => void send({ kind: "plan", accepted: false, reason: reason().trim() || "Please revise the plan." })}>Request changes</button>
            <button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void send({ kind: "plan", accepted: false, reason: null, cancelled: true })}>Cancel</button>
          </div></Show>
        </Match>
        <Match when={request().kind === "question"}>
          <form onSubmit={(e) => { e.preventDefault(); void send({ kind: "question", action: "accept", answers: (payload().questions ?? []).map((q) => ({ questionId: q.id, selectedOptionIds: answers()[q.id] ?? [] })) }); }}>
            <For each={payload().questions}>{(q) => <fieldset disabled={!active() || busy()}><legend>{q.prompt}</legend><For each={q.options}>{(o) => <label class="agent-request-choice">
              <input type={q.allowMultiple ? "checkbox" : "radio"} name={`${request().id}-${q.id}`} checked={(answers()[q.id] ?? []).includes(o.id)} onChange={(e) => answer(q.id, o.id, !!q.allowMultiple, e.currentTarget.checked)} />{o.label}
            </label>}</For></fieldset>}</For>
            <Show when={active()}><div class="agent-request-actions"><button class="ui-btn ui-btn-solid" type="submit" disabled={busy()}>Send answers</button><button class="ui-btn ui-btn-ghost" type="button" disabled={busy()} onClick={() => void send({ kind: "question", action: "decline" })}>Skip</button><button class="ui-btn ui-btn-ghost" type="button" disabled={busy()} onClick={() => void send({ kind: "question", action: "cancel" })}>Cancel</button></div></Show>
          </form>
        </Match>
        <Match when={request().kind === "form"}>
          <form onSubmit={(e) => { e.preventDefault(); void send({ kind: "form", action: "accept", content: values() }); }}>
            <For each={Object.entries(payload().requestedSchema?.properties ?? {})}>{([name, field]) => <label class="agent-request-field">
              <span>{field.title ?? name}{payload().requestedSchema?.required?.includes(name) ? " *" : ""}</span>
              <Show when={field.description}><small>{field.description}</small></Show>
              <Switch>
                <Match when={field.type === "boolean"}><input type="checkbox" disabled={!active() || busy()} checked={values()[name] === true} onChange={(e) => setField(name, e.currentTarget.checked)} /></Match>
                <Match when={field.type === "array"}><select class="ui-field" multiple disabled={!active() || busy()} value={values()[name] as string[] ?? []} onChange={(e) => setField(name, [...e.currentTarget.selectedOptions].map((o) => o.value))}><For each={field.items?.enum ?? field.items?.anyOf?.map((o) => o.const)}>{(v, i) => <option value={v}>{field.items?.enumNames?.[i()] ?? field.items?.anyOf?.[i()]?.title ?? v}</option>}</For></select></Match>
                <Match when={choices(field).length > 0}><select class="ui-field" required={payload().requestedSchema?.required?.includes(name)} disabled={!active() || busy()} value={values()[name] as string ?? ""} onChange={(e) => setField(name, e.currentTarget.value)}><option value="" disabled>Choose…</option><For each={choices(field)}>{(v, i) => <option value={v}>{field.enumNames?.[i()] ?? field.oneOf?.[i()]?.title ?? v}</option>}</For></select></Match>
                <Match when={true}><input class="ui-field" type={field.type === "string" ? "text" : "number"} step={field.type === "integer" ? "1" : "any"} required={payload().requestedSchema?.required?.includes(name)} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} disabled={!active() || busy()} value={values()[name] as string | number ?? ""} onInput={(e) => setField(name, field.type === "string" ? e.currentTarget.value : e.currentTarget.value === "" ? undefined : Number(e.currentTarget.value))} /></Match>
              </Switch>
            </label>}</For>
            <Show when={active()}><div class="agent-request-actions"><button type="submit" class="ui-btn ui-btn-solid" disabled={busy()}>Send answer</button><button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void send({ kind: "form", action: "decline" })}>Decline</button><button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void send({ kind: "form", action: "cancel" })}>Cancel</button></div></Show>
          </form>
        </Match>
        <Match when={request().kind === "url"}>
          <p>Continue with the provider in your browser. FlipFlopper does not collect your credentials.</p><p class="agent-request-url">{payload().url}</p>
          <Show when={active()}><div class="agent-request-actions"><button type="button" class="ui-btn ui-btn-solid" disabled={busy()} onClick={() => void openAuthentication()}>Open authentication page</button><button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void send({ kind: "url", action: "decline" })}>Decline</button><button type="button" class="ui-btn ui-btn-ghost" disabled={busy()} onClick={() => void send({ kind: "url", action: "cancel" })}>Cancel</button></div></Show>
        </Match>
      </Switch>
      <Show when={error()}><p role="alert">{error()}</p></Show>
    </div>
  );
};
export default AgentInteraction;
