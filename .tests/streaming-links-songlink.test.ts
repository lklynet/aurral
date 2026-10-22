import { afterAll, expect, test } from "vite-plus/test";
import { resolveStreamingLink } from "../backend/services/streamingLinks.ts";

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const pageWithEntityType = (type: string) =>
  `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: { pageData: { entityData: { type, artistName: "Artist", title: "Title" } } },
    },
  })}</script>`;

test("a song.link page whose entity type is an object member name is unreadable", async () => {
  globalThis.fetch = async () =>
    new Response(pageWithEntityType("constructor"), {
      headers: { "content-type": "text/html" },
    });
  await expect(resolveStreamingLink("https://song.link/constructor-page")).rejects.toMatchObject({
    message: expect.stringContaining("unreadable"),
  });
});
