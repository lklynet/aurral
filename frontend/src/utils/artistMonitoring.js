import { getMonitorOptionLabel, summarizeAurralMonitoring } from "./aurralMonitoring.js";
import { getManagerName } from "./libraryDestination.js";

const MANAGER_OPTIONS = {
  aurral: ["none", "all", "future", "missing", "latest", "first"],
  lidarr: ["none", "existing", "all", "future", "missing", "latest", "first"],
};

export const getManagerOptionLabel = (option, manager = null) => {
  if (option !== "none") return getMonitorOptionLabel(option);
  return manager === "aurral" ? "Unmonitored" : "None";
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

export const describeManagerMonitoring = (manager, state) => {
  if (manager === "aurral") return getManagerOptionLabel(state?.aurral?.mode || "none", "aurral");
  if (!state?.lidarr?.inLidarr) return "Add to Lidarr";
  const option = state.lidarr.monitorOption;
  return option ? getManagerOptionLabel(option) : "Custom";
};

export const buildArtistAddMenuItems = ({ destination = {}, onAdd }) => {
  const lidarrAvailable = [destination.primary, destination.alternative].includes("lidarr");
  const managers = lidarrAvailable
    ? [destination.primary, destination.alternative].filter(Boolean)
    : ["aurral"];
  return managers.map((manager) => ({
    id: `add-${manager}`,
    label: manager === "aurral" ? "Monitor with Aurral" : "Add to Lidarr",
    submenuItems: buildManagerMonitoringItems({
      manager,
      adding: true,
      onSelect: (option) => onAdd(manager, option),
    }),
  }));
};

export const describeArtistMonitoringChange = ({ name, manager, option, response }) => {
  if (option === "none") return `${getManagerName(manager)} no longer monitors ${name}`;
  const change = `${getManagerName(manager)} monitors ${name}: ${getMonitorOptionLabel(option)}`;
  const plan = response?.monitoring;
  if (!plan || (!plan.queued && !plan.skipped?.length)) return change;
  return `${change}. ${summarizeAurralMonitoring(plan).message}`;
};

export const describeArtistAdd = ({ name, manager, monitorOption, response }) => {
  const added = `Added ${name} to ${getManagerName(manager)}`;
  if (!monitorOption || monitorOption === "none") {
    return manager === "lidarr" && monitorOption === "none" ? `${added} without monitoring` : added;
  }
  const plan = response?.artist?.monitoring;
  const summary = plan && (plan.queued || plan.skipped?.length) ? `. ${summarizeAurralMonitoring(plan).message}` : "";
  return `${added}: ${getMonitorOptionLabel(monitorOption)}${summary}`;
};
