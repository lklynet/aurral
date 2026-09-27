import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.js";
import { refreshReleaseMetadata } from "../../backend/services/releaseMetadataSync.js";
import { upsertReleaseCalendarEntry } from "../../backend/services/releaseCalendarStore.js";
import { db } from "../../backend/config/db-sqlite.js";
import {
  getCanonicalAlbumsByReleaseDate,
  getCanonicalArtistProjection,
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

test("recent missing releases can be scoped to canonical artists", async () => {
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

test("BrainzMash refresh adds new releases without a Lidarr catalogue", async () => {
  const artistMbid = randomUUID();
  const firstReleaseMbid = randomUUID();
  const newReleaseMbid = randomUUID();
  const canonicalArtist = upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: "BrainzMash Refresh Artist",
    metadata: { id: artistMbid, librarySource: "aurral" },
  });
  const release = (id, title, firstReleaseDate) => ({
    id,
    title,
    type: "Album",
    secondaryTypes: [],
    releaseStatuses: ["Official"],
    firstReleaseDate,
  });
  let providerReleases = [
    release(firstReleaseMbid, "Initial BrainzMash Release", "2026-09-10"),
    release(randomUUID(), "Old BrainzMash Release", "2020-01-01"),
  ];
  const listAlbums = async (requestedMbid, options) => {
    assert.equal(requestedMbid, artistMbid);
    assert.equal(options.hydrateLimit, 0);
    return providerReleases;
  };

  try {
    assert.deepEqual(
      await refreshReleaseMetadata({
        artists: [{ id: canonicalArtist.id, mbid: artistMbid, name: "BrainzMash Refresh Artist" }],
        listAlbums,
        now: "2026-09-27T12:00:00Z",
      }),
      {
        artistsSeen: 1,
        artistsRefreshed: 1,
        artistsFailed: 0,
        releasesSeen: 1,
        releasesStored: 1,
        releasesStale: 0,
      },
    );
    let visible = await getRecentMissingReleases(100, { now: "2026-09-27T12:00:00Z" });
    assert.ok(visible.some((album) => album.mbid === firstReleaseMbid));
    assert.ok(!visible.some((album) => album.title === "Old BrainzMash Release"));

    providerReleases = [
      ...providerReleases,
      release(newReleaseMbid, "Newly Published BrainzMash Release", "2026-10-10"),
    ];
    const secondRefresh = await refreshReleaseMetadata({
      artists: [{ id: canonicalArtist.id, mbid: artistMbid, name: "BrainzMash Refresh Artist" }],
      listAlbums,
      now: "2026-09-27T12:00:00Z",
    });
    assert.equal(secondRefresh.releasesSeen, 2);
    visible = await getRecentMissingReleases(100, { now: "2026-09-27T12:00:00Z" });
    assert.ok(visible.some((album) => album.mbid === newReleaseMbid));

    providerReleases = [providerReleases.at(-1)];
    const thirdRefresh = await refreshReleaseMetadata({
      artists: [{ id: canonicalArtist.id, mbid: artistMbid, name: "BrainzMash Refresh Artist" }],
      listAlbums,
      now: "2026-09-27T12:00:00Z",
    });
    assert.equal(thirdRefresh.releasesStale, 1);
    visible = await getRecentMissingReleases(100, { now: "2026-09-27T12:00:00Z" });
    assert.ok(!visible.some((album) => album.mbid === firstReleaseMbid));
    assert.ok(visible.some((album) => album.mbid === newReleaseMbid));
  } finally {
    const albumIds = db.prepare("SELECT id FROM library_albums WHERE artist_id = ?")
      .all(canonicalArtist.id)
      .map((row) => row.id);
    for (const albumId of albumIds) {
      db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'album' AND entity_id = ?")
        .run(albumId);
    }
    db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?")
      .run(canonicalArtist.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(canonicalArtist.id);
  }
});

test("a malformed BrainzMash catalogue does not remove the last good calendar", async () => {
  const artistMbid = randomUUID();
  const releaseMbid = randomUUID();
  const canonicalArtist = upsertLibraryArtist({
    identityKey: `mbid:${artistMbid}`,
    mbid: artistMbid,
    name: "Malformed Catalogue Artist",
  });
  const artists = [{ id: canonicalArtist.id, mbid: artistMbid }];

  try {
    await refreshReleaseMetadata({
      artists,
      listAlbums: async () => [{
        id: releaseMbid,
        title: "Last Good Release",
        type: "Album",
        secondaryTypes: [],
        releaseStatuses: ["Official"],
        firstReleaseDate: "2026-09-20",
      }],
      now: "2026-09-27T12:00:00Z",
    });

    await assert.rejects(
      refreshReleaseMetadata({
        artists,
        listAlbums: async () => [{ id: "", title: "", type: null }],
        now: "2026-09-28T12:00:00Z",
      }),
      /failed for every library artist/,
    );

    const stored = db.prepare(
      "SELECT present FROM library_release_calendar WHERE release_group_mbid = ?",
    ).get(releaseMbid);
    assert.deepEqual(stored, { present: 1 });
  } finally {
    removeCalendarArtist(canonicalArtist.id);
  }
});

test("BrainzMash refresh keeps its calendar separate from canonical album metadata", async () => {
  const artistMbid = randomUUID();
  const releaseMbid = randomUUID();
  const canonicalArtist = upsertLibraryArtist({
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
  const canonicalAlbum = upsertLibraryAlbum({
    identityKey: `release-group:${releaseMbid}`,
    releaseGroupMbid: releaseMbid,
    artistId: canonicalArtist.id,
    title: "Owned Metadata Album",
    metadata: ownedMetadata,
  });
  const canonicalTrack = upsertLibraryTrack({
    identityKey: `recording:${randomUUID()}`,
    title: "Owned Metadata Track",
    artistName: "Owned Metadata Artist",
  });
  linkLibraryAlbumTrack({
    albumId: canonicalAlbum.id,
    trackId: canonicalTrack.id,
    trackNumber: 1,
  });
  const mediaPath = `/tmp/release-calendar-${randomUUID()}.flac`;
  upsertLibraryMediaFile({
    trackId: canonicalTrack.id,
    albumId: canonicalAlbum.id,
    source: "aurral",
    path: mediaPath,
    available: true,
  });

  try {
    await refreshReleaseMetadata({
      artists: [{ id: canonicalArtist.id, mbid: artistMbid, name: "Owned Metadata Artist" }],
      listAlbums: async () => [{
        id: releaseMbid,
        title: "Owned Metadata Album",
        type: "Album",
        secondaryTypes: [],
        releaseStatuses: ["Official"],
        firstReleaseDate: "2026-09-20",
      }],
      now: "2026-09-27T12:00:00Z",
    });
    const stored = db.prepare(
      "SELECT release_date, metadata_json FROM library_albums WHERE id = ?",
    ).get(canonicalAlbum.id);
    const calendar = db.prepare(
      `SELECT release_date, present
       FROM library_release_calendar
       WHERE release_group_mbid = ?`,
    ).get(releaseMbid);
    assert.equal(stored.release_date, null);
    assert.deepEqual(JSON.parse(stored.metadata_json), ownedMetadata);
    assert.deepEqual(calendar, { release_date: "2026-09-20", present: 1 });
    const visible = await getRecentMissingReleases(100, { now: "2026-09-27T12:00:00Z" });
    assert.ok(!visible.some((album) => album.mbid === releaseMbid));
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(mediaPath);
    db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'album' AND entity_id = ?")
      .run(canonicalAlbum.id);
    db.prepare("DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?")
      .run(canonicalArtist.id);
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(canonicalArtist.id);
    db.prepare("DELETE FROM library_tracks WHERE id = ?").run(canonicalTrack.id);
  }
});

test("canonical release-date reads return dated albums without loading old albums", async () => {
  const key = `recent-canonical-${process.pid}-${Date.now()}`;
  const canonicalArtist = upsertLibraryArtist({
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
      artistId: canonicalArtist.id,
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

    const projectedArtist = getCanonicalArtistProjection({ reference: canonicalArtist.id })[0];
    const projectedAlbums = getCanonicalAlbumsByReleaseDate({
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
    db.prepare("DELETE FROM library_artists WHERE id = ?").run(canonicalArtist.id);
    if (trackIds.length) {
      db.prepare(
        `DELETE FROM library_tracks WHERE id IN (${trackIds.map(() => "?").join(",")})`,
      ).run(...trackIds);
    }
  }
});
