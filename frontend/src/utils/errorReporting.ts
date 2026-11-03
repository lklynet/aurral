import { logsClient } from "./api/clients/logs.ts";

type Source = "error" | "rejection" | "react";

const MAX_REPORTS = 20;
const reported = new Set<string>();

export function reportClientError(source: Source, problem: unknown, componentStack?: string) {
  const error = problem instanceof Error ? problem : new Error(String(problem ?? "Unknown error"));
  if (error.name === "AbortError") return;
  const key = `${error.name}:${error.message}`;
  if (reported.size >= MAX_REPORTS || reported.has(key)) return;
  reported.add(key);
  const stack = [error.stack, componentStack].filter(Boolean).join("\n");
  void logsClient.client
    .$post({
      json: {
        source,
        name: error.name.slice(0, 200),
        message: error.message.slice(0, 2000),
        ...(stack ? { stack: stack.slice(0, 8000) } : {}),
        page: window.location.pathname.slice(0, 500),
      },
    })
    .catch(() => {});
}

export function startErrorReporting() {
  window.addEventListener("error", (event) =>
    reportClientError("error", event.error ?? event.message),
  );
  window.addEventListener("unhandledrejection", (event) =>
    reportClientError("rejection", event.reason),
  );
}
