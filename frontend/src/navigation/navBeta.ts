import { userToggle } from "../hooks/userToggle.ts";

export const { set: setNavBeta, use: useNavBeta } = userToggle("nav-beta", false);
