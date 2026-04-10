import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  getFlowStatus,
  getFlowJobs,
  createFlow,
  updateFlow,
  deleteFlow,
  setFlowEnabled,
  getFlowTrackStreamUrl,
  updateFlowWorkerSettings,
} from "../utils/api";
import { useToast } from "../contexts/ToastContext";
import { useWebSocketChannel } from "../hooks/useWebSocket";
import {
  FlowCard,
  FlowEmptyState,
  ConfirmDeleteModal,
  ConfirmDisableModal,
  ConfirmStopAllModal,
  FlowWorkerSettingsModal,
} from "./FlowPageComponents";

function formatNextRun(nextRunAt, now = Date.now()) {
  if (!nextRunAt) return null;
  const ts =
    typeof nextRunAt === "number" ? nextRunAt : parseInt(nextRunAt, 10);
  if (!Number.isFinite(ts)) return null;
  const diff = ts - now;
  if (diff <= 0) return "soon";
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diff < hourMs) {
    const minutes = Math.ceil(diff / minuteMs);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (diff < dayMs) {
    const hours = Math.ceil(diff / hourMs);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = Math.ceil(diff / dayMs);
  return days === 1 ? "1 day" : `${days} days`;
}

const DEFAULT_MIX = { discover: 50, mix: 30, trending: 20 };
const DEFAULT_SIZE = 30;

const MIX_PRESETS = [
  {
    id: "balanced",
    label: "Balanced",
    mix: DEFAULT_MIX,
  },
  {
    id: "discover",
    label: "Discover Focus",
    mix: { discover: 70, mix: 20, trending: 10 },
  },
  {
    id: "library",
    label: "Library Mix",
    mix: { discover: 25, mix: 65, trending: 10 },
  },
  {
    id: "trending",
    label: "Trending Lift",
    mix: { discover: 35, mix: 20, trending: 45 },
  },
  {
    id: "custom",
    label: "Custom",
    mix: null,
  },
];

const FOCUS_STRENGTHS = {
  light: 20,
  medium: 35,
  heavy: 50,
};

const FOCUS_OPTIONS = [
  { id: "light", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "heavy", label: "Heavy" },
];

const NEW_FLOW_TEMPLATE = {
  name: "Discover",
  size: DEFAULT_SIZE,
  mix: DEFAULT_MIX,
  deepDive: false,
  tags: {},
  relatedArtists: {},
};

const getNextFlowName = (flows, baseName = "Discover") => {
  const normalizedBase = String(baseName || "").trim() || "Discover";
  const existingNames = new Set(
    (Array.isArray(flows) ? flows : [])
      .map((flow) => String(flow?.name || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!existingNames.has(normalizedBase.toLowerCase())) {
    return normalizedBase;
  }
  let index = 2;
  while (index < 10000) {
    const candidate = `${normalizedBase} ${index}`;
    if (!existingNames.has(candidate.toLowerCase())) {
      return candidate;
    }
    index += 1;
  }
  return `${normalizedBase} ${Date.now()}`;
};

const parseListInput = (value) =>
  String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const normalizeScheduleDays = (value) => {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const entry of value) {
    const day = Number(entry);
    if (!Number.isFinite(day)) continue;
    const normalized = Math.round(day);
    if (normalized < 0 || normalized > 6) continue;
    unique.add(normalized);
  }
  return [...unique].sort((a, b) => a - b);
};

const normalizeMixPercent = (mix) => {
  const raw = {
    discover: Number(mix?.discover ?? 0),
    mix: Number(mix?.mix ?? 0),
    trending: Number(mix?.trending ?? 0),
  };
  const sum = raw.discover + raw.mix + raw.trending;
  if (!Number.isFinite(sum) || sum <= 0) {
    return { ...DEFAULT_MIX };
  }
  const weights = [
    { key: "discover", value: raw.discover },
    { key: "mix", value: raw.mix },
    { key: "trending", value: raw.trending },
  ];
  const scaled = weights.map((w) => ({
    ...w,
    raw: (w.value / sum) * 100,
  }));
  const floored = scaled.map((w) => ({
    ...w,
    count: Math.floor(w.raw),
    remainder: w.raw - Math.floor(w.raw),
  }));
  let remaining = 100 - floored.reduce((acc, w) => acc + w.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const item of ordered) {
    out[item.key] = item.count;
  }
  return out;
};

const getPresetForMix = (mix) => {
  const normalized = normalizeMixPercent(mix);
  const preset = MIX_PRESETS.find(
    (entry) =>
      entry.mix &&
      entry.mix.discover === normalized.discover &&
      entry.mix.mix === normalized.mix &&
      entry.mix.trending === normalized.trending
  );
  return preset?.id ?? "custom";
};

const buildCountsFromMixPercent = (size, mix) => {
  const weights = normalizeMixPercent(mix);
  const entries = [
    { key: "discover", value: weights.discover },
    { key: "mix", value: weights.mix },
    { key: "trending", value: weights.trending },
  ];
  const scaled = entries.map((entry) => ({
    ...entry,
    raw: (entry.value / 100) * size,
  }));
  const floored = scaled.map((entry) => ({
    ...entry,
    count: Math.floor(entry.raw),
    remainder: entry.raw - Math.floor(entry.raw),
  }));
  let remaining = size - floored.reduce((acc, entry) => acc + entry.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const entry of ordered) {
    out[entry.key] = entry.count;
  }
  return out;
};

const getFocusPercentFromStrength = (strength) =>
  FOCUS_STRENGTHS[strength] ?? FOCUS_STRENGTHS.medium;

const getFocusStrengthFromPercent = (percent) => {
  const numeric = Number(percent || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return "medium";
  const entries = Object.entries(FOCUS_STRENGTHS);
  const closest = entries.reduce((best, [key, value]) => {
    if (!best) return { key, distance: Math.abs(value - numeric) };
    const distance = Math.abs(value - numeric);
    return distance < best.distance ? { key, distance } : best;
  }, null);
  return closest?.key ?? "medium";
};

const buildCountsFromFocusPercent = (size, tagPercent, relatedPercent) => {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
  const tag = Math.max(0, Number(tagPercent || 0));
  const related = Math.max(0, Number(relatedPercent || 0));
  const totalPercent = tag + related;
  if (safeSize <= 0 || totalPercent <= 0) {
    return { tag: 0, related: 0, remaining: safeSize };
  }
  const targetTotal = Math.round((totalPercent / 100) * safeSize);
  const entries = [
    { key: "tag", raw: (tag / 100) * safeSize },
    { key: "related", raw: (related / 100) * safeSize },
  ];
  const floored = entries.map((entry) => ({
    ...entry,
    count: Math.floor(entry.raw),
    remainder: entry.raw - Math.floor(entry.raw),
  }));
  let remaining = targetTotal - floored.reduce((acc, entry) => acc + entry.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const entry of ordered) {
    out[entry.key] = entry.count;
  }
  return {
    tag: out.tag ?? 0,
    related: out.related ?? 0,
    remaining: Math.max(0, safeSize - (out.tag ?? 0) - (out.related ?? 0)),
  };
};

const buildFocusStrengthFromCounts = (size, tagCount, relatedCount) => {
  const safeSize = Number.isFinite(size) && size > 0 ? size : 0;
  if (safeSize <= 0) {
    return { tagStrength: "medium", relatedStrength: "medium" };
  }
  const tag = Math.max(0, Number(tagCount || 0));
  const related = Math.max(0, Number(relatedCount || 0));
  const totalPercent = Math.round(((tag + related) / safeSize) * 100);
  if (totalPercent <= 0) {
    return { tagStrength: "medium", relatedStrength: "medium" };
  }
  const entries = [
    { key: "tag", raw: (tag / safeSize) * 100 },
    { key: "related", raw: (related / safeSize) * 100 },
  ];
  const floored = entries.map((entry) => ({
    ...entry,
    count: Math.floor(entry.raw),
    remainder: entry.raw - Math.floor(entry.raw),
  }));
  let remaining = totalPercent - floored.reduce((acc, entry) => acc + entry.count, 0);
  const ordered = [...floored].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    ordered[i].count += 1;
    remaining -= 1;
  }
  const out = {};
  for (const entry of ordered) {
    out[entry.key] = entry.count;
  }
  return {
    tagStrength: getFocusStrengthFromPercent(out.tag ?? 0),
    relatedStrength: getFocusStrengthFromPercent(out.related ?? 0),
  };
};

const distributeCount = (total, values) => {
  const items = values.filter(Boolean);
  if (!items.length || total <= 0) return new Map();
  const per = Math.floor(total / items.length);
  let remaining = total - per * items.length;
  const result = new Map();
  for (const item of items) {
    const extra = remaining > 0 ? 1 : 0;
    if (remaining > 0) remaining -= 1;
    result.set(item, per + extra);
  }
  return result;
};

const sumWeightMap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value).reduce((acc, entry) => {
    const parsed = Number(entry);
    return acc + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
};

const flowToForm = (flow) => {
  const tagsMap =
    flow?.tags && typeof flow.tags === "object" && !Array.isArray(flow.tags)
      ? flow.tags
      : {};
  const relatedMap =
    flow?.relatedArtists &&
    typeof flow.relatedArtists === "object" &&
    !Array.isArray(flow.relatedArtists)
      ? flow.relatedArtists
      : {};
  const tagCount = sumWeightMap(tagsMap);
  const relatedCount = sumWeightMap(relatedMap);
  const recipeCounts =
    flow?.recipe && typeof flow.recipe === "object" && !Array.isArray(flow.recipe)
      ? flow.recipe
      : null;
  const recipeTotal = sumWeightMap(recipeCounts);
  const rawSize = Number(flow?.size || 0);
  const size =
    Number.isFinite(rawSize) && rawSize > 0
      ? rawSize
      : recipeTotal > 0
        ? recipeTotal
        : DEFAULT_SIZE;
  const mix = normalizeMixPercent(flow?.mix || DEFAULT_MIX);
  const preset = getPresetForMix(mix);
  const focusStrengths = buildFocusStrengthFromCounts(
    Number.isFinite(size) ? size : 0,
    tagCount,
    relatedCount
  );
  return {
    name: flow?.name || "",
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : DEFAULT_SIZE,
    mix,
    mixPreset: preset,
    deepDive: flow?.deepDive === true,
    includeTags: Object.keys(tagsMap).join(", "),
    includeRelatedArtists: Object.keys(relatedMap).join(", "),
    tagStrength: focusStrengths.tagStrength,
    relatedStrength: focusStrengths.relatedStrength,
    scheduleDays:
      normalizeScheduleDays(flow?.scheduleDays).length > 0
        ? normalizeScheduleDays(flow?.scheduleDays)
        : [new Date().getDay()],
  };
};

const buildFlowFromForm = (draft) => {
  const name = String(draft?.name ?? "").trim();
  if (!name) {
    throw new Error("Flow name is required");
  }
  const sizeValue = Number(draft?.size);
  if (!Number.isFinite(sizeValue) || sizeValue <= 0) {
    throw new Error("Total tracks must be a positive number");
  }
  const size = Math.round(sizeValue);
  const includeTags = parseListInput(draft?.includeTags);
  const includeRelatedArtists = parseListInput(draft?.includeRelatedArtists);
  const tagFocusPercent =
    includeTags.length > 0
      ? getFocusPercentFromStrength(draft?.tagStrength)
      : 0;
  const relatedFocusPercent =
    includeRelatedArtists.length > 0
      ? getFocusPercentFromStrength(draft?.relatedStrength)
      : 0;
  if (tagFocusPercent + relatedFocusPercent > 100) {
    throw new Error("Tag and related focus exceeds 100%");
  }
  const scheduleDays = normalizeScheduleDays(draft?.scheduleDays);
  if (scheduleDays.length === 0) {
    throw new Error("Select at least one day for this flow schedule");
  }
  const focusCounts = buildCountsFromFocusPercent(
    size,
    tagFocusPercent,
    relatedFocusPercent
  );
  const tagFocus = focusCounts.tag;
  const relatedFocus = focusCounts.related;
  const mix = normalizeMixPercent(draft?.mix);
  const recipe = buildCountsFromMixPercent(size, mix);
  const tags = {};
  if (tagFocus > 0 && includeTags.length > 0) {
    const tagCounts = distributeCount(tagFocus, includeTags);
    for (const [tag, count] of tagCounts.entries()) {
      if (count <= 0) continue;
      tags[tag] = count;
    }
  }
  const relatedArtists = {};
  if (relatedFocus > 0 && includeRelatedArtists.length > 0) {
    const relatedCounts = distributeCount(relatedFocus, includeRelatedArtists);
    for (const [artist, count] of relatedCounts.entries()) {
      if (count <= 0) continue;
      relatedArtists[artist] = count;
    }
  }
  return {
    name,
    size,
    mix,
    recipe,
    tags,
    relatedArtists,
    deepDive: draft?.deepDive === true,
    scheduleDays,
  };
};

const normalizeDraftForCompare = (draft) => {
  const normalizeList = (value) =>
    parseListInput(value)
      .map((entry) => entry.toLowerCase())
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
  return {
    name: String(draft?.name ?? "").trim(),
    size: Number(draft?.size ?? 0),
    mix: normalizeMixPercent(draft?.mix),
    includeTags: normalizeList(draft?.includeTags),
    includeRelatedArtists: normalizeList(draft?.includeRelatedArtists),
    tagStrength: draft?.tagStrength ?? "medium",
    relatedStrength: draft?.relatedStrength ?? "medium",
    deepDive: draft?.deepDive === true,
    scheduleDays: normalizeScheduleDays(draft?.scheduleDays),
  };
};

const isFlowDirty = (flow, draft) => {
  const base = normalizeDraftForCompare(flowToForm(flow));
  const next = normalizeDraftForCompare(draft);
  return JSON.stringify(base) !== JSON.stringify(next);
};

const EMPTY_FLOW_STATS = {
  total: 0,
  done: 0,
  pending: 0,
  downloading: 0,
};

const DEFAULT_WORKER_SETTINGS = {
  concurrency: 3,
  preferredFormat: "flac",
  preferredFormatStrict: false,
  seedDownloads: true,
};

const buildFlowStatsFromJobs = (jobs) => {
  const stats = { ...EMPTY_FLOW_STATS };
  if (!Array.isArray(jobs)) return stats;
  for (const job of jobs) {
    if (!job?.status || job.status === "failed") continue;
    stats[job.status] = (stats[job.status] || 0) + 1;
  }
  stats.total = stats.pending + stats.downloading + stats.done;
  return stats;
};

const sanitizeFlowStats = (stats) => {
  const pending = Number(stats?.pending || 0);
  const downloading = Number(stats?.downloading || 0);
  const done = Number(stats?.done || 0);
  return {
    total: pending + downloading + done,
    pending,
    downloading,
    done,
  };
};

function FlowPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [isWorkerSettingsOpen, setIsWorkerSettingsOpen] = useState(false);
  const [workerSettingsDraft, setWorkerSettingsDraft] = useState(
    DEFAULT_WORKER_SETTINGS,
  );
  const [workerSettingsBaseline, setWorkerSettingsBaseline] = useState(
    DEFAULT_WORKER_SETTINGS,
  );
  const [savingWorkerSettings, setSavingWorkerSettings] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState({});
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [simpleDrafts, setSimpleDrafts] = useState({});
  const [simpleErrors, setSimpleErrors] = useState({});
  const [applyingFlowId, setApplyingFlowId] = useState(null);
  const [flowStatsById, setFlowStatsById] = useState({});
  const [tracksExpandedId, setTracksExpandedId] = useState(null);
  const [tracksLoadingByFlowId, setTracksLoadingByFlowId] = useState({});
  const [tracksErrorByFlowId, setTracksErrorByFlowId] = useState({});
  const [tracksByFlowId, setTracksByFlowId] = useState({});
  const [bulkActionRunning, setBulkActionRunning] = useState(false);
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const lastFlowWsMessageAtRef = useRef(0);
  const { showSuccess, showError } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getFlowStatus();
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleFlowStatusMessage = useCallback((msg) => {
    if (msg?.type !== "weekly_flow_status") return;
    if (!msg?.status || typeof msg.status !== "object") return;
    lastFlowWsMessageAtRef.current = Date.now();
    setStatus(msg.status);
    setLoading(false);
  }, []);

  const { isConnected: isFlowSocketConnected } = useWebSocketChannel(
    "weekly-flow",
    handleFlowStatusMessage,
  );

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (isFlowSocketConnected) {
      fetchStatus();
    }
  }, [isFlowSocketConnected, fetchStatus]);

  useEffect(() => {
    const workerRunning = status?.worker?.running === true;
    const hintPhase = status?.hint?.phase;
    const inTransition = hintPhase === "preparing" || hintPhase === "downloading";
    if (!workerRunning && !inTransition) return;
    const hasRecentWsUpdate =
      Date.now() - lastFlowWsMessageAtRef.current < 20000;
    if (isFlowSocketConnected && hasRecentWsUpdate) return;
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [status?.worker?.running, status?.hint?.phase, isFlowSocketConnected, fetchStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdownNow(Date.now());
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const activeFlowIdsKey = useMemo(() => {
    if (!status?.worker?.running || !status?.flows?.length) return "";
    const activeIds = status.flows
      .filter((flow) => {
        const stats = status.flowStats?.[flow.id];
        return (stats?.pending || 0) > 0 || (stats?.downloading || 0) > 0;
      })
      .map((flow) => flow.id)
      .sort();
    return activeIds.join("|");
  }, [status?.worker?.running, status?.flows, status?.flowStats]);

  useEffect(() => {
    if (!activeFlowIdsKey) return;
    const activeFlowIds = activeFlowIdsKey.split("|").filter(Boolean);
    if (!activeFlowIds.length) return;

    let cancelled = false;
    const fetchIncrementalJobs = async () => {
      try {
        const results = await Promise.all(
          activeFlowIds.map((flowId) =>
            getFlowJobs(flowId).then((jobs) => ({
              flowId,
              stats: buildFlowStatsFromJobs(jobs),
            })),
          ),
        );
        if (cancelled) return;
        setFlowStatsById((prev) => {
          const next = { ...prev };
          for (const result of results) {
            next[result.flowId] = result.stats;
          }
          return next;
        });
      } catch {}
    };

    fetchIncrementalJobs();
    const interval = setInterval(fetchIncrementalJobs, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeFlowIdsKey]);

  useEffect(() => {
    if (!status?.flows?.length) {
      setFlowStatsById({});
      return;
    }
    const flowIds = new Set(status.flows.map((flow) => flow.id));
    setFlowStatsById((prev) => {
      const next = {};
      for (const [flowId, stats] of Object.entries(prev)) {
        if (flowIds.has(flowId)) {
          next[flowId] = stats;
        }
      }
      return next;
    });
  }, [status?.flows]);

  useEffect(() => {
    if (!status?.flows?.length) return;
    setSimpleDrafts((prev) => {
      const next = { ...prev };
      for (const flow of status.flows) {
        const normalized = flowToForm(flow);
        if (!next[flow.id]) {
          next[flow.id] = normalized;
          continue;
        }
        const current = next[flow.id];
        next[flow.id] = {
          ...normalized,
          ...current,
          tagStrength: current.tagStrength ?? normalized.tagStrength,
          relatedStrength: current.relatedStrength ?? normalized.relatedStrength,
        };
      }
      return next;
    });
  }, [status?.flows]);

  const getPlaylistStats = (flowId) => {
    return sanitizeFlowStats(
      status?.flowStats?.[flowId] ||
      flowStatsById[flowId] ||
      EMPTY_FLOW_STATS,
    );
  };

  const getPlaylistState = (flowId) => {
    const stats = getPlaylistStats(flowId);
    if (stats.total === 0) return "idle";
    if (stats.downloading > 0 || stats.pending > 0) return "running";
    if (stats.done > 0) return "completed";
    return "idle";
  };

  const handleCancelSimple = (flow) => {
    setSimpleDrafts((prev) => ({
      ...prev,
      [flow.id]: flowToForm(flow),
    }));
    setSimpleErrors((prev) => {
      const next = { ...prev };
      delete next[flow.id];
      return next;
    });
    setEditingId((prev) => (prev === flow.id ? null : prev));
  };

  const handleApplySimple = async (flow) => {
    setApplyingFlowId(flow.id);
    setSimpleErrors((prev) => {
      const next = { ...prev };
      delete next[flow.id];
      return next;
    });
    try {
      const draft = simpleDrafts[flow.id] || flowToForm(flow);
      const payload = buildFlowFromForm(draft);
      const response = await updateFlow(flow.id, payload);
      const updatedFlow = response?.flow || {
        ...flow,
        ...payload,
      };
      setSimpleDrafts((prev) => ({
        ...prev,
        [flow.id]: flowToForm(updatedFlow),
      }));
      showSuccess("Flow updated");
      await fetchStatus();
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to update flow";
      setSimpleErrors((prev) => ({ ...prev, [flow.id]: message }));
      showError(message);
    } finally {
      setApplyingFlowId(null);
    }
  };

  const handleCreateInline = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const uniqueName = getNextFlowName(status?.flows, NEW_FLOW_TEMPLATE.name);
      const draft = flowToForm({
        ...NEW_FLOW_TEMPLATE,
        name: uniqueName,
      });
      const payload = buildFlowFromForm(draft);
      const response = await createFlow(payload);
      const createdFlow = response?.flow;
      if (createdFlow?.id) {
        setSimpleDrafts((prev) => ({
          ...prev,
          [createdFlow.id]: flowToForm(createdFlow),
        }));
        setEditingId(createdFlow.id);
      }
      showSuccess("Flow created");
      await fetchStatus();
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to create flow";
      showError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (flow) => {
    setConfirmDelete({
      flowId: flow.id,
      title: flow.name,
    });
  };

  const handleConfirmDelete = async () => {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.flowId);
    try {
      await deleteFlow(confirmDelete.flowId);
      showSuccess("Flow deleted");
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message || err.message || "Failed to delete flow"
      );
    } finally {
      setDeletingId(null);
    }
    setConfirmDelete(null);
  };

  const handleToggleEnabled = async (flow, nextEnabled) => {
    setTogglingId(flow.id);
    try {
      await setFlowEnabled(flow.id, nextEnabled);
      showSuccess(nextEnabled ? "Flow enabled" : "Flow disabled");
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message || err.message || "Failed to update flow"
      );
    } finally {
      setOptimisticEnabled((prev) => {
        const next = { ...prev };
        delete next[flow.id];
        return next;
      });
      setTogglingId(null);
    }
  };

  const handleToggleRequest = (flow, nextEnabled) => {
    if (!nextEnabled) {
      setConfirmDisable({ flowId: flow.id, title: flow.name });
      return;
    }
    setOptimisticEnabled((prev) => ({ ...prev, [flow.id]: true }));
    handleToggleEnabled(flow, true);
  };

  const flowList = status?.flows || [];
  const effectiveFlowList = flowList.map((flow) => {
    const optimisticValue = optimisticEnabled[flow.id];
    if (typeof optimisticValue !== "boolean") return flow;
    return {
      ...flow,
      enabled: optimisticValue,
    };
  });
  const disabledFlowCount = effectiveFlowList.filter(
    (flow) => flow.enabled !== true,
  ).length;
  const enabledFlowCount = effectiveFlowList.length - disabledFlowCount;

  const handleConfirmDisable = async () => {
    if (!confirmDisable) return;
    const flow = flowList.find((entry) => entry.id === confirmDisable.flowId);
    if (flow) {
      setOptimisticEnabled((prev) => ({ ...prev, [flow.id]: false }));
      await handleToggleEnabled(flow, false);
    }
    setConfirmDisable(null);
  };

  const handleSetAllEnabled = async (targetEnabled) => {
    if (bulkActionRunning) return;
    const targetFlows = flowList.filter((flow) => {
      const optimisticValue = optimisticEnabled[flow.id];
      const isEnabled =
        typeof optimisticValue === "boolean"
          ? optimisticValue
          : flow.enabled === true;
      return targetEnabled ? !isEnabled : isEnabled;
    });
    if (targetFlows.length === 0) return;

    setBulkActionRunning(true);
    setOptimisticEnabled((prev) => {
      const next = { ...prev };
      for (const flow of targetFlows) {
        next[flow.id] = targetEnabled;
      }
      return next;
    });

    let successCount = 0;
    const failed = [];
    for (const flow of targetFlows) {
      try {
        await setFlowEnabled(flow.id, targetEnabled);
        successCount += 1;
      } catch (err) {
        failed.push({
          name: flow.name || "Flow",
          message:
            err.response?.data?.message ||
            err.message ||
            `Failed to ${targetEnabled ? "start" : "stop"} flow`,
        });
      }
    }

    if (successCount > 0) {
      showSuccess(
        successCount === targetFlows.length
          ? `${targetEnabled ? "Started" : "Stopped"} ${successCount} flows`
          : `${targetEnabled ? "Started" : "Stopped"} ${successCount} flows with ${failed.length} failures`,
      );
    }
    if (failed.length > 0) {
      const first = failed[0];
      showError(
        failed.length === 1
          ? `${first.name}: ${first.message}`
          : `Failed to ${targetEnabled ? "start" : "stop"} ${failed.length} flows. First issue: ${first.name} - ${first.message}`,
      );
    }

    await fetchStatus();
    setOptimisticEnabled((prev) => {
      const next = { ...prev };
      for (const flow of targetFlows) {
        delete next[flow.id];
      }
      return next;
    });
    setBulkActionRunning(false);
  };

  const handleStopAllRequest = () => {
    if (bulkActionRunning || enabledFlowCount === 0) return;
    setConfirmStopAll(true);
  };

  const handleConfirmStopAll = async () => {
    setConfirmStopAll(false);
    await handleSetAllEnabled(false);
  };

  const getCurrentWorkerSettings = () => {
    const raw = status?.worker?.settings || {};
    const parsedConcurrency = Number(raw.concurrency);
    const concurrency =
      Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
        ? Math.min(5, Math.floor(parsedConcurrency))
        : DEFAULT_WORKER_SETTINGS.concurrency;
    const preferredFormat =
      String(raw.preferredFormat || "").toLowerCase() === "mp3"
        ? "mp3"
        : "flac";
    const preferredFormatStrict = raw.preferredFormatStrict === true;
    const seedDownloads = raw.seedDownloads !== false;
    return {
      concurrency,
      preferredFormat,
      preferredFormatStrict,
      seedDownloads,
    };
  };

  const handleOpenWorkerSettings = () => {
    const current = getCurrentWorkerSettings();
    setWorkerSettingsBaseline(current);
    setWorkerSettingsDraft(current);
    setIsWorkerSettingsOpen(true);
  };

  const handleSaveWorkerSettings = async () => {
    const safeConcurrency = Math.min(
      5,
      Math.max(1, Math.floor(Number(workerSettingsDraft.concurrency) || 3)),
    );
    const safePreferredFormat =
      workerSettingsDraft.preferredFormat === "mp3" ? "mp3" : "flac";
    const safePreferredFormatStrict =
      workerSettingsDraft.preferredFormatStrict === true;
    const safeSeedDownloads = workerSettingsDraft.seedDownloads !== false;
    const current = workerSettingsBaseline;
    const hasChanges =
      safeConcurrency !== current.concurrency ||
      safePreferredFormat !== current.preferredFormat ||
      safePreferredFormatStrict !== current.preferredFormatStrict ||
      safeSeedDownloads !== current.seedDownloads;
    if (!hasChanges || savingWorkerSettings) return;
    setSavingWorkerSettings(true);
    try {
      await updateFlowWorkerSettings({
        concurrency: safeConcurrency,
        preferredFormat: safePreferredFormat,
        preferredFormatStrict: safePreferredFormatStrict,
        seedDownloads: safeSeedDownloads,
      });
      setWorkerSettingsBaseline({
        concurrency: safeConcurrency,
        preferredFormat: safePreferredFormat,
        preferredFormatStrict: safePreferredFormatStrict,
        seedDownloads: safeSeedDownloads,
      });
      showSuccess("Flow worker settings updated");
      setIsWorkerSettingsOpen(false);
      await fetchStatus();
    } catch (err) {
      showError(
        err.response?.data?.message ||
          err.response?.data?.error ||
          err.message ||
          "Failed to update flow worker settings",
      );
    } finally {
      setSavingWorkerSettings(false);
    }
  };

  const normalizeReason = (job) => {
    if (job?.reason) return job.reason;
    if (job?.playlistType) {
      if (job.playlistType === "discover") return "From discovery recommendations";
      if (job.playlistType === "mix") return "From your library mix";
      if (job.playlistType === "trending") return "From trending artists";
    }
    return "Flow selection";
  };

  const fetchFlowTracks = async (flowId, { showSpinner = true } = {}) => {
    if (!flowId) return;
    if (showSpinner) {
      setTracksLoadingByFlowId((prev) => ({ ...prev, [flowId]: true }));
    }
    setTracksErrorByFlowId((prev) => ({ ...prev, [flowId]: "" }));
    try {
      const jobs = await getFlowJobs(flowId, 500);
      const normalized = (Array.isArray(jobs) ? jobs : [])
        .filter((job) => job?.status !== "failed")
        .map((job) => ({
          ...job,
          albumName: job?.albumName || null,
          reason: normalizeReason(job),
          streamUrl:
            job?.status === "done" && job?.id ? getFlowTrackStreamUrl(job.id) : null,
        }));
      setTracksByFlowId((prev) => ({
        ...prev,
        [flowId]: normalized,
      }));
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Failed to load tracks";
      setTracksErrorByFlowId((prev) => ({ ...prev, [flowId]: message }));
      showError(message);
    } finally {
      if (showSpinner) {
        setTracksLoadingByFlowId((prev) => ({ ...prev, [flowId]: false }));
      }
    }
  };

  const handleToggleTracks = async (flowId) => {
    if (!flowId) return;
    if (tracksExpandedId === flowId) {
      setTracksExpandedId(null);
      return;
    }
    setEditingId(null);
    setTracksExpandedId(flowId);
    await fetchFlowTracks(flowId);
  };

  const handleToggleEditing = (flowId) => {
    setEditingId((prev) => {
      const next = prev === flowId ? null : flowId;
      if (next) {
        setSimpleErrors((prevErrors) => {
          const nextErrors = { ...prevErrors };
          delete nextErrors[flowId];
          return nextErrors;
        });
        setTracksExpandedId(null);
      }
      return next;
    });
  };

  const handleNavigateArtist = (track) => {
    if (!track?.artistMbid) return;
    navigate(`/artist/${track.artistMbid}`, {
      state: { artistName: track.artistName },
    });
  };
  if (loading && !status) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-[#707e61]" />
      </div>
    );
  }
  const currentWorkerSettings = workerSettingsBaseline;
  const hasWorkerSettingsChanges =
    Number(workerSettingsDraft.concurrency) !== currentWorkerSettings.concurrency ||
    (workerSettingsDraft.preferredFormat === "mp3" ? "mp3" : "flac") !==
      currentWorkerSettings.preferredFormat ||
    (workerSettingsDraft.preferredFormatStrict === true) !==
      currentWorkerSettings.preferredFormatStrict ||
    (workerSettingsDraft.seedDownloads !== false) !==
      currentWorkerSettings.seedDownloads;

  return (
    <div className="flow-page max-w-6xl mx-auto px-4 pb-10">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-end gap-2">
          <h2 className="text-base font-semibold text-white">Playlists</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleOpenWorkerSettings}
            className="btn btn-secondary btn-sm px-2 opacity-80 hover:opacity-100"
            aria-label="Open flow worker settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => handleSetAllEnabled(true)}
            className="btn btn-secondary btn-sm"
            disabled={bulkActionRunning || disabledFlowCount === 0}
          >
            {bulkActionRunning ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Working...
              </span>
            ) : (
              "Start All"
            )}
          </button>
          <button
            type="button"
            onClick={handleStopAllRequest}
            className="btn btn-secondary btn-sm"
            disabled={bulkActionRunning || enabledFlowCount === 0}
          >
            {bulkActionRunning ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Working...
              </span>
            ) : (
              "Stop All"
            )}
          </button>
          <button
            type="button"
            onClick={handleCreateInline}
            className="btn btn-primary btn-sm"
            disabled={creating}
          >
            {creating ? "Creating..." : "New Playlist"}
          </button>
        </div>
      </div>

      <div className="space-y-4">
        {effectiveFlowList.length === 0 && (
          <FlowEmptyState onCreate={handleCreateInline} creating={creating} />
        )}
        {effectiveFlowList.map((flow) => {
          const stats = getPlaylistStats(flow.id);
          const state = getPlaylistState(flow.id);
          const flowSize = Number(flow?.size || 0);
          const targetTotal =
            Number.isFinite(flowSize) && flowSize > 0
              ? Math.floor(flowSize)
              : stats.total;
          const displayStats = {
            ...stats,
            total: targetTotal,
          };
          const enabled = flow.enabled === true;
          const nextRun = formatNextRun(flow.nextRunAt, countdownNow);
          const isEditing = editingId === flow.id;
          const simpleDraft = simpleDrafts[flow.id] ?? flowToForm(flow);
          const simpleError = simpleErrors[flow.id];
          const simpleSize = Number(simpleDraft?.size ?? 0);
          const simpleMixSize = Number.isFinite(simpleSize) ? simpleSize : 0;
          const isApplying = applyingFlowId === flow.id;
          const hasChanges = isFlowDirty(flow, simpleDraft);
          return (
            <FlowCard
              key={flow.id}
              flow={flow}
              enabled={enabled}
              state={state}
              stats={displayStats}
              currentJob={status?.worker?.currentJob}
              statusHint={status?.hint}
              operationQueue={status?.operationQueue}
              nextRun={nextRun}
              isEditing={isEditing}
              isTracksOpen={tracksExpandedId === flow.id}
              tracks={tracksByFlowId[flow.id] || []}
              tracksLoading={tracksLoadingByFlowId[flow.id] === true}
              tracksError={tracksErrorByFlowId[flow.id] || ""}
              simpleDraft={simpleDraft}
              simpleRemaining={simpleMixSize}
              simpleError={simpleError}
              isApplying={isApplying}
              hasChanges={hasChanges}
              togglingId={togglingId}
              deletingId={deletingId}
              onToggleEditing={() => handleToggleEditing(flow.id)}
              onToggleEnabled={(checked) => handleToggleRequest(flow, checked)}
              onDelete={() => handleDelete(flow)}
              onViewTracks={() => handleToggleTracks(flow.id)}
              onNavigateArtist={handleNavigateArtist}
              onCancel={() => handleCancelSimple(flow)}
              onApply={() => handleApplySimple(flow)}
              onDraftChange={(updater) =>
                setSimpleDrafts((prev) => {
                  const base = prev[flow.id] ?? simpleDraft;
                  return { ...prev, [flow.id]: updater(base) };
                })
              }
              onClearError={() => {
                if (simpleErrors[flow.id]) {
                  setSimpleErrors((prev) => {
                    const next = { ...prev };
                    delete next[flow.id];
                    return next;
                  });
                }
              }}
              mixPresets={MIX_PRESETS}
              focusOptions={FOCUS_OPTIONS}
              normalizeMixPercent={normalizeMixPercent}
            />
          );
        })}
      </div>

      <ConfirmDeleteModal
        confirmDelete={confirmDelete}
        deletingId={deletingId}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleConfirmDelete}
      />
      <ConfirmDisableModal
        confirmDisable={confirmDisable}
        togglingId={togglingId}
        onCancel={() => setConfirmDisable(null)}
        onConfirm={handleConfirmDisable}
      />
      <ConfirmStopAllModal
        confirmStopAll={confirmStopAll}
        bulkActionRunning={bulkActionRunning}
        onCancel={() => setConfirmStopAll(false)}
        onConfirm={handleConfirmStopAll}
      />
      <FlowWorkerSettingsModal
        isOpen={isWorkerSettingsOpen}
        settings={workerSettingsDraft}
        hasChanges={hasWorkerSettingsChanges}
        saving={savingWorkerSettings}
        onCancel={() => {
          if (savingWorkerSettings) return;
          setIsWorkerSettingsOpen(false);
        }}
        onChange={setWorkerSettingsDraft}
        onSave={handleSaveWorkerSettings}
      />
    </div>
  );
}

export default FlowPage;
