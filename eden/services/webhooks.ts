import { NOTIFICATION_EVENTS } from "../../lib/notificationEvents.ts";
import { local, type Service } from "./service.ts";

export const webhooks: Service = {
  containers: ["webhook-sink"],
  about: (ports) => `${local(ports.webhookSink)}/requests lists what Aurral sent`,
  async setup({ ports, api }) {
    await api.post("/settings", {
      integrations: {
        webhooks: [
          {
            url: `${local(ports.webhookSink)}/aurral`,
            headers: [{ key: "x-eden", value: "webhook" }],
            body: JSON.stringify({
              event: "$event",
              message: "$message",
              album: "$albumName",
              artist: "$artistName",
              track: "$trackName",
              flow: "$flowName",
              user: "$username",
            }),
            events: [...NOTIFICATION_EVENTS],
          },
        ],
      },
    });
  },
};
