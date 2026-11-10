const TRACK_DOWNLOAD_ACTION_LABELS: Partial<Record<string, string>> = {
  submitting: "Adding to search queue…",
  pending: "Queued for search",
  processing: "Searching for track…",
  searching: "Searching for track…",
  downloading: "Downloading track…",
  moving: "Adding to library…",
  blocked: "Needs review",
  completed: "Downloaded; waiting for library refresh",
  failed: "Retry download track",
};

export const trackDownloadActionLabel = (status: string | null | undefined) =>
  TRACK_DOWNLOAD_ACTION_LABELS[status ?? ""] || "Download track";
