import { useMemo } from "react";
import { hasDownloadWorkerActivity, hasReviewActivity } from "./playlistStats";
import { usePlaylistStatusQuery } from "./usePlaylistStatusQuery";

export function useDownloadWorkerActivity({ enabled = true } = {}) {
  const { data: status } = usePlaylistStatusQuery({ enabled });

  const hasActivity = useMemo(() => hasDownloadWorkerActivity(status), [status]);
  const hasReview = useMemo(() => hasReviewActivity(status), [status]);

  return { hasActivity, hasReview, status };
}
