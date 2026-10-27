import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Link } from "react-router";
import { RotateCcw, X } from "./icons";

import { DotLoader } from "./DotLoader";
import type { AurralAlbumRef } from "./AurralAlbumMonitoring";
import { useToast } from "../contexts/ToastContext";
import { getApiErrorMessage } from "../pages/onboardingUtils.tsx";
import { queryKeys } from "../queryClient.ts";
import { cancelAurralAlbum, requestAlbumFromSearch } from "../utils/api/endpoints/library.ts";
import { libraryAlbumsClient } from "../utils/api/clients/libraryAlbums.ts";
import {
  buildAurralAlbumRetryPayload,
  describeAurralAlbumStatus,
  shouldPollAlbumStatus,
  type AlbumStatus,
} from "../utils/aurralAlbumStatus.ts";

const POLL_INTERVAL_MS = 4000;

interface AlbumArtistRef {
  mbid?: string | null;
  name?: string;
}

type AlbumStatusState = NonNullable<ReturnType<typeof describeAurralAlbumStatus>>;
type AlbumStatusAction = AlbumStatusState["actions"][number];

interface AurralAlbumStatusProps {
  album: AurralAlbumRef;
  artist?: AlbumArtistRef | null;
  canManage?: boolean;
  canRetry?: boolean;
  onChanged?: () => void;
  onSettled?: () => void;
}

export function AurralAlbumStatus({
  album,
  artist,
  canManage = false,
  canRetry = true,
  onChanged,
  onSettled,
}: AurralAlbumStatusProps) {
  const { showError } = useToast();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: queryKeys.aurralAlbumStatus(album.id),
    queryFn: ({ signal }) =>
      parseResponse(
        libraryAlbumsClient.albums.aurral[":canonicalId"].status.$get(
          { param: { canonicalId: encodeURIComponent(album.id) } },
          { init: { signal } },
        ),
      ),
    staleTime: 0,
    refetchInterval: (query) =>
      shouldPollAlbumStatus(query.state.data?.status) ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  const state = describeAurralAlbumStatus(statusQuery.data || {});
  const previousStatusRef = useRef<AlbumStatus | null | undefined>(null);

  useEffect(() => {
    const status = statusQuery.data?.status;
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (shouldPollAlbumStatus(previous) && status && !shouldPollAlbumStatus(status)) {
      onSettled?.();
    }
  }, [onSettled, statusQuery.data?.status]);

  if (!state || state.status === "complete") return null;
  const actions = canRetry
    ? state.actions
    : state.actions.filter((action) => action.id === "cancel");

  const runAction = async (action: AlbumStatusAction) => {
    setPendingAction(action.id);
    try {
      if (action.id === "cancel") {
        await cancelAurralAlbum(album.id);
      } else {
        await requestAlbumFromSearch(buildAurralAlbumRetryPayload({ album, artist }));
      }
      await statusQuery.refetch();
      onChanged?.();
    } catch (error) {
      showError(
        getApiErrorMessage(
          error,
          action.id === "cancel" ? "Could not cancel album downloads" : "Could not retry the album",
        ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="native-library-album-status" data-tone={state.tone}>
      <p className="native-library-album-status__label" role="status">
        {state.active && <DotLoader size="xs" label={null} />}
        <span>{state.label}</span>
      </p>
      {state.recovery?.message && (
        <p className="native-library-album-status__recovery">
          {state.recovery.message}
          {state.recovery.link && (
            <>
              {" "}
              <Link to={state.recovery.link.to}>{state.recovery.link.label}</Link>
            </>
          )}
        </p>
      )}
      {canManage && actions.length > 0 && (
        <div className="native-library-album-status__actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="native-library-detail__discover"
              onClick={() => runAction(action)}
              disabled={pendingAction !== null}
              aria-busy={pendingAction === action.id}
            >
              {pendingAction === action.id ? (
                <DotLoader size="xs" label={null} />
              ) : action.id === "cancel" ? (
                <X aria-hidden="true" />
              ) : (
                <RotateCcw aria-hidden="true" />
              )}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
