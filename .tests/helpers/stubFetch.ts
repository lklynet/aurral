export const json = (body: unknown, status: number = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function stubFetch(
  t: import("vite-plus/test").TestContext,
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(new URL(String(url)), init);
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
}
