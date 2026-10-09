import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, MoreVertical, Plus, SlidersHorizontal } from "lucide-react";
import AddActionButton from "./AddActionButton";
import { DotLoader } from "./DotLoader";
import { LibraryItemMenu } from "./LibraryItemMenu";
import Tooltip from "./Tooltip";
import { useToast } from "../contexts/ToastContext";
import { useLibraryDestination } from "../hooks/useLibraryDestination";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { queryClient, queryKeys } from "../queryClient.js";
import { getArtistMonitoring, updateLibraryArtist } from "../utils/api/endpoints/library.js";
import { describeAurralMonitoringError } from "../utils/aurralMonitoring.js";
import {
  buildArtistMonitoringItems,
  describeArtistMonitoring,
  describeArtistMonitoringChange,
  getArtistMonitorOption,
  isArtistMonitored,
} from "../utils/artistMonitoring.js";

export function useArtistMonitoring({
  mbid,
  artistName = "",
  canChange = false,
  canAdd = false,
  onChanged = null,
}) {
  const destination = useLibraryDestination();
  const { isArtistDownloading } = useActiveDownloads();
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const monitoringQuery = useQuery({
    queryKey: queryKeys.artistMonitoring(mbid),
    queryFn: ({ signal }) => getArtistMonitoring(mbid, { signal }),
    enabled: Boolean(mbid),
    staleTime: 0,
  });
  const state = monitoringQuery.data || null;
  const manager = state?.manager || destination.primary;
  const current = getArtistMonitorOption(state);
  const name = artistName || "this artist";

  const choose = async (option) => {
    if (option === current || pendingRef.current) return;
    const queryKey = queryKeys.artistMonitoring(mbid);
    const adding = state?.added === false;
    pendingRef.current = true;
    setPending(true);
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData(queryKey);
    const optimistic = queryClient.setQueryData(queryKey, (existing) =>
      existing ? { ...existing, added: true, monitorOption: option } : existing);
    try {
      const response = await updateLibraryArtist(mbid, { monitorOption: option, artistName: name });
      if (adding) queryClient.setQueryData(queryKeys.libraryLookup(mbid), true);
      showSuccess(describeArtistMonitoringChange({ name, option, response }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.libraryArtist(mbid) });
      await onChanged?.();
    } catch (error) {
      if (queryClient.getQueryData(queryKey) === optimistic) queryClient.setQueryData(queryKey, previous);
      showError(
        `Could not ${adding ? "add" : "change monitoring for"} ${name}. ${adding ? "Nothing was added." : "Nothing changed."} ${describeAurralMonitoringError(error, "Try again.")}`,
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  const reason = (() => {
    if (monitoringQuery.isError) return "Could not check monitoring. Reload the page to try again.";
    if (!state) return "Checking monitoring";
    if (state.error) return state.error;
    return null;
  })();

  const canMonitor = state ? (state.added ? canChange : canAdd) : false;

  return {
    state,
    destination,
    manager,
    ready: destination.ready && !destination.error,
    pending,
    downloading: isArtistDownloading(mbid),
    monitored: isArtistMonitored(state),
    label: describeArtistMonitoring(state),
    reason,
    monitoringItems: canMonitor
      ? buildArtistMonitoringItems({ manager, current, onSelect: choose })
      : [],
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
  const { manager, monitored, reason, monitoringItems, pending, downloading, state } = monitoring;

  if (!monitoring.ready) {
    return <AddActionButton destination={monitoring.destination} showLabel />;
  }

  const icon = monitored ? <Eye aria-hidden="true" /> : <Plus aria-hidden="true" />;
  const label = monitored ? monitoring.label : "Monitor";
  const monitorName = monitored ? `Monitoring: ${monitoring.label}` : "Monitor";
  const name = downloading ? `${monitorName}. Downloading` : monitorName;

  if (reason) {
    return (
      <Tooltip content={reason}>
        <span className="artist-monitoring-button__blocked" tabIndex={0} aria-label={`${name}. ${reason}`}>
          <span className="btn btn-add-action btn-add-action--labeled is-disabled" aria-hidden="true">
            <ButtonContent icon={icon} label={label} pending={false} />
          </span>
        </span>
      </Tooltip>
    );
  }

  if (!monitoringItems.length) {
    if (!monitored) return null;
    return (
      <span className="btn btn-add-action btn-add-action--labeled" role="img" aria-label={name}>
        <span className="btn-add-action__icon">
          {downloading ? <DotLoader size="sm" label={null} /> : icon}
        </span>
        <span className="btn-add-action__label">{label}</span>
      </span>
    );
  }

  const customizeItems = manager === "lidarr" && state?.added === false && onCustomizeLidarr
    ? [{
        id: "customize",
        label: "Customize add…",
        icon: SlidersHorizontal,
        separatorBefore: true,
        closeBeforeSelect: true,
        onSelect: onCustomizeLidarr,
      }]
    : [];

  return (
    <LibraryItemMenu
      label={name}
      menuLabel="Monitoring"
      triggerLabel={name}
      triggerClassName="btn btn-add-action btn-add-action--labeled btn-add-action--menu"
      triggerIcon={<ButtonContent icon={icon} label={label} pending={pending || downloading} />}
      disabled={pending}
      contextMenu={false}
      align="start"
      items={[...monitoringItems, ...customizeItems]}
    />
  );
}
