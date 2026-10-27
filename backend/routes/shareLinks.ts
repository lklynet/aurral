import { Hono, type Context } from "hono";
import * as v from "valibot";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { resolveShareTarget } from "../services/shareLinks/library.ts";
import { syncShareListener } from "../services/shareLinks/shareListener.ts";
import { getShareTunnelState, hasCloudflared } from "../services/shareLinks/tunnel.ts";
import {
  createShareLink,
  deleteShareLink,
  listShareLinks,
  shareLinkUrl,
} from "../services/shareLinks/store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_OPTIONS = { "1d": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS, never: null };
const KINDS = new Set(["track", "album", "artist"]);
const PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{4,700}$/;

type ShareLink = NonNullable<ReturnType<typeof createShareLink>>;

const ref = v.nullish(v.union([v.string(), v.number()]));
const targetQuery = v.object({
  kind: v.optional(v.string()),
  libraryTrackId: v.optional(v.string()),
  trackMbid: v.optional(v.string()),
  libraryAlbumId: v.optional(v.string()),
  albumMbid: v.optional(v.string()),
  libraryArtistId: v.optional(v.string()),
  artistMbid: v.optional(v.string()),
});
const createInput = v.object({
  kind: v.nullish(v.string()),
  libraryTrackId: ref,
  trackMbid: ref,
  libraryAlbumId: ref,
  albumMbid: ref,
  libraryArtistId: ref,
  artistMbid: ref,
  payload: v.nullish(v.string()),
  expiresIn: v.nullish(v.string()),
  allowDownload: v.nullish(v.boolean()),
});

type ShareTargetInput = Partial<v.InferOutput<typeof createInput>>;

const text = (value: unknown) => String(value ?? "").trim();

function targetFromInput(input: ShareTargetInput) {
  const kind = text(input.kind);
  if (!KINDS.has(kind)) return null;
  if (kind === "track") {
    const targetRef = text(input.libraryTrackId) || text(input.trackMbid);
    return targetRef ? { kind, targetRef, albumRef: text(input.libraryAlbumId) || null } : null;
  }
  if (kind === "album") {
    const targetRef = text(input.libraryAlbumId) || text(input.albumMbid);
    return targetRef ? { kind, targetRef, albumRef: null } : null;
  }
  const targetRef = text(input.libraryArtistId) || text(input.artistMbid);
  return targetRef ? { kind, targetRef, albumRef: null } : null;
}

const toResponse = (link: ShareLink) => ({
  id: link.id,
  kind: link.kind,
  title: link.title,
  artistName: link.artistName,
  allowDownload: link.allowDownload,
  expiresAt: link.expiresAt,
  createdAt: link.createdAt,
  url: shareLinkUrl(link),
});

const invalidTarget = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: "invalid_request", message: "Choose what to share." }, 400);

export default new Hono<AppEnv>()
  .basePath("/share-links")
  .use(requireAuth, requireUserAccount)
  .get("/", (c) =>
    c.json(
      {
        links: listShareLinks(Number(c.var.user.id)).map(toResponse),
        tunnel: getShareTunnelState(),
      },
      200,
    ),
  )
  .get("/availability", validate("query", targetQuery), async (c) => {
    const target = targetFromInput(c.req.valid("query"));
    if (!target) return invalidTarget(c);
    return c.json(
      {
        trackCount: resolveShareTarget(target)?.tracks.length || 0,
        tunnelAvailable: await hasCloudflared(),
      },
      200,
    );
  })
  .post("/", validate("json", createInput), async (c) => {
    const input = c.req.valid("json");
    const target = targetFromInput(input);
    if (!target) return invalidTarget(c);
    const payload = text(input.payload);
    if (!PAYLOAD_PATTERN.test(payload)) {
      return c.json(
        { error: "invalid_request", message: "The share link is incomplete.", field: "payload" },
        400,
      );
    }
    const expiresIn = text(input.expiresIn);
    if (!Object.hasOwn(EXPIRY_OPTIONS, expiresIn)) {
      return c.json(
        {
          error: "invalid_request",
          message: "Choose when the link expires.",
          field: "expiresIn",
        },
        400,
      );
    }
    const resolved = resolveShareTarget(target);
    if (!resolved) {
      return c.json(
        { error: "not_in_library", message: "No Library tracks available to share." },
        404,
      );
    }
    if (!(await hasCloudflared())) {
      return c.json(
        {
          error: "tunnel_unavailable",
          message: "Install cloudflared on your server to share playback.",
        },
        503,
      );
    }
    const duration = EXPIRY_OPTIONS[expiresIn as keyof typeof EXPIRY_OPTIONS];
    const link = createShareLink({
      ...target,
      userId: Number(c.var.user.id),
      payload,
      title: resolved.title,
      artistName: resolved.artistName,
      allowDownload: input.allowDownload === true,
      expiresAt: duration == null ? null : Date.now() + duration,
    });
    await syncShareListener();
    return c.json({ link: toResponse(link) }, 201);
  })
  .delete("/:id", async (c) => {
    if (!deleteShareLink(Number(c.var.user.id), c.req.param("id"))) {
      return c.json({ error: "not_found", message: "This link was already stopped." }, 404);
    }
    await syncShareListener();
    return c.body(null, 204);
  });
