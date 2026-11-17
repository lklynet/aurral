import { Hono } from "hono";
import * as v from "valibot";
import { requireAuth, requireUserAccount } from "../middleware/guards.ts";
import type { AppEnv } from "../middleware/requestUser.ts";
import { validate } from "../middleware/validate.ts";
import { friendArt } from "../services/friendArt.ts";
import {
  addFriend,
  FriendError,
  friendLists,
  removeFriend,
  shareListening,
} from "../services/hubFriends.ts";
import { forgetHubLink, HubLinkError, hubLinkStatus, startHubLink } from "../services/hubLink.ts";
import {
  makePlaylistPrivate,
  makePlaylistPublic,
  PublicPlaylistError,
  publicPlaylistState,
} from "../services/publicPlaylists.ts";
import { imageSizes } from "../../lib/imageSizes.ts";
import { sendImageFile } from "./shared/sendImageFile.ts";

const name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500));
const artQuery = v.object({ artist: name, album: v.optional(name), w: v.optional(v.string()) });

export default new Hono<AppEnv>()
  .basePath("/hub-link")
  .use(requireAuth, requireUserAccount)
  .get("/", async (c) => c.json(await hubLinkStatus(c.var.user.id)))
  .post("/", async (c) => {
    try {
      return c.json(await startHubLink(c.var.user));
    } catch (error) {
      if (error instanceof HubLinkError) return c.json({ error: error.message }, 502);
      throw error;
    }
  })
  .delete("/", async (c) => {
    forgetHubLink(c.var.user.id);
    return c.json(await hubLinkStatus(c.var.user.id));
  })
  .get("/friends", async (c) => {
    try {
      return c.json(await friendLists(c.var.user.id));
    } catch (error) {
      if (error instanceof FriendError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  })
  .get("/friends/art", validate("query", artQuery), async (c) => {
    const { artist, album, w } = c.req.valid("query");
    const width = Number(w) || 0;
    const art = await friendArt(artist, album);
    const missing = () => {
      c.header("Cache-Control", "private, max-age=3600");
      return c.json({ error: "Artwork not found" }, 404);
    };
    if ("file" in art && art.file) {
      c.header("Cache-Control", "private, max-age=86400");
      const sent = await sendImageFile(c, art.file.filePath, width, {
        contentType: art.file.contentType,
        dotfiles: "deny",
      });
      return sent ?? missing();
    }
    if (!("url" in art) || !art.url) return missing();
    c.header("Cache-Control", "private, max-age=86400");
    const sized = width > 0 && imageSizes(art.url).find((size) => size.width >= width)?.url;
    return c.redirect(sized || art.url, 302);
  })
  .put("/friends/:handle", async (c) => {
    try {
      return c.json(await addFriend(c.var.user.id, c.req.param("handle")));
    } catch (error) {
      if (error instanceof FriendError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  })
  .delete("/friends/:handle", async (c) => {
    try {
      await removeFriend(c.var.user.id, c.req.param("handle"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof FriendError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  })
  .put("/sharing", validate("json", v.object({ shared: v.boolean() })), async (c) => {
    try {
      await shareListening(c.var.user.id, c.req.valid("json").shared);
      return c.json(await hubLinkStatus(c.var.user.id));
    } catch (error) {
      if (error instanceof FriendError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  })
  .get("/public-playlists", (c) => c.json(publicPlaylistState(c.var.user.id)))
  .put("/public-playlists/:playlistId", async (c) => {
    try {
      await makePlaylistPublic(c.var.user, c.req.param("playlistId"));
      return c.json(publicPlaylistState(c.var.user.id));
    } catch (error) {
      if (error instanceof PublicPlaylistError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  })
  .delete("/public-playlists/:playlistId", async (c) => {
    try {
      await makePlaylistPrivate(c.var.user, c.req.param("playlistId"));
      return c.json(publicPlaylistState(c.var.user.id));
    } catch (error) {
      if (error instanceof PublicPlaylistError) {
        return c.json({ error: error.message }, error.status);
      }
      throw error;
    }
  });
