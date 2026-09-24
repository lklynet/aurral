const ACTIVITY_ACTIVE_FALLBACK_MS = 15_000;
const ACTIVITY_HISTORY_FALLBACK_MS = 60_000;
const ACTIVITY_ACTIVE_RECONCILE_MS = 60_000;
const ACTIVITY_HISTORY_RECONCILE_MS = 5 * 60_000;
const BOOTSTRAP_DISCONNECTED_POLL_MS = 30_000;
const BOOTSTRAP_CONNECTED_POLL_MS = 2 * 60_000;

export const getActivityPollIntervalMs = ({ isConnected, isListLikeView } = {}) => {
  if (isConnected) {
    return isListLikeView
      ? ACTIVITY_ACTIVE_RECONCILE_MS
      : ACTIVITY_HISTORY_RECONCILE_MS;
  }
  return isListLikeView
    ? ACTIVITY_ACTIVE_FALLBACK_MS
    : ACTIVITY_HISTORY_FALLBACK_MS;
};

export const shouldPollDiscoveryHealth = ({ isConnected } = {}) => !isConnected;

export const getBootstrapPollIntervalMs = ({ isConnected } = {}) =>
  isConnected ? BOOTSTRAP_CONNECTED_POLL_MS : BOOTSTRAP_DISCONNECTED_POLL_MS;
