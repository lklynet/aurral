import type { ReactNode } from "react";
import { asApiError } from "../utils/api/core.ts";

export const STEPS = ["admin", "lidarr"];

export function OnboardingStep({
  centered = false,
  children,
}: {
  centered?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`onboarding-step${centered ? " onboarding-step--center" : ""}`}>{children}</div>
  );
}

export function OnboardingStepHeader({
  title,
  titleClassName = "",
  copy,
  centered = false,
}: {
  title: ReactNode;
  titleClassName?: string;
  copy?: ReactNode;
  centered?: boolean;
}) {
  return (
    <div className={`onboarding-step__header${centered ? " onboarding-step__header--center" : ""}`}>
      <h2 className={`onboarding-title${titleClassName ? ` ${titleClassName}` : ""}`}>{title}</h2>
      {copy ? <p className="onboarding-copy">{copy}</p> : null}
    </div>
  );
}

export function OnboardingHint({
  children,
  center = false,
}: {
  children?: ReactNode;
  center?: boolean;
}) {
  if (!children) return null;
  return <p className={`onboarding-hint${center ? " onboarding-hint--center" : ""}`}>{children}</p>;
}

export const getApiErrorBody = (error: unknown) => {
  const data = asApiError(error)?.response?.data;
  return typeof data === "object" && data ? data : undefined;
};

export const getApiErrorText = (error: unknown, key: "message" | "error") => {
  const value = getApiErrorBody(error)?.[key];
  return typeof value === "string" ? value : undefined;
};

export const getApiErrorMessage = (error: unknown, fallback: string) =>
  getApiErrorText(error, "message") ||
  getApiErrorText(error, "error") ||
  asApiError(error)?.message ||
  fallback;

export const ONBOARDING_HERO_LOGO_SIZE = 56;
export const ONBOARDING_COMPACT_LOGO_SIZE = 28;
