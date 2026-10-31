import { UUID_REGEX } from "../../../lib/uuid.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";

export interface PlaylistTrackInput {
  artistName?: unknown;
  artist?: unknown;
  artist_name?: unknown;
  trackName?: unknown;
  title?: unknown;
  name?: unknown;
  track?: unknown;
  albumName?: unknown;
  album?: unknown;
  artistMbid?: unknown;
  artistId?: unknown;
  albumMbid?: unknown;
  releaseGroupMbid?: unknown;
  albumId?: unknown;
  trackMbid?: unknown;
  recordingMbid?: unknown;
  recordingId?: unknown;
  mbid?: unknown;
  releaseMbid?: unknown;
  releaseYear?: unknown;
  year?: unknown;
  durationMs?: unknown;
  trackNumber?: unknown;
  discNumber?: unknown;
  artistAliases?: unknown;
  reason?: unknown;
  canonicalJobId?: unknown;
  libraryJobId?: unknown;
  membershipId?: unknown;
}

type PlaylistJob = PlaylistTrackInput & { id: string; createdAt?: unknown };

const positiveInteger = (value: unknown) =>
  Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

export const normalizePlaylistTrack = (track: PlaylistTrackInput | null | undefined) => {
  if (!track || typeof track !== "object" || Array.isArray(track)) return null;
  const artistName = String(track.artistName ?? track.artist ?? track.artist_name ?? "").trim();
  const trackName = String(
    track.trackName ?? track.title ?? track.name ?? track.track ?? "",
  ).trim();
  if (!artistName || !trackName) return null;
  const albumName = String(track.albumName ?? track.album ?? "").trim();
  const artistMbid = String(track.artistMbid ?? track.artistId ?? "").trim();
  const albumMbid = String(track.albumMbid ?? track.releaseGroupMbid ?? track.albumId ?? "").trim();
  const trackMbid = String(
    track.trackMbid ?? track.recordingMbid ?? track.recordingId ?? track.mbid ?? "",
  ).trim();
  const releaseMbid = String(track.releaseMbid ?? "").trim();
  const releaseYear = String(track.releaseYear ?? track.year ?? "").trim();
  const durationMs =
    track.durationMs != null && Number.isFinite(Number(track.durationMs))
      ? Math.max(0, Math.round(Number(track.durationMs)))
      : null;
  const trackNumber = positiveInteger(track.trackNumber);
  const discNumber = positiveInteger(track.discNumber);
  const artistAliases = Array.isArray(track.artistAliases)
    ? track.artistAliases.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const reason = String(track.reason ?? "").trim();
  const canonicalJobId = String(track.canonicalJobId ?? track.libraryJobId ?? "").trim();
  const membershipId = String(track.membershipId || "").trim();
  return {
    artistName,
    trackName,
    albumName: albumName || null,
    artistMbid: artistMbid || null,
    albumMbid: albumMbid || null,
    trackMbid: trackMbid || null,
    releaseYear: releaseYear || null,
    durationMs,
    artistAliases,
    reason: reason || null,
    ...(UUID_REGEX.test(releaseMbid) ? { releaseMbid } : {}),
    ...(trackNumber ? { trackNumber } : {}),
    ...(discNumber ? { discNumber } : {}),
    ...(canonicalJobId ? { canonicalJobId } : {}),
    ...(membershipId ? { membershipId } : {}),
  };
};

export const buildPlaylistTrackIdentity = (track: PlaylistTrackInput | null | undefined) =>
  [
    String(track?.artistName || "")
      .trim()
      .toLowerCase(),
    String(track?.trackName || "")
      .trim()
      .toLowerCase(),
    String(track?.albumName || "")
      .trim()
      .toLowerCase(),
    String(track?.artistMbid || "").trim(),
    String(track?.albumMbid || "").trim(),
    String(track?.trackMbid || "").trim(),
    String(track?.releaseYear || "").trim(),
  ].join("\u0001");

export const buildImportTrackIdentity = (track: PlaylistTrackInput | null | undefined) =>
  [track?.artistName, track?.trackName, track?.albumName]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .join("\u0001");

export const buildCoreTrackIdentity = (track: PlaylistTrackInput | null | undefined) => {
  const artistName = String(track?.artistName || "")
    .trim()
    .toLowerCase();
  const trackName = String(track?.trackName || "")
    .trim()
    .toLowerCase();
  if (!artistName || !trackName) return "";
  return `${artistName}\u0001${trackName}`;
};

export const tracksShareMembership = (
  left: PlaylistTrackInput | null | undefined,
  right: PlaylistTrackInput | null | undefined,
) => {
  if (buildPlaylistTrackIdentity(left) === buildPlaylistTrackIdentity(right)) {
    return true;
  }
  const leftCore = buildCoreTrackIdentity(left);
  const rightCore = buildCoreTrackIdentity(right);
  return Boolean(leftCore) && leftCore === rightCore;
};

const sortJobsByCreatedAt = <T extends PlaylistJob>(jobs: T[] | null | undefined): T[] =>
  [...(Array.isArray(jobs) ? jobs : [])].sort((left, right) => {
    const leftCreated = Number(left?.createdAt || 0);
    const rightCreated = Number(right?.createdAt || 0);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });

const pairJobsWithPlaylistTracks = <T extends PlaylistJob>(
  jobs: T[] | null | undefined,
  tracks: PlaylistTrackInput[] | null | undefined,
) => {
  const unmatchedJobs = sortJobsByCreatedAt(jobs);
  const trackList = Array.isArray(tracks) ? tracks : [];
  const takeJob = (predicate: (job: T) => boolean) => {
    const index = unmatchedJobs.findIndex(predicate);
    return index < 0 ? null : unmatchedJobs.splice(index, 1)[0];
  };
  const pairedJobs = trackList.map((track) =>
    track?.canonicalJobId ? takeJob((job) => job.id === track.canonicalJobId) : null,
  );
  trackList.forEach((track, trackIndex) => {
    if (pairedJobs[trackIndex]) return;
    const identity = buildPlaylistTrackIdentity(track);
    pairedJobs[trackIndex] =
      takeJob((job) => buildPlaylistTrackIdentity(job) === identity) ||
      takeJob((job) => tracksShareMembership(job, track));
  });
  return [
    ...pairedJobs.flatMap((job, trackIndex) => (job ? [{ job, trackIndex }] : [])),
    ...unmatchedJobs.map((job) => ({ job, trackIndex: -1 })),
  ];
};

export function playlistJobEntries(
  playlist: { id: string; tracks?: PlaylistTrackInput[] } | null | undefined,
) {
  if (!playlist) return [];
  const referencedJobs = (playlist.tracks || [])
    .map((track) =>
      track?.canonicalJobId ? downloadTracker.getJob(String(track.canonicalJobId)) : null,
    )
    .filter((job) => job !== null);
  const jobs = [...referencedJobs, ...downloadTracker.getByPlaylistType(playlist.id)];
  const uniqueJobs = jobs.filter(
    (job, index, values) => values.findIndex((candidate) => candidate.id === job.id) === index,
  );
  return pairJobsWithPlaylistTracks(uniqueJobs, playlist.tracks);
}

export const orderJobsByPlaylistTracks = <T extends PlaylistJob>(
  jobs: T[] | null | undefined,
  tracks: PlaylistTrackInput[] | null | undefined,
) => pairJobsWithPlaylistTracks(jobs, tracks).map(({ job }) => job);

export const dedupePlaylistTracks = (tracks: PlaylistTrackInput[] | null | undefined) => {
  const seen = new Set();
  const uniqueTracks = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const normalizedTrack = normalizePlaylistTrack(track);
    if (!normalizedTrack) continue;
    const identity = `${buildPlaylistTrackIdentity(normalizedTrack)}\u0001${normalizedTrack.membershipId || ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    uniqueTracks.push(normalizedTrack);
  }
  return uniqueTracks;
};

export const rebuildStaticPlaylistTracksFromJobs = (
  configTracks: PlaylistTrackInput[] | null | undefined,
  jobs: PlaylistJob[] | null | undefined,
) => {
  const jobList = Array.isArray(jobs) ? jobs : [];
  const unmatchedJobIds = new Set(jobList.map((job) => job.id));
  const remainingTracks = [];
  for (const track of dedupePlaylistTracks(configTracks)) {
    const match = jobList.find(
      (job) => unmatchedJobIds.has(job.id) && tracksShareMembership(job, track),
    );
    if (!match) continue;
    unmatchedJobIds.delete(match.id);
    remainingTracks.push(track);
  }
  for (const job of sortJobsByCreatedAt(jobList)) {
    if (!unmatchedJobIds.has(job.id)) continue;
    unmatchedJobIds.delete(job.id);
    const track = normalizePlaylistTrack({
      artistName: job?.artistName,
      trackName: job?.trackName,
      albumName: job?.albumName || null,
      artistMbid: job?.artistMbid || null,
      albumMbid: job?.albumMbid || null,
      trackMbid: job?.trackMbid || null,
      releaseYear: job?.releaseYear || null,
      durationMs: job?.durationMs || null,
      artistAliases: job?.artistAliases || [],
      reason: job?.reason || null,
      releaseMbid: job?.releaseMbid,
      trackNumber: job?.trackNumber,
      discNumber: job?.discNumber,
    });
    if (track) remainingTracks.push(track);
  }
  return remainingTracks;
};

export const filterMissingPlaylistTracks = (
  existingTracks: PlaylistTrackInput[] | null | undefined,
  incomingTracks: PlaylistTrackInput[] | null | undefined,
) => {
  const seen = new Set(
    dedupePlaylistTracks(existingTracks).map((track) => buildPlaylistTrackIdentity(track)),
  );
  const missingTracks = [];
  for (const track of Array.isArray(incomingTracks) ? incomingTracks : []) {
    const normalizedTrack = normalizePlaylistTrack(track);
    if (!normalizedTrack) continue;
    const identity = buildPlaylistTrackIdentity(normalizedTrack);
    if (seen.has(identity)) continue;
    seen.add(identity);
    missingTracks.push(normalizedTrack);
  }
  return missingTracks;
};

export type PlaylistTrack = NonNullable<ReturnType<typeof normalizePlaylistTrack>>;
