import { Component, JSX } from "solid-js";
import account_tree from "@material-symbols/svg-400/rounded/account_tree.svg?raw";
import add from "@material-symbols/svg-400/rounded/add.svg?raw";
import alternate_email from "@material-symbols/svg-400/rounded/alternate_email.svg?raw";
import archive from "@material-symbols/svg-400/rounded/archive.svg?raw";
import arrow_downward from "@material-symbols/svg-400/rounded/arrow_downward.svg?raw";
import arrow_forward from "@material-symbols/svg-400/rounded/arrow_forward.svg?raw";
import arrow_upward from "@material-symbols/svg-400/rounded/arrow_upward.svg?raw";
import audio_file from "@material-symbols/svg-400/rounded/audio_file.svg?raw";
import bolt from "@material-symbols/svg-400/rounded/bolt.svg?raw";
import build from "@material-symbols/svg-400/rounded/build.svg?raw";
import chat_bubble from "@material-symbols/svg-400/rounded/chat_bubble.svg?raw";
import check from "@material-symbols/svg-400/rounded/check.svg?raw";
import chevron_right from "@material-symbols/svg-400/rounded/chevron_right.svg?raw";
import close from "@material-symbols/svg-400/rounded/close.svg?raw";
import code from "@material-symbols/svg-400/rounded/code.svg?raw";
import commit from "@material-symbols/svg-400/rounded/commit.svg?raw";
import compare from "@material-symbols/svg-400/rounded/compare.svg?raw";
import content_copy from "@material-symbols/svg-400/rounded/content_copy.svg?raw";
import content_paste from "@material-symbols/svg-400/rounded/content_paste.svg?raw";
import create_new_folder from "@material-symbols/svg-400/rounded/create_new_folder.svg?raw";
import css from "@material-symbols/svg-400/rounded/css.svg?raw";
import data_object from "@material-symbols/svg-400/rounded/data_object.svg?raw";
import deleteIcon from "@material-symbols/svg-400/rounded/delete.svg?raw";
import description from "@material-symbols/svg-400/rounded/description.svg?raw";
import dock_to_right from "@material-symbols/svg-400/rounded/dock_to_right.svg?raw";
import download from "@material-symbols/svg-400/rounded/download.svg?raw";
import draft from "@material-symbols/svg-400/rounded/draft.svg?raw";
import drag_indicator from "@material-symbols/svg-400/rounded/drag_indicator.svg?raw";
import edit from "@material-symbols/svg-400/rounded/edit.svg?raw";
import fit_screen from "@material-symbols/svg-400/rounded/fit_screen.svg?raw";
import folder from "@material-symbols/svg-400/rounded/folder.svg?raw";
import format_list_bulleted from "@material-symbols/svg-400/rounded/format_list_bulleted.svg?raw";
import help from "@material-symbols/svg-400/rounded/help.svg?raw";
import history from "@material-symbols/svg-400/rounded/history.svg?raw";
import html from "@material-symbols/svg-400/rounded/html.svg?raw";
import image from "@material-symbols/svg-400/rounded/image.svg?raw";
import javascript from "@material-symbols/svg-400/rounded/javascript.svg?raw";
import keyboard_arrow_down from "@material-symbols/svg-400/rounded/keyboard_arrow_down.svg?raw";
import language from "@material-symbols/svg-400/rounded/language.svg?raw";
import layers from "@material-symbols/svg-400/rounded/layers.svg?raw";
import lock from "@material-symbols/svg-400/rounded/lock.svg?raw";
import merge from "@material-symbols/svg-400/rounded/merge.svg?raw";
import more_horiz from "@material-symbols/svg-400/rounded/more_horiz.svg?raw";
import open_in_new from "@material-symbols/svg-400/rounded/open_in_new.svg?raw";
import package_2 from "@material-symbols/svg-400/rounded/package_2.svg?raw";
import picture_as_pdf from "@material-symbols/svg-400/rounded/picture_as_pdf.svg?raw";
import play_arrow from "@material-symbols/svg-400/rounded/play_arrow.svg?raw";
import refresh from "@material-symbols/svg-400/rounded/refresh.svg?raw";
import remove from "@material-symbols/svg-400/rounded/remove.svg?raw";
import schema from "@material-symbols/svg-400/rounded/schema.svg?raw";
import search from "@material-symbols/svg-400/rounded/search.svg?raw";
import settings from "@material-symbols/svg-400/rounded/settings.svg?raw";
import shield from "@material-symbols/svg-400/rounded/shield.svg?raw";
import stop from "@material-symbols/svg-400/rounded/stop.svg?raw";
import table_chart from "@material-symbols/svg-400/rounded/table_chart.svg?raw";
import task from "@material-symbols/svg-400/rounded/task.svg?raw";
import terminal from "@material-symbols/svg-400/rounded/terminal.svg?raw";
import upload from "@material-symbols/svg-400/rounded/upload.svg?raw";
import video_file from "@material-symbols/svg-400/rounded/video_file.svg?raw";
import view_sidebar from "@material-symbols/svg-400/rounded/view_sidebar.svg?raw";
import visibility from "@material-symbols/svg-400/rounded/visibility.svg?raw";
import wand_stars from "@material-symbols/svg-400/rounded/wand_stars.svg?raw";
import warning from "@material-symbols/svg-400/rounded/warning.svg?raw";

// Google Material Symbols, rounded / weight 400 (Apache-2.0). Vite bundles only
// these SVGs, so the desktop app needs no font download or network access.
const SYMBOLS = {
  plus: add,
  search: search,
  settings: settings,
  sidebar: view_sidebar,
  panelRight: dock_to_right,
  chevronDown: keyboard_arrow_down,
  chevronRight: chevron_right,
  gitBranch: account_tree,
  diff: compare,
  terminal: terminal,
  globe: language,
  flow: schema,
  arrowUp: arrow_upward,
  arrowDown: arrow_downward,
  arrowRight: arrow_forward,
  stop: stop,
  folder: folder,
  folderPlus: create_new_folder,
  file: draft,
  fileCheck: task,
  pencil: edit,
  trash: deleteIcon,
  archive: archive,
  copy: content_copy,
  check: check,
  x: close,
  play: play_arrow,
  eye: visibility,
  sparkle: wand_stars,
  list: format_list_bulleted,
  dragHandle: drag_indicator,
  wrench: build,
  shield: shield,
  zap: bolt,
  clipboard: content_paste,
  more: more_horiz,
  refresh: refresh,
  external: open_in_new,
  at: alternate_email,
  help: help,
  download: download,
  message: chat_bubble,
  layers: layers,
  upload: upload,
  merge: merge,
  history: history,
  alert: warning,
  remove: remove,
  fit: fit_screen,
  commit: commit,
  code: code,
  data: data_object,
  document: description,
  image: image,
  audio: audio_file,
  video: video_file,
  table: table_chart,
  package: package_2,
  lock: lock,
  pdf: picture_as_pdf,
  html: html,
  css: css,
  javascript: javascript,
} as const;

export type IconName = keyof typeof SYMBOLS;

// Keep the shared SVG wrapper so existing sizing, color and animation styles
// apply consistently. The markup comes only from the pinned icon package.
const ICONS = Object.fromEntries(
  Object.entries(SYMBOLS).map(([name, svg]) => [name, svg.replace(/^<svg[^>]*>|<\/svg>$/g, "")]),
) as Record<IconName, string>;

export const Icon: Component<{
  name: IconName;
  size?: number;
  style?: JSX.CSSProperties;
  class?: string;
}> = (props) => (
  <svg
    class={props.class}
    width={props.size ?? 16}
    height={props.size ?? 16}
    viewBox="0 -960 960 960"
    fill="currentColor"
    aria-hidden="true"
    style={{ flex: "0 0 auto", ...props.style }}
    innerHTML={ICONS[props.name]}
  />
);
