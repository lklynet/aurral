import { useRef, useState, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { Eye, MoreVertical, Plus, SlidersHorizontal } from "./icons";
import { ArtistMonitoringRulesDialog } from "./ArtistMonitoringRulesDialog";
import { DotLoader } from "./DotLoader";
import { LibraryItemMenu } from "./LibraryItemMenu";
import Tooltip from "./Tooltip";
import { useToast } from "../contexts/ToastContext";
import { useActiveDownloads } from "../hooks/useActiveDownloads";
import { queryClient, queryKeys } from "../queryClient.ts";
import { libraryArtistsClient } from "../utils/api/clients/libraryArtists.ts";
import { updateLibraryArtist } from "../utils/api/endpoints/library.ts";
import { describeAurralMonitoringError } from "../utils/aurralMonitoring.ts";
import {
  buildArtistMonitoringItems,
  describeArtistMonitoring,
  describeArtistMonitoringChange,
  isArtistMonitored,
} from "../utils/artistMonitoring.ts";

type MonitoringData = InferResponseType<
  (typeof libraryArtistsClient.artists)[":mbid"]["monitoring"]["$get"],
  200
>;
type MonitoringRequest = Parameters<
  Parameters<typeof buildArtistMonitoringItems>[0]["onSelect"]
>[0];

interface UseArtistMonitoringOptions {
  mbid: string | null | undefined;
  artistName?: string;
  canChange?: boolean;
  canAdd?: boolean;
  onChanged?: (() => unknown) | null;
}

const isUnchanged = (state: MonitoringData | null, { monitoring }: MonitoringRequest) => {
  if (!state || state.added === false) return monitoring.monitored === false;
  const { monitored, useDefault, rules } = monitoring;
  if (monitored !== isArtistMonitored(state)) return false;
  return useDefault === undefined && rules === undefined;
};

const optimisticState = (existing: MonitoringData | undefined, request: MonitoringRequest) => {
  if (!existing) return existing;
  const { monitored, useDefault } = request.monitoring;
  return {
    ...existing,
    added: true,
    monitored,
    ...(monitored && { useDefault: useDefault !== false }),
  };
};

export function useArtistMonitoring({
  mbid,
  artistName = "",
  canChange = false,
  canAdd = false,
  onChanged = null,
}: UseArtistMonitoringOptions) {
  const { isArtistDownloading } = useActiveDownloads();
  const { showSuccess, showError } = useToast();
  const [pending, setPending] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const pendingRef = useRef(false);
  const monitoringQuery = useQuery({
    queryKey: queryKeys.artistMonitoring(mbid),
    queryFn: mbid
      ? ({ signal }) =>
          parseResponse(
            libraryArtistsClient.artists[":mbid"].monitoring.$get(
              { param: { mbid: encodeURIComponent(mbid) } },
              { init: { signal } },
            ),
          )
      : skipToken,
    enabled: Boolean(mbid),
    staleTime: 0,
  });
  const state = monitoringQuery.data || null;
  const name = artistName || "this artist";

  const choose = async (request: MonitoringRequest) => {
    if (!mbid || pendingRef.current) return false;
    if (isUnchanged(state, request)) return true;
    const queryKey = queryKeys.artistMonitoring(mbid);
    const adding = state?.added === false;
    pendingRef.current = true;
    setPending(true);
    await queryClient.cancelQueries({ queryKey });
    const previous = queryClient.getQueryData(queryKey);
    const optimistic = queryClient.setQueryData<MonitoringData>(queryKey, (existing) =>
      optimisticState(existing, request),
    );
    try {
      const response = await updateLibraryArtist(mbid, { ...request, artistName: name });
      if (adding) queryClient.setQueryData(queryKeys.libraryLookup(mbid), true);
      showSuccess(describeArtistMonitoringChange({ name, request, response }));
      await queryClient.invalidateQueries({ queryKey: queryKeys.libraryArtist(mbid) });
      await onChanged?.();
      return true;
    } catch (error) {
      if (queryClient.getQueryData(queryKey) === optimistic)
        queryClient.setQueryData(queryKey, previous);
      showError(
        `Could not ${adding ? "add" : "change monitoring for"} ${name}. ${adding ? "Nothing was added." : "Nothing changed."} ${describeAurralMonitoringError(error, "Try again.")}`,
      );
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
      void queryClient.invalidateQueries({ queryKey });
    }
  };

  const reason = (() => {
    if (monitoringQuery.isError) return "Could not check monitoring. Reload the page to try again.";
    if (!state) return "Checking monitoring";
    return null;
  })();

  const canMonitor = state ? (state.added ? canChange : canAdd) : false;

  return {
    pending,
    downloading: isArtistDownloading(mbid),
    monitored: isArtistMonitored(state),
    label: describeArtistMonitoring(state),
    reason,
    monitoringItems: canMonitor
      ? buildArtistMonitoringItems({
          state,
          onSelect: choose,
          onEditRules: () => setRulesOpen(true),
        }).map((item) =>
          item.id === "monitor:rules" ? { ...item, icon: SlidersHorizontal } : item,
        )
      : [],
    dialog: mbid ? (
      <ArtistMonitoringRulesDialog
        open={rulesOpen}
        mbid={mbid}
        artistName={name}
        state={state}
        saving={pending}
        onClose={() => setRulesOpen(false)}
        onError={showError}
        onSave={async (monitoring) => {
          if (await choose({ monitoring })) setRulesOpen(false);
        }}
      />
    ) : null,
  };
}

const ButtonContent = ({
  icon,
  label,
  pending,
}: {
  icon: ReactNode;
  label: string;
  pending: boolean;
}) => (
  <>
    <span className="btn-add-action__icon">
      {pending ? <DotLoader size="sm" label={null} /> : icon}
    </span>
    <span className="btn-add-action__label">{label}</span>
    <MoreVertical className="btn-add-action__more" aria-hidden="true" />
  </>
);

export function ArtistMonitoringButtons(props: UseArtistMonitoringOptions) {
  const monitoring = useArtistMonitoring(props);
  const { monitored, reason, monitoringItems, pending, downloading } = monitoring;

  const icon = monitored ? <Eye aria-hidden="true" /> : <Plus aria-hidden="true" />;
  const label = monitored ? monitoring.label : "Monitor";
  const monitorName = monitored ? `Monitoring: ${monitoring.label}` : "Monitor";
  const name = downloading ? `${monitorName}. Downloading` : monitorName;

  if (reason) {
    return (
      <Tooltip content={reason}>
        <span
          className="artist-monitoring-button__blocked"
          tabIndex={0}
          aria-label={`${name}. ${reason}`}
        >
          <span
            className="btn btn-add-action btn-add-action--labeled is-disabled"
            aria-hidden="true"
          >
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

  return (
    <>
      <LibraryItemMenu
        label={name}
        menuLabel="Monitoring"
        triggerLabel={name}
        triggerClassName="btn btn-add-action btn-add-action--labeled btn-add-action--menu"
        triggerIcon={<ButtonContent icon={icon} label={label} pending={pending || downloading} />}
        disabled={pending}
        contextMenu={false}
        align="start"
        items={monitoringItems}
      />
      {monitoring.dialog}
    </>
  );
}
