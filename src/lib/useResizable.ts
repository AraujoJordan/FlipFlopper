import { createSignal } from "solid-js";

interface UseResizableOptions {
  /** Which pointer coordinate drives the resize. */
  axis: "x" | "y";
  /** Size (px) read once when the drag starts. */
  getSize: () => number;
  /** Called continuously while dragging with the next raw (unclamped) size —
   *  callers are expected to clamp/persist, same as the setters they already had. */
  setSize: (px: number) => void;
  /** True when the drag handle sits on the leading edge of the panel it resizes
   *  (e.g. the top edge of a bottom-docked panel, or the left edge of a
   *  right-docked one), so moving the pointer toward the start of the axis
   *  grows the panel instead of shrinking it. */
  invert?: boolean;
  /** Called once the drag ends — for callers that persist the final size
   *  separately from `setSize` (e.g. debounced localStorage writes) rather
   *  than on every move. */
  onEnd?: () => void;
}

/** Shared pointer-capture drag-resize behavior for TerminalPanel, the
 *  EditorPane preview split, and OrchestratorPanel — previously each
 *  hand-rolled an identical dragStart/dragging signal + pointer handlers. */
export function useResizable(opts: UseResizableOptions) {
  const [dragging, setDragging] = createSignal(false);
  let dragStart = 0;
  let dragStartSize = 0;

  function coord(e: PointerEvent) {
    return opts.axis === "x" ? e.clientX : e.clientY;
  }

  function onPointerDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart = coord(e);
    dragStartSize = opts.getSize();
    setDragging(true);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging()) return;
    const delta = coord(e) - dragStart;
    opts.setSize(dragStartSize + (opts.invert ? -delta : delta));
  }

  function onPointerUp(e: PointerEvent) {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setDragging(false);
    opts.onEnd?.();
  }

  return { dragging, onPointerDown, onPointerMove, onPointerUp };
}
