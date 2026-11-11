import * as v from "valibot";
import { json, local, until, type Service } from "./service.ts";

const ADMIN = { username: "admin", password: "password" };
const PLAYS = 60;
const STARS = 5;

const scanStatus = v.object({
  "subsonic-response": v.looseObject({
    scanStatus: v.looseObject({ scanning: v.boolean(), count: v.optional(v.number(), 0) }),
  }),
});
const songs = v.object({
  "subsonic-response": v.looseObject({
    searchResult3: v.optional(
      v.looseObject({ song: v.optional(v.array(v.looseObject({ id: v.string() })), []) }),
    ),
  }),
});

export const navidrome: Service = {
  containers: ["navidrome"],
  about: (ports) => `${local(ports.navidrome)}  ${ADMIN.username} / ${ADMIN.password}`,
  async setup({ ports, api }) {
    const rest = (method: string, params: [string, string][] = []) =>
      json(
        `${local(ports.navidrome)}/rest/${method}?${new URLSearchParams([
          ["u", ADMIN.username],
          ["p", ADMIN.password],
          ["v", "1.16.1"],
          ["c", "eden"],
          ["f", "json"],
          ...params,
        ])}`,
      );
    await until("Navidrome to scan the Library", async () => {
      const { scanStatus: status } = v.parse(scanStatus, await rest("getScanStatus"))[
        "subsonic-response"
      ];
      return !status.scanning && status.count > 0;
    });

    // Navidrome gets its own plays and favorites, so Aurral has something to import.
    const found = v.parse(
      songs,
      await rest("search3", [
        ["query", ""],
        ["songCount", String(PLAYS)],
      ]),
    );
    const ids = (found["subsonic-response"].searchResult3?.song ?? []).map((song) => song.id);
    const hour = 60 * 60 * 1000;
    await rest("scrobble", [
      ...ids.map((id): [string, string] => ["id", id]),
      ...ids.map((_, index): [string, string] => ["time", String(Date.now() - (index + 1) * hour)]),
      ["submission", "true"],
    ]);
    await rest(
      "star",
      ids.slice(0, STARS).map((id): [string, string] => ["id", id]),
    );

    await api.put("/history-servers/navidrome", {
      url: local(ports.navidrome),
      username: ADMIN.username,
      secret: ADMIN.password,
    });
  },
};
