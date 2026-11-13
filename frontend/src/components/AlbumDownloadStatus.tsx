import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Link } from "react-router";
import { RotateCcw, X } from "./icons";

import { DotLoader } from "./DotLoader";
import type { LibraryAlbumRef } from "./AlbumMonitoring";
import { useToast } from "../contexts/ToastContext";
import { SettingsLink } from "../navigation/settingsRoute";
import { getApiErrorMessage } from "../utils/api/errors.ts";
import { queryKeys } from "../queryClient.ts";
import { cancelAlbum, requestAlbumFromSearch } from "../utils/api/endpoints/library.ts";
import { libraryAlbumsClient } from "../utils/api/clients/libraryAlbums.ts";
import {
  buildAlbumRetryPayload,
  describeAlbumStatus,
  shouldPollAlbumStatus,
  type AlbumStatus,
} from "../utils/albumStatus.ts";

const POLL_INTERVAL_MS = 4000;

interface AlbumArtistRef {
  mbid?: string | null;
  name?: string;
}

type AlbumStatusState = NonNullable<ReturnType<typeof describeAlbumStatus>>;
type AlbumStatusAction = AlbumStatusState["actions"][number];

type LibraryEdition = { name: string; action: ReactNode };

interface AlbumDownloadStatusProps {
  album: LibraryAlbumRef;
  artist?: AlbumArtistRef | null;
  canManage?: boolean;
  edition?: LibraryEdition | null;
  onChanged?: () => void;
  onSettled?: () => void;
}

const editionLabel = (name: string) => (/\bedition$/i.test(name) ? name : `${name} edition`);

export function AlbumEditionNote({ edition }: { edition: LibraryEdition }) {
  return (
    <div className="native-library-album-status">
      <p className="native-library-album-status__label">
        Your Library has the {editionLabel(edition.name)}
      </p>
      {edition.action ? (
        <div className="native-library-album-status__actions">{edition.action}</div>
      ) : null}
    </div>
  );
}

export function AlbumDownloadStatus({
  album,
  artist,
  canManage = false,
  edition = null,
  onChanged,
  onSettled,
}: AlbumDownloadStatusProps) {
  const { showError } = useToast();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: queryKeys.albumStatus(album.id),
    queryFn: ({ signal }) =>
      parseResponse(
        libraryAlbumsClient.albums[":albumId"].status.$get(
          { param: { albumId: encodeURIComponent(album.id) } },
          { init: { signal } },
        ),
      ),
    staleTime: 0,
    refetchInterval: (query) =>
      shouldPollAlbumStatus(query.state.data?.status) ? POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  const state = describeAlbumStatus(statusQuery.data || {});
  const previousStatusRef = useRef<AlbumStatus | null | undefined>(null);

  useEffect(() => {
    const status = statusQuery.data?.status;
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (shouldPollAlbumStatus(previous) && status && !shouldPollAlbumStatus(status)) {
      onSettled?.();
    }
  }, [onSettled, statusQuery.data?.status]);

  if (!state || state.status === "complete") {
    return edition ? <AlbumEditionNote edition={edition} /> : null;
  }
  const actions = canManage ? state.actions : [];

  const runAction = async (action: AlbumStatusAction) => {
    setPendingAction(action.id);
    try {
      if (action.id === "cancel") {
        await cancelAlbum(album.id);
      } else {
        await requestAlbumFromSearch(buildAlbumRetryPayload({ album, artist }));
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
        <span>
          {state.label}
          {edition && state.active ? ` ${editionLabel(edition.name)}` : null}
        </span>
      </p>
      {state.recovery?.message && (
        <p className="native-library-album-status__recovery">
          {state.recovery.message}
          {state.recovery.link && (
            <>
              {" "}
              {"settings" in state.recovery.link ? (
                <SettingsLink to={state.recovery.link.settings}>
                  {state.recovery.link.label}
                </SettingsLink>
              ) : (
                <Link to={state.recovery.link.to}>{state.recovery.link.label}</Link>
              )}
            </>
          )}
        </p>
      )}
      {edition && !state.active ? (
        <p className="native-library-album-status__recovery">
          Your Library has the {editionLabel(edition.name)}
        </p>
      ) : null}
      {(actions.length > 0 || edition?.action) && (
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
          {edition?.action}
        </div>
      )}
    </div>
  );
}
