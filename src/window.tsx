import React from "react";
import ReactDOM from "react-dom/client";
import { WindowApp } from "./components/WindowApp";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowApp />
  </React.StrictMode>,
);
