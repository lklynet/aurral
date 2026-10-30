import type { IncomingMessage, ServerResponse } from "node:http";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { Context } from "hono";
import type { AppEnv } from "../../middleware/requestUser.ts";

export async function sendViaNode<E extends AppEnv, Args extends unknown[]>(
  c: Context<E>,
  send: (req: IncomingMessage, res: ServerResponse, ...args: Args) => Promise<boolean>,
  ...args: Args
) {
  const { incoming, outgoing } = c.env;
  c.res.headers.forEach((value, name) => outgoing.setHeader(name, value));
  return (await send(incoming, outgoing, ...args)) ? RESPONSE_ALREADY_SENT : null;
}
