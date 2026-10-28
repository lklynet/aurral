import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { useArtistTasteFeedback } from "../hooks/useArtistTasteFeedback";
import { useDiscoveryStatus } from "../hooks/useDiscoveryStatus";
import { queryClient, queryKeys } from "../queryClient.ts";
import { discoveryQueryOptions } from "../queryOptions.ts";
import { artistsShareDiscoveryIdentity } from "../utils/discoveryFeedback";
import type { ArtistFeedbackSource } from "../utils/artistTaste.ts";
import {
  readStoredDiscoveryData,
  writeStoredDiscoveryData,
  type DiscoverArtist,
  type normalizeDiscoveryData,
} from "./discoverUtils";
import { getApiErrorText } from "./onboardingUtils";

export type DiscoverData = Omit<
  NonNullable<ReturnType<typeof normalizeDiscoveryData>>,
  "recommendations" | "globalTop" | "topGenres" | "topTags"
> & {
  recommendations: DiscoverArtist[];
  globalTop: DiscoverArtist[];
  topGenres: string[];
  topTags: string[];
};

type SubmitFeedback = ReturnType<typeof useArtistTasteFeedback>["submitFeedback"];

export function useDiscoveryRecommendations() {
  const { user } = useAuth();
  const options = discoveryQueryOptions(user?.id);
  const initialData = useMemo(() => readStoredDiscoveryData(user?.id) || undefined, [user?.id]);
  const discoveryQuery = useQuery({ ...options, initialData, initialDataUpdatedAt: 0 });
  const data = (discoveryQuery.data || null) as DiscoverData | null;
  const { queryKey } = options;
  const setData = useCallback(
    (updater: (current: DiscoverData) => DiscoverData) => {
      queryClient.setQueryData<DiscoverData>(queryKeys.discovery(user?.id), (current) =>
        current ? updater(current) : current,
      );
    },
    [user?.id],
  );
  const { lookup: artistFeedbackLookup, submitFeedback } = useArtistTasteFeedback();
  const { status: discoveryStatus } = useDiscoveryStatus();
  const previousDiscoveryStatusRef = useRef<typeof discoveryStatus>(null);

  useEffect(() => {
    if (data) writeStoredDiscoveryData(data, user?.id);
  }, [user?.id, data]);

  useEffect(() => {
    const previous = previousDiscoveryStatusRef.current;
    previousDiscoveryStatusRef.current = discoveryStatus;
    if (!previous || !discoveryStatus) return;
    const finished = previous.isUpdating && !discoveryStatus.isUpdating;
    if (finished || previous.lastUpdated !== discoveryStatus.lastUpdated) {
      queryClient.invalidateQueries({ queryKey });
    }
  }, [queryKey, discoveryStatus]);

  const error = discoveryQuery.error
    ? getApiErrorText(discoveryQuery.error, "message") || "Failed to load discovery data"
    : null;

  const handleDiscoveryFeedback = useCallback(
    async (
      artist: ArtistFeedbackSource,
      action: Parameters<SubmitFeedback>[1],
      options: Parameters<SubmitFeedback>[2] = {},
    ) => {
      if (action !== "block_artist" || options.isSelected) {
        return submitFeedback(artist, action, options);
      }
      const hidden: Partial<
        Record<"recommendations" | "globalTop", { candidate: DiscoverArtist; index: number }[]>
      > = {};
      setData((current) => {
        const next = { ...current };
        for (const key of ["recommendations", "globalTop"] as const) {
          const list = current[key] || [];
          hidden[key] = list
            .map((candidate, index) => ({ candidate, index }))
            .filter(({ candidate }) => artistsShareDiscoveryIdentity(candidate, artist));
          next[key] = list.filter((candidate) => !artistsShareDiscoveryIdentity(candidate, artist));
        }
        return next;
      });
      const restoreCards = () =>
        setData((current) => {
          const next = { ...current };
          for (const key of ["recommendations", "globalTop"] as const) {
            const entries = hidden[key];
            if (!entries) continue;
            const list = [...(current[key] || [])];
            for (const { candidate, index } of entries) {
              if (!list.some((existing) => artistsShareDiscoveryIdentity(existing, candidate))) {
                list.splice(Math.min(index, list.length), 0, candidate);
              }
            }
            next[key] = list;
          }
          return next;
        });
      return submitFeedback(artist, action, { ...options, onRevert: restoreCards });
    },
    [setData, submitFeedback],
  );

  return {
    data,
    error,
    isPending: discoveryQuery.isPending,
    isFetching: discoveryQuery.isFetching,
    refetch: discoveryQuery.refetch,
    discoveryStatus,
    artistFeedbackLookup,
    handleDiscoveryFeedback,
  };
}
