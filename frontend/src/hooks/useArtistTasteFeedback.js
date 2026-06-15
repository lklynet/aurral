import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import {
  addDiscoveryFeedback,
  getDiscoveryFeedback,
  removeDiscoveryFeedback,
} from "../utils/api";
import {
  applyArtistDiscoveryFeedback,
  buildArtistFeedbackLookup,
  getArtistFeedbackFlags,
  normalizeDiscoveryFeedbackList,
} from "../utils/discoveryFeedback";
import { buildArtistFeedbackPayload } from "../utils/artistTaste";

export function useArtistTasteFeedback() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const [feedbackList, setFeedbackList] = useState([]);

  useEffect(() => {
    getDiscoveryFeedback()
      .then((payload) =>
        setFeedbackList(normalizeDiscoveryFeedbackList(payload)),
      )
      .catch(() => {});
  }, [user?.id]);

  const lookup = useMemo(
    () => buildArtistFeedbackLookup(feedbackList),
    [feedbackList],
  );

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
        const payload = buildArtistFeedbackPayload(artist, action, {
          sourceContext,
          seedArtistName,
        });
        const { feedbackList: next } = await applyArtistDiscoveryFeedback({
          feedbackList,
          artist,
          action,
          isSelected,
          payload,
          addDiscoveryFeedback,
          removeDiscoveryFeedback,
        });
        setFeedbackList(next);
        if (!isSelected) {
          showSuccess(
            action === "more_like_this"
              ? "We’ll bias future picks toward this taste"
              : "We’ll show less like this",
          );
        }
        return true;
      } catch (err) {
        showError(
          err.response?.data?.message || "Failed to save discovery feedback",
        );
        return false;
      }
    },
    [feedbackList, showError, showSuccess],
  );

  return {
    feedbackList,
    lookup,
    getFeedbackFlags,
    submitFeedback,
  };
}
