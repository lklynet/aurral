import test from "node:test";
import assert from "node:assert/strict";

test("getTracks hydrates missing track paths from Lidarr track files", async () => {
  const [{ libraryManager }, { lidarrClient }] = await Promise.all([
    import("../services/libraryManager.js"),
    import("../services/lidarrClient.js"),
  ]);

  const originalIsConfigured = lidarrClient.isConfigured;
  const originalGetAlbum = lidarrClient.getAlbum;
  const originalGetTracksByAlbumId = lidarrClient.getTracksByAlbumId;
  const originalGetTrackFilesByAlbumId = lidarrClient.getTrackFilesByAlbumId;

  lidarrClient.isConfigured = () => true;
  lidarrClient.getAlbum = async () => ({
    id: 999001,
    statistics: {
      percentOfTracks: 100,
      sizeOnDisk: 1234,
    },
    media: [],
  });
  lidarrClient.getTracksByAlbumId = async () => [
    {
      id: 281188,
      foreignRecordingId: "b13278c0-31fb-45ff-ade1-2678a1824563",
      trackFileId: 11126,
      albumId: 999001,
      trackNumber: "2",
      title: "Hot Dog",
      hasFile: true,
    },
  ];
  lidarrClient.getTrackFilesByAlbumId = async () => [
    {
      id: 11126,
      path: "/music/Limp Bizkit/Chocolate Starfish/02 Hot Dog.flac",
      size: 30511974,
      mediaInfo: {
        audioCodec: "FLAC",
      },
    },
  ];

  try {
    const tracks = await libraryManager.getTracks("999001");
    assert.equal(tracks.length, 1);
    assert.equal(
      tracks[0].path,
      "/music/Limp Bizkit/Chocolate Starfish/02 Hot Dog.flac",
    );
    assert.equal(tracks[0].size, 30511974);
    assert.equal(tracks[0].quality, "FLAC");
  } finally {
    lidarrClient.isConfigured = originalIsConfigured;
    lidarrClient.getAlbum = originalGetAlbum;
    lidarrClient.getTracksByAlbumId = originalGetTracksByAlbumId;
    lidarrClient.getTrackFilesByAlbumId = originalGetTrackFilesByAlbumId;
  }
});
