import assert from "node:assert/strict";
import zlib from "node:zlib";
import { test } from "vite-plus/test";
import { readSpotifyExport } from "../../frontend/src/utils/spotifyExportFiles.ts";

const NOW = Date.UTC(2026, 9, 1);
const YEAR = 365 * 24 * 60 * 60 * 1000;

function zipFile(name: string, entries: { name: string; data: unknown; deflate: boolean }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(JSON.stringify(entry.data));
    const body = entry.deflate ? zlib.deflateRawSync(raw) : raw;
    const fileName = Buffer.from(entry.name);
    const header = (size: number) => {
      const buffer = Buffer.alloc(size);
      buffer.writeUInt16LE(entry.deflate ? 8 : 0, size === 30 ? 8 : 10);
      buffer.writeUInt32LE(zlib.crc32(raw), size === 30 ? 14 : 16);
      buffer.writeUInt32LE(body.length, size === 30 ? 18 : 20);
      buffer.writeUInt32LE(raw.length, size === 30 ? 22 : 24);
      buffer.writeUInt16LE(fileName.length, size === 30 ? 26 : 28);
      return buffer;
    };
    const local = header(30);
    local.writeUInt32LE(0x04034b50, 0);
    const central = header(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, body);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new File([new Uint8Array(Buffer.concat([...locals, ...centrals, end]))], name);
}

const stream = (artist: string | null, playedAt: number, ms = 180_000) => ({
  ts: new Date(playedAt).toISOString(),
  ms_played: ms,
  master_metadata_album_artist_name: artist,
  master_metadata_track_name: artist ? "Song" : null,
  episode_name: artist ? null : "Episode",
  ip_addr: "203.0.113.7",
});

test("a Spotify zip keeps real plays, liked tracks and follows, and drops skips and podcasts", async () => {
  const zip = zipFile("my_spotify_data.zip", [
    {
      name: "Spotify Extended Streaming History/Streaming_History_Audio_2025-2026_0.json",
      deflate: true,
      data: [
        stream("Alvvays", NOW - 2 * YEAR),
        stream("Alvvays", NOW - 2 * YEAR),
        stream("alvvays", NOW),
        stream("Skipped Band", NOW, 12_000),
        stream(null, NOW),
      ],
    },
    {
      name: "Spotify Account Data/StreamingHistory_music_0.json",
      deflate: true,
      data: [{ endTime: "2026-09-01 10:00", artistName: "Also In Extended", msPlayed: 200_000 }],
    },
    {
      name: "Spotify Account Data/YourLibrary.json",
      deflate: false,
      data: {
        tracks: [{ artist: "Slowdive", track: "Alison" }],
        artists: [{ name: "Alvvays" }, { name: "Beach House" }],
      },
    },
  ]);

  assert.deepEqual(await readSpotifyExport([zip], NOW), [
    {
      name: "Alvvays",
      plays: 3,
      score: 5,
      likedTracks: 0,
      followed: true,
      firstPlayedAt: NOW - 2 * YEAR,
      lastPlayedAt: NOW,
    },
    {
      name: "Beach House",
      plays: 0,
      score: 3,
      likedTracks: 0,
      followed: true,
      firstPlayedAt: null,
      lastPlayedAt: null,
    },
    {
      name: "Slowdive",
      plays: 0,
      score: 1,
      likedTracks: 1,
      followed: false,
      firstPlayedAt: null,
      lastPlayedAt: null,
    },
  ]);
});

test("account history files rank what someone plays now above what they played years ago", async () => {
  const play = (artistName: string, playedAt: number) => ({
    endTime: new Date(playedAt).toISOString().slice(0, 16).replace("T", " "),
    artistName,
    trackName: "Song",
    msPlayed: 200_000,
  });
  const history = new File(
    [
      JSON.stringify([
        ...Array.from({ length: 3 }, () => play("Old Favorite", NOW - 4 * YEAR)),
        play("New Favorite", NOW),
      ]),
    ],
    "StreamingHistory_music_0.json",
  );

  const artists = await readSpotifyExport([history, new File(["{}"], "notes.json")], NOW);
  assert.deepEqual(
    artists.map(({ name, plays }) => [name, plays]),
    [
      ["New Favorite", 1],
      ["Old Favorite", 3],
    ],
  );
});
