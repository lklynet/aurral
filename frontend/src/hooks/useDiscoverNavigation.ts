import { useCallback } from "react";
import { useLocation, useNavigate, type NavigateOptions, type To } from "react-router";
import { useDiscoverRecent } from "../contexts/DiscoverRecentProvider";
import { shouldTrackDiscoverPath } from "../utils/discoverRecentNavigation";

export function useDiscoverNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { addRecentPage, shouldRecordNavigation } = useDiscoverRecent();

  return useCallback(
    (to: To, options?: NavigateOptions) => {
      if (
        typeof to === "string" &&
        shouldTrackDiscoverPath(to) &&
        shouldRecordNavigation(location)
      ) {
        addRecentPage(to, options?.state);
      }
      navigate(to, options);
    },
    [addRecentPage, location, navigate, shouldRecordNavigation],
  );
}
