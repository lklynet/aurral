import { userToggle } from "../hooks/userToggle.ts";

export const { set: setLegacyNav, use: useLegacyNav } = userToggle("nav-legacy", false);
