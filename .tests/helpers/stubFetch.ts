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

export function stubMissingMusicbrainz(t: import("vite-plus/test").TestContext) {
  const fetchBefore = globalThis.fetch;
  stubFetch(t, (url, init) =>
    url.hostname === "musicbrainz.org" ? json({}, 404) : fetchBefore(url, init),
  );
}
