import assert from "node:assert/strict";
import { afterAll, test, vi } from "vite-plus/test";
import { testClient } from "hono/testing";
import {
  cleanupIsolatedState,
  createMockHttpServer,
  setupIsolatedBackend,
} from "./helpers/backendTestHarness.ts";

const album = "70707070-7070-4070-8070-707070707070";
const artist = "71717171-7171-4171-8171-717171717171";
const recordings = ["72727272-7272-4272-8272-727272727201", "72727272-7272-4272-8272-727272727202"];
const songs = ["Low Light", "Quiet Hours"];
const provider = await createMockHttpServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  response.setHeader("content-type", "application/json");
  const quietBand = { id: artist, artistname: "Quiet Band" };
  const body =
    pathname === `/album/${album}`
      ? {
          id: album,
          title: "Night Songs",
          type: "Album",
          artistid: artist,
          artists: [quietBand],
          releases: [
            {
              id: `${album}-release`,
              status: "Official",
              tracks: songs.map((trackname, index) => ({
                id: `track-${index + 1}`,
                recordingid: recordings[index],
                trackname,
                trackposition: index + 1,
                mediumnumber: 1,
              })),
            },
          ],
        }
      : pathname === `/artist/${artist}`
        ? {
            ...quietBand,
            images: [],
            Albums: [],
            links: [{ type: "deezer", target: "https://www.deezer.com/artist/77" }],
          }
        : null;
  response.statusCode = body ? 200 : 404;
  response.end(JSON.stringify(body ?? {}));
});
process.env.BRAINZMASH_BASE_URL = provider.url;

const [state, { http }, { default: releaseGroupRoutes }] = await setupIsolatedBackend(
  "release-group-previews",
  () => import("../lib/http.ts"),
  () => import("../backend/routes/artists/handlers/releaseGroup.ts"),
);

afterAll(async () => {
  await cleanupIsolatedState(state);
  await provider.close();
  delete process.env.BRAINZMASH_BASE_URL;
});

test("album previews match Deezer by the album's own artist and title when the page sends none", async () => {
  const realGet = http.get.bind(http);
  const deezerPaths: string[] = [];
  vi.spyOn(http, "get").mockImplementation(async (url, options) => {
    if (String(url).startsWith(provider.url)) return realGet(url, options);
    const { pathname } = new URL(url);
    deezerPaths.push(pathname);
    const data =
      pathname === "/artist/77"
        ? { id: 77, name: "Quiet Band", picture_xl: null }
        : pathname === "/artist/77/albums"
          ? { data: [{ id: 9, title: "Night Songs", record_type: "album" }], total: 1 }
          : pathname === "/album/9/tracks"
            ? {
                data: songs.map((title, index) => ({
                  id: 900 + index,
                  title,
                  track_position: index + 1,
                  preview: `https://cdn.deezer.test/${900 + index}.mp3`,
                })),
                total: songs.length,
              }
            : {};
    return { status: 200, statusText: "OK", headers: {}, data };
  });

  const response = await testClient(releaseGroupRoutes).artists["release-group"][
    ":mbid"
  ].previews.$get({ param: { mbid: album }, query: {} });
  const body = await response.json();
  assert.ok("previews" in body);
  const { previews } = body;

  assert.deepEqual(Object.keys(previews).sort(), recordings);
  assert.deepEqual(
    recordings.map((id) => previews[id]?.previewTrackId),
    ["900", "901"],
  );
  assert.ok(deezerPaths.includes("/album/9/tracks"));
});
