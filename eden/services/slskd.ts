import { rmSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { readWorldManifest } from "../library/generate.ts";
import { LOGIN, paths } from "../state.ts";
import { addPathMapping, json, jsonBody, local, until, type Service } from "./service.ts";

export const SLSKD_API_KEY = "ede0000000000000000000000000a002";
const PEER = "eden-peer";
const SHARE = "shared";
const SEARCH_MS = 5000;
const COMPLETE = path.join(paths.downloads, "slskd", "complete");

const application = v.looseObject({ server: v.looseObject({ isLoggedIn: v.boolean() }) });
const transfers = v.looseObject({
  directories: v.array(
    v.looseObject({ files: v.array(v.looseObject({ id: v.string(), state: v.string() })) }),
  ),
});
const search = v.looseObject({
  id: v.string(),
  isComplete: v.boolean(),
  responses: v.optional(v.array(v.looseObject({ uploadSpeed: v.number() }))),
});

export const slskd: Service = {
  containers: ["soulseek", "slskd-peer", "slskd"],
  about: (ports) => `${local(ports.slskd)}  ${LOGIN.username} / ${LOGIN.password}`,
  async setup({ ports, api, restart }) {
    const base = `${local(ports.slskd)}/api/v0`;
    const headers = { "x-api-key": SLSKD_API_KEY };
    await until(
      "slskd to log in to Eden's Soulseek server",
      async () =>
        v.parse(application, await json(`${base}/application`, { headers })).server.isLoggedIn,
    );

    // Aurral skips a peer with no measured upload speed. A peer has one once it has
    // uploaded a file, and it reads its own speed from the server when it logs in.
    const [release] = readWorldManifest(paths.world);
    const [file] = release?.files ?? [];
    if (!release || !file) throw new Error("The world has no release for slskd to fetch");
    await json(
      `${base}/transfers/downloads/${PEER}`,
      jsonBody(
        "POST",
        [{ filename: [SHARE, release.name, file.name].join("\\"), size: file.size }],
        headers,
      ),
    );
    const fetched = await until("the Soulseek peer to upload a file", async () => {
      const found = v.parse(
        transfers,
        await json(`${base}/transfers/downloads/${PEER}`, { headers }),
      );
      return found.directories
        .flatMap((entry) => entry.files)
        .find((entry) => entry.state.includes("Succeeded"));
    });
    await json(`${base}/transfers/downloads/${PEER}/${fetched.id}?remove=true`, {
      method: "DELETE",
      headers,
    });
    rmSync(path.join(COMPLETE, release.name), { recursive: true, force: true });
    restart("slskd-peer");
    await until("the Soulseek peer to report its upload speed", async () => {
      const { id } = v.parse(
        search,
        await json(
          `${base}/searches`,
          jsonBody(
            "POST",
            { searchText: `${release.artist} ${release.album}`, searchTimeout: SEARCH_MS },
            headers,
          ),
        ),
      );
      const finished = await until("slskd to finish a search", async () => {
        const found = v.parse(
          search,
          await json(`${base}/searches/${id}?includeResponses=true`, { headers }),
        );
        return found.isComplete && found;
      });
      return finished.responses?.some((response) => response.uploadSpeed > 0);
    });

    await addPathMapping(api, { source: "slskd", remote: "/downloads/complete", local: COMPLETE });
    await api.post("/settings", {
      integrations: { slskd: { enabled: true, url: local(ports.slskd), apiKey: SLSKD_API_KEY } },
    });
  },
};
