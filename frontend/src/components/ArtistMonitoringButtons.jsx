import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, MoreVertical, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import lidarrLogo from "../../images/logos/lidarr-color.svg";
import AddActionButton from "./AddActionButton";
import { DotLoader } from "./DotLoader";
import { LibraryItemMenu } from "./LibraryItemMenu";
import SearchLibraryCheck from "./SearchLibraryCheck";
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
import { getRemovalTarget } from "../utils/libraryDestination.js";

export const LidarrLogo = ({ className }) => <img className={className} src={lidarrLogo} alt="" />;

export function useArtistMonitoring({
  mbid,
  artistName = "",
  canChange = false,
  canAdd = false,
  canRemove = false,
  onRemove = null,
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
      showError(describeAurralMonitoringError(error, "Could not update monitoring"));
    } finally {
      setPending(false);
    }
  };

  const reason = (() => {
    if (monitoringQuery.isError) return "Could not check monitoring. Reload the page to try again.";
    if (!state) return manager === "lidarr" ? "Checking Lidarr" : "Checking monitoring";
    if (state.error) return state.error;
    return null;
  })();

  const canMonitor = state ? (state.added ? canChange : canAdd) : false;
  const monitoringItems = canMonitor
    ? buildManagerMonitoringItems({ manager, current: state.monitorOption, adding, onSelect: choose })
    : [];
  const removals = canRemove && onRemove && state
    ? [
        manager === "lidarr" && state.added && "lidarr",
        (manager === "aurral" ? state.added : state.inAurral) && "aurral",
      ].filter(Boolean)
    : [];
  const removalItems = removals.map((target, index) => ({
    id: `remove-${target}`,
    label: `Remove from ${getRemovalTarget(target, manager)}`,
    icon: Trash2,
    danger: true,
    separatorBefore: index === 0,
    closeBeforeSelect: true,
    onSelect: () => onRemove(target),
  }));

  return {
    state,
    destination,
    manager,
    ready: destination.ready && !destination.error,
    pending,
    adding,
    label: describeArtistMonitoring(state ?? { manager, added: true, monitorOption: "none" }),
    reason,
    monitoringItems,
    removalItems,
  };
}

const ButtonContent = ({ icon, label, pending }) => (
  <>
    <span className="btn-add-action__icon">{pending ? <DotLoader size="sm" label={null} /> : icon}</span>
    <span className="btn-add-action__label">{label}</span>
    <MoreVertical className="btn-add-action__more" aria-hidden="true" />
  </>
);

export function ArtistMonitoringButtons({ onCustomizeLidarr = null, ...props }) {
  const monitoring = useArtistMonitoring(props);
  const { manager, adding, reason, label, monitoringItems, removalItems, pending } = monitoring;

  if (!monitoring.ready) {
    return <AddActionButton destination={monitoring.destination} showLabel />;
  }

  const view = manager === "aurral"
    ? {
        icon: monitoring.state?.monitorOption && monitoring.state.monitorOption !== "none"
          ? <Eye aria-hidden="true" />
          : <EyeOff aria-hidden="true" />,
        label,
        name: `Monitoring: ${label}`,
        menuLabel: "Monitoring",
        items: [...monitoringItems, ...removalItems],
      }
    : adding
      ? {
          icon: <Plus aria-hidden="true" />,
          label: "Add to Lidarr",
          name: "Add to Lidarr",
          menuLabel: "Add to Lidarr",
          items: [...monitoringItems, ...removalItems],
        }
      : {
          icon: <SearchLibraryCheck action aria-hidden="true" aria-label={undefined} />,
          label: "In library",
          name: `In library. Lidarr monitoring: ${label}`,
          menuLabel: "Library",
          items: [
            ...(monitoringItems.length
              ? [{ id: "monitor", label: `Monitor: ${label}`, icon: LidarrLogo, submenuItems: monitoringItems }]
              : []),
            ...removalItems,
          ],
        };

  if (reason) {
    return (
      <Tooltip content={reason}>
        <span className="artist-monitoring-button__blocked" tabIndex={0} aria-label={`${view.name}. ${reason}`}>
          <span className="btn btn-add-action btn-add-action--labeled is-disabled" aria-hidden="true">
            <ButtonContent icon={view.icon} label={view.label} pending={false} />
          </span>
        </span>
      </Tooltip>
    );
  }

  if (!view.items.length) {
    if (adding) return null;
    return (
      <span className="btn btn-add-action btn-add-action--labeled" role="img" aria-label={view.name}>
        <span className="btn-add-action__icon">{view.icon}</span>
        <span className="btn-add-action__label">{view.label}</span>
      </span>
    );
  }

  const menu = (
    <LibraryItemMenu
      label={view.name}
      menuLabel={view.menuLabel}
      triggerLabel={view.name}
      triggerClassName="btn btn-add-action btn-add-action--labeled btn-add-action--menu"
      triggerIcon={<ButtonContent icon={view.icon} label={view.label} pending={pending} />}
      disabled={pending}
      contextMenu={false}
      align="start"
      items={view.items}
    />
  );

  if (!(adding && onCustomizeLidarr && monitoringItems.length)) return menu;
  return (
    <div className="btn-add-action-group">
      {menu}
      <AddActionButton
        icon={SlidersHorizontal}
        label="Customize Lidarr add"
        onClick={onCustomizeLidarr}
        disabled={pending}
      />
    </div>
  );
}
