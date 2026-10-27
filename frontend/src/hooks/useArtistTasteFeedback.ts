import { useCallback, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { discoveryClient } from "../utils/api/clients/discovery.ts";
import {
  applyArtistDiscoveryFeedback,
  buildArtistFeedbackLookup,
  diffDiscoveryFeedback,
  getArtistFeedbackFlags,
  normalizeDiscoveryFeedbackList,
  previewArtistDiscoveryFeedback,
  revertDiscoveryFeedback,
} from "../utils/discoveryFeedback";
import {
  buildArtistFeedbackPayload,
  type ArtistFeedbackAction,
  type ArtistFeedbackSource,
} from "../utils/artistTaste";

import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryClient, queryKeys } from "../queryClient.ts";
import { asApiError } from "../utils/api/core.ts";
import type { DiscoveryFeedbackEntry } from "../utils/discoveryFeedback.ts";

type FeedbackChange = ReturnType<typeof diffDiscoveryFeedback>;
type ArtistFeedbackVariables = {
  artist: ArtistFeedbackSource;
  action: ArtistFeedbackAction;
  isSelected: boolean;
  payload: DiscoveryFeedbackEntry;
};
type SubmitFeedbackOptions = {
  isSelected?: boolean;
  sourceContext?: string | null;
  seedArtistName?: string | null;
  onRevert?: (() => void) | null;
};

const EMPTY_FEEDBACK: DiscoveryFeedbackEntry[] = [];

const getDiscoveryFeedback = () => parseResponse(discoveryClient.feedback.$get());

const addDiscoveryFeedback = (json: DiscoveryFeedbackEntry) =>
  parseResponse(discoveryClient.feedback.$post({ json }));

const removeDiscoveryFeedback = (id: string) =>
  parseResponse(discoveryClient.feedback[":id"].$delete({ param: { id: encodeURIComponent(id) } }));

const UNDOABLE_MESSAGES: Partial<Record<ArtistFeedbackAction, (name: string) => string>> = {
  less_like_this: (name) => `Showing less like ${name}`,
  block_artist: (name) => `Blocked ${name} from recommendations and playlist downloads`,
};

const FAILED_ACTIONS: Record<ArtistFeedbackAction, (name: string, isSelected: boolean) => string> =
  {
    more_like_this: (name, isSelected) =>
      isSelected ? `remove "More like this" from ${name}` : `save "More like this" for ${name}`,
    less_like_this: (name, isSelected) =>
      isSelected ? `remove "Less like this" from ${name}` : `save "Less like this" for ${name}`,
    block_artist: (name, isSelected) => (isSelected ? `unblock ${name}` : `block ${name}`),
  };

const artistLabel = (artist: ArtistFeedbackSource | null | undefined) =>
  artist?.name || artist?.artistName || "this artist";

const responseMessage = (error: unknown) => {
  const data = asApiError(error)?.response?.data;
  return typeof data === "object" && data ? data.message : undefined;
};

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
    mutationFn: async ({ artist, action, isSelected, payload }: ArtistFeedbackVariables) => {
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
      queryClient.setQueryData<DiscoveryFeedbackEntry[]>(queryKey, (current) =>
        previewArtistDiscoveryFeedback(current, variables),
      );
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
    async ({
      artist,
      change,
      onRevert,
    }: {
      artist: ArtistFeedbackSource;
      change: FeedbackChange;
      onRevert?: (() => void) | null;
    }) => {
      const name = artistLabel(artist);
      const before = queryClient.getQueryData(queryKey);
      queryClient.setQueryData<DiscoveryFeedbackEntry[]>(queryKey, (current) =>
        revertDiscoveryFeedback(current, change),
      );
      onRevert?.();
      try {
        const response = await parseResponse(
          discoveryClient.feedback.restore.$post({
            json: {
              removeIds: change.added
                .map((entry) => entry.id)
                .filter((id): id is string => Boolean(id)),
              entries: change.removed,
            },
          }),
        );
        queryClient.setQueryData(queryKey, normalizeDiscoveryFeedbackList(response?.feedbackList));
      } catch (err) {
        queryClient.setQueryData(queryKey, before);
        showError(
          `Could not undo the change for ${name}. It is still saved. ${
            responseMessage(err) || "Try again from the artist menu."
          }`,
        );
      }
    },
    [queryKey, showError],
  );

  const lookup = useMemo(() => buildArtistFeedbackLookup(feedbackList), [feedbackList]);

  const getFeedbackFlags = useCallback(
    (artist: ArtistFeedbackSource) => getArtistFeedbackFlags(lookup, artist),
    [lookup],
  );

  const submitFeedback = useCallback(
    async (
      artist: ArtistFeedbackSource,
      action: ArtistFeedbackAction,
      {
        isSelected = false,
        sourceContext = null,
        seedArtistName = null,
        onRevert = null,
      }: SubmitFeedbackOptions = {},
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
            responseMessage(err) || "Try again."
          }`,
        );
        return false;
      }
      if (isSelected) return true;
      const describeUndoable = UNDOABLE_MESSAGES[action];
      if (!describeUndoable) {
        showSuccess(`Showing more like ${name}`);
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
