import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { getNearbyShows } from "../utils/api/endpoints/discovery.js";
import { queryKeys } from "../queryClient.js";
import {
  readStoredNearbyLocation,
  writeStoredNearbyLocation,
} from "../pages/discoverUtils";

export function useNearbyShows({ enabled = true } = {}) {
  const [storedLocation, setStoredLocation] = useState(readStoredNearbyLocation);
  const { mode: locationMode, zip: appliedZip, country: appliedCountry } = storedLocation;

  const setLocationMode = useCallback((mode) => {
    setStoredLocation((current) => ({ ...current, mode }));
    writeStoredNearbyLocation({ mode });
  }, []);

  const setAppliedZip = useCallback((zip, country = "") => {
    const next = {
      mode: "zip",
      zip: String(zip || "").trim(),
      country: String(country || "").trim().toUpperCase(),
    };
    setStoredLocation(next);
    writeStoredNearbyLocation(next);
  }, []);

  const zip = locationMode === "zip" ? appliedZip.trim() : "";
  const country = zip ? appliedCountry.trim().toUpperCase() : "";
  const active = enabled && (locationMode !== "zip" || Boolean(zip));
  const query = useQuery({
    queryKey: queryKeys.nearbyShows(zip, country),
    queryFn: ({ signal }) => getNearbyShows({ zip, country, signal }),
    enabled: active,
    staleTime: 5 * 60 * 1000,
  });
  const data = active ? query.data : null;
  const error = !active
    ? null
    : data?.location?.resolved === false
      ? "We could not find that ZIP or postal code."
      : query.error?.response?.data?.message || query.error?.message || null;

  return {
    data,
    loading: active && query.isLoading,
    error,
    locationMode,
    appliedZip,
    appliedCountry,
    setLocationMode,
    setAppliedZip,
    locationLabel: data?.location?.label || data?.location?.postalCode || "your area",
  };
}
