import { useState } from "react";
import { Ban, Library, MoreVertical, ThumbsDown, ThumbsUp } from "lucide-react";
import { getDiscoveryFeedbackLabel } from "../utils/discoveryFeedback";
import { LibraryItemMenu } from "./LibraryItemMenu";
import TooltipButton from "./TooltipButton";
import { DotLoader } from "./DotLoader";

export function ArtistContextMenu({
  artist,
  artistName,
  isInLibrary = false,
  onOpenInLibrary,
  onFeedback,
  feedbackUsed = {},
  className = "",
  buttonClassName = "btn btn-icon-square artist-context-menu__trigger",
  menuLayout = "text",
}) {
  const [pendingAction, setPendingAction] = useState(null);
  const labelName = artistName || artist?.name || artist?.artistName || "artist";
  const hasLibraryItem = isInLibrary && onOpenInLibrary;
  const feedbackItems = onFeedback ? [
    { id: "more_like_this", icon: ThumbsUp },
    { id: "less_like_this", icon: ThumbsDown },
    { id: "block_artist", icon: Ban, danger: true },
  ].map((item) => ({
    ...item,
    label: item.id === "block_artist" && feedbackUsed.block_artist
      ? "Unblock artist" : getDiscoveryFeedbackLabel(item.id),
    selected: !!feedbackUsed[item.id],
    onSelect: () => onFeedback(artist, item.id, { isSelected: !!feedbackUsed[item.id] }),
  })) : [];

  const libraryItems = hasLibraryItem ? [{
    id: "open-library", label: "Open in library", icon: Library,
    onSelect: () => onOpenInLibrary(artist),
  }] : [];

  if (!hasLibraryItem && !onFeedback) return null;

  if (menuLayout === "inline") {
    const runFeedback = async (item) => {
      if (pendingAction) return;
      setPendingAction(item.id);
      try {
        await item.onSelect();
      } finally {
        setPendingAction(null);
      }
    };
    return (
      <div className={`${className} artist-context-menu--inline`} onClick={(event) => event.stopPropagation()}>
        {hasLibraryItem ? (
          <TooltipButton label="Open in library" onClick={() => onOpenInLibrary(artist)} className="btn btn-icon-square artist-context-menu__inline-action is-selected">
            <Library className="artist-icon-sm" />
          </TooltipButton>
        ) : null}
        {feedbackItems.map((item) => {
          const Icon = item.icon;
          return (
            <TooltipButton
              key={item.id}
              label={item.label}
              onClick={() => runFeedback(item)}
              disabled={!!pendingAction}
              aria-pressed={item.selected}
              className={`btn btn-icon-square artist-context-menu__inline-action${item.danger ? " artist-context-menu__inline-action--danger" : ""}${item.selected ? " is-selected" : ""}`}
            >
              {pendingAction === item.id ? <DotLoader size="sm" label={null} /> : <Icon className="artist-icon-sm" />}
            </TooltipButton>
          );
        })}
      </div>
    );
  }

  return (
    <div className={className} onClick={(event) => event.stopPropagation()}>
      <LibraryItemMenu
        label={labelName}
        menuLabel={`Artist options for ${labelName}`}
        triggerLabel={`Artist options for ${labelName}`}
        triggerClassName={buttonClassName}
        triggerIcon={<MoreVertical className="artist-icon-sm" aria-hidden="true" />}
        contextMenu={false}
        items={[...libraryItems, ...feedbackItems]}
      />
    </div>
  );
}
