import type { MonitoringRules } from "../components/MonitoringRulesFields.tsx";
import {
  getMonitorOptionLabel,
  summarizeAurralMonitoring,
  type AurralMonitoringPlan,
} from "./aurralMonitoring.ts";

interface ArtistMonitoringState {
  manager?: string | null;
  added?: boolean;
  monitored?: boolean;
  monitorOption?: string | null;
  useDefault?: boolean;
  rules?: MonitoringRules | null;
  monitoring?: AurralMonitoringPlan;
}

type ArtistMonitoringRequest =
  | {
      monitoring: { monitored: boolean; useDefault?: boolean; rules?: MonitoringRules | null };
      monitorOption?: undefined;
    }
  | { monitoring?: undefined; monitorOption: string };

const LIDARR_OPTIONS = ["none", "existing", "all", "future", "missing", "latest", "first"];

export const getArtistOptionLabel = (option: string) =>
  option === "none" ? "Not monitored" : getMonitorOptionLabel(option);

export const getArtistMonitorOption = (state: ArtistMonitoringState | null | undefined) =>
  state?.added === false ? "none" : (state?.monitorOption ?? null);

export const isArtistMonitored = (state: ArtistMonitoringState | null | undefined) => {
  if (state?.manager === "aurral") return state.added !== false && state.monitored === true;
  return getArtistMonitorOption(state) !== "none";
};

export const buildArtistMonitoringItems = ({
  manager,
  state,
  onSelect,
  onEditRules = null,
}: {
  manager?: string | null;
  state: ArtistMonitoringState | null | undefined;
  onSelect: (request: ArtistMonitoringRequest) => unknown;
  onEditRules?: (() => void) | null;
}) => {
  if (manager === "aurral") {
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
      ...(onEditRules
        ? [
            {
              id: "monitor:rules",
              label: "Monitoring rules…",
              separatorBefore: true,
              closeBeforeSelect: true,
              onSelect: onEditRules,
            },
          ]
        : []),
    ];
  }
  const current = getArtistMonitorOption(state);
  return LIDARR_OPTIONS.map((option) => ({
    id: `monitor:${option}`,
    label: getArtistOptionLabel(option),
    radio: true,
    selected: current === option,
    onSelect: () => onSelect({ monitorOption: option }),
  }));
};

export const describeArtistMonitoring = (state: ArtistMonitoringState | null | undefined) => {
  if (state?.manager === "aurral") {
    if (!isArtistMonitored(state)) return "Not monitored";
    return state.useDefault === false ? "Custom rules" : "Monitored";
  }
  const option = getArtistMonitorOption(state);
  return option ? getArtistOptionLabel(option) : "Custom";
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
  if (request?.monitoring) {
    if (!request.monitoring.monitored) return `Stopped monitoring ${name}`;
    const change =
      response?.useDefault === false
        ? `Monitoring ${name} with custom rules`
        : `Monitoring ${name}`;
    return response?.monitoring
      ? `${change}. ${summarizeAurralMonitoring(response.monitoring, response).message}`
      : change;
  }
  const option = request?.monitorOption;
  if (option === "none") return `Stopped monitoring ${name}`;
  return `Monitoring ${name}: ${getMonitorOptionLabel(option)}`;
};

export const describeArtistAdd = ({
  name,
  monitorOption,
}: {
  name: string | undefined;
  monitorOption?: string | null;
}) =>
  monitorOption && monitorOption !== "none"
    ? `Monitoring ${name}: ${getMonitorOptionLabel(monitorOption)}`
    : `Added ${name} to your library`;
