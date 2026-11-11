import * as v from "valibot";
import { LOGIN } from "../state.ts";
import { json, jsonBody, local, until, type Service } from "./service.ts";

const LISTENS = 40;

const apiKey = v.looseObject({ key: v.string() });
const songs = v.object({
  "subsonic-response": v.looseObject({
    searchResult3: v.optional(
      v.looseObject({
        song: v.optional(
          v.array(
            v.looseObject({
              title: v.string(),
              artist: v.optional(v.string(), ""),
              album: v.optional(v.string(), ""),
              duration: v.optional(v.number(), 0),
              musicBrainzId: v.optional(v.string()),
            }),
          ),
          [],
        ),
      }),
    ),
  }),
});

export const koito: Service = {
  containers: ["koito"],
  about: (ports) => `${local(ports.koito)}  ${LOGIN.username} / ${LOGIN.password}`,
  async setup({ ports, api }) {
    const base = local(ports.koito);
    const cookie = await until("Koito to accept a login", async () => {
      const response = await fetch(`${base}/apis/web/v1/login`, jsonBody("POST", LOGIN));
      return response.ok && response.headers.getSetCookie().map((entry) => entry.split(";")[0]);
    });
    const { key } = v.parse(
      apiKey,
      await json(
        `${base}/apis/web/v1/user/apikeys`,
        jsonBody("POST", { label: "Aurral" }, { cookie: cookie.join("; ") }),
      ),
    );

    // Koito gets listens of its own, so Aurral has history to read back.
    const found = v.parse(
      songs,
      await json(
        `${local(ports.aurralApi)}/rest/search3?${new URLSearchParams({
          u: LOGIN.username,
          p: LOGIN.password,
          v: "1.16.1",
          c: "eden",
          f: "json",
          query: "",
          songCount: String(LISTENS),
        })}`,
      ),
    );
    const hour = 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    await json(
      `${base}/apis/listenbrainz/1/submit-listens`,
      jsonBody(
        "POST",
        {
          listen_type: "import",
          payload: (found["subsonic-response"].searchResult3?.song ?? []).map((song, index) => ({
            listened_at: now - (index + 1) * hour,
            track_metadata: {
              track_name: song.title,
              artist_name: song.artist,
              release_name: song.album,
              additional_info: {
                duration_ms: song.duration * 1000,
                ...(song.musicBrainzId && { recording_mbid: song.musicBrainzId }),
              },
            },
          })),
        },
        { authorization: `Token ${key}` },
      ),
    );

    await api.put("/scrobbling/koito/link", { url: base, token: key });
  },
};
