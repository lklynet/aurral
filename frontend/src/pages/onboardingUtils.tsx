import type { ReactNode } from "react";

export const STEPS = ["admin", "music"] as const;
export const ONBOARDING_STEP_COUNT = 3;

export function OnboardingStep({ children }: { children?: ReactNode }) {
  return <div className="onboarding-step">{children}</div>;
}

export function OnboardingStepHeader({
  title,
  titleClassName = "",
}: {
  title: ReactNode;
  titleClassName?: string;
}) {
  return (
    <div className="onboarding-step__header">
      <h2 className={`onboarding-title${titleClassName ? ` ${titleClassName}` : ""}`}>{title}</h2>
    </div>
  );
}

export function OnboardingHint({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="onboarding-hint">{children}</p>;
}

export const ONBOARDING_HERO_LOGO_SIZE = 56;
export const ONBOARDING_COMPACT_LOGO_SIZE = 28;
