import { APP_PROFILE, hasAppCapability } from "../config/app-profile.js";

export const getCapabilityUnavailablePayload = (capability, profile = APP_PROFILE) => ({
  error: "Capability unavailable",
  code: "capability_unavailable",
  capability,
  profile,
});

export const requireAppCapability = (capability) => (_req, res, next) => {
  if (hasAppCapability(capability)) {
    next();
    return;
  }

  res.status(404).json(getCapabilityUnavailablePayload(capability));
};
