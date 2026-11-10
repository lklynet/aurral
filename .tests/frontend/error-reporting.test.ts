import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

test("browser error reporting skips the harmless ResizeObserver loop notice", async (t: import("vite-plus/test").TestContext) => {
  vi.resetModules();
  t.onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  const listeners = new Map<string, (event: { error: unknown; message: string }) => void>();
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    location: { origin: "https://aurral.example.com", pathname: "/activity/queue" },
    addEventListener: (
      type: string,
      listener: (event: { error: unknown; message: string }) => void,
    ) => listeners.set(type, listener),
  });
  const reported: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
    reported.push(String(init?.body));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });

  const { startErrorReporting } = await import("../../frontend/src/utils/errorReporting.ts");
  startErrorReporting();
  const onError = listeners.get("error");
  onError?.({
    error: null,
    message: "ResizeObserver loop completed with undelivered notifications.",
  });
  onError?.({ error: new TypeError("queue is undefined"), message: "queue is undefined" });
  await vi.waitFor(() => assert.equal(reported.length, 1));

  assert.match(reported[0] ?? "", /"message":"queue is undefined"/);
});
