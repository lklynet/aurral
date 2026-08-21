import { useMemo } from "react";
import { hasFlowWorkerActivity, hasReviewActivity } from "./flowStats";
import { usePlaylistStatusQuery } from "./usePlaylistStatusQuery";

export function useFlowWorkerActivity({ enabled = true } = {}) {
  const { data: status } = usePlaylistStatusQuery({ enabled });

  const hasActivity = useMemo(() => hasFlowWorkerActivity(status), [status]);
  const hasReview = useMemo(() => hasReviewActivity(status), [status]);

  return { hasActivity, hasReview, status };
}
