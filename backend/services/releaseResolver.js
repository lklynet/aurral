import { db } from "../config/db-sqlite.js";
import createCache from "./apiClients/simpleCache.js";
import { getAlbumByMbid, isMetadataNotFoundError, selectAlbumRelease } from "./providers/brainzmashProvider.js";
import { invalidateLibraryQueryCache } from "./libraryQueryService.js";
import { manifestIndexFor, releasesHolding, toReleaseManifest } from "./releaseManifest.js";

const MANIFEST_TTL_SECONDS = 60 * 60;
// A release its group does not list is looked for again after a minute.
const MISSING_MANIFEST_TTL_SECONDS = 60;
const MAX_MANIFESTS = 64;
const manifests = createCache(MANIFEST_TTL_SECONDS, MAX_MANIFESTS);
const UNREACHABLE = Symbol("metadata unreachable");
// How long and how often a download waits for metadata it cannot read
// before it goes on without its release.
export const RELEASE_WAIT_SECONDS = 60;
export const MAX_RELEASE_WAITS = 30;
// A group that could not be read is asked for again within every wait.
const UNREACHABLE_TTL_SECONDS = RELEASE_WAIT_SECONDS / 2;
const unreachableGroups = createCache(UNREACHABLE_TTL_SECONDS, MAX_MANIFESTS);

const libraryAlbumStmt = db.prepare(
  `SELECT metadata_json FROM library_albums
   WHERE lower(release_group_mbid) = ? OR lower(mbid) = ?
   ORDER BY lower(release_group_mbid) = ? DESC, id
   LIMIT 1`,
);
const replaceRequestedReleaseStmt = db.prepare(
  `UPDATE library_albums
   SET metadata_json = json_set(metadata_json, '$.requestedRelease', ?), updated_at = ?
   WHERE (lower(release_group_mbid) = ? OR lower(mbid) = ?)
     AND json_valid(metadata_json) AND lower(json_extract(metadata_json, '$.requestedRelease')) = ?`,
);

const id = (value) => String(value || "").trim().toLowerCase();

export function clearReleaseManifests() {
  manifests.flushAll();
  unreachableGroups.flushAll();
}

// Every track of an album asks for its group, so while one cannot be read
// the provider is asked for it again once in each wait, not by every track.
async function readGroup(groupMbid) {
  if (unreachableGroups.get(groupMbid)) return UNREACHABLE;
  try {
    const group = await getAlbumByMbid(groupMbid);
    return group?.releases?.length && (!group.id || id(group.id) === groupMbid) ? group : null;
  } catch (error) {
    if (isMetadataNotFoundError(error)) return null;
    unreachableGroups.set(groupMbid, true, UNREACHABLE_TTL_SECONDS);
    return UNREACHABLE;
  }
}

async function loadGroup(groupMbid) {
  const group = await readGroup(groupMbid);
  return group === UNREACHABLE ? null : group;
}

function releaseById(group, releaseMbid) {
  return (group?.releases || []).find((release) => id(release?.id) === id(releaseMbid)) || null;
}

function remember(manifest) {
  if (manifest) manifests.set(id(manifest.releaseMbid), manifest);
  return manifest;
}

// The group's releases tell a pin MusicBrainz merged away from one it still
// lists.
function manifestOf(group, release) {
  const manifest = toReleaseManifest(group, release);
  return manifest && { ...manifest, groupReleaseMbids: group.releases.map((entry) => id(entry?.id)).filter(Boolean) };
}

// The manifest of a release already chosen, or none, and whether that is
// because its group could not be read rather than because the group does
// not list it. A job with no release learns only whether its group reads.
// The group comes from the metadata cache, which keeps it across restarts,
// so only a cold cache asks the provider again.
export async function readReleaseManifest(albumMbid, releaseMbid) {
  const groupMbid = id(albumMbid);
  if (!groupMbid) return { manifest: null, unreachable: false };
  const key = id(releaseMbid) || `group:${groupMbid}`;
  let loading = manifests.get(key);
  if (loading === undefined) {
    loading = readGroup(groupMbid).then((group) => (group === UNREACHABLE ? UNREACHABLE
      : (group && manifestOf(group, releaseById(group, key))) || null));
    manifests.set(key, loading);
    const loaded = await loading;
    if (loaded === UNREACHABLE) manifests.delete(key);
    else if (loaded) remember(loaded);
    else manifests.set(key, null, MISSING_MANIFEST_TTL_SECONDS);
  }
  const loaded = await loading;
  if (loaded === UNREACHABLE) return { manifest: null, unreachable: true };
  return { manifest: id(loaded?.releaseGroupMbid) === groupMbid ? loaded : null, unreachable: false };
}

export async function loadReleaseManifest(albumMbid, releaseMbid) {
  return id(releaseMbid) ? (await readReleaseManifest(albumMbid, releaseMbid)).manifest : null;
}

// The release an attempt searches for: an album attempt keeps the one it
// was started with, and a track search uses its job's.
export function attemptRelease(payload, job) {
  return loadReleaseManifest(job?.albumMbid, payload?.albumGrab === true ? payload.releaseMbid : job?.releaseMbid);
}

function libraryAlbum(groupMbid) {
  try {
    const row = libraryAlbumStmt.get(groupMbid, groupMbid, groupMbid);
    const metadata = row ? JSON.parse(row.metadata_json || "{}") : null;
    return metadata && typeof metadata === "object" ? metadata : null;
  } catch {
    return null;
  }
}

const isLibraryJob = (job) => (job?.playlistId || job?.playlistType) === "library";

// The edition a Library album asks for: the one it was added with, else the
// release its files list unless it wants the expanded edition, else the
// commonest edition of its kind.
export function chooseRequestedRelease(group, { requestedRelease = null, listedRelease = null, edition = "standard" } = {}) {
  const usable = (release) => (release?.tracks?.length ? release : null);
  return usable(releaseById(group, requestedRelease))
    || (edition !== "expanded" && usable(releaseById(group, listedRelease)))
    || selectAlbumRelease(group, { edition });
}

// The release a Library request for this album downloads unless a track
// pins another: the Library album's edition, else the standard edition. An
// album page lists it, so the release a track is added from is the album's.
export function chooseLibraryRelease(group) {
  const album = libraryAlbum(id(group?.id));
  return album ? albumEdition(group, album) : selectAlbumRelease(group);
}

function albumEdition(group, album) {
  return chooseRequestedRelease(group, { requestedRelease: album.requestedRelease,
    listedRelease: album.trackList?.release, edition: album.edition === "expanded" ? "expanded" : "standard" });
}

// The chosen release as the group lists it: the provider's choice carries
// lengths averaged across pressings, and the manifest keeps the release's own.
function holding(group, release, job) {
  const manifest = manifestOf(group, releaseById(group, release?.id));
  return remember(manifest && manifestIndexFor(manifest, job) != null ? manifest : null);
}

// The commonest tracklist among the releases that hold the track.
function holdingRelease(group, job) {
  const releases = releasesHolding(group, job);
  return releases.length ? selectAlbumRelease({ releases }) : null;
}

// Chooses the one exact edition a request asks for. A release the job or
// its Library album pins is that edition or nothing: a pinned edition
// without the track leaves the request unresolved instead of moving to
// another edition. A pin MusicBrainz no longer lists, as after a merge, is
// chosen again, and a Library album that asked for it asks for the new
// choice from then on.
export async function resolveReleaseManifest(job) {
  const groupMbid = id(job?.albumMbid);
  if (!groupMbid || !String(job?.trackName || "").trim()) return null;
  const group = await loadGroup(groupMbid);
  if (!group) return null;

  const pinned = releaseById(group, job.releaseMbid);
  if (pinned) return holding(group, pinned, job);
  const manifest = chooseRelease(group, groupMbid, job);
  if (manifest && job.releaseMbid && isLibraryJob(job)
    && replaceRequestedReleaseStmt.run(manifest.releaseMbid, Date.now(), groupMbid, groupMbid, id(job.releaseMbid)).changes > 0) {
    invalidateLibraryQueryCache({ persistedGenres: false });
  }
  return manifest;
}

function chooseRelease(group, groupMbid, job) {
  const album = libraryAlbum(groupMbid);
  const edition = album?.edition === "expanded" ? "expanded" : "standard";
  const requested = releaseById(group, album?.requestedRelease);
  if (isLibraryJob(job) && requested) return holding(group, requested, job);

  const candidates = [
    album && (isLibraryJob(job) || requested) ? albumEdition(group, album) : null,
    selectAlbumRelease(group, { edition: isLibraryJob(job) ? edition : "standard" }),
  ].filter(Boolean);
  for (const release of candidates) {
    const manifest = holding(group, release, job);
    if (manifest) return manifest;
  }
  const held = holdingRelease(group, job);
  return held ? holding(group, held, job) : null;
}
