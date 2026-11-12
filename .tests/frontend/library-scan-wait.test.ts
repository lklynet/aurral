import assert from "node:assert/strict";
import { onTestFinished, test } from "vite-plus/test";

const { waitForLibraryScan } = await import("../../frontend/src/pages/library/libraryShared.tsx");

test("a scan request waits for the scan that follows the one it joined", async () => {
  const originalFetch = globalThis.fetch;
  onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const serve = (responses: Record<string, unknown[]>) => {
    const requested: string[] = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://aurral");
      const key = url.pathname.replace(/^.*\/library/, "");
      requested.push(key);
      const body = requireValue(responses[key]?.shift(), key);
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    };
    return requested;
  };
  const requireValue = (value: unknown, key: string) => {
    assert.ok(value !== undefined, `Unexpected request ${key}`);
    return value;
  };
  const status = (jobId: number, state: string, error: string | null = null) => ({
    jobId,
    status: state,
    error,
  });

  const requested = serve({
    "/refresh/1": [status(1, "completed")],
    "/refresh": [
      { jobId: 2, status: status(2, "queued") },
      { jobId: null, status: null },
    ],
    "/refresh/2": [status(2, "completed")],
  });
  assert.equal(await waitForLibraryScan(1), true);
  assert.deepEqual(requested, ["/refresh/1", "/refresh", "/refresh/2", "/refresh"]);

  serve({
    "/refresh/1": [status(1, "completed")],
    "/refresh": [{ jobId: 2, status: status(2, "running") }],
    "/refresh/2": [status(2, "failed", "Disk unavailable")],
  });
  await assert.rejects(waitForLibraryScan(1), /Disk unavailable/);
});
