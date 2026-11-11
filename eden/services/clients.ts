import { LOGIN } from "../state.ts";
import { local, type Service } from "./service.ts";

// Both are static web apps. The browser connects to whatever server you enter,
// so they need no setup: sign in with this Eden's Aurral address.
const client = (container: "feishin" | "airsonic", flavor: string): Service => ({
  containers: [container],
  about: (ports) =>
    `${local(ports[container])}  ${flavor}: enter ${local(ports.aurralApi)} and ${LOGIN.username} / ${LOGIN.password}`,
  setup: async () => {},
});

export const feishin = client("feishin", "OpenSubsonic");
export const airsonic = client("airsonic", "classic Subsonic");
