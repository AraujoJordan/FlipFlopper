import { createSignal } from "solid-js";

const [paletteOpen, setPaletteOpen] = createSignal(false);
export { paletteOpen, setPaletteOpen };

export const openPalette = () => setPaletteOpen(true);
export const togglePalette = () => setPaletteOpen((v) => !v);
