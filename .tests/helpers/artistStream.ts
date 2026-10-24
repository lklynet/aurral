import artistStream from "../../backend/routes/artists/handlers/stream.ts";

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

const parseEvent = (block: string) => {
  const [event, data] = block.split("\n");
  return { event: event.slice("event: ".length), data: JSON.parse(data.slice("data: ".length)) };
};

export function openArtistStream(mbid: string, query: Record<string, string> = {}) {
  const parsed: ReturnType<typeof parseEvent>[] = [];
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  const read = async () => {
    const response = await artistStream.request(
      `/artists/${mbid}/stream?${new URLSearchParams(query)}`,
      {
        signal: controller.signal,
      },
    );
    let buffer = "";
    for await (const text of response.body!.pipeThrough(new TextDecoderStream())) {
      buffer += text;
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        parsed.push(parseEvent(buffer.slice(0, end)));
        buffer = buffer.slice(end + 2);
        for (const notify of listeners) notify();
      }
    }
  };
  read().catch(() => {});
  const events = () => parsed;
  const waitFor = async (
    predicate: (event: ReturnType<typeof events>[number]) => boolean,
    { timeoutMs = 3000 } = {},
  ) => {
    const existing = events().find(predicate);
    if (existing) return existing;
    return new Promise<ReturnType<typeof events>[number]>((resolve, reject) => {
      const notify = () => {
        const match = events().find(predicate);
        if (!match) return;
        clearTimeout(timer);
        listeners.delete(notify);
        resolve(match);
      };
      const timer = setTimeout(() => {
        listeners.delete(notify);
        reject(new Error("stream event did not arrive"));
      }, timeoutMs);
      listeners.add(notify);
    });
  };
  return { events, waitFor, close: () => controller.abort() };
}
