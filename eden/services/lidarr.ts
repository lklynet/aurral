import { mkdirSync } from "node:fs";
import * as v from "valibot";
import { LOGIN, paths } from "../state.ts";
import { addFromSchema } from "./servarr.ts";
import { json, jsonBody, local, until, type Service } from "./service.ts";

export const LIDARR_API_KEY = "ede0000000000000000000000000a003";
const ROOT = "/music";

const profile = v.array(v.looseObject({ id: v.number() }));

export const lidarr: Service = {
  containers: ["lidarr"],
  needs: ["nzbget", "plugins"],
  about: (ports) => `${local(ports.lidarr)}  API key ${LIDARR_API_KEY}`,
  async setup({ ports, api }) {
    const base = `${local(ports.lidarr)}/api/v1`;
    const headers = { "x-api-key": LIDARR_API_KEY };
    const first = async (path: string) => {
      const [found] = v.parse(profile, await json(`${base}/${path}`, { headers }));
      if (!found) throw new Error(`Lidarr has no ${path}`);
      return found.id;
    };
    await until("Lidarr to start", () => json(`${base}/system/status`, { headers }));

    // Lidarr looks albums up in Eden's catalogue, as Aurral does.
    const metadata = await json(`${base}/config/metadataprovider`, { headers });
    await json(
      `${base}/config/metadataprovider`,
      jsonBody("PUT", { ...Object(metadata), metadataSource: "http://metadata:5002/" }, headers),
    );
    await json(
      `${base}/rootfolder`,
      jsonBody(
        "POST",
        {
          name: "Eden",
          path: ROOT,
          defaultQualityProfileId: await first("qualityprofile"),
          defaultMetadataProfileId: await first("metadataprofile"),
          defaultMonitorOption: "all",
          defaultNewItemMonitorOption: "all",
          defaultTags: [],
        },
        headers,
      ),
    );
    await addFromSchema(
      base,
      headers,
      "indexer",
      "Newznab",
      {
        name: "Eden Usenet",
        enableRss: false,
        enableAutomaticSearch: true,
        enableInteractiveSearch: true,
        priority: 25,
      },
      {
        baseUrl: "http://world:8080/internal/newznab",
        apiPath: "/api",
        apiKey: "eden",
        categories: [3000, 3040],
      },
    );
    // Lidarr tests the client before saving it, and NZBGet may still be reloading.
    await until("Lidarr to reach NZBGet", async () => {
      await addFromSchema(
        base,
        headers,
        "downloadclient",
        "Nzbget",
        { name: "NZBGet", enable: true, priority: 1 },
        {
          host: "nzbget",
          port: 6789,
          username: LOGIN.username,
          password: LOGIN.password,
          musicCategory: "lidarr",
        },
      );
      return true;
    });

    // Lidarr files albums in its own folder, which Aurral reads and never changes.
    mkdirSync(paths.lidarr, { recursive: true });
    await api.post("/library/files/read-only-folders", { path: paths.lidarr });
    await api.put("/plugins/lidarr", {
      enabled: true,
      settings: { url: local(ports.lidarr), apiKey: LIDARR_API_KEY },
    });
  },
};
