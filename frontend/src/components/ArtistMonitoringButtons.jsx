import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, SlidersHorizontal, Trash2 } from "lucide-react";
import lidarrLogo from "../../images/logos/lidarr-color.svg";
import AddActionButton from "./AddActionButton";
import { DotLoader } from "./DotLoader";
import { LibraryItemMenu } from "./LibraryItemMenu";
import Tooltip from "./Tooltip";
import { useToast } from "../contexts/ToastContext";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { queryClient, queryKeys } from "../queryClient.js";
import { getArtistMonitoring, updateLibraryArtist } from "../utils/api/endpoints/library.js";
import { describeAurralMonitoringError } from "../utils/aurralMonitoring.js";
import {
  buildManagerMonitoringItems,
  describeArtistAdd,
  describeArtistMonitoring,
  describeArtistMonitoringChange,
} from "../utils/artistMonitoring.js";
import { getManagerName } from "../utils/libraryDestination.js";

const LOGOS = { aurral: "/arralogo.svg", lidarr: lidarrLogo };

export const ManagerLogo = {
  aurral: ({ className }) => <img className={className} src={LOGOS.aurral} alt="" />,
  lidarr: ({ className }) => <img className={className} src={LOGOS.lidarr} alt="" />,
};

export function useArtistMonitoring({
  mbid,
  artistName = "",
  canChange = false,
  canAdd = false,
  canRemove = false,
  onRemove = null,
  onCustomizeLidarr = null,
  onChanged = null,
}) {
  const destination = useLibraryDestination();
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState(false);
  const monitoringQuery = useQuery({
    queryKey: queryKeys.artistMonitoring(mbid),
    queryFn: ({ signal }) => getArtistMonitoring(mbid, { signal }),
    enabled: Boolean(mbid),
    staleTime: 0,
  });
  const state = monitoringQuery.data || null;
  const manager = state?.manager || destination.primary;
  const adding = manager === "lidarr" && state?.added === false;
  const name = artistName || "this artist";

  const choose = async (option) => {
    if (!adding && option === state?.monitorOption) return;
    setPending(true);
    try {
      const response = await updateLibraryArtist(mbid, { monitorOption: option, artistName: name });
      showSuccess(
        adding
          ? describeArtistAdd({ name, manager, monitorOption: option })
          : describeArtistMonitoringChange({ name, manager, option, response }),
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.libraryArtist(mbid) });
      await onChanged?.();
    } catch (error) {
      showError(describeAurralMonitoringError(error, `Could not update ${getManagerName(manager)} monitoring`));
    } finally {
      setPending(false);
    }
  };

  const reason = (() => {
    if (monitoringQuery.isError) return "Could not check monitoring. Reload the page to try again.";
    if (!state) return `Checking ${getManagerName(manager)}`;
    if (state.error) return state.error;
    if (!(state.added ? canChange : canAdd)) return "You don't have permission to change this";
    return null;
  })();

  const items = [
    ...buildManagerMonitoringItems({ manager, current: state?.monitorOption, adding, onSelect: choose }),
    ...(adding && onCustomizeLidarr
      ? [{
          id: "customize-lidarr",
          label: "Customize Lidarr add…",
          icon: SlidersHorizontal,
          separatorBefore: true,
          closeBeforeSelect: true,
          onSelect: onCustomizeLidarr,
        }]
      : []),
    ...(state?.added && canRemove && onRemove
      ? [{
          id: "remove",
          label: `Remove from ${getManagerName(manager)}`,
          icon: Trash2,
          danger: true,
          separatorBefore: true,
          closeBeforeSelect: true,
          onSelect: () => onRemove(manager),
        }]
      : []),
  ];

  return {
    state,
    destination,
    manager,
    ready: destination.ready && !destination.error,
    pending,
    adding,
    label: describeArtistMonitoring(state ?? { manager, added: true, monitorOption: "none" }),
    reason,
    items,
  };
}

export function ArtistMonitoringButtons(props) {
  const monitoring = useArtistMonitoring(props);

  if (!monitoring.ready) {
    return <AddActionButton destination={monitoring.destination} showLabel />;
  }

  const { manager, adding, reason, label } = monitoring;
  const accessibleName = adding ? "Add to Lidarr" : `${getManagerName(manager)} monitoring: ${label}`;
  const content = (
    <>
      <span className="btn-add-action__icon">
        {monitoring.pending ? (
          <DotLoader size="sm" label={null} />
        ) : (
          <img className="artist-monitoring-button__logo" src={LOGOS[manager]} alt="" />
        )}
      </span>
      <span className="btn-add-action__label">{label}</span>
      <ChevronDown className="btn-add-action__more" aria-hidden="true" />
    </>
  );

  if (reason) {
    return (
      <Tooltip content={reason}>
        <span className="artist-monitoring-button__blocked" tabIndex={0} aria-label={`${accessibleName}. ${reason}`}>
          <span className="btn btn-add-action btn-add-action--labeled is-disabled" aria-hidden="true">
            {content}
          </span>
        </span>
      </Tooltip>
    );
  }

  return (
    <LibraryItemMenu
      label={accessibleName}
      menuLabel={adding ? "Add to Lidarr" : `${getManagerName(manager)} monitoring`}
      triggerLabel={accessibleName}
      triggerClassName="btn btn-add-action btn-add-action--labeled btn-add-action--menu"
      triggerIcon={content}
      disabled={monitoring.pending}
      contextMenu={false}
      align="start"
      items={monitoring.items}
    />
  );
}
