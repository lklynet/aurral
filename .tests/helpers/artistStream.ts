import { createRouteHarness } from "../library/routeHarness.ts";
import { registerStream } from "../../backend/routes/artists/handlers/stream.ts";

const wallClockSetTimeout = globalThis.setTimeout;
const wallClockClearTimeout = globalThis.clearTimeout;

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

export function openArtistStream(mbid: string, query: Record<string, string> = {}) {
  const routes = createRouteHarness(registerStream);
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  let closeStream = () => {};
  void routes.get("GET /:mbid/stream")(
    {
      params: { mbid },
      query,
      headers: {},
      socket: { destroyed: false },
      on(event: string, handler: () => void) {
        if (event === "close") closeStream = handler;
      },
    },
    {
      setHeader() {},
      status() {
        return this;
      },
      json() {
        return this;
      },
      write(value: string) {
        writes.push(value);
        for (const notify of listeners) notify();
      },
      flush() {},
      end() {},
    },
  );
  const events = () => {
    const parsed = [];
    for (let index = 0; index + 1 < writes.length; index += 2) {
      parsed.push({
        event: writes[index].slice("event: ".length).trim(),
        data: JSON.parse(writes[index + 1].slice("data: ".length)),
      });
    }
    return parsed;
  };
  const waitFor = async (
    predicate: (event: ReturnType<typeof events>[number]) => boolean,
    { timeoutMs = 3000 } = {},
  ) => {
    const existing = events().find(predicate);
    if (existing) return existing;
    return new Promise<ReturnType<typeof events>[number]>((resolve, reject) => {
      let timer: ReturnType<typeof wallClockSetTimeout>;
      const notify = () => {
        const match = events().find(predicate);
        if (!match) return;
        wallClockClearTimeout(timer);
        listeners.delete(notify);
        resolve(match);
      };
      timer = wallClockSetTimeout(() => {
        listeners.delete(notify);
        reject(new Error("stream event did not arrive"));
      }, timeoutMs);
      listeners.add(notify);
    });
  };
  return { events, waitFor, close: () => closeStream() };
}
