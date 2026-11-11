import { addFromSchema } from "./servarr.ts";
import { json, local, until, type Service } from "./service.ts";

export const PROWLARR_API_KEY = "ede0000000000000000000000000a001";
const WORLD = "http://world:8080";

export const prowlarr: Service = {
  containers: ["world", "prowlarr"],
  about: (ports) => `${local(ports.prowlarr)}  API key ${PROWLARR_API_KEY}`,
  async setup({ ports, api }) {
    const base = `${local(ports.prowlarr)}/api/v1`;
    const headers = { "x-api-key": PROWLARR_API_KEY };
    await until("Prowlarr to start", () => json(`${base}/system/status`, { headers }));
    for (const [implementation, name, path] of [
      ["Newznab", "Eden Usenet", "/newznab"],
      ["Torznab", "Eden Torrents", "/torznab"],
    ] as const) {
      await addFromSchema(
        base,
        headers,
        "indexer",
        implementation,
        { name, enable: true, appProfileId: 1, priority: 25 },
        { baseUrl: `${WORLD}${path}`, apiPath: "/api", apiKey: "eden" },
      );
    }
    await api.post("/settings", {
      integrations: {
        prowlarr: { enabled: true, url: local(ports.prowlarr), apiKey: PROWLARR_API_KEY },
      },
    });
  },
};
