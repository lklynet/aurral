import test from "node:test";
import assert from "node:assert/strict";
import { buildTrackRequest } from "../../backend/services/trackMatching/trackIdentity.js";
import {
  normalizeCandidate,
  getCapabilities,
  SOURCE_CAPABILITIES,
  parseFilenameArtistTitle,
  getFileBaseName,
} from "../../backend/services/trackMatching/candidateNormalizer.js";

test("buildTrackRequest keeps established Aurral field names", () => {
  const request = buildTrackRequest({
    artistName: "  Daft Punk ",
    trackName: "Get Lucky",
    albumName: "Random Access Memories",
    releaseYear: "2013",
    durationMs: "248000",
    artistAliases: ["Daft Punk Robot Duo", ""],
    trackNumber: 8,
    trackMbid: "rec-123",
    albumTrackTitles: ["Give Life Back to Music", "Get Lucky"],
  });
  assert.equal(request.artistName, "Daft Punk");
  assert.equal(request.releaseYear, "2013");
  assert.equal(request.durationMs, 248000);
  assert.deepEqual(request.artistAliases, ["Daft Punk Robot Duo"]);
  assert.equal(request.recordingMbid, "rec-123");
  assert.equal(request.trackNumber, 8);
  assert.equal(request.variants.live, false);
  assert.equal(request.albumTrackCount, null);
});

test("buildTrackRequest extracts variants from the requested title", () => {
  const request = buildTrackRequest({ trackName: "Get Lucky (Live at Wembley)" });
  assert.equal(request.variants.live, true);
});

test("normalizeCandidate preserves only evidence a source provides", () => {
  const candidate = normalizeCandidate("deemix", {
    id: "3135553",
    title: "Get Lucky (feat. Pharrell Williams)",
    artist: "Daft Punk",
    album: "Random Access Memories",
    durationSec: 248,
    url: "https://deezer.com/track/3135553",
  });
  assert.equal(candidate.source, "deemix");
  assert.equal(candidate.title, "Get Lucky (feat. Pharrell Williams)");
  assert.deepEqual(candidate.artists, ["Daft Punk"]);
  assert.equal(candidate.album, "Random Access Memories");
  assert.equal(candidate.durationMs, 248000);
  assert.equal(candidate.quality.format, null);
  assert.equal(candidate.provider.id, "3135553");
  assert.equal(candidate.recordingMbid, null);
  assert.equal(candidate.year, null);
});

test("normalizeCandidate parses filename evidence for filename-based sources", () => {
  const candidate = normalizeCandidate(
    "soulseek",
    {
      file: "Daft Punk/Random Access Memories/08. Daft Punk - Get Lucky.flac",
      bitrate: 921600,
      length: 248.4,
      user: "musicfan",
      slots: true,
    },
    {
      capabilities: SOURCE_CAPABILITIES.soulseek,
      parseFilename: true,
      knownArtistNames: ["Daft Punk"],
    },
  );
  assert.equal(candidate.source, "soulseek");
  assert.equal(candidate.filename, "08. Daft Punk - Get Lucky.flac");
  assert.equal(getFileBaseName(candidate.filename), "08. Daft Punk - Get Lucky");
  assert.equal(candidate.filenameTitle, "Get Lucky");
  assert.deepEqual(candidate.artists, ["Daft Punk"]);
  assert.equal(candidate.durationMs, 248400);
  assert.equal(candidate.quality.format, "flac");
  assert.equal(candidate.provider.uploader, "musicfan");
  assert.equal(candidate.provider.slots, true);
  assert.equal(candidate.directoryPath, "Daft Punk/Random Access Memories");
});

test("parseFilenameArtistTitle handles numeric artists and leading track numbers", () => {
  const parsed = parseFilenameArtistTitle("07. 50 Cent - In Da Club", ["50 Cent"]);
  assert.equal(parsed.artist, "50 Cent");
  assert.equal(parsed.title, "In Da Club");
  const unparsed = parseFilenameArtistTitle("Some Random Title", []);
  assert.equal(unparsed.artist, null);
});

test("provider capabilities keep noisy sources honest", () => {
  assert.equal(getCapabilities("deemix").structuredArtist, true);
  assert.equal(getCapabilities("ytdlp").structuredArtist, false);
  assert.equal(getCapabilities("soulseek").filename, true);
  assert.equal(getCapabilities("usenet").releaseContext, true);
  assert.equal(getCapabilities("unknown-source").structuredArtist, false);
});

test("normalizeCandidate drops results without any title evidence", () => {
  assert.equal(normalizeCandidate("soulseek", { file: "", user: "x" }), null);
});
