import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { minimapItems, nearestMinimapIndex, type Message } from "../../lib/transcript";

/** A slim rail at the edge of a long conversation: one tick per sent prompt, the one in view
 *  highlighted. Hover shows the prompt; click jumps to it. */
const TimelineMinimap: Component<{ scroller: () => HTMLElement | undefined; messages: () => readonly Message[]; onJump: (id: string) => void }> = (props) => {
  const items = createMemo(() => minimapItems(props.messages()));
  const [current, setCurrent] = createSignal(0);
  let frame = 0;

  const measure = () => {
    frame = 0;
    const scroller = props.scroller();
    if (!scroller || items().length === 0) return;
    const box = scroller.getBoundingClientRect();
    const tops = items().map((item) => {
      const element = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`);
      // Prompts that are not rendered yet sit above everything that is.
      return element ? element.getBoundingClientRect().top - box.top + scroller.scrollTop : -1e9;
    });
    setCurrent(nearestMinimapIndex(tops, scroller.scrollTop + scroller.clientHeight * 0.25));
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };

  onMount(() => {
    const scroller = props.scroller();
    scroller?.addEventListener("scroll", schedule, { passive: true });
    schedule();
    onCleanup(() => { scroller?.removeEventListener("scroll", schedule); if (frame) cancelAnimationFrame(frame); });
  });

  const top = (i: number) => (items().length < 2 ? 0 : (i / (items().length - 1)) * 100);

  return (
    <Show when={items().length > 0}>
      <nav class="timeline-minimap" aria-label="Jump to a prompt">
        <For each={items()}>
          {(item, i) => (
            <button type="button" class="timeline-tick" classList={{ "timeline-tick-on": current() === i() }}
              style={{ top: `${top(i())}%` }} data-label={item.label} aria-label={`Prompt ${i() + 1}: ${item.label}`}
              onClick={() => props.onJump(item.id)} />
          )}
        </For>
      </nav>
    </Show>
  );
};

export default TimelineMinimap;
