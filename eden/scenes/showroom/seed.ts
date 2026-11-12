import * as v from "valibot";
import { AurralApi } from "../../aurral.ts";
import { linkListening } from "../../seed.ts";
import { until } from "../../services/service.ts";
import { LISTENER, LOGIN, type Ports } from "../../state.ts";

export const DISCOVERY_TIMEOUT_MS = 5 * 60 * 1000;
const NOW_PLAYING = "Streetcar";
const NOW_PLAYING_AT_MS = 83_000;

export const discoveryStatus = v.looseObject({
  isUpdating: v.boolean(),
  lastUpdated: v.nullable(v.string()),
});
const createdFlow = v.looseObject({ flow: v.looseObject({ id: v.string() }) });
// A new flow's cover is drawn at random, so the showroom pins the one its template shows.
const FLOW_COVER = { style: "simple", artistKey: null, template: "b4" };
const inbox = v.looseObject({ refreshing: v.boolean() });
const libraryTracks = v.looseObject({
  tracks: v.array(v.looseObject({ streamPath: v.string() })),
});

// Both accounts have been asked for a star and have a track paused in the player.
async function settleIn(session: AurralApi) {
  await session.post("/star-prompt");
  const { tracks } = v.parse(libraryTracks, await session.get(`/search/library?q=${NOW_PLAYING}`));
  const [track] = tracks;
  if (!track) throw new Error(`${NOW_PLAYING} is not in the showroom Library`);
  await session.put("/play-queue", {
    streamPaths: [track.streamPath],
    current: 0,
    positionMs: NOW_PLAYING_AT_MS,
    device: "Eden showroom",
  });
}

// What the showroom adds to an Eden. The admin's listening accounts are linked and
// live news is off, since it would change every screenshot and put real headlines on
// the site. The listener keeps immersive mode off, for the plain Discover shot. Anything
// a screenshot shows is set up here, so taking one never changes the next.
export async function seedShowroom(api: AurralApi, ports: Ports) {
  await api.post("/settings", { integrations: { news: { enabled: false } } });
  await linkListening(ports, LOGIN);
  const { flow } = v.parse(
    createdFlow,
    await api.post("/playlists/flows", { templateId: "release-radar", name: "Release Radar" }),
  );
  await api.post(`/playlists/artwork/${flow.id}/generate`, { style: "simple", pick: FLOW_COVER });
  await settleIn(api);

  const listener = new AurralApi(ports);
  await listener.login(LISTENER);
  await listener.put("/users/me/theme", {
    theme: { version: 2, themeId: "aurral", appearance: "system", matchArtwork: false, themes: [] },
  });
  await settleIn(listener);

  for (const session of [api, listener]) {
    await until(
      "Discover to finish",
      async () => {
        const status = v.parse(discoveryStatus, await session.get("/discover/status"));
        return !status.isUpdating && status.lastUpdated !== null;
      },
      DISCOVERY_TIMEOUT_MS,
    );
  }
  await api.post("/inbox/refresh");
  await until(
    "the Inbox to fill",
    async () => !v.parse(inbox, await api.get("/inbox")).refreshing,
    DISCOVERY_TIMEOUT_MS,
  );
}
