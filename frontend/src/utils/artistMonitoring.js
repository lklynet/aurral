import { getMonitorOptionLabel, summarizeAurralMonitoring } from "./aurralMonitoring.js";

const MANAGER_OPTIONS = {
  aurral: ["none", "all", "future", "missing", "latest", "first"],
  lidarr: ["none", "existing", "all", "future", "missing", "latest", "first"],
};

export const getArtistOptionLabel = (option) =>
  option === "none" ? "Not monitored" : getMonitorOptionLabel(option);

export const getArtistMonitorOption = (state) => (state?.added === false ? "none" : state?.monitorOption ?? null);

export const isArtistMonitored = (state) => getArtistMonitorOption(state) !== "none";

export const buildArtistMonitoringItems = ({ manager, current = "none", onSelect }) =>
  MANAGER_OPTIONS[manager].map((option) => ({
    id: `monitor:${option}`,
    label: getArtistOptionLabel(option),
    radio: true,
    selected: current === option,
    onSelect: () => onSelect(option),
  }));

export const describeArtistMonitoring = (state) => {
  const option = getArtistMonitorOption(state);
  return option ? getArtistOptionLabel(option) : "Custom";
};

export const describeArtistMonitoringChange = ({ name, option, response }) => {
  if (option === "none") return `Stopped monitoring ${name}`;
  const change = `Monitoring ${name}: ${getMonitorOptionLabel(option)}`;
  const plan = response?.monitoring;
  if (!plan || (!plan.queued && !plan.skipped?.length)) return change;
  return `${change}. ${summarizeAurralMonitoring(plan).message}`;
};

export const describeArtistAdd = ({ name, monitorOption }) =>
  monitorOption && monitorOption !== "none"
    ? `Monitoring ${name}: ${getMonitorOptionLabel(monitorOption)}`
    : `Added ${name} to your library`;
