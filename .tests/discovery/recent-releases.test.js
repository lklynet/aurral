import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import axios from "../../lib/axiosFetch.js";
import { getHonkerDb, getHonkerQueueByName } from "../../backend/services/honkerDb.js";

import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.js";
import {
  refreshReleaseMetadata,
  scheduleReleaseMetadataRefresh,
} from "../../backend/services/releaseMetadataSync.js";
import {
  markUnseenReleaseCalendarEntries,
  upsertReleaseCalendarEntry,
} from "../../backend/services/releaseCalendarStore.js";
import { db } from "../../backend/config/db-sqlite.js";
import {
  getLibraryAlbumsByReleaseDate,
  getLibraryArtistProjection,
} from "../../backend/services/libraryQueryService.js";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.js";

function createCalendarArtist(name) {
  const mbid = randomUUID();
  const artist = upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name,
    metadata: { id: mbid, librarySource: "aurral" },
  });
  return { ...artist, mbid };
}

function addCalendarRelease(artistId, title, releaseDate) {
  const releaseGroupMbid = randomUUID();
  upsertReleaseCalendarEntry({
    releaseGroupMbid,
    artistId,
    title,
    releaseDate,
    releaseType: "Album",
    releaseStatuses: ["Official"],
  });
  return releaseGroupMbid;
}

const catalogueRelease = (id, title, type = "Album") => ({
  Id: id,
  Title: title,
  Type: type,
  SecondaryTypes: [],
  ReleaseStatuses: ["Official"],
});

function stubBrainzMash(t, { catalogues = {}, albumDates = {}, onArtist } = {}) {
  const albumRequests = [];
  let requests = 0;
  t.mock.method(axios, "get", async (url) => {
    requests += 1;
    const [, kind, mbid] = new URL(url).pathname.match(/^\/(artist|album)\/([^/]+)$/) || [];
    if (kind === "artist" && catalogues[mbid]) {
      onArtist?.();
      return { data: { id: mbid, artistname: "Calendar Artist", Albums: catalogues[mbid] } };
    }
    if (kind === "album") {
      albumRequests.push(mbid);
      if (mbid in albumDates) {
        return {
          data: { id: mbid, title: "Album", type: "Album", releasedate: albumDates[mbid], releases: [] },
        };
      }
    }
    throw Object.assign(new Error("Not found"), { response: { status: 404 } });
  });
  return { albumRequests, requestCount: () => requests };
}

function removeCalendarArtist(artistId) {
  db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?")
    .run(artistId);
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artistId);
}

test("recent missing releases can exclude future releases for Release Radar", async () => {
  const artist = createCalendarArtist("Release Radar Artist");
  addCalendarRelease(artist.id, "Released Album", "2026-06-11");
  addCalendarRelease(artist.id, "Future Album", "2026-08-20");

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [{ canonicalId: artist.id }],
      includeFuture: false,
      now: "2026-06-15T12:00:00Z",
    });

    assert.deepEqual(
      releases.map((album) => album.albumName),
      ["Released Album"],
    );
  } finally {
    removeCalendarArtist(artist.id);
  }
});

test("recent missing releases keep upcoming albums by default for the Discover rail", async () => {
  const artist = createCalendarArtist("Upcoming Release Artist");
  addCalendarRelease(artist.id, "Released Album", "2026-06-11");
  addCalendarRelease(artist.id, "Future Album", "2026-08-20");

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [{ id: artist.id }],
      now: "2026-06-15T12:00:00Z",
    });

    assert.deepEqual(
      releases.map((album) => album.albumName),
      ["Future Album", "Released Album"],
    );
  } finally {
    removeCalendarArtist(artist.id);
  }
});

test("recent missing releases can be scoped to library artists", async () => {
  const includedArtist = createCalendarArtist("Included Calendar Artist");
  const excludedArtist = createCalendarArtist("Excluded Calendar Artist");
  addCalendarRelease(includedArtist.id, "Included Release", "2026-06-11");
  addCalendarRelease(excludedArtist.id, "Excluded Release", "2026-06-12");

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [{ canonicalId: includedArtist.id }],
      now: "2026-06-15T12:00:00Z",
    });

    assert.deepEqual(releases.map((album) => album.albumName), ["Included Release"]);
    assert.equal(releases[0].artistMbid, includedArtist.mbid);
  } finally {
    removeCalendarArtist(includedArtist.id);
    removeCalendarArtist(excludedArtist.id);
  }
});

test("BrainzMash refresh dates releases from album lookups and only rechecks dates that can move", async (t) => {
  const artist = createCalendarArtist("BrainzMash Refresh Artist");
  const recentMbid = randomUUID();
  const oldMbid = randomUUID();
  const upcomingMbid = randomUUID();
  const singleMbid = randomUUID();
  const newMbid = randomUUID();
  const catalogues = {
    [artist.mbid]: [
      catalogueRelease(recentMbid, "Recent Release"),
      catalogueRelease(oldMbid, "Old Release"),
      catalogueRelease(upcomingMbid, "Upcoming Release"),
      catalogueRelease(singleMbid, "Ineligible Single", "Single"),
    ],
  };
  const albumDates = {
    [recentMbid]: "2026-09-10",
    [oldMbid]: "2020-01-01",
    [upcomingMbid]: "2026-10-20",
    [singleMbid]: "2026-09-12",
  };
  const { albumRequests } = stubBrainzMash(t, { catalogues, albumDates });
  const refresh = (now) => {
    albumRequests.length = 0;
    return refreshReleaseMetadata({ artists: [artist], now });
  };
  const visible = async (now) => Object.fromEntries(
    (await getRecentMissingReleases(100, { artists: [artist], now }))
      .map((album) => [album.title, album.releaseDate]),
  );

  try {
    await refresh("2026-09-27T12:00:00Z");
    assert.deepEqual(albumRequests.sort(), [recentMbid, oldMbid, upcomingMbid].sort());
    assert.deepEqual(await visible("2026-09-27T12:00:00Z"), {
      "Upcoming Release": "2026-10-20",
      "Recent Release": "2026-09-10",
    });

    await refresh("2026-09-27T18:00:00Z");
    assert.deepEqual(albumRequests, []);

    albumDates[upcomingMbid] = "2026-11-06";
    albumDates[newMbid] = "2026-09-28";
    catalogues[artist.mbid].push(catalogueRelease(newMbid, "New Release"));
    await refresh("2026-09-29T12:00:00Z");
    assert.deepEqual(albumRequests.sort(), [recentMbid, upcomingMbid, newMbid].sort());
    assert.deepEqual(await visible("2026-09-29T12:00:00Z"), {
      "Upcoming Release": "2026-11-06",
      "New Release": "2026-09-28",
      "Recent Release": "2026-09-10",
    });

    catalogues[artist.mbid] = catalogues[artist.mbid]
      .filter((release) => release.Id !== recentMbid);
    const result = await refresh("2026-09-30T12:00:00Z");
    assert.equal(result.releasesStale, 1);
    assert.equal((await visible("2026-09-30T12:00:00Z"))["Recent Release"], undefined);
  } finally {
    removeCalendarArtist(artist.id);
  }
});

test("repeat refreshes skip artists refreshed in the last day and only queue for artists that are due", async (t) => {
  getHonkerDb();
  const artist = createCalendarArtist("Recently Refreshed Artist");
  const releaseMbid = randomUUID();
  const catalogues = { [artist.mbid]: [catalogueRelease(releaseMbid, "Calendar Release")] };
  const { requestCount } = stubBrainzMash(t, { catalogues, albumDates: { [releaseMbid]: "2026-09-20" } });
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  let newArtist = null;
  let queuedJob = null;

  try {
    const first = await refreshReleaseMetadata({ now });
    assert.equal(first.artistsRefreshed, 1);
    const requestsAfterFirst = requestCount();
    assert.ok(requestsAfterFirst > 0);

    const repeat = await refreshReleaseMetadata({ now: now + 6 * hour });
    assert.equal(repeat.artistsSeen, 0);
    assert.equal(requestCount(), requestsAfterFirst);
    assert.equal(scheduleReleaseMetadataRefresh(), null);

    newArtist = createCalendarArtist("Newly Added Artist");
    queuedJob = scheduleReleaseMetadataRefresh();
    assert.ok(queuedJob);

    const daily = await refreshReleaseMetadata({ artists: [artist], now: now + 21 * hour });
    assert.equal(daily.artistsRefreshed, 1);
    assert.ok(requestCount() > requestsAfterFirst);
  } finally {
    if (queuedJob) getHonkerQueueByName("release-metadata-refresh").cancel(queuedJob);
    if (newArtist) removeCalendarArtist(newArtist.id);
    removeCalendarArtist(artist.id);
  }
});

test("an artist whose catalogue failed is retried after an hour, not on every refresh", async (t) => {
  const artist = createCalendarArtist("Missing Catalogue Artist");
  const { requestCount } = stubBrainzMash(t);
  const hour = 60 * 60 * 1000;
  const now = Date.parse("2026-09-27T12:00:00Z");

  try {
    await assert.rejects(refreshReleaseMetadata({ artists: [artist], now }), /failed for every library artist/);
    const requestsAfterFailure = requestCount();
    assert.ok(requestsAfterFailure > 0);

    const soon = await refreshReleaseMetadata({ artists: [artist], now: now + hour / 2 });
    assert.equal(soon.artistsSeen, 0);
    assert.equal(requestCount(), requestsAfterFailure);

    await assert.rejects(
      refreshReleaseMetadata({ artists: [artist], now: now + hour }),
      /failed for every library artist/,
    );
    assert.ok(requestCount() > requestsAfterFailure);
  } finally {
    removeCalendarArtist(artist.id);
  }
});

test("a malformed BrainzMash catalogue does not remove the last good calendar", async (t) => {
  const artist = createCalendarArtist("Malformed Catalogue Artist");
  const releaseMbid = randomUUID();
  const catalogues = { [artist.mbid]: [catalogueRelease(releaseMbid, "Last Good Release")] };
  stubBrainzMash(t, { catalogues, albumDates: { [releaseMbid]: "2026-09-20" } });

  try {
    await refreshReleaseMetadata({ artists: [artist], now: "2026-09-27T12:00:00Z" });

    catalogues[artist.mbid] = [{ Id: "", Title: "", Type: null }];
    await assert.rejects(
      refreshReleaseMetadata({ artists: [artist], now: "2026-09-28T12:00:00Z" }),
      /failed for every library artist/,
    );

    const stored = db.prepare(
      "SELECT present FROM library_release_calendar WHERE release_group_mbid = ?",
    ).get(releaseMbid);
    assert.deepEqual(stored, { present: 1 });
  } finally {
    removeCalendarArtist(artist.id);
  }
});

test("a failed album lookup keeps the last known release date", async (t) => {
  const artist = createCalendarArtist("Failed Album Lookup Artist");
  const releaseMbid = randomUUID();
  const albumDates = { [releaseMbid]: "2026-09-20" };
  stubBrainzMash(t, {
    catalogues: { [artist.mbid]: [catalogueRelease(releaseMbid, "Release With A Known Date")] },
    albumDates,
  });

  try {
    await refreshReleaseMetadata({ artists: [artist], now: "2026-09-27T12:00:00Z" });
    delete albumDates[releaseMbid];
    const result = await refreshReleaseMetadata({ artists: [artist], now: "2026-09-29T12:00:00Z" });

    assert.equal(result.releasesFailed, 1);
    assert.equal(result.releasesStale, 0);
    const stored = db.prepare(
      "SELECT release_date, present FROM library_release_calendar WHERE release_group_mbid = ? AND artist_id = ?",
    ).get(releaseMbid, artist.id);
    assert.deepEqual(stored, { release_date: "2026-09-20", present: 1 });
  } finally {
    removeCalendarArtist(artist.id);
  }
});

test("collaboration releases retain an independent calendar row for each artist", async () => {
  const firstArtist = createCalendarArtist("First Collaboration Artist");
  const secondArtist = createCalendarArtist("Second Collaboration Artist");
  const releaseGroupMbid = randomUUID();

  try {
    for (const artist of [firstArtist, secondArtist]) {
      upsertReleaseCalendarEntry({
        releaseGroupMbid,
        artistId: artist.id,
        title: "Shared Collaboration Release",
        releaseDate: "2026-09-20",
        releaseType: "Album",
        releaseStatuses: ["Official"],
      });
    }

    const rows = db.prepare(
      "SELECT artist_id, present FROM library_release_calendar WHERE release_group_mbid = ? ORDER BY artist_id",
    ).all(releaseGroupMbid);
    assert.deepEqual(rows, [
      { artist_id: firstArtist.id, present: 1 },
      { artist_id: secondArtist.id, present: 1 },
    ]);

    markUnseenReleaseCalendarEntries(firstArtist.id, new Set());
    const afterStale = db.prepare(
      "SELECT artist_id, present FROM library_release_calendar WHERE release_group_mbid = ? ORDER BY artist_id",
    ).all(releaseGroupMbid);
    assert.deepEqual(afterStale, [
      { artist_id: firstArtist.id, present: 0 },
      { artist_id: secondArtist.id, present: 1 },
    ]);

    const secondArtistReleases = await getRecentMissingReleases(10, {
      artists: [{ id: secondArtist.id }],
      now: "2026-09-27T12:00:00Z",
    });
    assert.deepEqual(
      secondArtistReleases.map((album) => album.albumName),
      ["Shared Collaboration Release"],
    );
  } finally {
    removeCalendarArtist(firstArtist.id);
    removeCalendarArtist(secondArtist.id);
  }
});

test("BrainzMash refresh skips owned albums and leaves their library metadata alone", async (t) => {
  const artistMbid = randomUUID();
  const releaseMbid = randomUUID();
  const libraryArtist = upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: "Owned Metadata Artist",
    metadata: { id: artistMbid, librarySource: "aurral" },
  });
  const ownedMetadata = {
    id: releaseMbid,
    librarySource: "aurral",
    monitored: true,
    aurralOnly: "keep-me",
  };
  const libraryAlbum = upsertLibraryAlbum({
    identityKey: `release-group:${releaseMbid}`,
    releaseGroupMbid: releaseMbid,
    artistId: libraryArtist.id,
    title: "Owned Metadata Album",
    metadata: ownedMetadata,
  });
  const libraryTrack = upsertLibraryTrack({
    identityKey: `recording:${randomUUID()}`,
    title: "Owned Metadata Track",
    artistName: "Owned Metadata Artist",
  });
  linkLibraryAlbumTrack({
    albumId: libraryAlbum.id,
    trackId: libraryTrack.id,
    trackNumber: 1,
  });
  const mediaPath = `/tmp/release-calendar-${randomUUID()}.flac`;
  upsertLibraryMediaFile({
    trackId: libraryTrack.id,
    albumId: libraryAlbum.id,
    source: "aurral",
    path: mediaPath,
    available: true,
  });

  const { albumRequests } = stubBrainzMash(t, {
    catalogues: { [artistMbid]: [catalogueRelease(releaseMbid, "Owned Metadata Album")] },
    albumDates: { [releaseMbid]: "2026-09-20" },
  });

  try {
    await refreshReleaseMetadata({
      artists: [{ id: libraryArtist.id, mbid: artistMbid, name: "Owned Metadata Artist" }],
      now: "2026-09-27T12:00:00Z",
    });
    const stored = db.prepare(
      "SELECT release_date, metadata_json FROM library_albums WHERE id = ?",
    ).get(libraryAlbum.id);
    assert.deepEqual(albumRequests, []);
    assert.equal(stored.release_date, null);
    assert.deepEqual(JSON.parse(stored.metadata_json), ownedMetadata);
    const visible = await getRecentMissingReleases(100, { now: "2026-09-27T12:00:00Z" });
    assert.ok(!visible.some((album) => album.mbid === releaseMbid));
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(mediaPath);
    db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'album' AND entity_id = ?")
      .run(libraryAlbum.id);
    db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?")
      .run(libraryArtist.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(libraryArtist.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(libraryTrack.id);
  }
});

test("library release-date reads return dated albums without loading old albums", async () => {
  const key = `recent-canonical-${process.pid}-${Date.now()}`;
  const libraryArtist = upsertLibraryArtist({
    identityKey: `${key}:artist`,
    mbid: "45454545-4545-4454-8454-454545454545",
    name: "Canonical Release Artist",
    metadata: { id: 4545 },
  });
  const trackIds = [];
  const addAlbum = ({ suffix, title, releaseDate, available = false }) => {
    const album = upsertLibraryAlbum({
      identityKey: `${key}:album:${suffix}`,
      releaseGroupMbid: `56565656-5656-4565-8565-${String(suffix).padStart(12, "0")}`,
      artistId: libraryArtist.id,
      title,
      releaseDate,
    });
    const track = upsertLibraryTrack({
      identityKey: `${key}:track:${suffix}`,
      title: `${title} Track`,
      artistName: "Canonical Release Artist",
    });
    trackIds.push(track.id);
    linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
    if (available) {
      upsertLibraryMediaFile({
        trackId: track.id,
        albumId: album.id,
        source: "lidarr",
        path: `/tmp/${key}/${suffix}.flac`,
        available: true,
      });
    }
  };

  try {
    addAlbum({ suffix: 1, title: "Missing Current", releaseDate: "2026-08-20" });
    addAlbum({ suffix: 2, title: "Owned Current", releaseDate: "2026-08-19", available: true });
    const unrelatedArtist = upsertLibraryArtist({
      identityKey: `${key}:unrelated-artist`,
      name: "Unrelated Release Artist",
    });
    const unrelatedAlbum = upsertLibraryAlbum({
      identityKey: `${key}:unrelated-album`,
      artistId: unrelatedArtist.id,
      title: "Unrelated Newer Release",
      releaseDate: "2026-08-21",
    });
    const unrelatedTrack = upsertLibraryTrack({
      identityKey: `${key}:unrelated-track`,
      title: "Unrelated Track",
      artistName: "Unrelated Release Artist",
    });
    trackIds.push(unrelatedTrack.id);
    linkLibraryAlbumTrack({ albumId: unrelatedAlbum.id, trackId: unrelatedTrack.id });
    for (let index = 0; index < 125; index += 1) {
      addAlbum({ suffix: index + 100, title: `Old Album ${index}`, releaseDate: "2000-01-01" });
    }

    const projectedArtist = getLibraryArtistProjection({ reference: libraryArtist.id })[0];
    const projectedAlbums = getLibraryAlbumsByReleaseDate({
      from: "2026-08-01",
      to: "2026-08-22",
      limit: 10,
    });
    assert.equal(
      projectedAlbums.find((album) => album.title === "Missing Current")?.artistId,
      projectedArtist?.id,
    );

    assert.deepEqual(
      projectedAlbums.map((album) => album.title),
      ["Unrelated Newer Release", "Missing Current", "Owned Current"],
    );
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path LIKE ?").run(`/tmp/${key}/%`);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(libraryArtist.id);
    if (trackIds.length) {
      db.prepare(
        `DELETE FROM library_tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`,
      ).run(...trackIds);
    }
  }
});

test("lease loss during a catalogue request leaves the last good calendar untouched", async (t) => {
  getHonkerDb();
  const artist = createCalendarArtist("Lease Loss Artist");
  const releaseMbid = addCalendarRelease(artist.id, "Last Good Release", "2026-09-20");
  stubBrainzMash(t, {
    catalogues: { [artist.mbid]: [] },
    onArtist: () => {
      db.prepare("UPDATE _honker_locks SET owner = ? WHERE name = ?")
        .run("replacement-owner", "release-metadata-refresh");
    },
  });
  try {
    await assert.rejects(refreshReleaseMetadata({
      artists: [artist],
      now: "2026-09-27T12:00:00Z",
    }), { code: "HONKER_JOB_INTERRUPTED" });
    assert.equal(db.prepare("SELECT present FROM library_release_calendar WHERE release_group_mbid = ?")
      .get(releaseMbid).present, 1);
  } finally {
    db.prepare("DELETE FROM _honker_locks WHERE name = ?").run("release-metadata-refresh");
    removeCalendarArtist(artist.id);
  }
});

test("an aborted metadata refresh never calls the provider or changes the calendar", async (t) => {
  const controller = new AbortController();
  controller.abort();
  const artist = createCalendarArtist("Aborted Refresh Artist");
  const { requestCount } = stubBrainzMash(t, { catalogues: { [artist.mbid]: [] } });
  try {
    await assert.rejects(refreshReleaseMetadata({
      artists: [artist],
      signal: controller.signal,
    }), { code: "HONKER_JOB_INTERRUPTED" });
    assert.equal(requestCount(), 0);
  } finally {
    removeCalendarArtist(artist.id);
  }
});
