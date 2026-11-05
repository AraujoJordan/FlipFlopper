import { Component } from "solid-js";

export const BrandMark: Component<{ size?: number; badge?: boolean }> = (props) => {
  const size = () => props.size ?? 24;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size()}
      height={size()}
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ "flex-shrink": 0, display: "block" }}
    >
      {props.badge !== false && <rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="#11131A" stroke="#232838" stroke-width="1" />}
      <path fill="#6366F1" d="M7 6H21L19 10H10V12H18V15H10V24H6V7Q6 6 7 6Z" />
      <path fill="#FF5E7E" d="M25 26H11L13 22H22V20H14V17H22V8H26V25Q26 26 25 26Z" />
    </svg>
  );
};
