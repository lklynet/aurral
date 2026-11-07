import { db } from "../../config/db-sqlite.ts";
import { dbOps, userOps } from "../../db/helpers/index.ts";
import { getBulkOperation, saveBulkOperation } from "./bulkOperationStore.ts";
import type {
  BulkOperationOutcome,
  BulkOperationRecord,
  StaticPlaylistSelection,
} from "./bulkOperationStore.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { withPlaylistMutationLock } from "../downloadJobs/mutationGuards.ts";
import { flowPlaylistConfig, invalidateFlowPlaylistConfigCache } from "./flowPlaylistConfig.ts";
import { tracksShareMembership } from "./playlistTracks.ts";
import type { StaticPlaylist } from "./flowPlaylistConfig.ts";
import { isStaticPlaylistSelectionCurrent } from "./trackRemoval.ts";
import { linkTracksToLibrary, releaseLibraryJobs } from "./playlistLibrary.ts";
import { playlistManager } from "./playlistManager.ts";
import { isArtistBlockedForUser } from "../discovery/feedback.ts";

function persist(record: BulkOperationRecord) {
  record.updatedAt = Date.now();
  saveBulkOperation(record);
}

function persistMembership<T>(operation: () => T) {
  try {
    return db.transaction(operation)();
  } catch (error) {
    dbOps.invalidateSettingsCache();
    invalidateFlowPlaylistConfigCache();
    throw error;
  }
}

export async function processStaticPlaylistBulkOperation(operationId: unknown) {
  const record = getBulkOperation(operationId);
  if (!record || ["completed", "failed"].includes(record.state)) return;
  const user = userOps.getUserById(record.ownerUserId);
  const source =
    user?.status === "active"
      ? flowPlaylistConfig.getStaticPlaylistForUser(user, record.sourcePlaylistId)
      : null;
  if (!user || !source) throw new Error("Source playlist access is no longer available");
  record.state = "running";
  persist(record);
  let target: Pick<StaticPlaylist, "id" | "name" | "ownerUserId" | "tracks"> | null = null;
  let creatingTarget = false;
  if (record.action === "move") {
    target = flowPlaylistConfig.getStaticPlaylist(record.target.playlistId);
    if (!target && record.target.create) {
      creatingTarget = true;
      target = {
        id: record.target.playlistId,
        name: record.target.name!,
        ownerUserId: user.id,
        tracks: [],
      };
    }
    if (
      !target ||
      !flowPlaylistConfig.canUserAccessStaticPlaylist(user, target) ||
      target.id === source.id
    ) {
      throw new Error("Destination playlist access is no longer available");
    }
  }
  const destinationSaved = target ? target.id in record.synchronization : false;
  const finished = new Set(record.outcomes.map((outcome) => outcome.jobId));
  const eligible: StaticPlaylistSelection[] = [];
  const rejected: BulkOperationOutcome[] = [];
  for (const selection of record.selections.filter((entry) => !finished.has(entry.jobId))) {
    const job = downloadTracker.getJob(selection.jobId);
    if (!job || !isStaticPlaylistSelectionCurrent(selection, source, job)) {
      rejected.push({
        jobId: selection.jobId,
        status: job ? "failed" : "alreadyAbsent",
        ...(job && { message: "The selected membership changed. Select the track again." }),
      });
    } else if (
      !destinationSaved &&
      target?.tracks.some((track) => tracksShareMembership(track, job))
    ) {
      rejected.push({
        jobId: selection.jobId,
        status: "failed",
        message: "Track already in the destination. Source kept.",
      });
    } else if (target && isArtistBlockedForUser(target.ownerUserId, job)) {
      rejected.push({
        jobId: selection.jobId,
        status: "failed",
        message: "The destination owner has blocked this artist.",
      });
    } else eligible.push(selection);
  }
  const selected = (track: StaticPlaylist["tracks"][number]) =>
    eligible.some(
      (selection) =>
        track.canonicalJobId === selection.jobId &&
        (!selection.membershipId || track.membershipId === selection.membershipId),
    );
  if (target && eligible.length && !destinationSaved) {
    const destination = target;
    const linked = await linkTracksToLibrary(
      source.tracks.filter(selected).map(({ membershipId: _, ...track }) => track),
      { startedByPlaylist: destination.id, download: false },
    );
    await withPlaylistMutationLock(destination.id, () =>
      persistMembership(() => {
        const result = creatingTarget
          ? flowPlaylistConfig.createStaticPlaylist({
              id: destination.id,
              name: destination.name,
              ownerUserId: user.id,
              tracks: linked.tracks,
            })
          : flowPlaylistConfig.appendStaticPlaylistTracks(destination.id, linked.tracks);
        if (!result) throw new Error("Could not persist destination membership");
        record.synchronization[destination.id] = false;
        persist(record);
      }),
    );
  }
  await withPlaylistMutationLock(source.id, () =>
    persistMembership(() => {
      const current = flowPlaylistConfig.getStaticPlaylist(source.id);
      if (!current) throw new Error("Source playlist no longer exists");
      flowPlaylistConfig.updateStaticPlaylist(source.id, {
        tracks: current.tracks.filter((track) => !selected(track)),
      });
      record.outcomes.push(
        ...rejected,
        ...eligible.map(({ jobId }): BulkOperationOutcome =>
          target
            ? { jobId, status: "moved", targetPlaylistId: target.id }
            : { jobId, status: "removed" },
        ),
      );
      record.outcomes.sort(
        (a, b) =>
          record.selections.findIndex((selection) => selection.jobId === a.jobId) -
          record.selections.findIndex((selection) => selection.jobId === b.jobId),
      );
      if (eligible.length) record.synchronization[source.id] = false;
      persist(record);
    }),
  );
  if (!target)
    await releaseLibraryJobs(
      source.id,
      eligible.map((selection) => selection.jobId),
    );
  if (record.target?.create) await playlistManager.ensurePlaylistArtwork(record.target.playlistId);
  const unsynchronized = Object.entries(record.synchronization)
    .filter(([, synchronized]) => !synchronized)
    .map(([id]) => id);
  if (unsynchronized.length) {
    playlistManager.requestPlaylistSync(unsynchronized);
    for (const id of unsynchronized) record.synchronization[id] = true;
    persist(record);
  }
  record.state = "completed";
  delete record.message;
  persist(record);
}
