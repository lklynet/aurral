import { beforeEach, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { http } from "../../lib/http.ts";

import { getRecentMissingReleases } from "../../backend/services/discovery/recentReleases.ts";
import { refreshReleaseMetadata } from "../../backend/services/releaseMetadataSync.ts";
import { upsertReleaseCalendarEntry } from "../../backend/services/releaseCalendarStore.ts";
import { db } from "../../backend/config/db-sqlite.ts";
import { VARIOUS_ARTISTS_MBID } from "../../backend/services/trackMatching/titleText.ts";
import {
  getLibraryAlbumsByReleaseDate,
  getLibraryArtistProjection,
} from "../../backend/services/libraryQueryService.ts";
import {
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryMediaFile,
  upsertLibraryTrack,
} from "../../backend/services/libraryMediaStore.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setTimerTickMode("nextTimerAsync");
});

function createCalendarArtist(name: string, mbid = randomUUID()) {
  const artist = upsertLibraryArtist({
    identityKey: `mbid:${mbid}`,
    mbid,
    name,
    metadata: { id: mbid, librarySource: "aurral" },
  });
  return { ...artist, mbid };
}

function addCalendarRelease(artistId: number, title: string, releaseDate: string) {
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

const feedOf = (releases: unknown[]) => ({ payload: { releases } });

function freshRelease(
  artistMbids: string[],
  title: string,
  releaseDate: string,
  {
    id = randomUUID(),
    type = "Album",
    secondaryType,
    cover,
  }: { id?: string; type?: string; secondaryType?: string; cover?: [string, number] } = {},
) {
  return {
    release_group_mbid: id,
    release_name: title,
    artist_credit_name: "Calendar Artist",
    artist_mbids: artistMbids,
    release_group_primary_type: type,
    ...(secondaryType && { release_group_secondary_type: secondaryType }),
    ...(cover && { caa_release_mbid: cover[0], caa_id: cover[1] }),
    release_date: releaseDate,
  };
}

function stubFreshReleases(feed: () => unknown) {
  const requests: string[] = [];
  vi.spyOn(http, "get").mockImplementation(async (url, config) => {
    const query = Object.entries(config?.query || {}).map(([key, value]) => `${key}=${value}`);
    const { host, pathname } = new URL(String(url));
    requests.push(`${host}${pathname}?${query.join("&")}`);
    return { status: 200, statusText: "OK", headers: {}, data: feed() };
  });
  return requests;
}

const titles = (releases: { title: string }[]) => releases.map((release) => release.title);

function removeCalendarArtist(artistId: number) {
  db.prepare(
    "DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?",
  ).run(artistId);
  db.prepare("DELETE FROM library_artists WHERE id = ?").run(artistId);
}

test("recent missing releases leave out future releases unless asked for upcoming", async () => {
  const artist = createCalendarArtist("Release Radar Artist");
  addCalendarRelease(artist.id, "Released Album", "2026-06-11");
  addCalendarRelease(artist.id, "Future Album", "2026-08-20");

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [{ id: String(artist.id) }],
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

test("upcoming releases come soonest first", async () => {
  const artist = createCalendarArtist("Upcoming Release Artist");
  addCalendarRelease(artist.id, "Released Album", "2026-06-11");
  addCalendarRelease(artist.id, "Later Album", "2026-09-20");
  addCalendarRelease(artist.id, "Sooner Album", "2026-06-16");

  try {
    const releases = await getRecentMissingReleases(10, {
      artists: [{ id: String(artist.id) }],
      now: "2026-06-15T12:00:00Z",
      when: "upcoming",
    });

    assert.deepEqual(
      releases.map((album) => album.albumName),
      ["Sooner Album", "Later Album"],
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
      artists: [{ id: String(includedArtist.id) }],
      now: "2026-06-15T12:00:00Z",
    });

    assert.deepEqual(
      releases.map((album) => album.albumName),
      ["Included Release"],
    );
    assert.equal(releases[0]?.artistMbid, includedArtist.mbid);
  } finally {
    removeCalendarArtist(includedArtist.id);
    removeCalendarArtist(excludedArtist.id);
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

    const rows = db
      .prepare<
        unknown[],
        {
          artist_id: import("../../backend/db/rows.ts").LibraryReleaseCalendarRow["artist_id"];
          present: import("../../backend/db/rows.ts").LibraryReleaseCalendarRow["present"];
        }
      >(
        "SELECT artist_id, present FROM library_release_calendar WHERE release_group_mbid = ? ORDER BY artist_id",
      )
      .all(releaseGroupMbid);
    assert.deepEqual(rows, [
      { artist_id: firstArtist.id, present: 1 },
      { artist_id: secondArtist.id, present: 1 },
    ]);

    const secondArtistReleases = await getRecentMissingReleases(10, {
      artists: [{ id: String(secondArtist.id) }],
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

test("an owned album in the ListenBrainz feed stays out of the calendar and its library metadata is left alone", async () => {
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

  vi.setSystemTime(Date.parse("2030-03-01T12:00:00Z"));
  stubFreshReleases(() =>
    feedOf([freshRelease([artistMbid], "Owned Metadata Album", "2030-02-20", { id: releaseMbid })]),
  );

  try {
    await refreshReleaseMetadata();
    const stored = db
      .prepare<
        unknown[],
        {
          release_date: import("../../backend/db/rows.ts").LibraryAlbumsRow["release_date"];
          metadata_json: import("../../backend/db/rows.ts").LibraryAlbumsRow["metadata_json"];
        }
      >("SELECT release_date, metadata_json FROM library_albums WHERE id = ?")
      .get(libraryAlbum.id);
    assert.ok(stored != null);
    assert.equal(stored.release_date, null);
    assert.ok(stored != null);
    assert.ok(stored.metadata_json != null);
    assert.deepEqual(JSON.parse(stored.metadata_json), ownedMetadata);
    const visible = await getRecentMissingReleases(100, {
      now: Date.parse("2030-03-01T12:00:00Z"),
    });
    assert.ok(!visible.some((album) => album.mbid === releaseMbid));
  } finally {
    db.prepare("DELETE FROM library_media_files WHERE path = ?").run(mediaPath);
    db.prepare(
      "DELETE FROM library_search_documents WHERE entity_kind = 'album' AND entity_id = ?",
    ).run(libraryAlbum.id);
    db.prepare(
      "DELETE FROM library_search_documents WHERE entity_kind = 'artist' AND entity_id = ?",
    ).run(libraryArtist.id);
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
  const trackIds: number[] = [];
  const addAlbum = ({
    suffix,
    title,
    releaseDate,
    available = false,
  }: {
    suffix: number;
    title: string;
    releaseDate: string;
    available?: boolean;
  }) => {
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

test("the calendar lists library artists' albums and EPs from one ListenBrainz request", async () => {
  vi.setSystemTime(Date.parse("2030-04-10T12:00:00Z"));
  const first = createCalendarArtist("First Fresh Artist");
  const second = createCalendarArtist("Second Fresh Artist");
  const various = createCalendarArtist("Various Artists", VARIOUS_ARTISTS_MBID);
  const laterMbid = randomUUID();
  const coverRelease = randomUUID();
  const requests = stubFreshReleases(() =>
    feedOf([
      freshRelease([first.mbid], "Out Now", "2030-04-02", { cover: [coverRelease, 42] }),
      freshRelease([second.mbid], "Coming Soon", "2030-05-01", { type: "EP" }),
      freshRelease([first.mbid, second.mbid], "Together", "2030-04-05"),
      freshRelease([first.mbid], "Just A Single", "2030-04-06", { type: "Single" }),
      freshRelease([first.mbid], "Greatest Hits", "2030-04-07", { secondaryType: "Compilation" }),
      freshRelease([randomUUID()], "Someone Else", "2030-04-08"),
      freshRelease([laterMbid], "Later Album", "2030-04-09"),
      freshRelease([VARIOUS_ARTISTS_MBID], "Summer Hits", "2030-04-08"),
      freshRelease([VARIOUS_ARTISTS_MBID], "Winter Hits", "2030-05-02"),
    ]),
  );
  const artists = [first, second, various].map(({ id }) => ({ id: String(id) }));
  let added: { id: number } | null = null;

  try {
    assert.deepEqual(await refreshReleaseMetadata(), { releases: 4, gone: 0 });
    assert.deepEqual(
      (await getRecentMissingReleases(10, { artists })).map(({ title, coverUrl }) => [
        title,
        coverUrl,
      ]),
      [
        ["Together", null],
        ["Out Now", `https://imagecache.lidarr.audio/v1/caa/${coverRelease}/42-500.jpg`],
      ],
    );
    assert.deepEqual(titles(await getRecentMissingReleases(10, { artists, when: "upcoming" })), [
      "Coming Soon",
    ]);

    vi.setSystemTime(Date.parse("2030-04-10T13:00:00Z"));
    added = createCalendarArtist("Later Fresh Artist", laterMbid);
    await refreshReleaseMetadata();
    assert.deepEqual(
      titles(await getRecentMissingReleases(10, { artists: [{ id: String(added.id) }] })),
      ["Later Album"],
    );
    assert.deepEqual(requests, [
      "api.listenbrainz.org/1/explore/fresh-releases/?days=90&past=true&future=true",
    ]);
  } finally {
    removeCalendarArtist(first.id);
    removeCalendarArtist(second.id);
    removeCalendarArtist(various.id);
    if (added) removeCalendarArtist(added.id);
  }
});

test("a release that leaves the ListenBrainz feed leaves the calendar, and a failed or empty feed keeps it", async () => {
  vi.setSystemTime(Date.parse("2030-05-01T12:00:00Z"));
  const artist = createCalendarArtist("Changing Feed Artist");
  const older = addCalendarRelease(artist.id, "Long Ago", "2001-01-01");
  const dropped = freshRelease([artist.mbid], "Dropped", "2030-04-20");
  const kept = freshRelease([artist.mbid], "Kept", "2030-04-25");
  let answer: () => unknown = () => feedOf([dropped, kept]);
  stubFreshReleases(() => answer());
  const listed = async () =>
    titles(await getRecentMissingReleases(10, { artists: [{ id: String(artist.id) }] }));
  const later = (hours: number) => vi.setSystemTime(Date.now() + hours * 60 * 60 * 1000);

  try {
    await refreshReleaseMetadata();
    assert.deepEqual(await listed(), ["Kept", "Dropped"]);

    later(7);
    answer = () => feedOf([kept]);
    assert.deepEqual(await refreshReleaseMetadata(), { releases: 1, gone: 1 });
    assert.deepEqual(await listed(), ["Kept"]);

    later(7);
    answer = () => {
      throw Object.assign(new Error("ListenBrainz is down"), { response: { status: 500 } });
    };
    await assert.rejects(refreshReleaseMetadata());
    later(7);
    answer = () => feedOf([freshRelease([], "Nobody's Album", "2030-04-28")]);
    await assert.rejects(refreshReleaseMetadata(), /no fresh releases/);
    assert.deepEqual(await listed(), ["Kept"]);
    answer = () => feedOf([kept]);
    await refreshReleaseMetadata();
    assert.deepEqual(await listed(), ["Kept"]);
    assert.equal(
      db
        .prepare<[string], { present: number }>(
          "SELECT present FROM library_release_calendar WHERE release_group_mbid = ?",
        )
        .get(older)?.present,
      1,
    );
  } finally {
    removeCalendarArtist(artist.id);
  }
});

test("lease loss while ListenBrainz answers leaves the last good calendar untouched", async () => {
  vi.setSystemTime(Date.parse("2030-07-01T12:00:00Z"));
  const artist = createCalendarArtist("Lease Loss Artist");
  addCalendarRelease(artist.id, "Last Good Release", "2030-06-20");
  stubFreshReleases(() => {
    db.prepare("UPDATE job_locks SET owner = ? WHERE name = ?").run(
      "replacement-owner",
      "release-metadata-refresh",
    );
    return feedOf([freshRelease([artist.mbid], "Replacement", "2030-06-25")]);
  });
  try {
    await assert.rejects(refreshReleaseMetadata(), { code: "JOB_INTERRUPTED" });
    assert.deepEqual(
      titles(await getRecentMissingReleases(10, { artists: [{ id: String(artist.id) }] })),
      ["Last Good Release"],
    );
  } finally {
    db.prepare("DELETE FROM job_locks WHERE name = ?").run("release-metadata-refresh");
    removeCalendarArtist(artist.id);
  }
});

test("an aborted refresh never asks ListenBrainz", async () => {
  const controller = new AbortController();
  controller.abort();
  const requests = stubFreshReleases(() => feedOf([]));
  await assert.rejects(refreshReleaseMetadata({ signal: controller.signal }), {
    code: "JOB_INTERRUPTED",
  });
  assert.deepEqual(requests, []);
});
