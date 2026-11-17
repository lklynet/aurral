import * as v from "valibot";
import type { HubLinksRow } from "../db/rows.ts";
import {
  authorized,
  hubLinksEnabled,
  hubRequest,
  linkedLink,
  markLinkBroken,
  refusalOf,
  selectLink,
} from "./hubLink.ts";

const HANDLE = /^[a-z0-9_]{3,20}$/;

const friendSchema = v.object({ handle: v.string() });
const listsSchema = v.object({
  friends: v.array(friendSchema),
  incoming: v.array(friendSchema),
  outgoing: v.array(friendSchema),
});
const requestedSchema = v.object({ status: v.picklist(["sent", "friends"]) });

export class FriendError extends Error {
  status: 404 | 409 | 422 | 502;
  constructor(message: string, status: FriendError["status"]) {
    super(message);
    this.status = status;
  }
}

const unreachable = () => new FriendError("Couldn't reach aurral.org. Try again.", 502);
const relink = () =>
  new FriendError("Your aurral.org link stopped working. Relink in Profile.", 409);

async function callHub(link: HubLinksRow, method: string, handle?: string) {
  const path = handle === undefined ? "/v1/friends" : `/v1/friends/${handle}`;
  const response = await hubRequest(link.origin, path, authorized(link, method)).catch(() => null);
  if (!response) throw unreachable();
  if (response.ok) return response;
  const refusal = await refusalOf(response);
  if (refusal === "link_revoked") {
    markLinkBroken(link.user_id);
    return null;
  }
  if (refusal === "no_account") {
    throw new FriendError("No one on aurral.org has that handle.", 404);
  }
  if (refusal === "self") throw new FriendError("That's your handle.", 422);
  throw unreachable();
}

function changeableLink(userId: number) {
  const link = linkedLink(userId);
  if (!link) throw new FriendError("Link an aurral.org account first.", 409);
  return link;
}

const handleOf = (input: string) => {
  const handle = input.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE.test(handle)) throw new FriendError("No one on aurral.org has that handle.", 404);
  return handle;
};

export async function friendLists(userId: number) {
  if (!hubLinksEnabled()) return { state: "off" as const };
  const link = selectLink.get(userId);
  if (!link?.linked_at) return { state: "none" as const };
  const response = link.broken ? null : await callHub(link, "GET");
  if (!response) return { state: "broken" as const };
  const lists = v.safeParse(listsSchema, await response.json().catch(() => null));
  if (!lists.success) throw unreachable();
  return { state: "linked" as const, ...lists.output };
}

export async function addFriend(userId: number, input: string) {
  if (!hubLinksEnabled()) throw new FriendError("aurral.org accounts are turned off.", 409);
  const link = changeableLink(userId);
  const response = await callHub(link, "PUT", handleOf(input));
  if (!response) throw relink();
  const added = v.safeParse(requestedSchema, await response.json().catch(() => null));
  if (!added.success) throw unreachable();
  return added.output;
}

export async function removeFriend(userId: number, input: string) {
  const link = changeableLink(userId);
  if (!(await callHub(link, "DELETE", handleOf(input)))) throw relink();
}
