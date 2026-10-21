import { db } from "../config/db-sqlite.ts";
import { dbOps } from "../db/helpers/index.ts";
import type { AurralHistoryEntry } from "../db/helpers/history.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";

type AlbumGrabJob = {
  id: string;
  managedBy?: string | null;
  playlistType?: string | null;
  requestGroupId?: string | null;
  albumMbid?: string | null;
  albumName?: string | null;
  artistName?: string | null;
  trackMbid?: string | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  trackName?: string | null;
  createdAt: number;
  status: string;
  error?: string | null;
  completedAt?: string | number | null;
  downloadSource?: string | null;
  downloadClient?: string | null;
};

type AlbumGrabPayload = {
  jobId: string;
  albumGrab?: boolean;
  albumGroupJobIds?: string[];
  phase?: string;
  source?: string | null;
};

type AlbumGrabManifest = {
  id: string;
  requestGroupId: string;
  albumMbid: string;
  memberJobIds: string[];
  requestedAt: string | null;
  phase: string;
  source: string | null;
  fallbackReason: string | null;
  completedAt?: string | null;
};

type TrackMetadata = {
  albumGrabId?: string;
  previousErrors?: (string | null)[];
  actualDownloadSource?: string | null;
  downloadMethod?: string | null;
  completedAt?: string | null;
  discNumber?: number | null;
};

type HistoryEntryOf<Metadata> = Omit<AurralHistoryEntry, "metadata"> & {
  id: string;
  metadata: Metadata;
};

const trackHistoryId = (jobId: string) => `aurral-track_download-${jobId}`;

export function getAlbumGrabActivity(jobId: string) {
  const id = (
    dbOps.getAurralHistoryById(trackHistoryId(jobId)) as HistoryEntryOf<TrackMetadata | null> | null
  )?.metadata?.albumGrabId;
  return id
    ? (dbOps.getAurralHistoryById(id) as HistoryEntryOf<AlbumGrabManifest> | null)?.metadata || null
    : null;
}

export function recordAlbumGrabQueued(
  payload: AlbumGrabPayload | null | undefined,
  jobs: AlbumGrabJob[],
) {
  if (payload?.albumGrab !== true || !Array.isArray(payload.albumGroupJobIds)) return;
  const leader = jobs.find((job) => job.id === payload.jobId);
  if (
    !leader ||
    leader.managedBy !== "aurral" ||
    leader.playlistType !== "library" ||
    !leader.requestGroupId ||
    !leader.albumMbid
  )
    return;
  const members = payload.albumGroupJobIds
    .map((id) => jobs.find((job) => job.id === id))
    .filter(
      (job) =>
        job &&
        job.managedBy === "aurral" &&
        job.playlistType === "library" &&
        job.requestGroupId === leader.requestGroupId &&
        job.albumMbid === leader.albumMbid,
    ) as AlbumGrabJob[];
  if (members.length < 2) return;
  try {
    const previous = getAlbumGrabActivity(leader.id);
    const id = previous?.id || `aurral-album_grab-${leader.id}`;
    const requestedAt =
      previous?.requestedAt ||
      new Date(Math.min(...members.map((job) => job.createdAt))).toISOString();
    const manifest = previous || {
      id,
      requestGroupId: leader.requestGroupId,
      albumMbid: leader.albumMbid,
      memberJobIds: members.map((job) => job.id),
      requestedAt,
      phase: "search",
      source: null,
      fallbackReason: null,
    };
    dbOps.insertAurralHistory({
      id,
      kind: "album_grab",
      title: leader.albumName || "Album download",
      status: "processing",
      metadata: manifest,
      createdAt: Date.now(),
    });
    for (const job of members) {
      const existing = dbOps.getAurralHistoryById(
        trackHistoryId(job.id),
      ) as HistoryEntryOf<TrackMetadata | null> | null;
      const position = job.trackMbid
        ? db
            .prepare<
              [
                string | null | undefined,
                string | null | undefined,
                string | null | undefined,
                number,
              ],
              { discNumber: number; trackNumber: number }
            >(`
        SELECT relation.disc_number AS discNumber, relation.track_number AS trackNumber
        FROM library_album_tracks relation
        JOIN library_albums album ON album.id = relation.album_id
        JOIN library_tracks track ON track.id = relation.track_id
        WHERE (album.mbid = ? OR album.release_group_mbid = ?) AND track.mbid = ?
          AND relation.track_number = ?
        ORDER BY relation.disc_number LIMIT 1
      `)
            .get(job.albumMbid, job.albumMbid, job.trackMbid, job.trackNumber || 0)
        : null;
      dbOps.insertAurralHistory({
        ...existing,
        id: trackHistoryId(job.id),
        kind: "track_download",
        title: existing?.title || `Queued ${job.trackName}`,
        status: existing?.status || "pending",
        statusLabel: existing?.statusLabel || "Queued",
        createdAt: existing?.createdAt || job.createdAt,
        metadata: {
          ...existing?.metadata,
          jobId: job.id,
          playlistId: "library",
          trackName: job.trackName,
          artistName: job.artistName,
          albumName: job.albumName,
          discNumber:
            job.discNumber || position?.discNumber || existing?.metadata?.discNumber || null,
          trackNumber: position?.trackNumber || job.trackNumber,
          albumGrabId: id,
          requestedAt,
        },
      });
    }
  } catch (error) {
    logger.warn("history", "Could not record album download activity", {
      reason: safeLogDiagnostic(error),
    });
  }
}

export function recordAlbumTrackState(job: AlbumGrabJob, importedSource: string | null = null) {
  try {
    const existing = dbOps.getAurralHistoryById(
      trackHistoryId(job.id),
    ) as HistoryEntryOf<TrackMetadata | null> | null;
    if (!existing?.metadata?.albumGrabId) return;
    const manifest = dbOps.getAurralHistoryById(
      existing.metadata.albumGrabId,
    ) as HistoryEntryOf<AlbumGrabManifest> | null;
    if (!manifest) return;
    const status =
      job.status === "done"
        ? "completed"
        : ["downloading", "cancel_requested"].includes(job.status)
          ? "processing"
          : job.status;
    const previousErrors = [
      ...new Set([...(existing.metadata.previousErrors || []), job.error].filter(Boolean)),
    ].slice(-10);
    const statusLabel = {
      completed: "Downloaded",
      failed: "Failed",
      cancelled: "Cancelled",
      blocked: "Review",
      pending: "Queued",
      processing: "Downloading",
    }[status];
    dbOps.insertAurralHistory({
      ...existing,
      status,
      statusLabel,
      title: `${statusLabel} ${job.trackName}`,
      subtitle: job.error || `${job.artistName} · library`,
      createdAt: Date.now(),
      metadata: {
        ...existing.metadata,
        previousErrors,
        actualDownloadSource:
          importedSource ||
          job.downloadSource ||
          (status === "completed" ? existing.metadata.actualDownloadSource : null) ||
          null,
        completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
        downloadMethod: importedSource
          ? "album"
          : status === "completed"
            ? existing.metadata.downloadMethod || "track"
            : null,
        downloadSource: importedSource || job.downloadSource || null,
        downloadClient: job.downloadClient || null,
      },
    });
    const members = manifest.metadata.memberJobIds.map((id) =>
      dbOps.getAurralHistoryById(trackHistoryId(id)),
    );
    const terminal = members.every(
      (entry) => entry && ["completed", "failed", "cancelled"].includes(entry.status),
    );
    dbOps.insertAurralHistory({
      ...manifest,
      createdAt: Date.now(),
      metadata: {
        ...manifest.metadata,
        completedAt: terminal
          ? new Date(
              Math.max(
                ...(members as NonNullable<(typeof members)[number]>[]).map(
                  (entry) => Date.parse(entry.metadata.completedAt) || entry.createdAt,
                ),
              ),
            ).toISOString()
          : null,
      },
    });
  } catch (error) {
    logger.warn("history", "Could not record album track outcome", {
      reason: safeLogDiagnostic(error),
    });
  }
}

export function recordAlbumGrabPhase(
  payload: AlbumGrabPayload,
  fallbackReason: string | null = null,
) {
  try {
    const activity = getAlbumGrabActivity(payload?.jobId);
    if (!activity) return;
    const existing = dbOps.getAurralHistoryById(activity.id)!;
    dbOps.insertAurralHistory({
      ...existing,
      createdAt: Date.now(),
      metadata: {
        ...activity,
        phase: fallbackReason ? "tracks" : payload.phase,
        source: payload.source || activity.source,
        fallbackReason: fallbackReason || activity.fallbackReason,
      },
    });
  } catch (error) {
    logger.warn("history", "Could not record album download phase", {
      reason: safeLogDiagnostic(error),
    });
  }
}

export function expandAlbumGrabHistory(
  entries: AurralHistoryEntry[],
  since: number,
  canViewEntry: (entry: AurralHistoryEntry) => boolean,
) {
  const expanded = new Map(
    entries.map((entry): [string | null, AurralHistoryEntry] => [entry.id, entry]),
  );
  const manifests = new Map<string, AlbumGrabManifest>();
  for (const entry of entries) {
    const id =
      entry.kind === "album_grab"
        ? entry.id
        : (entry.metadata as TrackMetadata | null)?.albumGrabId;
    if (!id || manifests.has(id)) continue;
    const manifest = (dbOps.getAurralHistoryById(id) as HistoryEntryOf<AlbumGrabManifest> | null)
      ?.metadata;
    if (manifest) manifests.set(id, manifest);
  }
  for (const manifest of manifests.values()) {
    const visibleMemberJobIds: string[] = [];
    for (const jobId of manifest.memberJobIds) {
      const id = trackHistoryId(jobId);
      const entry = expanded.get(id) || dbOps.getAurralHistoryById(id);
      if (entry && !canViewEntry(entry)) continue;
      visibleMemberJobIds.push(jobId);
      if (entry && entry.createdAt >= since) expanded.set(id, entry);
    }
    manifest.memberJobIds = visibleMemberJobIds;
  }
  return { entries: [...expanded.values()], manifests };
}
