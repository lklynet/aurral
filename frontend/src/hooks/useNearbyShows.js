import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { getNearbyShows } from "../utils/api/endpoints/discovery.js";
import { queryKeys } from "../queryClient.js";
import {
  readStoredNearbyLocation,
  writeStoredNearbyLocation,
} from "../pages/discoverUtils";

export function useNearbyShows({ enabled = true, limit } = {}) {
  const [locationMode, setLocationModeState] = useState(() => readStoredNearbyLocation().mode);
  const [appliedZip, setAppliedZipState] = useState(() => readStoredNearbyLocation().zip);

  const setLocationMode = useCallback((mode) => {
    setLocationModeState(mode);
    writeStoredNearbyLocation({ mode });
  }, []);

  const setAppliedZip = useCallback((zip) => {
    const nextZip = String(zip || "").trim();
    setAppliedZipState(nextZip);
    setLocationModeState("zip");
    writeStoredNearbyLocation({ mode: "zip", zip: nextZip });
  }, []);

  const shouldUseZip = locationMode === "zip";
  const trimmedZip = appliedZip.trim();
  const query = useQuery({
    queryKey: queryKeys.nearbyShows(locationMode, trimmedZip, limit),
    queryFn: ({ signal }) => getNearbyShows(shouldUseZip ? trimmedZip : "", limit, { signal }),
    enabled: enabled && (!shouldUseZip || Boolean(trimmedZip)),
    staleTime: 5 * 60 * 1000,
  });
  const data = enabled && (!shouldUseZip || Boolean(trimmedZip)) ? query.data : null;
  const error = shouldUseZip && !trimmedZip
    ? null
    : data?.location?.resolved === false
      ? "We could not find that ZIP or postal code."
      : query.error?.response?.data?.message || query.error?.message || null;

  return {
    data,
    loading: enabled && (query.isPending || query.isFetching),
    error,
    locationMode,
    appliedZip,
    setLocationMode,
    setAppliedZip,
    locationLabel:
      data?.location?.label || data?.location?.postalCode || "your area",
    shows: data?.shows || [],
  };
}
