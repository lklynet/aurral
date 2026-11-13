import { db } from "../config/db-sqlite.ts";
import type { LibraryAlbumsRow } from "../db/rows.ts";
import createCache from "./apiClients/simpleCache.ts";
import { getAlbumByMbid, isMetadataNotFoundError } from "./providers/brainzmashProvider.ts";
import { invalidateLibraryQueryCache } from "./libraryQueryService.ts";
import { readLibraryMetadata, type LibraryMetadata } from "./libraryMetadata.ts";
import type { NormalizedAlbum, NormalizedRelease } from "./providers/brainzmashMappers.ts";
import {
  listsEveryTrack,
  runningOrder,
  selectAlbumRelease,
} from "./providers/brainzmashRanking.ts";
import type { DownloadTrackFields } from "./downloadUtils.ts";
import { manifestIndexFor, releasesHolding, toReleaseManifest } from "./releaseManifest.ts";

interface ResolverJob extends DownloadTrackFields {
  playlistId?: string | null;
  playlistType?: string | null;
}

type ReleaseManifest = ReturnType<typeof toReleaseManifest>;

const MANIFEST_TTL_SECONDS = 60 * 60;
// A release its group does not list is looked for again after a minute.
const MISSING_MANIFEST_TTL_SECONDS = 60;
const MAX_MANIFESTS = 64;
const UNREACHABLE = Symbol("metadata unreachable");
type LoadedManifest =
  | (NonNullable<ReleaseManifest> & { groupReleaseMbids?: string[] })
  | null
  | typeof UNREACHABLE;
const manifests = createCache<LoadedManifest | Promise<LoadedManifest>>(
  MANIFEST_TTL_SECONDS,
  MAX_MANIFESTS,
);
// How long and how often a download waits for metadata it cannot read
// before it goes on without its release.
export const RELEASE_WAIT_SECONDS = 60;
export const MAX_RELEASE_WAITS = 30;
// A group that could not be read is asked for again within every wait.
const UNREACHABLE_TTL_SECONDS = RELEASE_WAIT_SECONDS / 2;
const unreachableGroups = createCache<true>(UNREACHABLE_TTL_SECONDS, MAX_MANIFESTS);

const libraryAlbumStmt = db.prepare<
  [string, string, string],
  Pick<LibraryAlbumsRow, "metadata_json">
>(
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

const id = (value: unknown) =>
  String(value || "")
    .trim()
    .toLowerCase();

export function clearReleaseManifests() {
  manifests.flushAll();
  unreachableGroups.flushAll();
}

// Every track of an album asks for its group, so while one cannot be read
// the provider is asked for it again once in each wait, not by every track.
async function readGroup(groupMbid: string) {
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

async function loadGroup(groupMbid: string) {
  const group = await readGroup(groupMbid);
  return group === UNREACHABLE ? null : group;
}

function releaseById(
  group: NormalizedAlbum | null | undefined,
  releaseMbid: string | null | undefined,
) {
  return (group?.releases || []).find((release) => id(release?.id) === id(releaseMbid)) || null;
}

function remember(manifest: ReleaseManifest) {
  if (manifest) manifests.set(id(manifest.releaseMbid), manifest);
  return manifest;
}

// The group's releases tell a pin MusicBrainz merged away, or lists only part
// of, from one it still lists whole.
function manifestOf(group: NormalizedAlbum, release: NormalizedRelease | null | undefined) {
  const manifest = toReleaseManifest(group, release);
  return (
    manifest && {
      ...manifest,
      groupReleaseMbids: group.releases
        .filter(listsEveryTrack)
        .map((entry) => id(entry?.id))
        .filter(Boolean),
    }
  );
}

// The manifest of a release already chosen, or none, and whether that is
// because its group could not be read rather than because the group does
// not list it. A job with no release learns only whether its group reads.
// The group comes from the metadata cache, which keeps it across restarts,
// so only a cold cache asks the provider again.
export async function readReleaseManifest(
  albumMbid: string | null | undefined,
  releaseMbid: string | null | undefined,
) {
  const groupMbid = id(albumMbid);
  if (!groupMbid) return { manifest: null, unreachable: false };
  const key = id(releaseMbid) || `group:${groupMbid}`;
  let loading = manifests.get(key);
  if (loading === undefined) {
    loading = readGroup(groupMbid).then((group) =>
      group === UNREACHABLE
        ? UNREACHABLE
        : (group && manifestOf(group, releaseById(group, key))) || null,
    );
    manifests.set(key, loading);
    const loaded = await loading;
    if (loaded === UNREACHABLE) manifests.delete(key);
    else if (loaded) remember(loaded);
    else manifests.set(key, null, MISSING_MANIFEST_TTL_SECONDS);
  }
  const loaded = await loading;
  if (loaded === UNREACHABLE) return { manifest: null, unreachable: true };
  return {
    manifest: id(loaded?.releaseGroupMbid) === groupMbid ? loaded : null,
    unreachable: false,
  };
}

export async function loadReleaseManifest(
  albumMbid: string | null | undefined,
  releaseMbid: string | null | undefined,
) {
  return id(releaseMbid) ? (await readReleaseManifest(albumMbid, releaseMbid)).manifest : null;
}

// The release an attempt searches for: an album attempt keeps the one it
// was started with, and a track search uses its job's.
export function attemptRelease(
  payload: { albumGrab?: boolean; releaseMbid?: string | null } | null | undefined,
  job: ResolverJob | null | undefined,
) {
  return loadReleaseManifest(
    job?.albumMbid,
    payload?.albumGrab === true ? payload.releaseMbid : job?.releaseMbid,
  );
}

function libraryAlbum(groupMbid: string) {
  const row = libraryAlbumStmt.get(groupMbid, groupMbid, groupMbid);
  return row ? readLibraryMetadata(row.metadata_json || "{}") : null;
}

const isLibraryJob = (job: ResolverJob | null | undefined) =>
  (job?.playlistId || job?.playlistType) === "library";

// The edition a Library album asks for: the one it was added with, else the
// release its files list unless it wants the expanded edition, else the
// commonest edition of its kind.
export function chooseRequestedRelease(
  group: NormalizedAlbum,
  {
    requestedRelease = null,
    listedRelease = null,
    edition = "standard",
  }: { requestedRelease?: string | null; listedRelease?: string | null; edition?: string } = {},
) {
  const usable = (release: NormalizedRelease | null | undefined) =>
    release && listsEveryTrack(release) ? release : null;
  return (
    usable(releaseById(group, requestedRelease)) ||
    (edition !== "expanded" && usable(releaseById(group, listedRelease))) ||
    selectAlbumRelease(group, { edition })
  );
}

// The release a Library request for this album downloads unless a track
// pins another: the Library album's edition, else the standard edition. An
// album page lists it, so the release a track is added from is the album's.
export function chooseLibraryRelease(group: NormalizedAlbum) {
  return libraryRelease(group) || selectAlbumRelease(group);
}

export function libraryRelease(group: NormalizedAlbum) {
  const album = libraryAlbum(id(group?.id));
  return album ? albumEdition(group, album) : null;
}

// A release of the group that lists every track, else the Library's edition.
export function chooseAlbumEdition(group: NormalizedAlbum, releaseMbid: string | null | undefined) {
  const release = releaseById(group, releaseMbid);
  return release && listsEveryTrack(release) ? release : chooseLibraryRelease(group);
}

const isOfficial = (release: NormalizedRelease) =>
  String(release.status || "").toLowerCase() === "official";

// An album's editions are the tracklists its releases list in full, the
// official ones when it has any: pressings with the same running order are
// one edition. The standard edition comes first, then the rest by date.
export function albumEditions(group: NormalizedAlbum) {
  const standard = selectAlbumRelease(group);
  const whole = group.releases.filter(listsEveryTrack);
  const official = whole.filter(isOfficial);
  const standardOrder = standard ? runningOrder(standard) : null;
  const pressings = Map.groupBy(official.length ? official : whole, runningOrder);
  const editions = [...pressings].map(([order, releases]) => {
    const isStandard = order === standardOrder;
    const release =
      (isStandard && standard) ||
      releases.reduce((earliest, entry) =>
        (entry.releaseDate || "9999") < (earliest.releaseDate || "9999") ? entry : earliest,
      );
    return {
      id: release.id,
      name: isStandard ? "Standard" : editionName(group, release),
      date: release.releaseDate,
      trackCount: release.tracks.length,
      order,
      isStandard,
    };
  });
  return editions.sort(
    (left, right) =>
      Number(right.isStandard) - Number(left.isStandard) ||
      (left.date || "9999").localeCompare(right.date || "9999") ||
      left.trackCount - right.trackCount,
  );
}

export function editionOf(
  editions: ReturnType<typeof albumEditions>,
  release: NormalizedRelease | null | undefined,
) {
  const order = release && runningOrder(release);
  return editions.find((edition) => edition.order === order) || null;
}

function editionName(group: NormalizedAlbum, release: NormalizedRelease) {
  const title = release.title.trim();
  const named = title.toLowerCase().startsWith(group.title.toLowerCase())
    ? title.slice(group.title.length)
    : title;
  const name = named.replace(/^[\s:/([-]+|[\s)\]]+$/g, "") || release.disambiguation;
  return name ? name[0]!.toUpperCase() + name.slice(1) : "Alternate edition";
}

export function albumEdition(group: NormalizedAlbum, album: LibraryMetadata) {
  return chooseRequestedRelease(group, {
    requestedRelease: album.requestedRelease,
    listedRelease: album.trackList?.release,
    edition: album.edition === "expanded" ? "expanded" : "standard",
  });
}

// The chosen release as the group lists it: the provider's choice carries
// lengths averaged across pressings, and the manifest keeps the release's own.
function holding(
  group: NormalizedAlbum,
  release: NormalizedRelease | null | undefined,
  job: ResolverJob,
) {
  const manifest = manifestOf(group, releaseById(group, release?.id));
  return remember(manifest && manifestIndexFor(manifest, job) != null ? manifest : null);
}

// The commonest tracklist among the releases that hold the track.
function holdingRelease(group: NormalizedAlbum, job: ResolverJob) {
  const releases = releasesHolding(group, job);
  return releases.length ? selectAlbumRelease({ releases }) : null;
}

// Chooses the one exact edition a request asks for. A release the job or
// its Library album pins is that edition or nothing: a pinned edition
// without the track leaves the request unresolved instead of moving to
// another edition. A pin MusicBrainz no longer lists, as after a merge, or
// lists only part of, is chosen again, and a Library album that asked for it
// asks for the new choice from then on.
export async function resolveReleaseManifest(job: ResolverJob) {
  const groupMbid = id(job?.albumMbid);
  if (!groupMbid || !String(job?.trackName || "").trim()) return null;
  const group = await loadGroup(groupMbid);
  if (!group) return null;

  const pinned = releaseById(group, job.releaseMbid);
  if (pinned && listsEveryTrack(pinned)) return holding(group, pinned, job);
  const manifest = chooseRelease(group, groupMbid, job);
  if (
    manifest &&
    job.releaseMbid &&
    isLibraryJob(job) &&
    replaceRequestedReleaseStmt.run(
      manifest.releaseMbid,
      Date.now(),
      groupMbid,
      groupMbid,
      id(job.releaseMbid),
    ).changes > 0
  ) {
    invalidateLibraryQueryCache({ persistedGenres: false });
  }
  return manifest;
}

function chooseRelease(group: NormalizedAlbum, groupMbid: string, job: ResolverJob) {
  const album = libraryAlbum(groupMbid);
  const edition = album?.edition === "expanded" ? "expanded" : "standard";
  const requested = releaseById(group, album?.requestedRelease);
  if (isLibraryJob(job) && requested && listsEveryTrack(requested))
    return holding(group, requested, job);

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
