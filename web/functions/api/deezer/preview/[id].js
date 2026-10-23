const TRACK_ID_PATTERN = /^\d{1,20}$/;
const DEEZER_TIMEOUT_MS = 2500;
const LINK_CACHE_SECONDS = 300;

const reply = (status, headers = {}) =>
  new Response(null, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function onRequestGet({ params }) {
  const id = String(params?.id || "");
  if (!TRACK_ID_PATTERN.test(id)) return reply(404);
  let track;
  try {
    const response = await fetch(`https://api.deezer.com/track/${id}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DEEZER_TIMEOUT_MS),
      cf: { cacheTtl: LINK_CACHE_SECONDS, cacheEverything: true },
    });
    if (!response.ok) return reply(502);
    track = await response.json();
  } catch {
    return reply(502);
  }
  const preview = typeof track?.preview === "string" ? track.preview : "";
  return preview.startsWith("https://") ? reply(302, { Location: preview }) : reply(404);
}
