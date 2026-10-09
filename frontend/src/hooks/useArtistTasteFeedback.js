import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  addDiscoveryFeedback,
  getDiscoveryFeedback,
  removeDiscoveryFeedback,
  restoreDiscoveryFeedback,
} from "../utils/api/endpoints/discovery.js";
import {
  applyArtistDiscoveryFeedback,
  buildArtistFeedbackLookup,
  diffDiscoveryFeedback,
  getArtistFeedbackFlags,
  normalizeDiscoveryFeedbackList,
  previewArtistDiscoveryFeedback,
  revertDiscoveryFeedback,
} from "../utils/discoveryFeedback";
import { buildArtistFeedbackPayload } from "../utils/artistTaste";

import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.js";

const EMPTY_FEEDBACK = [];

const UNDOABLE_MESSAGES = {
  less_like_this: (name) => `Showing less like ${name}`,
  block_artist: (name) => `Blocked ${name} from recommendations and playlist downloads`,
};

const FAILED_ACTIONS = {
  more_like_this: (name, isSelected) =>
    isSelected ? `remove "More like this" from ${name}` : `save "More like this" for ${name}`,
  less_like_this: (name, isSelected) =>
    isSelected ? `remove "Less like this" from ${name}` : `save "Less like this" for ${name}`,
  block_artist: (name, isSelected) => (isSelected ? `unblock ${name}` : `block ${name}`),
};

const artistLabel = (artist) => artist?.name || artist?.artistName || "this artist";

export function useArtistTasteFeedback() {
  const { user } = useAuth();
  const toast = useToast();
  const { showSuccess, showError } = toast;
  const queryKey = queryKeys.tasteFeedback(user?.id);
  const feedbackQuery = useQuery({
    queryKey,
    queryFn: () => getDiscoveryFeedback().then(normalizeDiscoveryFeedbackList),
    enabled: user?.id != null,
    staleTime: 60_000,
  });
  const feedbackList = feedbackQuery.data ?? EMPTY_FEEDBACK;
  const { mutateAsync } = useMutation({
    scope: { id: `taste-feedback:${user?.id ?? "anonymous"}` },
    mutationFn: async ({ artist, action, isSelected, payload }) => {
      const previous = normalizeDiscoveryFeedbackList(await getDiscoveryFeedback());
      const result = await applyArtistDiscoveryFeedback({
        feedbackList: previous,
        artist,
        action,
        isSelected,
        payload,
        addDiscoveryFeedback,
        removeDiscoveryFeedback,
      });
      return { ...result, previous };
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey });
      const snapshot = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (current) =>
        previewArtistDiscoveryFeedback(current, variables));
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(queryKey, context?.snapshot);
      void queryClient.invalidateQueries({ queryKey });
    },
    onSuccess: ({ feedbackList: next }) => {
      queryClient.setQueryData(queryKey, next);
    },
  });

  const undoFeedback = useCallback(
    async ({ artist, change, onRevert }) => {
      const name = artistLabel(artist);
      const before = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (current) => revertDiscoveryFeedback(current, change));
      onRevert?.();
      try {
        const response = await restoreDiscoveryFeedback({
          removeIds: change.added.map((entry) => entry.id),
          entries: change.removed,
        });
        queryClient.setQueryData(queryKey, normalizeDiscoveryFeedbackList(response?.feedbackList));
      } catch (err) {
        queryClient.setQueryData(queryKey, before);
        showError(
          `Could not undo the change for ${name}. It is still saved. ${
            err.response?.data?.message || "Try again from the artist menu."
          }`,
        );
      }
    },
    [queryKey, showError],
  );

  const lookup = useMemo(() => buildArtistFeedbackLookup(feedbackList), [feedbackList]);

  const getFeedbackFlags = useCallback(
    (artist) => getArtistFeedbackFlags(lookup, artist),
    [lookup],
  );

  const submitFeedback = useCallback(
    async (
      artist,
      action,
      { isSelected = false, sourceContext = null, seedArtistName = null, onRevert = null } = {},
    ) => {
      const name = artistLabel(artist);
      const payload = buildArtistFeedbackPayload(artist, action, { sourceContext, seedArtistName });
      let result;
      try {
        result = await mutateAsync({ artist, action, isSelected, payload });
      } catch (err) {
        onRevert?.();
        showError(
          `Could not ${FAILED_ACTIONS[action]?.(name, isSelected) || "save your feedback"}. Nothing changed. ${
            err.response?.data?.message || "Try again."
          }`,
        );
        return false;
      }
      if (isSelected) return true;
      const describeUndoable = UNDOABLE_MESSAGES[action];
      if (!describeUndoable) {
        showSuccess("We’ll bias future picks toward this taste");
        return true;
      }
      const change = diffDiscoveryFeedback(result.previous, result.feedbackList);
      toast.addToast(
        {
          message: describeUndoable(name),
          action: {
            label: "Undo",
            onClick: () => undoFeedback({ artist, change, onRevert }),
          },
        },
        "success",
        8000,
      );
      return true;
    },
    [mutateAsync, showError, showSuccess, toast, undoFeedback],
  );

  return {
    feedbackList,
    lookup,
    getFeedbackFlags,
    submitFeedback,
  };
}
