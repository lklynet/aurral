import { decodeSharePayload } from "../../s/[[path]].js";
import { INSTANCE_ID_PATTERN, SHARE_TOKEN_PATTERN } from "../../_shareInstances.js";
import { getHostedShare, loadSharedFiles } from "../../_shareManifests.js";
import { parseShareManifest } from "../../../../lib/shareManifest.ts";

export async function onRequest({ request, env }) {
  if (request.method !== "GET")
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  const segment = new URL(request.url).searchParams.get("share") || "";
  const [payload, listen] = segment.split("~");
  const [id, token, extra] = (listen || payload).split(".");
  const identified = !extra && INSTANCE_ID_PATTERN.test(id) && SHARE_TOKEN_PATTERN.test(token);
  const hosted = !listen ? await getHostedShare(env?.SHARE_DB, payload) : null;
  const decoded = hosted ? hosted.manifest : decodeSharePayload(payload);
  const manifest = parseShareManifest(
    decoded && {
      ...decoded,
      tracks:
        !hosted && decoded.kind === "track"
          ? [{ ...decoded, albumTitle: decoded.albumTitle }]
          : decoded.tracks,
    },
  );
  if (!manifest || (identified && !listen && !hosted))
    return Response.json({ error: "not_found" }, { status: 404 });
  const files = hosted?.shareFiles
    ? await loadSharedFiles(env?.SHARE_DB, hosted.instanceId, hosted.token)
    : identified && listen
      ? await loadSharedFiles(env?.SHARE_DB, id, token)
      : null;
  return Response.json({ manifest, files }, { headers: { "Cache-Control": "no-store" } });
}
