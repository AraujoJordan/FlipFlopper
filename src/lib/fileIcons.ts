import type { IconName } from "../components/shell/Icon";

// File categories share the app's Material Symbols instead of maintaining a
// complete editor icon theme. Unknown names retain the generic file symbol.
const CATEGORIES: [RegExp, IconName][] = [
  [/\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?)$/, "image"],
  [/\.(mp3|wav|ogg|flac|m4a|aac)$/, "audio"],
  [/\.(mp4|webm|mov|mkv|avi)$/, "video"],
  [/\.pdf$/, "pdf"],
  [/\.(csv|tsv|xlsx?|ods)$/, "table"],
  [/\.(zip|gz|bz2|xz|tar|7z|rar|jar|war)$/, "archive"],
  [/\.(pem|key|crt|cer|p12|pfx)$/, "lock"],
  [/\.(jsonc?|ya?ml|toml|xml|ini|properties|lock)$|^\.env(?:\.|$)/, "data"],
  [/\.(mdx?|txt|rst|adoc|docx?|rtf)$/, "document"],
  [/\.(html?|vue|svelte)$/, "html"],
  [/\.(css|scss|sass|less)$/, "css"],
  [/\.(jsx?|[cm]js)$/, "javascript"],
  [/\.(sh|zsh|bash|fish|ps1|bat|cmd)$|^(dockerfile|makefile)(\.|$)/, "terminal"],
  [/\.(tsx?|rs|py|go|java|kt|kts|swift|[ch]|cpp|hpp|cc|cs|rb|php|dart|sql|lua|exs?|erl|scala)$/, "code"],
];

export function getFileIcon(path: string): IconName {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return CATEGORIES.find(([pattern]) => pattern.test(name))?.[1] ?? "file";
}
