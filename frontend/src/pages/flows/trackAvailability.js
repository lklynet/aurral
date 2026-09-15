export function countAvailableTracks(tracks) {
  return tracks.filter((track) => track.status === "done" && track.streamUrl).length;
}

export function getTrackAvailability(track) {
  if (track.status === "done" && track.streamUrl) return { status: "done", label: "Available" };
  if (track.status === "pending") return { status: "pending", label: "Queued" };
  if (track.status === "downloading") return { status: "downloading", label: "Downloading" };
  if (track.status === "blocked") return { status: "blocked", label: "Needs review" };
  return { status: "failed", label: "Missing" };
}

export function getTrackSearchAction(track, showTrackAvailability = false) {
  if (track.status === "failed") return "research";
  if (track.status !== "done") return null;
  if (showTrackAvailability) return track.streamUrl ? null : "research";
  return track.qualityOwned === true && track.qualityState !== "preferred" ? "upgrade" : null;
}
