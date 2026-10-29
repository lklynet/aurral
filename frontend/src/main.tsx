import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "@fontsource-variable/inter/opsz.css";
import "./index.css";
import { initializeTheme } from "./utils/theme.ts";

initializeTheme();

if (!window.location.pathname.endsWith("/oauth.html")) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
