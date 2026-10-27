import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { discoveryClient } from "../utils/api/clients/discovery.ts";
import { queryKeys } from "../queryClient.ts";
import { asApiError } from "../utils/api/core.ts";
import { readStoredNearbyLocation, writeStoredNearbyLocation } from "../pages/discoverUtils";

export function useNearbyShows({ enabled = true }: { enabled?: boolean } = {}) {
  const [storedLocation, setStoredLocation] = useState(readStoredNearbyLocation);
  const { mode: locationMode, zip: appliedZip, country: appliedCountry } = storedLocation;

  const setLocationMode = useCallback((mode: (typeof storedLocation)["mode"]) => {
    setStoredLocation((current) => ({ ...current, mode }));
    writeStoredNearbyLocation({ mode });
  }, []);

  const setAppliedZip = useCallback((zip: string, country = "") => {
    const next: typeof storedLocation = {
      mode: "zip",
      zip: String(zip || "").trim(),
      country: String(country || "")
        .trim()
        .toUpperCase(),
    };
    setStoredLocation(next);
    writeStoredNearbyLocation(next);
  }, []);

  const zip = locationMode === "zip" ? appliedZip.trim() : "";
  const country = zip ? appliedCountry.trim().toUpperCase() : "";
  const active = enabled && (locationMode !== "zip" || Boolean(zip));
  const query = useQuery({
    queryKey: queryKeys.nearbyShows(zip, country),
    queryFn: ({ signal }) =>
      parseResponse(
        discoveryClient["nearby-shows"].$get(
          { query: { zip: zip || undefined, country: country || undefined } },
          { init: { signal } },
        ),
      ),
    enabled: active,
    staleTime: 5 * 60 * 1000,
  });
  const data = active ? query.data : null;
  const errorData = asApiError(query.error)?.response?.data;
  const error = !active
    ? null
    : data?.location?.resolved === false
      ? "ZIP or postal code not found."
      : (typeof errorData === "object" && errorData ? errorData.message : undefined) ||
        query.error?.message ||
        null;

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
