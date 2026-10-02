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
import {
  addArtistToLibrary,
  getArtistMonitoring,
  updateLibraryArtist,
} from "../utils/api/endpoints/library.js";
import { describeAurralMonitoringError } from "../utils/aurralMonitoring.js";
import {
  buildManagerMonitoringItems,
  describeArtistAdd,
  describeArtistMonitoringChange,
  describeManagerMonitoring,
} from "../utils/artistMonitoring.js";
import { getManagerName } from "../utils/libraryDestination.js";

const LOGOS = { aurral: "/arralogo.svg", lidarr: lidarrLogo };

const blockedReason = (manager, state, { canAct, failed }) => {
  if (failed) return "Could not check monitoring. Reload the page to try again.";
  if (!state) return `Checking ${getManagerName(manager)}`;
  if (manager === "lidarr" && state.lidarr.error) return state.lidarr.error;
  const other = manager === "aurral" ? "lidarr" : "aurral";
  if (state.active === other) {
    const off = other === "aurral" ? "Unmonitored" : "None";
    return `${getManagerName(other)} monitors this artist. Set ${getManagerName(other)} to ${off} to use ${getManagerName(manager)}.`;
  }
  if (!canAct) return "You don't have permission to change this";
  return null;
};

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
  const [pending, setPending] = useState(null);
  const monitoringQuery = useQuery({
    queryKey: queryKeys.artistMonitoring(mbid),
    queryFn: ({ signal }) => getArtistMonitoring(mbid, { signal }),
    enabled: Boolean(mbid),
    staleTime: 0,
  });
  const state = monitoringQuery.data || null;
  const lidarrAvailable = [destination.primary, destination.alternative].includes("lidarr");
  const managers = lidarrAvailable
    ? [destination.primary, destination.alternative].filter(Boolean)
    : ["aurral"];
  const name = artistName || "this artist";
  const isAdding = (manager) => manager === "lidarr" && !state?.lidarr?.inLidarr;

  const addsArtist = (manager) => (manager === "aurral" ? !state?.aurral?.known : isAdding(manager));

  const choose = async (manager, option) => {
    const adding = addsArtist(manager);
    const current = manager === "aurral" ? state?.aurral?.mode : state?.lidarr?.monitorOption;
    if (option === current && (!adding || manager === "aurral")) return;
    setPending(manager);
    try {
      if (adding) {
        const response = await addArtistToLibrary({
          foreignArtistId: mbid,
          artistName: name,
          managedBy: manager,
          monitorOption: option,
        });
        showSuccess(describeArtistAdd({ name, manager, monitorOption: option, response }));
      } else {
        const response = await updateLibraryArtist(mbid, { manager, monitorOption: option, artistName: name });
        showSuccess(describeArtistMonitoringChange({ name, manager, option, response }));
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.libraryArtist(mbid) });
      await onChanged?.();
    } catch (error) {
      showError(describeAurralMonitoringError(error, `Could not update ${getManagerName(manager)} monitoring`));
    } finally {
      setPending(null);
    }
  };

  const reasonFor = (manager) => {
    const canAct = addsArtist(manager) ? canAdd : canChange;
    return blockedReason(manager, state, { canAct, failed: monitoringQuery.isError });
  };

  const labelFor = (manager) => (isAdding(manager) ? "Add to Lidarr" : describeManagerMonitoring(manager, state));

  const itemsFor = (manager) => {
    const adding = isAdding(manager);
    const current = manager === "aurral" ? state?.aurral?.mode : state?.lidarr?.monitorOption;
    return [
      ...buildManagerMonitoringItems({
        manager,
        current,
        adding,
        onSelect: (option) => choose(manager, option),
      }),
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
      ...(!adding && canRemove && onRemove && (manager === "lidarr" || state?.aurral?.inLibrary)
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
  };

  return {
    state,
    destination,
    ready: destination.ready && !destination.error,
    managers,
    pending,
    isAdding,
    labelFor,
    reasonFor,
    itemsFor,
  };
}

export function ArtistMonitoringButtons(props) {
  const monitoring = useArtistMonitoring(props);

  const renderButton = (manager) => {
    const adding = monitoring.isAdding(manager);
    const reason = monitoring.reasonFor(manager);
    const label = monitoring.labelFor(manager);
    const accessibleName = adding ? "Add to Lidarr" : `${getManagerName(manager)} monitoring: ${label}`;
    const content = (
      <>
        <span className="btn-add-action__icon">
          {monitoring.pending === manager ? (
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
        <Tooltip key={manager} content={reason}>
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
        key={manager}
        label={accessibleName}
        menuLabel={adding ? "Add to Lidarr" : `${getManagerName(manager)} monitoring`}
        triggerLabel={accessibleName}
        triggerClassName="btn btn-add-action btn-add-action--labeled btn-add-action--menu"
        triggerIcon={content}
        disabled={monitoring.pending !== null}
        contextMenu={false}
        align="start"
        items={monitoring.itemsFor(manager)}
      />
    );
  };

  if (!monitoring.ready) {
    return <AddActionButton destination={monitoring.destination} showLabel />;
  }

  return <div className="artist-monitoring-buttons">{monitoring.managers.map(renderButton)}</div>;
}
