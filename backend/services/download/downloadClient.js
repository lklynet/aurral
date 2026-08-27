const REQUIRED_METHODS = [
  "isConfigured",
  "testConnection",
  "getStatus",
  "updateConfig",
];

export function assertDownloadClient(client) {
  if (!client || (typeof client !== "object" && typeof client !== "function")) {
    throw new TypeError("DownloadClient must be an object");
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof client[method] !== "function") {
      throw new TypeError(`DownloadClient.${method} must be a function`);
    }
  }
  return client;
}
