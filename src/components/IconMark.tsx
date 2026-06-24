import { Component, Show } from "solid-js";

interface IconMarkProps {
  icon: string;
  alt: string;
  class?: string;
}

const IconMark: Component<IconMarkProps> = (props) => {
  const isImage = () =>
    props.icon.startsWith("/") ||
    props.icon.startsWith("./") ||
    props.icon.startsWith("http://") ||
    props.icon.startsWith("https://");

  return (
    <Show
      when={isImage()}
      fallback={<span class={props.class}>{props.icon}</span>}
    >
      <img class={props.class} src={props.icon} alt={props.alt} />
    </Show>
  );
};

export default IconMark;
