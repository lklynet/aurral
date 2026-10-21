import type {
  NormalizedAlbum,
  NormalizedArtist,
  NormalizedRelease,
  NormalizedTrack,
} from "./providers/brainzmashMappers.ts";
import { median, pressingLengths, scoreTextMatch } from "./providers/brainzmashRanking.ts";
import { buildResolvedJobTrack, type DownloadTrackFields } from "./downloadUtils.ts";
import { normalizeMatchText } from "./trackMatching/nativeMatcher.ts";
import { extractVariants } from "./trackMatching/semanticPolicy.ts";
import { isVariousArtistsCredit } from "./trackMatching/titleText.ts";

type ManifestArtistInput = NormalizedArtist & { artistname?: string };

type ManifestTrackInput = NormalizedTrack & {
  discNumber?: number;
  recordingMbid?: string;
  recordingMbidAliases?: string[];
  artistMbid?: string;
  artistName?: string;
};

type ManifestReleaseInput = NormalizedRelease & {
  releaseMbid?: string;
  releaseGroupMbid?: string;
  albumName?: string;
  artistName?: string;
};

type ManifestGroupInput = Omit<NormalizedAlbum, "artists"> & {
  artists: ManifestArtistInput[];
  artistName?: string;
};

type ManifestJobInput = DownloadTrackFields & {
  id?: string;
  recordingMbid?: string | null;
};

type ManifestJob = ManifestJobInput & { id: string };

const VERSION_KEYS = [
  "live",
  "concert",
  "acoustic",
  "instrumental",
  "karaoke",
  "demo",
  "cover",
  "remix",
  "sped_up",
  "slowed",
  "nightcore",
  "eight_d",
] as const;

const id = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();
const text = (value: unknown) => String(value ?? "").trim();
const positive = (value: unknown) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : null;
const unique = (values: unknown[]) => [...new Set(values.map(text).filter(Boolean))];

// "Song" and "Song (Live)" score as the same title, so a title only names a
// release track when both carry the same versions.
export function sameVersion(left: string | null | undefined, right: string | null | undefined) {
  const a = extractVariants(left);
  const b = extractVariants(right);
  return (
    VERSION_KEYS.every((key) => Boolean(a[key]) === Boolean(b[key])) &&
    a.mixVariant === b.mixVariant
  );
}

function sameTitle(left: string | null | undefined, right: string | null | undefined) {
  const a = normalizeMatchText(left);
  if (!a) return false;
  return (
    a === normalizeMatchText(right) ||
    (sameVersion(left, right) && scoreTextMatch(left, right, { extended: true }) >= 90)
  );
}

function groupArtists(group: ManifestGroupInput) {
  const artists = (Array.isArray(group?.artists) ? group.artists : [])
    .map((artist) => ({
      id: id(artist?.id),
      name: text(artist?.name || artist?.artistname),
      aliases: unique(artist?.aliases || []),
    }))
    .filter((artist) => artist.name);
  const lead = id(group?.artistId);
  return artists.toSorted((left, right) => (right.id === lead) - (left.id === lead));
}

function parseTrack(track: ManifestTrackInput, index: number) {
  return {
    index,
    title: text(track?.title),
    trackNumber: positive(track?.trackPosition ?? track?.trackNumber),
    discNumber: positive(track?.mediumNumber ?? track?.discNumber) || 1,
    durationMs: positive(track?.durationMs),
    recordingMbid: text(track?.recordingId || track?.recordingMbid) || null,
    recordingMbidAliases: unique(track?.oldRecordingIds || track?.recordingMbidAliases || []),
    artistId: id(track?.artistId || track?.artistMbid),
    artistName: text(track?.artistName),
  };
}

type ParsedTrack = ReturnType<typeof parseTrack>;

function inRunningOrder(tracks: ParsedTrack[]) {
  return tracks.toSorted(
    (left, right) => left.discNumber - right.discNumber || left.trackNumber - right.trackNumber,
  );
}

// A tracklist proves it is whole when every disc runs 1..n.
function isWhole(tracks: ParsedTrack[]) {
  const discs = new Map<number, number[]>();
  for (const track of tracks) {
    if (!track.trackNumber) return false;
    discs.set(track.discNumber, [...(discs.get(track.discNumber) || []), track.trackNumber]);
  }
  return [...discs.values()].every((numbers) =>
    numbers.toSorted((left, right) => left - right).every((number, index) => number === index + 1),
  );
}

// MusicBrainz keeps the IDs of recordings merged into another, and files
// tagged before the merge still carry them, whichever release listed them.
function recordingAliases(group: ManifestGroupInput) {
  const aliases = new Map<string, string[]>();
  for (const release of group?.releases || []) {
    for (const track of (release?.tracks || []).map(parseTrack)) {
      const key = id(track.recordingMbid);
      if (key && track.recordingMbidAliases.length)
        aliases.set(key, [...(aliases.get(key) || []), ...track.recordingMbidAliases]);
    }
  }
  return aliases;
}

// A release's tracks in running order, with the recording IDs merged into
// each, or null unless the tracklist is complete and ordered.
function tracklist(
  release: ManifestReleaseInput | null | undefined,
  aliases: Map<string, string[]>,
) {
  const listed = Array.isArray(release?.tracks) ? release.tracks : [];
  if (!text(release?.id || release?.releaseMbid) || listed.length === 0) return null;
  const declared = positive(release?.trackCount);
  if (declared && declared !== listed.length) return null;
  const parsed = inRunningOrder(listed.map(parseTrack));
  if (parsed.some((track) => !track.title) || !isWhole(parsed)) return null;
  return parsed.map((track) => ({
    ...track,
    recordingMbidAliases: unique([
      ...track.recordingMbidAliases,
      ...(aliases.get(id(track.recordingMbid)) || []),
    ]),
  }));
}

// The releases of a group that hold the job's track, placed as a manifest
// places it. Lengths play no part, so they are not read.
export function releasesHolding(group: ManifestGroupInput, job: ManifestJobInput) {
  const aliases = recordingAliases(group);
  return (group?.releases || []).filter((release) => {
    const tracks = tracklist(release, aliases);
    return tracks && manifestIndexFor({ tracks }, job) != null;
  });
}

// The boundary parser for the exact edition a download must deliver. It takes
// a BrainzMash album and one of its releases, or a release record that uses
// Aurral's own track field names, and refuses any tracklist that is not
// complete and ordered.
export function toReleaseManifest(
  group: ManifestGroupInput,
  release: ManifestReleaseInput | null | undefined,
) {
  const releaseMbid = text(release?.id || release?.releaseMbid);
  const aliases = recordingAliases(group);
  const listed = tracklist(release, aliases);
  if (!listed) return null;
  // A release keeps the lengths it lists, since a rip of it matches those.
  // A length it lacks is the median of its pressings' lengths.
  const lengths = pressingLengths(group?.releases || [], release, aliases);
  const tracks = listed.map((track, index) => ({
    ...track,
    durationMs: track.durationMs ?? median(lengths[index]),
  }));
  const otherLengths = lengths.map((found, index) => [
    ...new Set(found.filter((length) => length !== tracks[index].durationMs)),
  ]);

  const artists = groupArtists(group);
  const artistNames = artists.length
    ? artists.map((artist) => artist.name)
    : unique([release?.artistName, group?.artistName]);
  const compilation =
    artistNames.some((name) => isVariousArtistsCredit(name)) ||
    artists.some((artist) => isVariousArtistsCredit(artist.name, artist.id));
  const albumArtists = artists.filter((artist) => !isVariousArtistsCredit(artist.name, artist.id));
  const lead = id(group?.artistId) || albumArtists[0]?.id || "";
  const byId = new Map(artists.map((artist) => [artist.id, artist] as const));
  const creditFor = (track: (typeof tracks)[number]) => {
    if (track.artistName && !isVariousArtistsCredit(track.artistName)) {
      return {
        artists: [track.artistName],
        artistAliases: byId.get(track.artistId)?.aliases || [],
      };
    }
    const credited = track.artistId && byId.get(track.artistId);
    if (credited && !isVariousArtistsCredit(credited.name, credited.id)) {
      return { artists: [credited.name], artistAliases: credited.aliases };
    }
    // An unknown credit, or a compilation's, would be contradicted by the
    // album artist, so the track names no artist.
    if (compilation || (track.artistId && track.artistId !== lead))
      return { artists: [], artistAliases: [] };
    return {
      artists: albumArtists
        .map((artist) => artist.name)
        .concat(artists.length ? [] : artistNames)
        .filter(Boolean),
      artistAliases: unique(albumArtists.flatMap((artist) => artist.aliases)),
    };
  };

  return {
    releaseMbid,
    releaseGroupMbid: text(group?.id || release?.releaseGroupMbid) || null,
    title: text(release?.title || release?.albumName || group?.title),
    artistNames,
    compilation,
    secondaryTypes: unique(group?.secondaryTypes || []),
    tracks: tracks.map((track, index) => ({
      title: track.title,
      ...creditFor(track),
      durationMs: track.durationMs,
      pressingDurationsMs: otherLengths[index],
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      recordingMbid: track.recordingMbid,
      recordingMbidAliases: track.recordingMbidAliases,
    })),
  };
}

export type ReleaseManifest = NonNullable<ReturnType<typeof toReleaseManifest>>;
export type ReleaseManifestTrack = ReleaseManifest["tracks"][number];

type PlacedTrack = Pick<
  ReleaseManifestTrack,
  "title" | "trackNumber" | "discNumber" | "recordingMbid" | "recordingMbidAliases"
>;

type PlaceableManifest = { tracks: PlacedTrack[] };

function recordingIds(track: PlacedTrack) {
  return [track.recordingMbid, ...(track.recordingMbidAliases || [])].map(id).filter(Boolean);
}

function jobRecordings(job: ManifestJobInput) {
  return [job?.trackMbid, job?.recordingMbid, ...(job?.recordingMbidAliases || [])]
    .map(id)
    .filter(Boolean);
}

function positionScore(job: ManifestJobInput, track: PlacedTrack) {
  const trackNumber = positive(job?.trackNumber);
  if (!trackNumber) return 0;
  return (
    (track.trackNumber === trackNumber ? 2 : 0) +
    ((track.discNumber || 1) === (positive(job?.discNumber) || 1) ? 1 : 0)
  );
}

// A known recording that the track does not list is another recording, even
// when the title and place agree.
function contradicts(job: ManifestJobInput, track: PlacedTrack) {
  const wanted = jobRecordings(job);
  const listed = recordingIds(track);
  return wanted.length > 0 && listed.length > 0 && !wanted.some((entry) => listed.includes(entry));
}

function pick(manifest: PlaceableManifest, job: ManifestJobInput, taken: Set<number>) {
  const open = manifest.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ index }) => !taken.has(index));
  const wanted = jobRecordings(job);
  const byRecording = wanted.length
    ? open.filter(({ track }) => recordingIds(track).some((entry) => wanted.includes(entry)))
    : [];
  if (byRecording.length) {
    return byRecording.reduce((best, entry) =>
      positionScore(job, entry.track) > positionScore(job, best.track) ? entry : best,
    ).index;
  }
  const title = text(job?.trackName);
  const compatible = open.filter(({ track }) => !contradicts(job, track));
  const trackNumber = positive(job?.trackNumber);
  const placed = trackNumber
    ? compatible.find(
        ({ track }) => positionScore(job, track) === 3 && sameTitle(track.title, title),
      )
    : null;
  if (placed) return placed.index;
  const key = normalizeMatchText(title);
  const named = manifest.tracks.filter((track) => normalizeMatchText(track.title) === key);
  if (key && named.length === 1) {
    const entry = compatible.find(({ track }) => track === named[0]);
    if (entry) return entry.index;
  }
  return null;
}

// Places each job on one manifest track: by recording ID or a merged-away ID,
// with the job's place choosing between copies of one recording; then by its
// disc, number, and title; then by a title the manifest lists once.
export function mapRequest(manifest: PlaceableManifest | null | undefined, jobs: ManifestJob[]) {
  const wanted = new Map<number, string>();
  const offManifest: string[] = [];
  const list = Array.isArray(jobs) ? jobs : [];
  if (!manifest?.tracks?.length) return { wanted, offManifest: list.map((job) => job.id) };
  const specificity = (job: ManifestJobInput) =>
    (jobRecordings(job).length ? 2 : 0) + (positive(job?.trackNumber) ? 1 : 0);
  const ordered = list.toSorted((left, right) => specificity(right) - specificity(left));
  for (const job of ordered) {
    const index = pick(manifest, job, new Set(wanted.keys()));
    if (index == null) offManifest.push(job.id);
    else wanted.set(index, job.id);
  }
  return { wanted: new Map([...wanted].sort(([left], [right]) => left - right)), offManifest };
}

export function manifestIndexFor(
  manifest: PlaceableManifest | null | undefined,
  job: ManifestJobInput,
) {
  const { wanted } = mapRequest(manifest, [{ ...job, id: job?.id ?? "request" }]);
  return wanted.size ? [...wanted.keys()][0] : null;
}

// The validation request for one job at its place on the edition: the
// position, length, and recording come from the manifest, and the album's
// tracklist is the whole edition rather than the tracks still wanted.
export function trackRequestFor(
  job: ManifestJobInput,
  manifest: ReleaseManifest,
  index: number | null = manifestIndexFor(manifest, job),
) {
  const track = index == null ? null : manifest?.tracks?.[index];
  if (!track) return null;
  const base = buildResolvedJobTrack(job);
  const requested = jobRecordings(job);
  return {
    ...base,
    albumMbid: manifest.releaseGroupMbid || base.albumMbid,
    releaseMbid: manifest.releaseMbid,
    trackMbid: track.recordingMbid || base.trackMbid || null,
    recordingMbidAliases: unique([...track.recordingMbidAliases, ...requested]).filter(
      (entry) => id(entry) !== id(track.recordingMbid),
    ),
    durationMs: track.durationMs ?? base.durationMs ?? null,
    pressingDurationsMs: track.pressingDurationsMs || [],
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    albumTrackCount: manifest.tracks.length,
    albumTrackTitles: manifest.tracks.map((entry) => entry.title),
    secondaryTypes: manifest.secondaryTypes,
    artistAliases: unique([
      ...(base.artistAliases || []),
      ...track.artists,
      ...track.artistAliases,
    ]).filter(
      (name) =>
        !isVariousArtistsCredit(name) &&
        normalizeMatchText(name) !== normalizeMatchText(base.artistName),
    ),
  };
}

// The track as the attempt's release lists it, or as the job describes it.
export function attemptTrackRequest(
  job: ManifestJobInput,
  release: ReleaseManifest | null | undefined,
  payloadTrack: DownloadTrackFields = {},
) {
  return (release && trackRequestFor(job, release)) || buildResolvedJobTrack(job, payloadTrack);
}
