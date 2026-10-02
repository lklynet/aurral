import { getMonitorOptionLabel, summarizeAurralMonitoring } from "./aurralMonitoring.js";
import { getDestinationName } from "./libraryDestination.js";

const MANAGER_OPTIONS = {
  aurral: ["none", "all", "future", "missing", "latest", "first"],
  lidarr: ["none", "existing", "all", "future", "missing", "latest", "first"],
};

export const getManagerOptionLabel = (option, manager = null) => {
  if (option !== "none") return getMonitorOptionLabel(option);
  return manager === "aurral" ? "Not monitored" : "None";
};

export const buildManagerMonitoringItems = ({ manager, current = "none", adding = false, onSelect }) =>
  MANAGER_OPTIONS[manager]
    .filter((option) => !(adding && manager === "aurral" && option === "none"))
    .map((option) => ({
      id: `${manager}:${option}`,
      label: adding && option === "none" ? "Add without monitoring" : getManagerOptionLabel(option, manager),
      ...(adding ? {} : { radio: true, selected: current === option }),
      onSelect: () => onSelect(option),
    }));

export const describeArtistMonitoring = (state) => {
  if (state?.manager === "lidarr" && !state.added) return "Add to Lidarr";
  const option = state?.monitorOption;
  return option ? getManagerOptionLabel(option, state?.manager) : "Custom";
};

export const describeArtistMonitoringChange = ({ name, manager, option, response }) => {
  if (manager === "lidarr") {
    return option === "none"
      ? `Lidarr no longer monitors new albums for ${name}`
      : `Lidarr monitors ${name}: ${getMonitorOptionLabel(option)}`;
  }
  if (option === "none") return `Stopped monitoring ${name}`;
  const change = `Monitoring ${name}: ${getMonitorOptionLabel(option)}`;
  const plan = response?.monitoring;
  if (!plan || (!plan.queued && !plan.skipped?.length)) return change;
  return `${change}. ${summarizeAurralMonitoring(plan).message}`;
};

export const describeArtistAdd = ({ name, manager, monitorOption }) => {
  const added = `Added ${name} to ${getDestinationName(manager)}`;
  if (!monitorOption) return added;
  if (monitorOption === "none") return `${added} without monitoring`;
  return `${added}: ${getMonitorOptionLabel(monitorOption)}`;
};
