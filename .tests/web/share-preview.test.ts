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
