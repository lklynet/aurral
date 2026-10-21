import { getMonitorOptionLabel, summarizeAurralMonitoring } from "./aurralMonitoring.js";

const LIDARR_OPTIONS = ["none", "existing", "all", "future", "missing", "latest", "first"];

export const getArtistOptionLabel = (option) =>
  option === "none" ? "Not monitored" : getMonitorOptionLabel(option);

export const getArtistMonitorOption = (state) =>
  state?.added === false ? "none" : (state?.monitorOption ?? null);

export const isArtistMonitored = (state) => {
  if (state?.manager === "aurral") return state.added !== false && state.monitored === true;
  return getArtistMonitorOption(state) !== "none";
};

export const buildArtistMonitoringItems = ({ manager, state, onSelect, onEditRules = null }) => {
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

export const describeArtistMonitoring = (state) => {
  if (state?.manager === "aurral") {
    if (!isArtistMonitored(state)) return "Not monitored";
    return state.useDefault === false ? "Custom rules" : "Monitored";
  }
  const option = getArtistMonitorOption(state);
  return option ? getArtistOptionLabel(option) : "Custom";
};

export const describeArtistMonitoringChange = ({ name, request, response }) => {
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

export const describeArtistAdd = ({ name, monitorOption }) =>
  monitorOption && monitorOption !== "none"
    ? `Monitoring ${name}: ${getMonitorOptionLabel(monitorOption)}`
    : `Added ${name} to your library`;
