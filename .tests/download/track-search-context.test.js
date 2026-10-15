import test from "node:test";
import assert from "node:assert/strict";
import axios from "../../lib/axiosFetch.js";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
} from "../helpers/backendTestHarness.js";
import { clearMetadataProviderCaches } from "../../backend/services/providers/brainzmashProvider.js";
import { clearReleaseManifests } from "../../backend/services/releaseResolver.js";
import { pickResolvedDurationMs } from "../../backend/services/providers/brainzmashRanking.js";
import { toNormalizedTrack } from "../../backend/services/providers/brainzmashMappers.js";

const [isolatedState, { dbOps }, { resolveTrackSearchContext }] =
  await setupIsolatedBackend(
    "track-search-context",
    "backend/db/helpers/index.js",
    "backend/services/downloadJobs/trackSearchContext.js",
  );

test.after(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("BrainzMash release-track IDs are not treated as recording IDs, and merged recording IDs are kept", () => {
  assert.deepEqual(
    toNormalizedTrack({ id: "release-track-id", trackname: "Song", oldrecordingids: ["merged-recording-id"] }),
    {
      id: "release-track-id",
      recordingId: "",
      title: "Song",
      trackNumber: null,
      trackPosition: null,
      mediumNumber: null,
      durationMs: null,
      artistId: null,
      oldRecordingIds: ["merged-recording-id"],
    },
  );
});

test("pickResolvedDurationMs takes a Last.fm length only when no other is known", () => {
  assert.equal(
    pickResolvedDurationMs({ playlistDurationMs: 282973, lastfmDurationMs: 207000 }),
    282973,
  );
  assert.equal(pickResolvedDurationMs({ lastfmDurationMs: 207000 }), 207000);
  assert.equal(
    pickResolvedDurationMs({ lastfmDurationMs: null, matchedTrackDurationMs: 207000 }),
    207000,
  );
});

test("pickResolvedDurationMs replaces a stale playlist duration with the matched release duration", () => {
  assert.equal(
    pickResolvedDurationMs({
      playlistDurationMs: 524773,
      albumName: "Jet Set Radio Future SEGA Original Tracks",
      matchedTrackDurationMs: 222813,
    }),
    222813,
  );
});

test("resolveTrackSearchContext replaces a stale album MBID before resolving duration", async (t) => {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: {
        ...originalSettings.integrations.metadata,
        baseUrl: "https://brainzmash.example.test",
        enableNarrowFallbacks: false,
      },
    },
  });
  clearMetadataProviderCaches();
  t.after(() => {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
  });

  t.mock.method(axios, "get", async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/search/album") {
      return {
        data: options?.params?.artist
          ? [
              {
                id: "wrong-album",
                title: "Jet Set Radio",
                artistid: "wrong-artist",
                artists: [{ id: "wrong-artist", artistname: "Vulgar Unicorn" }],
              },
            ]
          : [
              {
                id: "correct-album",
                title: "Jet Set Radio Future Original Sound Tracks",
                artistid: "correct-artist",
                artists: [{ id: "correct-artist", artistname: "長沼英樹" }],
                releasedate: "2002-03-20",
              },
            ],
      };
    }
    if (path === "/album/wrong-album") {
      return {
        data: {
          id: "wrong-album",
          title: "Jet Set Radio",
          artistid: "wrong-artist",
          artists: [{ id: "wrong-artist", artistname: "Vulgar Unicorn" }],
          releases: [
            {
              id: "wrong-release",
              status: "Official",
              tracks: [
                {
                  trackname: "I Saw the Messenger of the New God There",
                  trackposition: 4,
                  durationms: 524773,
                  recordingid: "wrong-track",
                },
              ],
            },
          ],
        },
      };
    }
    if (path === "/album/correct-album") {
      return {
        data: {
          id: "correct-album",
          title: "Jet Set Radio Future Original Sound Tracks",
          artistid: "correct-artist",
          artists: [{ id: "correct-artist", artistname: "長沼英樹", artistaliases: ["Hideki Naganuma"] }],
          releasedate: "2002-03-20",
          releases: [
            {
              id: "correct-release",
              status: "Official",
              releasedate: "2002-03-20",
              tracks: [
                {
                  trackname: "The Concept of Love",
                  trackposition: 1,
                  durationms: 222813,
                  recordingid: "correct-track",
                },
              ],
            },
          ],
        },
      };
    }
    return { data: {} };
  });

  const resolved = await resolveTrackSearchContext({
    artistName: "Hideki Naganuma",
    trackName: "The Concept of Love",
    albumName: "Jet Set Radio Future SEGA Original Tracks",
    artistMbid: "wrong-artist",
    albumMbid: "wrong-album",
    durationMs: 524773,
    trackNumber: 4,
  });

  assert.equal(resolved.albumMbid, "correct-album");
  assert.equal(resolved.artistMbid, "correct-artist");
  assert.equal(resolved.durationMs, 222813);
  assert.equal(resolved.trackNumber, 1);
  assert.deepEqual(resolved.albumTrackTitles, ["The Concept of Love"]);
});

test("resolveTrackSearchContext preserves a recording from a non-representative edition", async (t) => {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: { ...originalSettings.integrations.metadata, baseUrl: "https://brainzmash.example.test" },
    },
  });
  clearMetadataProviderCaches();
  t.after(() => {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
  });
  const get = t.mock.method(axios, "get", async (url) => {
    assert.equal(new URL(url).pathname, "/album/b1392450-e666-3926-a536-22c65f834433");
    return { data: {
      id: "b1392450-e666-3926-a536-22c65f834433",
      title: "OK Computer",
      artistid: "earlier-alias-artist",
      artists: [
        { id: "earlier-alias-artist", artistname: "Different Artist", artistaliases: ["Radiohead"] },
        { id: "a74b1b7f-71a5-4011-9441-d0b5e4122711", artistname: "Radiohead" },
      ],
      releases: [
        { id: "ok-computer-representative", status: "Official", tracks: [
          {
            id: "airbag-representative-track",
            recordingid: "airbag-representative-recording",
            trackname: "Airbag",
            trackposition: 1,
            durationms: 287000,
          },
          {
            id: "paranoid-representative-track",
            recordingid: "paranoid-representative-recording",
            trackname: "Paranoid Android",
            trackposition: 2,
            durationms: 382000,
          },
        ] },
        { id: "ok-computer-remaster", status: "Official", tracks: [
          {
            id: "airbag-remaster-track",
            recordingid: "airbag-remaster-recording",
            trackname: "Airbag",
            trackposition: 1,
            durationms: 288000,
          },
          {
            id: "release-track-from-musicbrainz",
            recordingid: "recording-from-musicbrainz",
            trackname: "Paranoid Android",
            trackposition: 2,
            durationms: 383000,
          },
        ] },
      ],
    } };
  });
  const job = {
    artistName: "Radiohead",
    trackName: "Paranoid Android",
    albumName: "OK Computer",
    artistMbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    albumMbid: "b1392450-e666-3926-a536-22c65f834433",
    trackMbid: "recording-from-musicbrainz",
    durationMs: 383000,
    trackNumber: 2,
    albumTrackTitles: ["Airbag", "Paranoid Android"],
    artistAliases: ["Radio Head"],
  };
  const resolved = await resolveTrackSearchContext(job);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(resolved.artistMbid, job.artistMbid);
  assert.equal(resolved.trackMbid, job.trackMbid);
  assert.equal(resolved.trackNumber, 2);
  assert.deepEqual(resolved.albumTrackTitles, job.albumTrackTitles);
});

test("resolveTrackSearchContext learns a track's disc and keeps a known disc for a recording on two discs", async (t) => {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: { ...originalSettings.integrations.metadata, baseUrl: "https://brainzmash.example.test" },
    },
  });
  clearMetadataProviderCaches();
  t.after(() => {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
  });
  const track = (mediumnumber, trackposition, trackname, recordingid) =>
    ({ id: `${recordingid}-${mediumnumber}`, recordingid, trackname, trackposition, mediumnumber, durationms: 200000 });
  t.mock.method(axios, "get", async () => ({ data: {
    id: "sixteen-stone",
    title: "Sixteen Stone",
    artistid: "bush",
    artists: [{ id: "bush", artistname: "Bush" }],
    releases: [{ id: "deluxe", status: "Official", tracks: [
      track(1, 1, "Swim", "swim"),
      track(1, 3, "Bomb", "bomb"),
      track(2, 1, "Swim", "swim-demo"),
      track(2, 3, "Bomb", "bomb"),
    ] }],
  } }));
  const resolve = (trackMbid, trackNumber, discNumber) => resolveTrackSearchContext({
    artistName: "Bush", trackName: trackNumber === 1 ? "Swim" : "Bomb", albumName: "Sixteen Stone",
    artistMbid: "bush", albumMbid: "sixteen-stone", trackMbid, durationMs: 200000, trackNumber, discNumber,
    albumTrackTitles: ["Swim", "Bomb", "Swim", "Bomb"], artistAliases: ["Bush"],
  });

  const positions = await Promise.all([
    resolve("swim-demo", 1, null),
    resolve("bomb", 3, null),
    resolve("bomb", 3, 2),
  ]);
  assert.deepEqual(positions.map(({ discNumber, trackNumber }) => [discNumber, trackNumber]), [[2, 1], [1, 3], [2, 3]]);
});

test("resolveTrackSearchContext repairs a stored Last.fm release-track ID", async (t) => {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: { ...originalSettings.integrations.metadata, baseUrl: "https://brainzmash.example.test" },
    },
  });
  clearMetadataProviderCaches();
  t.after(() => {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
  });
  t.mock.method(axios, "get", async (url) => {
    assert.equal(new URL(url).pathname, "/album/legacy-album");
    return { data: {
      id: "legacy-album",
      title: "ROCKISDEAD",
      artistid: "legacy-artist",
      artists: [{ id: "legacy-artist", artistname: "Dorothy" }],
      releases: [{ id: "legacy-release", status: "Official", tracks: [{
        id: "be758dcb-9166-4c33-87ff-30ba2d32e501",
        recordingid: "befc26a0-5403-4d73-b0f8-3f6a6fb0c292",
        trackname: "What's Coming To Me",
        trackposition: 1,
        durationms: 203000,
      }] }],
    } };
  });

  const resolved = await resolveTrackSearchContext({
    artistName: "Dorothy",
    trackName: "What's Coming To Me",
    albumName: "ROCKISDEAD",
    artistMbid: "legacy-artist",
    albumMbid: "legacy-album",
    trackMbid: "be758dcb-9166-4c33-87ff-30ba2d32e501",
    durationMs: 203000,
    trackNumber: 1,
    albumTrackCount: 1,
    albumTrackTitles: ["What's Coming To Me"],
    artistAliases: ["Dorothy"],
  });

  assert.equal(resolved.trackMbid, "befc26a0-5403-4d73-b0f8-3f6a6fb0c292");
});

test("resolveTrackSearchContext drops an unverified stored recording ID", async (t) => {
  clearMetadataProviderCaches();
  t.after(() => clearMetadataProviderCaches());
  t.mock.method(axios, "get", async () => {
    const error = new Error("metadata unavailable");
    error.response = { status: 503 };
    throw error;
  });

  const resolved = await resolveTrackSearchContext({
    artistName: "Legacy Artist",
    trackName: "Legacy Song",
    albumName: "Legacy Album",
    artistMbid: "legacy-artist-unavailable",
    albumMbid: "legacy-album-unavailable",
    trackMbid: "unverified-track-id",
    durationMs: 180000,
    trackNumber: 1,
    albumTrackCount: 1,
    albumTrackTitles: ["Legacy Song"],
    artistAliases: ["Legacy Artist"],
  });

  assert.equal(resolved.trackMbid, null);
});

test("resolveTrackSearchContext takes neither a recording ID nor a length from Last.fm", async (t) => {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      lastfm: { apiKey: "lastfm-key" },
      metadata: { ...originalSettings.integrations.metadata, baseUrl: "https://brainzmash.example.test" },
    },
  });
  clearMetadataProviderCaches();
  t.after(() => {
    clearMetadataProviderCaches();
    dbOps.updateSettings(originalSettings);
  });
  t.mock.method(axios, "get", async (url, options) => {
    if (options?.params?.method === "track.getInfo") {
      return { data: { track: { mbid: "stale-lastfm-recording", duration: "233000",
        artist: { name: "Lastfm Artist" }, album: { title: "Lastfm Album" } } } };
    }
    if (new URL(url).pathname === "/album/lastfm-album") {
      return { data: { id: "lastfm-album", title: "Lastfm Album", artistid: "artist-known",
        artists: [{ id: "artist-known", artistname: "Lastfm Artist" }],
        releases: [{ id: "lastfm-release", status: "Official", tracks: [
          { trackname: "Lastfm Song", trackposition: 8, durationms: 369626, recordingid: "release-recording" },
        ] }] } };
    }
    return { data: {} };
  });
  const request = { artistName: "Lastfm Artist", trackName: "Lastfm Song", artistMbid: "artist-known" };
  assert.equal((await resolveTrackSearchContext(request)).trackMbid, null);
  const fromRelease = await resolveTrackSearchContext({ ...request, albumName: "Lastfm Album",
    albumMbid: "lastfm-album", durationMs: 369626 });
  assert.equal(fromRelease.durationMs, 369626);
});

function stubMetadata(t, respond) {
  const originalSettings = dbOps.getSettings();
  dbOps.updateSettings({
    ...originalSettings,
    integrations: {
      ...originalSettings.integrations,
      metadata: { ...originalSettings.integrations.metadata, baseUrl: "https://brainzmash.example.test", enableNarrowFallbacks: false },
    },
  });
  clearMetadataProviderCaches();
  clearReleaseManifests();
  t.after(() => {
    clearMetadataProviderCaches();
    clearReleaseManifests();
    dbOps.updateSettings(originalSettings);
  });
  t.mock.method(axios, "get", async (url, options) => ({ data: respond(new URL(url).pathname, options?.params || {}) ?? {} }));
}

const artistEntry = (id, name, extra = {}) => ({ id, artistname: name, type: "Group", ...extra });
const albumEntry = (id, title, artist, tracks = null) => ({
  id,
  title,
  type: "Album",
  artistid: artist.id,
  artists: [artist],
  ...(tracks ? { releases: [{ id: `${id}-release`, status: "Official", tracks: tracks.map((name, index) => ({
    trackname: name, trackposition: index + 1, mediumnumber: 1, durationms: 200000, recordingid: `${id}-${index + 1}`,
  })) }] } : {}),
});

test("a download credited to an artist and a guest takes the lead artist, and not another artist's album of the same title", async (t) => {
  const lead = artistEntry("dance-gavin-dance", "Dance Gavin Dance");
  const namesake = artistEntry("andrew-dance", "Andrew Dance", { disambiguation: "techno artist" });
  const other = artistEntry("other-band", "Other Band");
  stubMetadata(t, (path, params) => {
    if (path === "/search/artist") {
      return params.query === "Dance Gavin Dance" ? [lead] : [lead, namesake];
    }
    if (path === "/search/album") return params.artist ? [] : [albumEntry("other-afterburner", "Afterburner", other)];
    if (path === "/album/other-afterburner") return albumEntry("other-afterburner", "Afterburner", other, ["Afterburner"]);
    return null;
  });

  const resolved = await resolveTrackSearchContext({
    artistName: "Dance Gavin Dance feat. Andrew Wells",
    trackName: "Afterburner",
    albumName: "Afterburner",
  });

  assert.equal(resolved.artistMbid, "dance-gavin-dance");
  assert.equal(resolved.albumMbid, null);
  assert.equal(resolved.trackMbid, null);

  for (const complete of [false, true]) {
    const existing = await resolveTrackSearchContext({
      artistName: "Dance Gavin Dance feat. Andrew Wells",
      artistMbid: "dance-gavin-dance",
      artistAliases: ["Dance Gavin Dance"],
      trackName: "Afterburner",
      albumName: "Afterburner",
      albumMbid: "other-afterburner",
      ...(complete ? {
        trackMbid: "other-afterburner-1",
        durationMs: 200000,
        trackNumber: 1,
        albumTrackTitles: ["Afterburner"],
      } : {}),
    });
    assert.equal(existing.artistMbid, "dance-gavin-dance");
    assert.equal(existing.albumMbid, null);
    assert.equal(existing.trackMbid, null);
    assert.equal(existing.trackNumber, null);
    assert.deepEqual(existing.albumTrackTitles, []);
  }
});

test("a download credited with \"&\" takes the artist MusicBrainz names with \"and\"", async (t) => {
  const band = artistEntry("belle-and-sebastian", "Belle and Sebastian");
  const namesake = artistEntry("sebastian", "Sebastian", { disambiguation: "French producer" });
  stubMetadata(t, (path) => (path === "/search/artist" ? [namesake, band] : null));

  const resolved = await resolveTrackSearchContext({ artistName: "Belle & Sebastian", trackName: "The Boy with the Arab Strap" });

  assert.equal(resolved.artistMbid, "belle-and-sebastian");
});

test("a download takes the album of its title that lists the song, over the album the job named or the artist's first album of that title", async (t) => {
  const weezer = artistEntry("weezer", "Weezer");
  const albums = {
    blue: albumEntry("blue", "Weezer", weezer, ["My Name Is Jonas", "Buddy Holly"]),
    teal: albumEntry("teal", "Weezer", weezer, ["Africa", "Everybody Wants to Rule the World"]),
    records: albumEntry("records", "Records", weezer),
  };
  const deluxe = albumEntry("teal-deluxe", "Weezer", weezer, ["Africa", "Everybody Wants to Rule the World", "Billie Jean"]);
  albums.teal.releases.push({ ...albums.teal.releases[0], id: "teal-vinyl" }, deluxe.releases[0]);
  stubMetadata(t, (path, params) => {
    if (path === "/search/album") {
      return Object.values(albums).filter((album) => album.title === params.query).map(({ releases, ...album }) => album);
    }
    if (path === "/artist/weezer") {
      return { ...weezer, Albums: [{ Id: "blue", Title: "Weezer", Type: "Album" }, { Id: "teal", Title: "Weezer", Type: "Album" }] };
    }
    return albums[path.replace("/album/", "")] || null;
  });

  const resolved = await resolveTrackSearchContext({
    artistName: "Weezer",
    artistMbid: "weezer",
    trackName: "Africa",
    albumName: "Weezer",
    albumMbid: "blue",
  });
  assert.equal(resolved.albumMbid, "teal");
  assert.equal(resolved.trackMbid, "teal-1");
  assert.equal(resolved.trackNumber, 1);

  const complete = await resolveTrackSearchContext({
    artistName: "Weezer",
    artistMbid: "weezer",
    artistAliases: ["Weezer"],
    trackName: "Africa",
    albumName: "Weezer",
    albumMbid: "blue",
    releaseMbid: "blue-release",
    trackMbid: "blue-1",
    durationMs: 200000,
    trackNumber: 1,
    albumTrackTitles: ["Africa"],
  });
  assert.equal(complete.albumMbid, "teal");
  assert.equal(complete.releaseMbid, "teal-release");

  const unplaced = await resolveTrackSearchContext({ ...complete, albumName: "Records", albumMbid: null,
    trackName: "Records", trackMbid: null });
  assert.equal(unplaced.albumMbid, "records");
  assert.equal(unplaced.releaseMbid, null);
  const dropped = await resolveTrackSearchContext({ ...complete, artistMbid: "weezer", albumName: null, albumMbid: null,
    trackMbid: null, albumTrackTitles: [] });
  assert.equal(dropped.albumMbid, null);
  assert.equal(dropped.releaseMbid, null);
  assert.equal(complete.trackMbid, "teal-1");
  assert.deepEqual(complete.albumTrackTitles, ["Africa", "Everybody Wants to Rule the World"]);

  const unsearched = await resolveTrackSearchContext({
    artistName: "Weezer",
    artistMbid: "weezer",
    trackName: "Everybody Wants to Rule the World",
    albumName: "Weezer (Teal Album)",
  });
  assert.equal(unsearched.albumMbid, "teal");

  const bonus = await resolveTrackSearchContext({ artistName: "Weezer", artistMbid: "weezer", trackName: "Billie Jean", albumName: "Weezer" });
  assert.equal(bonus.albumMbid, "teal");
  assert.equal(bonus.trackMbid, "teal-deluxe-3");
  assert.equal(bonus.trackNumber, 3);

  const single = await resolveTrackSearchContext({ artistName: "Weezer", trackName: "Records", albumName: "Records" });
  assert.equal(single.albumMbid, "records");
});

const editionAlbum = () => {
  const band = artistEntry("edition-band", "Edition Band");
  const song = (trackname, recordingid, trackposition, durationms, extra = {}) =>
    ({ id: `${recordingid}-${trackposition}`, trackname, recordingid, trackposition, mediumnumber: 1, durationms, ...extra });
  return {
    id: "edition-album", title: "Edition Album", type: "Album", artistid: band.id, artists: [band],
    releases: [
      { id: "edition-standard", status: "Official", tracks: [song("Opener", "opener", 1, 200000, { oldrecordingids: ["opener-merged"] }),
        song("Middle", "middle", 2, 210000)] },
      { id: "edition-reissue", status: "Official", tracks: [song("Opener", "opener", 1, 200000), song("Middle", "middle", 2, 210000)] },
      { id: "edition-deluxe", status: "Official", tracks: [song("Bonus Intro", "intro", 1, 60000), song("Opener", "opener", 2, 201000),
        song("Middle", "middle", 3, 211000), song("Middle (Acoustic)", "middle-acoustic", 4, 190000)] },
    ],
  };
};

test("a track's tracklist, place, and length all come from the edition its release ID pins, and a pin without the track stays", async (t) => {
  const album = editionAlbum();
  stubMetadata(t, (path) => (path === "/album/edition-album" ? album : null));
  const resolved = await resolveTrackSearchContext({
    artistName: "Edition Band", artistMbid: "edition-band", artistAliases: ["Edition Band"], trackName: "Middle",
    albumName: "Edition Album", albumMbid: "edition-album", releaseMbid: "edition-deluxe", trackMbid: "middle",
    durationMs: 210000, trackNumber: 2, albumTrackTitles: ["Opener", "Middle"],
  });
  assert.equal(resolved.releaseMbid, "edition-deluxe");
  assert.deepEqual(resolved.albumTrackTitles, ["Bonus Intro", "Opener", "Middle", "Middle (Acoustic)"]);
  assert.equal(resolved.albumTrackCount, 4);
  assert.equal(resolved.trackNumber, 3);
  assert.equal(resolved.durationMs, 211000);

  for (const releaseMbid of ["edition-standard", "EDITION-STANDARD"]) {
    const unplaced = await resolveTrackSearchContext({
      artistName: "Edition Band", artistMbid: "edition-band", trackName: "Middle (Acoustic)",
      albumName: "Edition Album", albumMbid: "edition-album", releaseMbid,
    });
    assert.equal(unplaced.releaseMbid, releaseMbid);
  }
});

test("a track that names only its release and album title is searched on that release", async (t) => {
  const album = editionAlbum();
  stubMetadata(t, (path) => {
    if (path === "/search/album") return [{ id: album.id, title: album.title, type: "Album", artistid: album.artistid, artists: album.artists }];
    return path === "/album/edition-album" ? album : null;
  });
  const resolved = await resolveTrackSearchContext({
    artistName: "Edition Band", trackName: "Middle", albumName: "Edition Album", releaseMbid: "edition-deluxe",
  });
  assert.equal(resolved.albumMbid, "edition-album");
  assert.equal(resolved.releaseMbid, "edition-deluxe");
  assert.equal(resolved.trackNumber, 3);
  assert.equal(resolved.durationMs, 211000);
});

test("an album ID the metadata provider does not know is replaced by the album its title names", async (t) => {
  const album = editionAlbum();
  stubMetadata(t, (path) => {
    if (path === "/search/album") return [{ id: album.id, title: album.title, type: "Album", artistid: album.artistid, artists: album.artists }];
    if (path === "/album/edition-deluxe") throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
    return path === "/album/edition-album" ? album : null;
  });
  const resolved = await resolveTrackSearchContext({
    artistName: "Edition Band", trackName: "Middle", albumName: "Edition Album", albumMbid: "edition-deluxe",
  });
  assert.equal(resolved.albumMbid, "edition-album");
  assert.equal(resolved.trackNumber, 2);
});

test("an album ID is kept while the metadata provider is down, and its release is read once it is back", async (t) => {
  const album = { ...editionAlbum(), id: "outage-album" };
  let down = true;
  stubMetadata(t, (path) => {
    if (down && path.startsWith("/album/")) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return path === "/album/outage-album" ? album : null;
  });
  const track = {
    artistName: "Edition Band", artistMbid: "edition-band", artistAliases: ["Edition Band"], trackName: "Middle",
    albumName: "Edition Album", albumMbid: "outage-album", releaseMbid: "edition-deluxe", trackMbid: "middle",
    durationMs: 211000, trackNumber: 3, albumTrackTitles: ["Bonus Intro", "Opener", "Middle", "Middle (Acoustic)"],
  };
  const during = await resolveTrackSearchContext(track);
  assert.equal(during.albumMbid, "outage-album");
  assert.equal(during.releaseMbid, "edition-deluxe");

  down = false;
  clearReleaseManifests();
  const after = await resolveTrackSearchContext(track);
  assert.equal(after.releaseMbid, "edition-deluxe");
  assert.equal(after.trackMbid, "middle");
});

test("a merged recording ID is repaired to the current recording and kept as its alias", async (t) => {
  const album = editionAlbum();
  stubMetadata(t, (path) => (path === "/album/edition-album" ? album : null));
  const resolved = await resolveTrackSearchContext({
    artistName: "Edition Band", artistMbid: "edition-band", artistAliases: ["Edition Band"], trackName: "Opener",
    albumName: "Edition Album", albumMbid: "edition-album", trackMbid: "opener-merged",
    durationMs: 200000, trackNumber: 1, albumTrackTitles: ["Opener", "Middle"],
  });
  assert.equal(resolved.trackMbid, "opener");
  assert.deepEqual(resolved.recordingMbidAliases, ["opener-merged"]);
  assert.equal(resolved.releaseMbid, "edition-standard");

  album.releases.push({ id: "edition-single", status: "Official", tracks: [
    { id: "middle-single", trackname: "Middle", recordingid: "middle", trackposition: 1, mediumnumber: 1, durationms: 210000 }] });
  const unplaced = await resolveTrackSearchContext({
    artistName: "Edition Band", artistMbid: "edition-band", artistAliases: ["Edition Band"], trackName: "Opener",
    albumName: "Edition Album", albumMbid: "edition-album", releaseMbid: "edition-single", trackMbid: "opener-merged",
    durationMs: 200000, trackNumber: 1, albumTrackTitles: ["Middle"],
  });
  assert.equal(unplaced.trackMbid, "opener");
  assert.deepEqual(unplaced.recordingMbidAliases, ["opener-merged"]);
});

test("a song's other version never stands in for it on the album", async (t) => {
  const album = editionAlbum();
  stubMetadata(t, (path) => (path === "/album/edition-album" ? album : null));
  const resolved = await resolveTrackSearchContext({
    artistName: "Edition Band", artistMbid: "edition-band", artistAliases: ["Edition Band"], trackName: "Middle (Acoustic)",
    albumName: "Edition Album", albumMbid: "edition-album",
  });
  assert.equal(resolved.trackMbid, "middle-acoustic");
  assert.equal(resolved.trackNumber, 4);
  assert.equal(resolved.releaseMbid, "edition-deluxe");
});
