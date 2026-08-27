import {
  normalizeReleaseText as normalizeText,
  scoreTextMatch,
} from "../providers/brainzmashRanking.js";

const MAX_CANDIDATES = 5;

function readContext(context) {
  return {
    trackName: String(context?.trackName || context?.title || "").trim(),
    artistName: String(context?.artistName || context?.artist || "").trim(),
    albumName: String(context?.albumName || context?.album || "").trim(),
    durationMs: Number(context?.durationMs || 0),
  };
}

// Deezer reports the real track length, so a wide window only lets edits and
// extended versions through.
function scoreDuration(durationSec, expectedMs) {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) return { ok: true, score: 0 };
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { ok: true, score: -8 };
  const diff = Math.abs(durationSec * 1000 - expectedMs);
  if (diff > Math.max(10000, expectedMs * 0.08)) return { ok: false, score: -40 };
  if (diff <= 2000) return { ok: true, score: 25 };
  if (diff <= 5000) return { ok: true, score: 18 };
  return { ok: true, score: 10 };
}

function quote(value) {
  return String(value || "").replace(/"/g, " ").trim();
}

export function buildDeemixSearchQueries(context) {
  const ctx = readContext(context);
  if (!ctx.trackName) return [];
  const queries = [];
  if (ctx.artistName) {
    // Deezer's advanced search syntax keeps the first pass tight.
    queries.push(`artist:"${quote(ctx.artistName)}" track:"${quote(ctx.trackName)}"`);
    queries.push(`${ctx.artistName} ${ctx.trackName}`);
  } else {
    queries.push(ctx.trackName);
  }
  const seen = new Set();
  return queries.filter((query) => {
    const key = normalizeText(query);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rankDeemixResults(results, context) {
  const ctx = readContext(context);
  const ranked = [];
  for (const result of Array.isArray(results) ? results : []) {
    const id = String(result?.id || "").trim();
    const title = String(result?.title || "").trim();
    const artist = String(result?.artist || "").trim();
    const album = String(result?.album || "").trim();
    if (!id || !title) continue;
    if (result?.readable === false) continue;
    const duration = scoreDuration(result.durationSec, ctx.durationMs);
    if (!duration.ok) continue;

    const titleScore = scoreTextMatch(title, ctx.trackName);
    const artistScore = ctx.artistName ? scoreTextMatch(artist, ctx.artistName) : 0;
    const albumScore =
      ctx.albumName && album ? Math.round(scoreTextMatch(album, ctx.albumName) / 4) : 0;
    if (titleScore < 55 || (ctx.artistName && artistScore < 40)) continue;
    ranked.push({
      raw: {
        id,
        title,
        artist,
        album,
        url: result.url,
        durationSec: result.durationSec,
        file: artist ? `${artist} - ${title}` : title,
      },
      score: titleScore + artistScore + albumScore + duration.score,
      scores: {
        title: titleScore,
        artist: artistScore,
        album: albumScore,
        duration: duration.score,
      },
      resolvedAlbumName: album || ctx.albumName || null,
      preDownloadValid: titleScore >= 70 && (!ctx.artistName || artistScore >= 55),
    });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, MAX_CANDIDATES);
}

if (process.argv[1] && process.argv[1].endsWith("weeklyFlowDeemixMatcher.js")) {
  const context = { artistName: "Daft Punk", trackName: "Get Lucky", durationMs: 248000 };
  const ranked = rankDeemixResults(
    [
      { id: "good", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories", durationSec: 248 },
      { id: "wrong-artist", title: "Get Lucky", artist: "Lounge Covers", durationSec: 248 },
      { id: "extended", title: "Get Lucky", artist: "Daft Punk", durationSec: 620 },
      { id: "blocked", title: "Get Lucky", artist: "Daft Punk", durationSec: 248, readable: false },
    ],
    context,
  );
  console.assert(ranked[0]?.raw?.id === "good", "prefer the exact artist and duration match");
  console.assert(!ranked.some((entry) => entry.raw.id === "wrong-artist"), "reject other artists");
  console.assert(!ranked.some((entry) => entry.raw.id === "extended"), "reject long edits");
  console.assert(!ranked.some((entry) => entry.raw.id === "blocked"), "reject unplayable tracks");
  console.assert(
    buildDeemixSearchQueries(context)[0] === 'artist:"Daft Punk" track:"Get Lucky"',
    "build the advanced Deezer query first",
  );
  console.log("weeklyFlowDeemixMatcher self-check ok");
}
