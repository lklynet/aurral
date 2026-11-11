import {
  Ban,
  Library,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Share,
  Shuffle,
  ThumbsDown,
  ThumbsUp,
} from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import { getDiscoveryFeedbackLabel } from "../../../utils/discoveryFeedback";
import TooltipButton from "../../../components/TooltipButton";
import { ArtistMonitoringButtons } from "../../../components/ArtistMonitoringButtons";
import { LibraryItemMenu, type LibraryMenuItem } from "../../../components/LibraryItemMenu";
import { useShareAction } from "../../../hooks/useShareAction";
import { useMediaQuery } from "../../../hooks/useMediaQuery.ts";
import RouteLink from "../../../components/RouteLink";
import type { ArtistFeedbackAction } from "../../../utils/artistTaste.ts";
import type { useArtistDetailsLibrary } from "../hooks/useArtistDetailsLibrary";

export type ArtistLibrarySummary = {
  to: string;
  owned: number;
  total: number;
  incomplete: number;
};

function LibrarySummaryLink({ summary }: { summary: ArtistLibrarySummary }) {
  const { to, owned, total, incomplete } = summary;
  const full = total > 0 ? `${owned} of ${total} album${total === 1 ? "" : "s"}` : "In Library";
  const note = incomplete > 0 ? `, ${incomplete} incomplete` : "";
  return (
    <RouteLink
      to={to}
      className="btn btn-ghost artist-actions__library"
      aria-label={`${full}${note}. Open in Library`}
    >
      <Library aria-hidden="true" />
      <span className="artist-actions__library-full">
        {full}
        {note ? <span className="artist-actions__library-note">{note}</span> : null}
      </span>
      <span className="artist-actions__library-short">Library</span>
    </RouteLink>
  );
}

export function ArtistDetailsActionBar({
  library,
  mbid,
  artistName = "",
  existsInLibrary,
  librarySummary = null,
  loadingLibrary,
  canChangeMonitoring,
  canAddArtist,
  buildingQueue = false,
  isArtistPlaybackActive,
  handlePreviewPlayAll,
  handlePreviewShuffle,
  canPlayPreviews,
  missingDownloads = null,
  onEditIds,
  onTasteFeedback,
  tasteFeedbackUsed = {},
  tasteActionPending = null,
}: {
  library: Pick<ReturnType<typeof useArtistDetailsLibrary>, "reloadLibraryState">;
  mbid: string;
  artistName?: string;
  existsInLibrary: boolean;
  librarySummary?: ArtistLibrarySummary | null;
  loadingLibrary: boolean;
  canChangeMonitoring: boolean;
  canAddArtist: boolean;
  buildingQueue?: boolean;
  isArtistPlaybackActive: boolean;
  handlePreviewPlayAll: () => void;
  handlePreviewShuffle: () => void;
  canPlayPreviews: boolean;
  missingDownloads?: { count: number; pending: boolean; onFind: () => void } | null;
  onEditIds?: () => void;
  onTasteFeedback?: (action: ArtistFeedbackAction) => void;
  tasteFeedbackUsed?: Partial<Record<ArtistFeedbackAction, boolean>>;
  tasteActionPending?: ArtistFeedbackAction | null;
}) {
  const narrow = useMediaQuery("(max-width: 359px)");
  const share = useShareAction();
  const isPreviewPlaying = isArtistPlaybackActive;

  const renderLibraryAction = () => {
    if (loadingLibrary) {
      return (
        <div className="btn btn-secondary btn-min-h">
          <DotLoader size="sm" label={null} />
          {existsInLibrary ? "Loading library" : "Checking library"}
        </div>
      );
    }

    return (
      <ArtistMonitoringButtons
        mbid={mbid}
        artistName={artistName}
        canChange={canChangeMonitoring}
        canAdd={canAddArtist}
        onChanged={library.reloadLibraryState}
      />
    );
  };

  const feedbackItem = (
    action: ArtistFeedbackAction,
    icon: LibraryMenuItem["icon"],
    label: string,
  ): LibraryMenuItem => ({
    id: action,
    label,
    icon,
    checked: !!tasteFeedbackUsed[action],
    disabled: !!tasteActionPending,
    onSelect: () => onTasteFeedback?.(action),
  });
  const moreItems: LibraryMenuItem[] = [
    ...(narrow
      ? [
          {
            id: "shuffle",
            label: "Shuffle",
            icon: Shuffle,
            disabled: !canPlayPreviews,
            onSelect: handlePreviewShuffle,
          },
          ...(missingDownloads
            ? [
                {
                  id: "find-missing",
                  label: `Find ${missingDownloads.count} missing album${missingDownloads.count === 1 ? "" : "s"}`,
                  icon: RefreshCw,
                  disabled: missingDownloads.pending,
                  onSelect: missingDownloads.onFind,
                },
              ]
            : []),
        ]
      : []),
    {
      id: "share",
      label: "Share artist",
      icon: Share,
      disabled: !artistName,
      separatorBefore: narrow,
      onSelect: () => share({ kind: "artist", artistMbid: mbid, artistName }, artistName),
    },
    ...(onTasteFeedback
      ? [
          {
            ...feedbackItem(
              "more_like_this",
              ThumbsUp,
              getDiscoveryFeedbackLabel("more_like_this"),
            ),
            separatorBefore: true,
          },
          feedbackItem("less_like_this", ThumbsDown, getDiscoveryFeedbackLabel("less_like_this")),
          {
            ...feedbackItem(
              "block_artist",
              Ban,
              tasteFeedbackUsed.block_artist
                ? "Unblock artist"
                : getDiscoveryFeedbackLabel("block_artist"),
            ),
            checked: undefined,
          },
        ]
      : []),
    ...(onEditIds
      ? [
          {
            id: "edit-ids",
            label: "Edit IDs",
            icon: Pencil,
            separatorBefore: true,
            onSelect: onEditIds,
          },
        ]
      : []),
  ];

  return (
    <div className="artist-actions">
      <TooltipButton
        type="button"
        onClick={handlePreviewPlayAll}
        disabled={buildingQueue || !canPlayPreviews}
        className="btn btn-accent btn-round-lg artist-actions__play"
        label={isPreviewPlaying ? `Pause ${artistName}` : `Play ${artistName}`}
      >
        {buildingQueue ? (
          <DotLoader size="md" label={null} />
        ) : isPreviewPlaying ? (
          <Pause className="artist-icon-md" />
        ) : (
          <Play className="artist-icon-md" />
        )}
      </TooltipButton>
      <TooltipButton
        type="button"
        onClick={handlePreviewShuffle}
        disabled={!canPlayPreviews}
        className="btn btn-ghost btn-icon-square artist-actions__shuffle"
        label={`Shuffle ${artistName}`}
      >
        <Shuffle aria-hidden="true" />
      </TooltipButton>
      {renderLibraryAction()}
      {librarySummary ? <LibrarySummaryLink summary={librarySummary} /> : null}
      <LibraryItemMenu
        label={artistName || "Artist"}
        menuLabel="Artist actions"
        triggerLabel="More artist actions"
        triggerClassName="btn btn-ghost btn-icon-square"
        triggerIcon={<MoreHorizontal aria-hidden="true" />}
        contextMenu={false}
        align="start"
        items={moreItems}
      />
    </div>
  );
}
