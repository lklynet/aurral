import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

const { onRequest: sharePage } = await import("../../web/functions/s/[[path]].js");
const { onRequestGet: previewLink } =
  await import("../../web/functions/api/deezer/preview/[id].js");

const TRACK_PAYLOAD = "AQMAU29uZwBBcnRpc3QAQWxidW0";

test("a shared track's preview resolves to Deezer's current link when played", async () => {
  let issued = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/track") {
      return Response.json({
        data: [
          {
            id: 7,
            title: "Song",
            artist: { name: "Artist" },
            album: { title: "Album" },
            preview: "https://cdnt-preview.dzcdn.net/7.mp3?hdnea=exp=1",
          },
        ],
      });
    }
    if (url.pathname === "/track/7") {
      issued += 1;
      return Response.json({ preview: `https://cdnt-preview.dzcdn.net/7.mp3?hdnea=exp=${issued}` });
    }
    throw new Error(`unexpected request to ${url}`);
  });

  const page = await sharePage({
    request: new Request(`https://aurral.org/s/${TRACK_PAYLOAD}`),
    params: { path: [TRACK_PAYLOAD] },
    env: {},
  });
  assert.match(await page.text(), /<audio[^>]+src="\/api\/deezer\/preview\/7"/);

  const played = await previewLink({ params: { id: "7" } });
  assert.equal(played.status, 302);
  assert.equal(played.headers.get("location"), "https://cdnt-preview.dzcdn.net/7.mp3?hdnea=exp=1");
});

test("a Deezer outage on a shared preview is a 502, not a missing track", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/track/8") return Response.json({ error: { code: 4 } });
    if (url.pathname === "/track/9") return Response.json({ error: { code: 800 } });
    throw new Error(`unexpected request to ${url}`);
  });

  assert.equal((await previewLink({ params: { id: "8" } })).status, 502);
  assert.equal((await previewLink({ params: { id: "9" } })).status, 404);
});

for (const kind of ["artist", "album"] as const) {
  test(`a shared ${kind} offers catalog previews without a tunnel or local files`, async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/search/${kind}`)
        return Response.json({
          data: [
            kind === "artist"
              ? { id: 7, name: "Artist" }
              : { id: 7, title: "Album", artist: { name: "Artist" } },
          ],
        });
      if (url.pathname === "/artist/7/top" || url.pathname === "/album/7/tracks")
        return Response.json({
          data: [
            {
              id: 42,
              title: "Song <test>",
              artist: { name: "Artist" },
              preview: "https://preview.example.com/42.mp3",
            },
          ],
        });
      throw new Error(`unexpected request to ${url}`);
    });
    const payload = kind === "artist" ? "AQEAQXJ0aXN0" : "AQIAQWxidW0AQXJ0aXN0";
    assert.ok(payload);
    const response = await sharePage({
      request: new Request(`https://aurral.org/s/${payload}`),
      params: { path: [payload] },
      env: {},
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('data-src="/api/deezer/preview/42"'));
    assert.ok(html.includes("Song &lt;test&gt;"));
    assert.ok(!html.includes("/stream"));
  });
}
