export type PlaylistTrackStatus =
  | "pending"
  | "downloading"
  | "cancel_requested"
  | "cancelled"
  | "done"
  | "failed"
  | "blocked"
  | "saved";

export interface PlaylistTrack {
  id: string;
  trackName?: string | null;
  status: PlaylistTrackStatus;
  streamUrl?: string | null;
  qualityOwned?: boolean;
  qualityState?: string | null;
  libraryOwned?: boolean;
}

export function countAvailableTracks(tracks: PlaylistTrack[]) {
  return tracks.filter((track) => track.status === "done" && track.streamUrl).length;
}

export function getTrackAvailability(track: PlaylistTrack) {
  if (track.status === "done" && track.streamUrl) return { status: "done", label: "Available" };
  if (track.status === "pending") return { status: "pending", label: "Queued" };
  if (track.status === "downloading") return { status: "downloading", label: "Downloading" };
  if (track.status === "blocked") return { status: "blocked", label: "Needs review" };
  if (track.status === "saved") return { status: "pending", label: "Details only" };
  return { status: "failed", label: "Missing" };
}

export function getTrackSearchAction(track: PlaylistTrack, showTrackAvailability = false) {
  if (track.status === "failed" || track.status === "saved") return "research";
  if (track.status !== "done") return null;
  if (showTrackAvailability) return track.streamUrl ? null : "research";
  return track.qualityOwned === true && track.qualityState !== "preferred" ? "upgrade" : null;
}

export function shouldShowAddToLibrary(
  track: PlaylistTrack | null | undefined,
  onAddToLibrary: unknown,
) {
  return typeof onAddToLibrary === "function" && track?.libraryOwned !== true;
}
