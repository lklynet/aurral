import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDiscoveryFeedback, getDiscoveryFeedback, removeDiscoveryFeedback } from "../utils/api/endpoints/discovery.js";
import {
  applyArtistDiscoveryFeedback,
  buildArtistFeedbackLookup,
  getArtistFeedbackFlags,
  normalizeDiscoveryFeedbackList,
} from "../utils/discoveryFeedback";
import { buildArtistFeedbackPayload } from "../utils/artistTaste";

import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.js";

const EMPTY_FEEDBACK = [];

export function useArtistTasteFeedback() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryKey = queryKeys.tasteFeedback(user?.id);
  const feedbackQuery = useQuery({
    queryKey,
    queryFn: () => getDiscoveryFeedback().then(normalizeDiscoveryFeedbackList),
    enabled: user?.id != null,
    staleTime: 60_000,
  });
  const feedbackList = feedbackQuery.data ?? EMPTY_FEEDBACK;
  const feedbackMutation = useMutation({
    mutationFn: async ({ artist, action, isSelected, sourceContext, seedArtistName }) => {
      const payload = buildArtistFeedbackPayload(artist, action, { sourceContext, seedArtistName });
      return applyArtistDiscoveryFeedback({
        feedbackList: queryClient.getQueryData(queryKey) || [],
        artist,
        action,
        isSelected,
        payload,
        addDiscoveryFeedback,
        removeDiscoveryFeedback,
      });
    },
    onSuccess: ({ feedbackList: next }, { action, isSelected }) => {
      queryClient.setQueryData(queryKey, next);
      if (!isSelected) {
        showSuccess(
          action === "more_like_this"
            ? "We’ll bias future picks toward this taste"
            : action === "less_like_this"
              ? "We’ll show less like this"
              : "Artist blocked from recommendations and playlist downloads",
        );
      }
    },
  });

  const lookup = useMemo(() => buildArtistFeedbackLookup(feedbackList), [feedbackList]);

  const getFeedbackFlags = useCallback(
    (artist) => getArtistFeedbackFlags(lookup, artist),
    [lookup],
  );

  const submitFeedback = useCallback(
    async (
      artist,
      action,
      { isSelected = false, sourceContext = null, seedArtistName = null } = {},
    ) => {
      try {
        await feedbackMutation.mutateAsync({
          artist,
          action,
          isSelected,
          sourceContext,
          seedArtistName,
        });
        return true;
      } catch (err) {
        showError(err.response?.data?.message || "Failed to save discovery feedback");
        return false;
      }
    },
    [feedbackMutation, showError],
  );

  return {
    feedbackList,
    lookup,
    getFeedbackFlags,
    submitFeedback,
  };
}
