// Run with `node scripts/generate-icons.mjs` after editing the SVG masters.
// Uses the project's installed Tauri CLI; no image tools or fonts are required.
// The preview is SVG so it can be opened directly in a browser at actual size.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "src-tauri/icons");
const media = join(root, "docs/media");
const brand = join(media, "branding");
const stage = await mkdtemp(join(tmpdir(), "flipflopper-icons-"));
const render = (source, output, sizes = []) => execFileSync(process.execPath, [
  join(root, "node_modules/@tauri-apps/cli/tauri.js"), "icon", source,
  "--output", output, ...sizes.flatMap(size => ["--png", String(size)]),
], { cwd: root, stdio: "pipe" });

// Keep Tauri's desktop representations, substituting the optical artwork at
// small sizes. In ICNS, ic11/ic12 are the 16pt/32pt Retina representations.
function icnsChunks(buffer) {
  const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) throw Error("Invalid ICNS chunk");
    chunks.push([buffer.toString("ascii", offset, offset + 4), buffer.subarray(offset, offset + length)]);
    offset += length;
  }
  return chunks;
}

function icoImages(buffer) {
  return Array.from({ length: buffer.readUInt16LE(4) }, (_, index) => {
    const offset = 6 + index * 16;
    const entry = Buffer.from(buffer.subarray(offset, offset + 16));
    const start = entry.readUInt32LE(12);
    return { size: entry[0] || 256, entry, data: buffer.subarray(start, start + entry.readUInt32LE(8)) };
  });
}

try {
  const large = join(stage, "large");
  const small = join(stage, "small");
  const proof = join(stage, "proof");
  render(join(icons, "app-icon.svg"), large);
  render(join(icons, "app-icon-small.svg"), small);
  render(join(icons, "app-icon-small.svg"), proof, [16, 24, 30, 32]);
  render(join(icons, "app-icon.svg"), join(stage, "sizes"), [48, 128, 256, 512]);

  const desktop = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "StoreLogo.png",
    ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map(size => `Square${size}x${size}Logo.png`)];
  for (const name of desktop) {
    const source = name === "32x32.png" ? join(proof, name)
      : name === "Square30x30Logo.png" ? join(proof, "30x30.png") : join(large, name);
    await copyFile(source, join(icons, name));
  }

  const opticalChunks = new Map(icnsChunks(await readFile(join(small, "icon.icns"))));
  const opticalTypes = new Set(["is32", "s8mk", "il32", "l8mk", "ic11", "ic12", "icp4", "icp5"]);
  const chunks = icnsChunks(await readFile(join(large, "icon.icns"))).sort(([a], [b]) => a.localeCompare(b)).map(([type, data]) => {
    if (!opticalTypes.has(type)) return data;
    if (!opticalChunks.has(type)) throw Error(`Missing optical ICNS chunk: ${type}`);
    return opticalChunks.get(type);
  });
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write("icns");
  icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  await writeFile(join(icons, "icon.icns"), Buffer.concat([icnsHeader, ...chunks]));

  const opticalImages = new Map(icoImages(await readFile(join(small, "icon.ico"))).map(item => [item.size, item]));
  const images = icoImages(await readFile(join(large, "icon.ico"))).map(item => {
    if (item.size > 32) return item;
    if (!opticalImages.has(item.size)) throw Error(`Missing optical ICO image: ${item.size}`);
    return opticalImages.get(item.size);
  });
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(1, 2);
  icoHeader.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  for (const item of images) {
    item.entry.writeUInt32LE(offset, 12);
    offset += item.data.length;
  }
  await writeFile(join(icons, "icon.ico"), Buffer.concat([icoHeader, ...images.map(item => item.entry), ...images.map(item => item.data)]));
  await copyFile(join(icons, "icon.png"), join(media, "flipflopper-icon.png"));

  await mkdir(brand, { recursive: true });
  for (const obsolete of ["flipflopper-mark-jade.svg", "flipflopper-mark-graphite.svg"]) {
    await rm(join(brand, obsolete), { force: true });
  }
  const master = await readFile(join(icons, "app-icon.svg"), "utf8");
  const rawPaths = master.match(/<path\b[^>]*\/>/g);
  if (!rawPaths?.length) throw Error("No symbol paths in master SVG");
  const duotonePaths = rawPaths.join("\n    ");
  const monoPaths = rawPaths.map(p => p.replace(/\s+fill="[^"]*"/g, "").replace(/\s+class="[^"]*"/g, "")).join("\n    ");

  await writeFile(join(brand, "flipflopper-mark-duotone.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="704" viewBox="0 0 768 704" role="img" aria-label="FlipFlopper interlocking rotational FF switch">
  <g transform="translate(-128 -160)">
    ${duotonePaths}
  </g>
</svg>\n`);

  for (const [name, color] of [["indigo", "#6366F1"], ["coral", "#FF5E7E"], ["carbon", "#11131A"], ["white", "#FFFFFF"]]) {
    await writeFile(join(brand, `flipflopper-mark-${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="704" viewBox="0 0 768 704" role="img" aria-label="FlipFlopper interlocking rotational FF switch">
  <g fill="${color}" transform="translate(-128 -160)">
    ${monoPaths}
  </g>
</svg>\n`);
  }

  const png = async (path, x, y, size) => `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/png;base64,${(await readFile(path)).toString("base64")}"/>`;
  const label = (x, y, text, size = 18, color = "#9EADB4") => `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${color}">${text}</text>`;
  const markDuotone = (x, y, scale = 0.24) => `<g transform="translate(${x} ${y}) scale(${scale})"><g transform="translate(-128 -160)">${duotonePaths}</g></g>`;
  const markMono = (x, y, color, scale = 0.24) => `<g transform="translate(${x} ${y}) scale(${scale})"><g fill="${color}" transform="translate(-128 -160)">${monoPaths}</g></g>`;
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1900" viewBox="0 0 1600 1900">',
    '<rect width="1600" height="1900" fill="#0B0D13"/>',
    label(80, 76, "FLIPFLOPPER / ICON SYSTEM", 18, "#6366F1"),
    label(80, 148, "One conversation. Flip any time.", 48, "#F1F6F7"),
    label(80, 192, "Interlocking rotational FF switch in Electric Indigo and Hot Coral.", 22),
    '<rect x="80" y="240" width="700" height="460" rx="24" fill="#181C26"/>',
    '<rect x="800" y="240" width="720" height="460" rx="24" fill="#F3F4F6"/>',
    await png(join(icons, "icon.png"), 280, 310, 300),
    await png(join(icons, "icon.png"), 1010, 310, 300),
    label(112, 664, "01 / DARK SURFACE", 16),
    label(832, 664, "02 / LIGHT SURFACE", 16, "#53626B"),
    label(80, 766, "ACTUAL PIXEL SIZES", 18, "#6366F1"),
    label(80, 800, "16–32 px use pixel-snapped 4px stems and 2px channels. View at 100% for size checks.", 18),
  ];
  let x = 88;
  for (const size of [16, 24, 32, 48, 128, 256, 512]) {
    const source = join(size <= 32 ? proof : join(stage, "sizes"), `${size}x${size}.png`);
    svg.push(await png(source, x, 1380 - size, size), label(x, 1412, String(size), 16));
    x += size + 50;
  }
  svg.push(
    '<path d="M80 1460H1520" stroke="#262C3A"/>',
    label(80, 1510, "STANDALONE / DUO-TONE & SINGLE COLOR", 18, "#6366F1"),
    markDuotone(80, 1540), markMono(400, 1540, "#FFFFFF"),
    '<rect x="740" y="1530" width="270" height="190" rx="16" fill="#F3F4F6"/>',
    markMono(785, 1540, "#11131A"),
    '<rect x="1080" y="1535" width="44" height="44" rx="12" fill="#6366F1"/>',
    label(1140, 1564, "ELECTRIC INDIGO / #6366F1", 17),
    '<rect x="1080" y="1595" width="44" height="44" rx="12" fill="#FF5E7E"/>',
    label(1140, 1624, "HOT CORAL / #FF5E7E", 17),
    '<rect x="1080" y="1655" width="44" height="44" rx="12" fill="#11131A" stroke="#262C3A"/>',
    label(1140, 1684, "CARBON / #11131A", 17),
    label(80, 1810, "Interlocking rotational FF symbol · Duo-tone & monochrome · Transparent outer corners", 20),
    label(80, 1846, "Desktop: PNG / ICNS / ICO     Brand marks: SVG", 17),
    '</svg>\n',
  );
  await writeFile(join(brand, "flipflopper-icon-preview.svg"), svg.join("\n"));
  console.log("Generated desktop icons, standalone marks, README image, and preview sheet.");
} finally {
  await rm(stage, { recursive: true, force: true });
}
