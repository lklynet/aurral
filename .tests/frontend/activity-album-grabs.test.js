import test from "node:test";
import assert from "node:assert/strict";
import { groupAlbumGrabRequests, matchesActivitySearch } from "../../frontend/src/pages/activity/activityListUtils.js";
import { matchesActivityView } from "../../frontend/src/navigation/activityNavConfig.js";

function albumTracks({ id = "grab-one", statuses = ["completed", "processing", "pending"], phase = "poll" } = {}) {
  const memberJobIds = statuses.map((_, index) => `${id}-${index}`);
  return statuses.map((status, index) => ({
    id: `history-${memberJobIds[index]}`, jobId: memberJobIds[index], kind: "track_download",
    playlistId: "library", albumName: "Everything Now", artistName: "Arcade Fire",
    trackName: `Song ${index + 1}`, trackNumber: index + 1, status,
    statusLabel: status === "processing" ? "Downloading" : status,
    requestedAt: "2026-09-29T15:06:00Z", completedAt: status === "completed" ? "2026-09-29T15:08:00Z" : null,
    actualDownloadSource: status === "completed" ? "slskd" : null,
    downloadMethod: status === "completed" ? "album" : null,
    albumGrab: { id, memberJobIds, requestGroupId: id, albumMbid: "release-one",
      phase, source: "slskd", requestedAt: "2026-09-29T15:06:00Z" },
  }));
}

test("an album grab keeps completed tracks inside its queue row until every track is terminal", () => {
  const tracks = albumTracks();
  const [row] = groupAlbumGrabRequests(tracks.toReversed());
  assert.equal(row.albumName, "Everything Now");
  assert.equal(row.statusLabel, "Downloading album");
  assert.equal(row.progressLabel, "1 of 3 tracks ready");
  assert.deepEqual(row.children.map((child) => child.trackName), ["Song 1", "Song 2", "Song 3"]);
  assert.equal(matchesActivityView(row, "queue"), true);
  assert.equal(matchesActivityView(row, "history"), false);
  const [done] = groupAlbumGrabRequests(tracks.map((track) => ({ ...track, status: "completed", completedAt: "2026-09-29T15:08:00Z" })));
  assert.equal(done.id, row.id);
  assert.equal(done.statusLabel, "Completed");
  assert.equal(matchesActivityView(done, "history"), true);
  assert.equal(done.requestedAt, "2026-09-29T15:06:00Z");
  assert.equal(done.completedAt, "2026-09-29T15:08:00.000Z");
});

test("track-only requests and distinct album grabs are never combined by album title", () => {
  const first = albumTracks();
  const second = albumTracks({ id: "another-request" });
  const trackOnly = { ...first[0], id: "track-only", jobId: "track-only", albumGrab: undefined };
  const playlist = { ...first[0], id: "playlist-track", jobId: "playlist-track", playlistId: "my-playlist" };
  const rows = groupAlbumGrabRequests([...first, ...second, trackOnly, playlist]);
  assert.equal(rows.length, 4);
  assert.ok(rows.includes(trackOnly));
  assert.ok(rows.includes(playlist));
  assert.deepEqual(rows.filter((row) => row.children).map((row) => row.children.length), [3, 3]);
});

test("partial fallback, blocked review, and unavailable evidence never report a completed album", () => {
  const fallback = albumTracks({ statuses: ["completed", "pending", "failed"], phase: "tracks" });
  const [row] = groupAlbumGrabRequests(fallback);
  assert.equal(row.statusLabel, "Searching for tracks");
  assert.equal(row.downloadMethodLabel, "Album download with track fallback");
  const [blocked] = groupAlbumGrabRequests(fallback.map((track, index) => index === 1 ? { ...track, status: "blocked" } : track));
  assert.equal(blocked.statusLabel, "Needs review");
  assert.equal(matchesActivityView(blocked, "queue"), true);
  const [partial] = groupAlbumGrabRequests(fallback.filter((_, index) => index !== 1));
  assert.equal(partial.statusLabel, "Incomplete");
  assert.equal(partial.progressLabel, "1 of 3 tracks ready · 1 track detail unavailable");
});

test("search finds child tracks without discarding siblings or their album context", () => {
  const [row] = groupAlbumGrabRequests(albumTracks());
  assert.equal(matchesActivitySearch(row, "song 2"), true);
  assert.equal(matchesActivitySearch(row, "arcade fire"), true);
  assert.equal(matchesActivitySearch(row, "missing artist"), false);
  assert.equal(row.children.length, 3);
});

test("album rows follow disc order and distinguish failed and cancelled terminal requests", () => {
  const tracks = albumTracks({ statuses: ["cancelled", "cancelled", "cancelled"] });
  const [cancelled] = groupAlbumGrabRequests(tracks.map((track, index) => ({ ...track,
    discNumber: index === 0 ? 2 : 1, trackNumber: index === 2 ? 1 : 2 })));
  assert.deepEqual(cancelled.children.map((child) => child.trackName), ["Song 3", "Song 2", "Song 1"]);
  assert.equal(cancelled.statusLabel, "Cancelled");
  const [failed] = groupAlbumGrabRequests(tracks.map((track, index) => index === 1 ? { ...track, status: "failed" } : track));
  assert.equal(failed.statusLabel, "Failed");
  assert.equal(matchesActivityView(failed, "history"), true);
});
