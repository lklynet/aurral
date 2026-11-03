import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "@fontsource-variable/inter/opsz.css";
import "./index.css";
import { reportClientError, startErrorReporting } from "./utils/errorReporting.ts";
import { initializeTheme } from "./utils/theme.ts";

initializeTheme();

if (!window.location.pathname.endsWith("/oauth.html")) {
  startErrorReporting();
  ReactDOM.createRoot(document.getElementById("root")!, {
    onCaughtError: (error, { componentStack }) => {
      console.error(error);
      reportClientError("react", error, componentStack);
    },
  }).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
