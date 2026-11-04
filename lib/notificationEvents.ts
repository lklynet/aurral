export const NOTIFICATION_EVENTS = [
  "notifyDiscoveryUpdated",
  "notifyWeeklyFlowDone",
  "notifyRequestMade",
  "notifyRequestAvailable",
  "notifyArtistAdded",
  "notifyTrackAdded",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
