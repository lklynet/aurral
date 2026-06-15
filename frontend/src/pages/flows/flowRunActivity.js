const GENERATION_ACTIONS = new Set(["enable", "scheduled", "manual-start"]);
const CLEANUP_ACTIONS = new Set(["disable", "delete", "reset"]);

export function parseOperationQueueLabel(label) {
  const trimmed = String(label || "").trim();
  if (!trimmed.includes(":")) {
    return { action: trimmed, flowId: "" };
  }
  const index = trimmed.indexOf(":");
  return {
    action: trimmed.slice(0, index),
    flowId: trimmed.slice(index + 1),
  };
}

export function getPlaylistRunActivity({
  playlistId,
  kind = "flow",
  enabled = true,
  status = null,
  stats = null,
  rerunning = false,
  togglingToEnabled = null,
  addingTrack = false,
  reSearchingCount = 0,
} = {}) {
  if (!playlistId) return null;

  if (togglingToEnabled === true) {
    return { message: "Enabling flow…", phase: "preparing" };
  }

  if (togglingToEnabled === false) {
    return { message: "Disabling flow…", phase: "preparing" };
  }

  if (addingTrack) {
    return { message: "Adding track…", phase: "preparing" };
  }

  if (reSearchingCount > 0) {
    return {
      message:
        reSearchingCount === 1
          ? "Re-searching track…"
          : `Re-searching ${reSearchingCount} tracks…`,
      phase: "searching",
    };
  }

  const operationQueue = status?.operationQueue;
  const queueProcessing = operationQueue?.processing === true;
  const { action: queueAction, flowId: queueFlowId } = parseOperationQueueLabel(
    operationQueue?.currentLabel,
  );
  const queueTargetsThisPlaylist = queueFlowId === playlistId;
  const hintPhase = String(status?.hint?.phase || "").trim();
  const hintMessage = String(status?.hint?.message || "").trim();
  const currentJob = status?.worker?.currentJob;
  const isCurrentJobForPlaylist =
    currentJob?.playlistType === playlistId &&
    currentJob?.artistName &&
    currentJob?.trackName;
  const pendingCount = Number(stats?.pending || 0);
  const downloadingCount = Number(stats?.downloading || 0);
  const doneCount = Number(stats?.done || 0);
  const isGeneratingThisPlaylist =
    queueProcessing &&
    GENERATION_ACTIONS.has(queueAction) &&
    queueTargetsThisPlaylist;
  const isQueueCleanupThisPlaylist =
    queueProcessing &&
    CLEANUP_ACTIONS.has(queueAction) &&
    queueTargetsThisPlaylist;

  if (kind === "flow" && !enabled && !rerunning && !isQueueCleanupThisPlaylist) {
    return null;
  }

  if (rerunning || isGeneratingThisPlaylist) {
    return { message: "Generating playlist…", phase: "generating" };
  }

  if (isCurrentJobForPlaylist) {
    const progressPct = Math.max(
      0,
      Math.min(100, Math.round(Number(currentJob?.progressPct || 0))),
    );
    return {
      message: `Downloading: ${currentJob.trackName} (${progressPct}%)`,
      phase: "downloading",
    };
  }

  if (isQueueCleanupThisPlaylist) {
    return { message: "Cleaning flow files…", phase: "cleaning" };
  }

  if (pendingCount > 0 || downloadingCount > 0) {
    const total = pendingCount + downloadingCount + doneCount;
    if (downloadingCount > 0) {
      return {
        message: `Downloading tracks (${doneCount} of ${total})`,
        phase: "downloading",
      };
    }
    return {
      message: "Tracks queued and waiting…",
      phase: "queued",
    };
  }

  if (
    queueProcessing &&
    queueTargetsThisPlaylist &&
    hintMessage &&
    hintPhase !== "completed"
  ) {
    return {
      message: hintMessage.endsWith("…") ? hintMessage : `${hintMessage}…`,
      phase: hintPhase || "preparing",
    };
  }

  return null;
}

export function getFlowRunActivity(options = {}) {
  return getPlaylistRunActivity({
    ...options,
    playlistId: options.flowId || options.playlistId,
  });
}
