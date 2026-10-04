import { getAlbumByMbid } from "./providers/brainzmashProvider.js";
import { normalizeMatchText } from "./trackMatching/nativeMatcher.js";
import { isVariousArtistsCredit } from "./trackMatching/titleText.js";

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// A compilation names each track's artist, or still credits "Various
// Artists"; its folders and release names carry the album title only.
export function isCompilationJobs(jobs) {
  const artists = new Set(jobs.map((job) => normalizeMatchText(job.artistName)).filter(Boolean));
  return artists.size > 1 || jobs.some((job) => isVariousArtistsCredit(job.artistName));
}

export function jobReleaseTrack(job) {
  return {
    title: job.trackName,
    artists: [job.artistName].filter(Boolean),
    artistAliases: job.artistAliases || [],
    durationMs: job.durationMs,
    trackNumber: job.trackNumber,
    recordingMbid: job.trackMbid,
  };
}

// Every release of the album's release group, so a download can match the
// edition it actually is. An unavailable lookup leaves only the tracklist
// stored on the jobs.
export async function loadAlbumReleases(albumMbid) {
  const id = String(albumMbid || "").trim();
  if (!MBID_PATTERN.test(id)) return [];
  try {
    const album = await getAlbumByMbid(id);
    return (album?.releases || [])
      .filter((release) => release?.tracks?.length > 0)
      .map((release) => ({
        id: release.id,
        tracks: release.tracks.map((track) => ({
          title: track.title,
          durationMs: track.durationMs,
          trackNumber: track.trackPosition ?? track.trackNumber,
          recordingMbid: track.recordingId,
        })),
      }));
  } catch {
    return [];
  }
}

// Lines a release up with the requested jobs: each job takes the release
// track with its recording ID, or else its title, when only one track has it.
export function releaseTracksForJobs(release, jobs) {
  const byRecording = new Map();
  const byTitle = new Map();
  for (const track of release.tracks) {
    const recording = String(track.recordingMbid || "").toLowerCase();
    if (recording) byRecording.set(recording, byRecording.has(recording) ? null : track);
    const title = normalizeMatchText(track.title);
    byTitle.set(title, byTitle.has(title) ? null : track);
  }
  return jobs.map((job) => {
    const track = byRecording.get(String(job.trackMbid || "").toLowerCase())
      || byTitle.get(normalizeMatchText(job.trackName));
    return {
      ...jobReleaseTrack(job),
      durationMs: track?.durationMs || job.durationMs,
      trackNumber: track ? track.trackNumber : null,
      onRelease: Boolean(track),
    };
  });
}

// Popular albums have dozens of releases with the same tracklist. Releases
// that line the requested tracks up the same way fit every folder the same
// way, so only the first of them is kept.
// Each candidate also says whether every one of its tracks was requested,
// so a download that fills it is that whole edition.
export function candidateReleasesForJobs(jobs, releases = []) {
  const seen = new Set();
  return [
    { id: null, tracks: jobs.map((job) => ({ ...jobReleaseTrack(job), onRelease: true })), titles: null,
      requestedAll: true },
    ...releases.map((release) => {
      const tracks = releaseTracksForJobs(release, jobs);
      return {
        id: release.id,
        tracks,
        titles: release.tracks.map((track) => track.title),
        requestedAll: tracks.filter((track) => track.onRelease).length === release.tracks.length,
      };
    }),
  ].filter((release) => {
    const key = release.tracks
      .map((track) => `${track.trackNumber ?? ""}:${Math.round(Number(track.durationMs || 0) / 1000)}`)
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
