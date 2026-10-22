import assert from "node:assert/strict";

import { registerStream } from "../../backend/routes/artists/handlers/stream.ts";

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(new URL(String(url)), init);
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
}

export function openArtistStream(mbid, query = {}) {
  const routes = new Map();
  registerStream({
    get(path, ...handlers) {
      routes.set(path, handlers.at(-1));
    },
  });
  const writes = [];
  let closeStream = () => {};
  routes.get("/:mbid/stream")(
    {
      params: { mbid },
      query,
      headers: {},
      socket: { destroyed: false },
      on(event, handler) {
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
      write(value) {
        writes.push(value);
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
  const waitFor = async (predicate, { timeoutMs = 3000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = events().find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("stream event did not arrive");
  };
  return { events, waitFor, close: () => closeStream() };
}
