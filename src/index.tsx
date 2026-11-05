/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { mark } from "./lib/perf";

mark("js:module");
render(() => <App />, document.getElementById("root") as HTMLElement);
mark("js:rendered");
