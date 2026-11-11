import type { MonitoringRules } from "./monitoringRules.ts";
import { summarizeAurralMonitoring, type AurralMonitoringPlan } from "./aurralMonitoring.ts";

interface ArtistMonitoringState {
  added?: boolean;
  monitored?: boolean;
  useDefault?: boolean;
  rules?: MonitoringRules | null;
  monitoring?: AurralMonitoringPlan;
}

type ArtistMonitoringRequest = {
  monitoring: { monitored: boolean; useDefault?: boolean; rules?: MonitoringRules | null };
};

export const isArtistMonitored = (state: ArtistMonitoringState | null | undefined) =>
  state?.added !== false && state?.monitored === true;

export const buildArtistMonitoringItems = ({
  state,
  onSelect,
  onEditRules,
}: {
  state: ArtistMonitoringState | null | undefined;
  onSelect: (request: ArtistMonitoringRequest) => unknown;
  onEditRules: () => void;
}) => {
  const monitored = isArtistMonitored(state);
  return [
    {
      id: "monitor:on",
      label: "Monitored",
      radio: true,
      selected: monitored,
      onSelect: () => onSelect({ monitoring: { monitored: true } }),
    },
    {
      id: "monitor:off",
      label: "Not monitored",
      radio: true,
      selected: !monitored,
      onSelect: () => onSelect({ monitoring: { monitored: false } }),
    },
    {
      id: "monitor:rules",
      label: "Monitoring rules…",
      separatorBefore: true,
      closeBeforeSelect: true,
      onSelect: onEditRules,
    },
  ];
};

export const describeArtistMonitoring = (state: ArtistMonitoringState | null | undefined) => {
  if (!isArtistMonitored(state)) return "Not monitored";
  return state?.useDefault === false ? "Custom rules" : "Monitored";
};

export const describeArtistMonitoringChange = ({
  name,
  request,
  response,
}: {
  name: string;
  request: ArtistMonitoringRequest;
  response?: ArtistMonitoringState;
}) => {
  if (!request.monitoring.monitored) return `Stopped monitoring ${name}`;
  const change =
    response?.useDefault === false ? `Monitoring ${name} with custom rules` : `Monitoring ${name}`;
  return response?.monitoring
    ? `${change}. ${summarizeAurralMonitoring(response.monitoring, response).message}`
    : change;
};
