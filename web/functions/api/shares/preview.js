import { getHostedShare } from "../../_shareManifests.js";
import { findOnDeezer } from "../../s/[[path]].js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const position = Number(url.searchParams.get("track"));
  if (!Number.isInteger(position) || position < 0) return new Response(null, { status: 404 });
  const share = await getHostedShare(env?.SHARE_DB, url.searchParams.get("share"));
  const track = share?.manifest.tracks[position];
  if (!track) return new Response(null, { status: 404 });
  const match = await findOnDeezer({ ...track, kind: "track" });
  return match.preview
    ? new Response(null, {
        status: 302,
        headers: { Location: match.preview, "Cache-Control": "no-store" },
      })
    : new Response(null, { status: 404 });
}
