import type { NormalizedRelease, NormalizedTrack } from "./brainzmashMappers.ts";

type Track = Partial<NormalizedTrack> & {
  discNumber?: unknown;
  recordingMbid?: unknown;
  recordingMbidAliases?: string[];
};

type Release = NormalizedRelease & { releaseMbid?: unknown };

type PressingRelease = Partial<Omit<Release, "tracks">> & { tracks?: Track[] };

type AlbumCandidate = {
  id?: string;
  title?: unknown;
  artistName?: unknown;
  artistId?: unknown;
  releaseDate?: unknown;
  type?: unknown;
  secondaryTypes?: unknown[];
  releaseStatuses?: unknown[];
  score?: unknown;
};

const UNDECOMPOSED_LETTERS = {
  ø: "o",
  Ø: "O",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  ł: "l",
  Ł: "L",
  þ: "th",
  Þ: "TH",
  ß: "ss",
  ẞ: "SS",
} satisfies Record<string, string>;

export function foldDiacritics(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(
      /[øØæÆœŒđĐðÐłŁþÞßẞ]/g,
      (letter) => UNDECOMPOSED_LETTERS[letter as keyof typeof UNDECOMPOSED_LETTERS],
    );
}

function normalizeText(value: unknown) {
  return foldDiacritics(String(value || "").normalize("NFKD"))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSearchWords(value: unknown) {
  return normalizeText(value)
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getNormalizedText(value: unknown) {
  return normalizeText(value);
}

export const TITLE_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "feat",
  "featuring",
  "ft",
  "with",
]);

const USENET_STRIP =
  /\b(deluxe|expanded|anniversary|remaster(?:ed)?|bonus|edition|explicit|clean)\b/g;
const MATCHER_STRIP =
  /\b(deluxe|expanded|anniversary|remaster(?:ed)?|bonus|edition|live|mono|stereo|single|ep|explicit|clean)\b/g;

export function normalizeReleaseText(
  value: unknown,
  { extended = false }: { extended?: boolean } = {},
) {
  return foldDiacritics(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(extended ? MATCHER_STRIP : USENET_STRIP, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(value: unknown, { extended = false }: { extended?: boolean } = {}) {
  return normalizeReleaseText(value, { extended })
    .split(" ")
    .filter((word) => word && !TITLE_STOP_WORDS.has(word))
    .join(" ");
}

export function splitWords(value: unknown, options?: { extended?: boolean }) {
  return normalizeReleaseText(value, options)
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scoreReleaseTextMatch(left: unknown, right: unknown, options: { extended?: boolean }) {
  const a = normalizeReleaseText(left, options);
  const b = normalizeReleaseText(right, options);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) {
    const aWords = a.split(" ").filter(Boolean).length;
    const bWords = b.split(" ").filter(Boolean).length;
    const ratio = Math.min(aWords, bWords) / Math.max(aWords, bWords, 1);
    if (ratio >= 0.6) return 92;
    if (ratio >= 0.25) return 70;
    return 45;
  }
  const leftWords = new Set(splitWords(a, options));
  const rightWords = new Set(splitWords(b, options));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  return Math.round(((2 * overlap) / Math.max(1, leftWords.size + rightWords.size)) * 100);
}

export function scoreTextMatch(
  left: unknown,
  right: unknown,
  options?: { extended?: boolean } | null,
) {
  if (options != null) {
    return scoreReleaseTextMatch(left, right, options);
  }
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) {
    const aWords = a.split(" ").filter(Boolean).length;
    const bWords = b.split(" ").filter(Boolean).length;
    const wordRatio = Math.min(aWords, bWords) / Math.max(aWords, bWords, 1);
    if (wordRatio >= 0.6) return 92;
    if (wordRatio >= 0.25) return 70;
    return 45;
  }
  const leftWords = new Set(splitSearchWords(a));
  const rightWords = new Set(splitSearchWords(b));
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let overlap = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) overlap += 1;
  }
  const ratio = (2 * overlap) / Math.max(1, leftWords.size + rightWords.size);
  return Math.round(ratio * 100);
}

function positiveMs(value: unknown) {
  return value != null && Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.round(Number(value))
    : null;
}

// The length of the matched MusicBrainz release track, then the length the
// request carried. Last.fm lengths are often a radio edit, so they only fill
// a gap.
export function pickResolvedDurationMs({
  playlistDurationMs = null,
  lastfmDurationMs = null,
  matchedTrackDurationMs = null,
}: {
  playlistDurationMs?: unknown;
  lastfmDurationMs?: unknown;
  matchedTrackDurationMs?: unknown;
} = {}) {
  return (
    positiveMs(matchedTrackDurationMs) ||
    positiveMs(playlistDurationMs) ||
    positiveMs(lastfmDurationMs)
  );
}

export function getYear(value: unknown) {
  const match = String(value || "").match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : null;
}

function typeRank(value: unknown) {
  if (value === "Album") return 0;
  if (value === "EP") return 1;
  if (value === "Single") return 2;
  return 3;
}

function bootlegPenalty(item: AlbumCandidate | null | undefined) {
  const statuses = Array.isArray(item?.releaseStatuses) ? item.releaseStatuses : [];
  return statuses.some((status) => String(status || "").toLowerCase() === "bootleg") ? 1 : 0;
}

export function artistNamesMatch(left: unknown, right: unknown) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  return Boolean(a) && a === b;
}

export function rankAlbumCandidates<T extends AlbumCandidate>(
  albumTitle: unknown,
  candidates: T[] = [],
  { artistName = "", releaseYear = null }: { artistName?: unknown; releaseYear?: unknown } = {},
): T[] {
  const normalizedArtist = normalizeText(artistName);
  const targetYear = getYear(releaseYear);
  // A free-text search such as "Fleetwood Mac Rumours" names the artist and
  // the title together.
  const titleScore = (candidate: T) =>
    Math.max(
      scoreTextMatch(candidate?.title, albumTitle),
      normalizedArtist
        ? 0
        : scoreTextMatch(`${candidate?.artistName || ""} ${candidate?.title || ""}`, albumTitle),
    );
  return [...candidates].sort((left, right) => {
    const leftTitleScore = titleScore(left);
    const rightTitleScore = titleScore(right);
    if (leftTitleScore !== rightTitleScore) {
      return rightTitleScore - leftTitleScore;
    }

    const leftArtistScore = normalizedArtist ? scoreTextMatch(left?.artistName, artistName) : 0;
    const rightArtistScore = normalizedArtist ? scoreTextMatch(right?.artistName, artistName) : 0;
    if (leftArtistScore !== rightArtistScore) {
      return rightArtistScore - leftArtistScore;
    }

    const leftYear = getYear(left?.releaseDate);
    const rightYear = getYear(right?.releaseDate);
    const leftYearScore =
      targetYear && leftYear === targetYear ? 1 : targetYear && leftYear ? -1 : 0;
    const rightYearScore =
      targetYear && rightYear === targetYear ? 1 : targetYear && rightYear ? -1 : 0;
    if (leftYearScore !== rightYearScore) {
      return rightYearScore - leftYearScore;
    }

    const leftTypeRank = typeRank(left?.type);
    const rightTypeRank = typeRank(right?.type);
    if (leftTypeRank !== rightTypeRank) return leftTypeRank - rightTypeRank;

    const leftSecondary = (left?.secondaryTypes || []).length > 0 ? 1 : 0;
    const rightSecondary = (right?.secondaryTypes || []).length > 0 ? 1 : 0;
    if (leftSecondary !== rightSecondary) return leftSecondary - rightSecondary;

    const leftBootleg = bootlegPenalty(left);
    const rightBootleg = bootlegPenalty(right);
    if (leftBootleg !== rightBootleg) return leftBootleg - rightBootleg;

    const leftScore = Number(left?.score || 0);
    const rightScore = Number(right?.score || 0);
    if (leftScore !== rightScore) return rightScore - leftScore;

    return String(left?.title || "").localeCompare(String(right?.title || ""));
  });
}

export function tracksInOrder(release: { tracks?: Track[] } | null | undefined) {
  const disc = (track: Track) => Number(track?.mediumNumber ?? track?.discNumber) || 1;
  return [...(release?.tracks || [])].sort(
    (left, right) => disc(left) - disc(right) || (left.trackNumber || 0) - (right.trackNumber || 0),
  );
}

export function runningOrder(release: { tracks?: Track[] } | null | undefined) {
  return tracksInOrder(release)
    .map((track) => getNormalizedText(track.title))
    .join("\n");
}

export function median(values: number[]) {
  const sorted = values.filter((value) => Number(value) > 0).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

const lowerId = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();
const isOfficial = (release: { status?: unknown } | null | undefined) =>
  String(release?.status || "").toLowerCase() === "official";

function recordingIds(track: Track | null | undefined, aliases: Map<string, string[]>) {
  const recording = lowerId(track?.recordingId || track?.recordingMbid);
  return [
    recording,
    ...(track?.oldRecordingIds || track?.recordingMbidAliases || []),
    ...(aliases.get(recording) || []),
  ]
    .map(lowerId)
    .filter(Boolean);
}

// Each track's lengths, in running order, on the other pressings of a
// release: the same running order, only official ones among releases that
// have any, and the same recording at that place. A rip of an LP listed with
// its sleeve lengths may come from a CD pressing, so those lengths match too,
// but a remix or re-recording with the same titles does not. `aliases` maps
// a recording ID to the IDs merged into it.
export function pressingLengths(
  releases: PressingRelease[],
  release: PressingRelease,
  aliases: Map<string, string[]> = new Map(),
) {
  const own = lowerId(release?.id || release?.releaseMbid);
  const order = runningOrder(release);
  const officialOnly = releases.some(isOfficial);
  const pressings = releases
    .filter(
      (entry) =>
        entry !== release &&
        (!own || lowerId(entry?.id || entry?.releaseMbid) !== own) &&
        (!officialOnly || isOfficial(entry)) &&
        entry?.tracks?.length === release.tracks?.length &&
        runningOrder(entry) === order,
    )
    .map(tracksInOrder);
  return tracksInOrder(release).map((track, index) => {
    const recordings = recordingIds(track, aliases);
    return pressings
      .map((tracks) => tracks[index])
      .filter((entry) =>
        recordingIds(entry, aliases).some((recording) => recordings.includes(recording)),
      )
      .map((entry) => Number(entry.durationMs))
      .filter((length) => length > 0);
  });
}

// A release keeps the lengths it lists, and a length it lacks is the median
// of its pressings' lengths.
export function withPressingDurations(releases: Release[], release: Release) {
  const ordered = tracksInOrder(release);
  const lengths = pressingLengths(releases, release);
  return {
    ...release,
    tracks: release.tracks.map((track) => ({
      ...track,
      durationMs:
        track.durationMs != null && track.durationMs > 0
          ? track.durationMs
          : (median(lengths[ordered.indexOf(track)]) ?? track.durationMs),
    })),
  };
}
