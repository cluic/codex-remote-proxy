import { createRoot } from "react-dom/client";

import { App } from "./app";
import "./styles.css";

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("CRP UI root is missing.");

createRoot(root).render(<App />);
