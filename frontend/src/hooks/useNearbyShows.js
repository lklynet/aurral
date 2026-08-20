import { useState, useEffect, useCallback } from "react";
import { getNearbyShows } from "../utils/api/endpoints/discovery.js";
import {
  readStoredNearbyLocation,
  writeStoredNearbyLocation,
} from "../pages/discoverUtils";

export function useNearbyShows({ enabled = true, limit } = {}) {
  const initial = readStoredNearbyLocation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [locationMode, setLocationModeState] = useState(initial.mode);
  const [appliedZip, setAppliedZipState] = useState(initial.zip);

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

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const shouldUseZip = locationMode === "zip";
    const trimmedZip = appliedZip.trim();
    if (shouldUseZip && !trimmedZip) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    getNearbyShows(shouldUseZip ? trimmedZip : "", limit, {
      signal: controller.signal,
    })
      .then((response) => {
        if (controller.signal.aborted) return;
        setData(response);
        setError(
          response?.location?.resolved === false
            ? "We could not find that ZIP or postal code."
            : null,
        );
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err.response?.data?.message || "Failed to load nearby shows");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, locationMode, appliedZip, limit]);

  return {
    data,
    loading,
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
