import { randomUUID } from "node:crypto";
import { db } from "../../config/db-sqlite.ts";
import type { LibraryTracksRow } from "../../db/rows.ts";
import {
  findSharedTrack,
  parseShareManifest,
  type SharedTrack,
} from "../../../lib/shareManifest.ts";
import { getLibraryForTrackMatches } from "../libraryQueryService.ts";
import { selectCanonicalFile } from "../canonicalFileSelector.ts";
import {
  buildFallbackIdentityKey,
  buildIdentityKey,
  linkLibraryAlbumTrack,
  upsertLibraryAlbum,
  upsertLibraryArtist,
  upsertLibraryTrack,
} from "../libraryMediaStore.ts";
import { getLibraryManagementEntry, setLibraryManagement } from "../libraryManagementStore.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { playlistManager } from "../playlists/playlistManager.ts";
import { wakeDownloadWorker } from "../downloadJobs/mutationGuards.ts";
import { recordTrackJobQueued } from "../aurralHistoryService.ts";
import { userOps } from "../../db/helpers/index.ts";
import { loadRemoteShare } from "./remote.ts";
import { saveShareDownload, getShareDownload } from "./downloadStore.ts";
import { findQueuedLibraryTrackJob } from "../libraryTrackRequests.ts";

export function toImportTrack(track: SharedTrack) {
  return { ...track, trackName: track.title, albumName: track.albumTitle };
}

export function findShareLocalFiles(tracks: SharedTrack[]) {
  const library = getLibraryForTrackMatches({
    availableOnly: true,
    mbids: tracks.map((track) => track.trackMbid),
    titles: tracks.map((track) => track.title),
  });
  return tracks.map((track) => {
    const local = library.tracks.find(
      (entry) =>
        (track.trackMbid
          ? track.trackMbid === entry.mbid
          : track.title.toLowerCase() === entry.title.toLowerCase() &&
            track.artistName.toLowerCase() === (entry.artistName || "").toLowerCase() &&
            (!track.albumTitle ||
              entry.albums.some((album) =>
                library.albums.some(
                  (release) =>
                    release.id === album.albumId &&
                    release.title.toLowerCase() === track.albumTitle!.toLowerCase(),
                ),
              ))) && entry.files.some((file) => file.available && file.source !== "flow"),
    );
    return (
      selectCanonicalFile(
        local?.files.filter((file) => file.available && file.source !== "flow") || [],
      ) || null
    );
  });
}

function retainUnmonitored(kind: string, id: number) {
  if (!getLibraryManagementEntry(kind, id))
    setLibraryManagement({
      entityKind: kind,
      entityId: id,
      managedBy: "aurral",
      monitorMode: "none",
    });
}

function saveArtist(name: string, mbid: string | null) {
  const artist = upsertLibraryArtist({
    identityKey: mbid ? buildIdentityKey("mbid", mbid) : buildFallbackIdentityKey("artist", name),
    mbid,
    name,
  });
  retainUnmonitored("artist", artist.id);
  return artist;
}

function saveTrack(track: SharedTrack) {
  const artist = saveArtist(track.albumArtistName, track.artistMbid);
  const album = upsertLibraryAlbum({
    identityKey: track.albumMbid
      ? buildIdentityKey("release-group", track.albumMbid)
      : track.releaseMbid
        ? buildIdentityKey("album", track.releaseMbid)
        : buildFallbackIdentityKey("album", artist.identity_key, track.albumTitle || "Singles"),
    artistId: artist.id,
    title: track.albumTitle || "Singles",
    mbid: track.releaseMbid,
    releaseGroupMbid: track.albumMbid,
    albumArtist: track.albumArtistName,
  });
  retainUnmonitored("album", album.id);
  const identityKey = track.trackMbid
    ? buildIdentityKey("recording", track.trackMbid)
    : buildFallbackIdentityKey(
        "track",
        album.identity_key,
        track.discNumber,
        track.trackNumber || 0,
        track.title,
      );
  const existing = db
    .prepare<[string | null], Pick<LibraryTracksRow, "monitored">>(
      "SELECT monitored FROM library_tracks WHERE identity_key = ?",
    )
    .get(identityKey);
  const saved = upsertLibraryTrack({
    identityKey,
    mbid: track.trackMbid,
    title: track.title,
    artistName: track.artistName,
    monitored: existing?.monitored === 1,
  });
  linkLibraryAlbumTrack({
    albumId: album.id,
    trackId: saved.id,
    trackNumber: track.trackNumber || 0,
    discNumber: track.discNumber,
    keepPosition: true,
  });
  return { artist, album, track: saved };
}

export async function importShare(payload: Record<string, unknown>) {
  const manifest = parseShareManifest(payload.manifest);
  const owner = userOps.getUserById(Number(payload.ownerUserId));
  if (!manifest || owner?.status !== "active") return { skipped: true };
  const includeFiles = payload.includeFiles === true;
  const remote = includeFiles ? await loadRemoteShare(payload.url) : null;
  if (includeFiles && !remote?.files)
    throw new Error("The sender's files are unavailable or downloads are no longer allowed.");
  const localFiles = findShareLocalFiles(manifest.tracks);
  let to = "/library";
  let playlist =
    manifest.kind === "playlist"
      ? flowPlaylistConfig.getStaticPlaylist(String(payload.playlistId))
      : null;
  const ownerId =
    playlist?.id || (manifest.kind === "playlist" ? String(payload.playlistId) : "library");
  const jobIds: string[] = [];
  if (manifest.kind === "playlist" && playlist) {
    for (const job of downloadTracker.getByPlaylistType(playlist.id)) {
      if (job.status === "pending" && getShareDownload(job.id))
        downloadTracker.enqueueDownloadPipeline(job.id);
    }
    await wakeDownloadWorker();
    return { to: `/library/playlists/${playlist.id}` };
  }
  const savedTracks = db.transaction(() => {
    if (manifest.kind === "artist") {
      const artist = saveArtist(manifest.artistName, manifest.artistMbid);
      to = `/library/artist/${artist.id}`;
      if (!includeFiles) return [];
    } else if (manifest.kind === "album") {
      const artist = saveArtist(manifest.artistName, manifest.artistMbid);
      const album = upsertLibraryAlbum({
        identityKey: manifest.albumMbid
          ? buildIdentityKey("release-group", manifest.albumMbid)
          : buildFallbackIdentityKey("album", artist.identity_key, manifest.title),
        artistId: artist.id,
        title: manifest.title,
        releaseGroupMbid: manifest.albumMbid,
      });
      retainUnmonitored("album", album.id);
      to = `/library/album/${album.id}`;
    }
    return manifest.tracks.map((track, index) => {
      if (manifest.kind !== "playlist") {
        const saved = saveTrack(track);
        if (manifest.kind === "track") to = `/library/album/${saved.album.id}`;
      }
      const input = toImportTrack(track);
      if (manifest.kind !== "playlist" && (!includeFiles || localFiles[index])) return input;
      const file = track.path
        ? remote?.files?.tracks.find((entry) => entry.path === track.path)
        : findSharedTrack(remote?.files?.tracks || [], track);
      if (manifest.kind !== "playlist" && (!file?.path || findQueuedLibraryTrackJob(input)))
        return input;
      const jobId = downloadTracker.addJob(input, ownerId);
      if (!jobId) throw new Error("The shared track is incomplete.");
      const local = localFiles[index];
      if (local)
        downloadTracker.setDone(jobId, local.path, track.albumTitle, null, {
          reusedLibraryFile: true,
        });
      else if (includeFiles && file?.path) {
        saveShareDownload(jobId, remote!.url, file.path);
        downloadTracker.updateDownloadMetadata(jobId, { downloadSource: "share" });
        jobIds.push(jobId);
      } else downloadTracker.setSaved(jobId);
      return { ...input, canonicalJobId: jobId, membershipId: randomUUID() };
    });
  })();
  if (manifest.kind === "playlist") {
    const names = new Set(
      [
        ...flowPlaylistConfig.getStaticPlaylistsForUser(owner),
        ...flowPlaylistConfig.getFlowsForUser(owner),
      ].map((entry) => entry.name.toLowerCase()),
    );
    const requestedName = String(payload.name || manifest.title);
    let name = requestedName;
    for (let copy = 2; names.has(name.toLowerCase()); copy += 1)
      name = `${requestedName} (${copy})`;
    playlist = flowPlaylistConfig.createStaticPlaylist({
      id: ownerId,
      name,
      ownerUserId: owner.id,
      sourceName: "Aurral share",
      tracks: savedTracks,
    });
    to = `/library/playlists/${playlist.id}`;
  }
  for (const jobId of jobIds) {
    recordTrackJobQueued(downloadTracker.getJob(jobId), owner);
    downloadTracker.enqueueDownloadPipeline(jobId);
  }
  playlistManager.updateConfig();
  if (playlist) playlistManager.requestPlaylistSync([playlist.id]);
  if (jobIds.length) await wakeDownloadWorker();
  return { to, downloaded: jobIds.length };
}
