import React from "react";
import ReactDOM from "react-dom/client";
import { BreakoutApp } from "./components/BreakoutApp";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BreakoutApp />
  </React.StrictMode>,
);
