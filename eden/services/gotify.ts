import * as v from "valibot";
import { LOGIN } from "../state.ts";
import { NOTIFICATION_EVENTS } from "../../lib/notificationEvents.ts";
import { addWebhook, json, jsonBody, local, until, type Service } from "./service.ts";

const application = v.looseObject({ token: v.string() });
const basic = `Basic ${Buffer.from(`${LOGIN.username}:${LOGIN.password}`).toString("base64")}`;

export const gotify: Service = {
  containers: ["gotify"],
  about: (ports) => `${local(ports.gotify)}  ${LOGIN.username} / ${LOGIN.password}`,
  async setup({ ports, api }) {
    const base = local(ports.gotify);
    await until("Gotify to start", () => json(`${base}/health`).then(() => true));
    const { token } = v.parse(
      application,
      await json(
        `${base}/application`,
        jsonBody("POST", { name: "Aurral" }, { authorization: basic }),
      ),
    );
    await addWebhook(api, {
      url: `${base}/message`,
      headers: [{ key: "X-Gotify-Key", value: token }],
      body: '{"title":"$title","message":"$message","priority":5}',
      events: [...NOTIFICATION_EVENTS],
    });
  },
};
