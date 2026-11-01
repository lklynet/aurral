import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { parseResponse } from "hono/client";
import { useNavigate } from "react-router";
import { onboardingClient } from "../utils/api/clients/onboarding.ts";
import { setStoredAuth } from "../utils/api/core.ts";
import { invalidateBootstrapCache } from "../utils/appHealth.ts";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSiteLogo } from "../hooks/useSiteLogo";
import { OnboardingStep, OnboardingStepHeader, OnboardingHint } from "./onboardingUtils.tsx";
import PillToggle from "../components/PillToggle";
import DownloadFolderField from "../components/DownloadFolderField";
import { DotLoader } from "../components/DotLoader";
import {
  ONBOARDING_HERO_LOGO_SIZE,
  ONBOARDING_COMPACT_LOGO_SIZE,
  ONBOARDING_STEP_COUNT,
  STEPS,
} from "./onboardingUtils.tsx";
import { getApiErrorMessage } from "../utils/api/errors.ts";

import { ChevronRight, ChevronLeft } from "../components/icons";

type ExistingMusicMode = "read-in-place" | "import";

const EXISTING_MUSIC_MODES: { value: ExistingMusicMode; label: string }[] = [
  { value: "read-in-place", label: "Read in place" },
  { value: "import", label: "Import" },
];

const EXISTING_MUSIC_HINTS: Record<ExistingMusicMode, string> = {
  "read-in-place": "Aurral plays these files where they are and never changes them.",
  import: "Aurral copies these files into the Library folder. The originals stay put.",
};

function Onboarding() {
  useDocumentTitle("Setup");
  const logo = useSiteLogo();
  const [step, setStep] = useState(0);
  const [authUser, setAuthUser] = useState("admin");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [localNetworkBypass, setLocalNetworkBypass] = useState(false);
  const [downloadFolderPath, setDownloadFolderPath] = useState("");
  const [existingMusicPath, setExistingMusicPath] = useState("");
  const [existingMusicMode, setExistingMusicMode] = useState<ExistingMusicMode>("read-in-place");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const cardRef = useRef<HTMLFormElement>(null);
  const stepMeasureRef = useRef<HTMLDivElement>(null);
  const heroAnchorRef = useRef<HTMLDivElement>(null);
  const compactAnchorRef = useRef<HTMLDivElement>(null);
  const [stepHeight, setStepHeight] = useState<number | null>(null);
  const [animateStepHeight, setAnimateStepHeight] = useState(false);
  const [logoFlyout, setLogoFlyout] = useState<CSSProperties>({ opacity: 0 });
  const { refreshAuth } = useAuth();
  const navigate = useNavigate();

  const currentStep = STEPS[step];
  const passwordTooShort = authPassword.length > 0 && authPassword.length < 8;
  const passwordMismatch = authPasswordConfirm.length > 0 && authPassword !== authPasswordConfirm;
  const adminComplete =
    authUser.trim() && authPassword && !passwordTooShort && authPassword === authPasswordConfirm;

  const syncLogoPosition = useCallback(() => {
    const card = cardRef.current;
    const anchor = step === 0 ? heroAnchorRef.current : compactAnchorRef.current;
    if (!card || !anchor) return;
    const cardRect = card.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const size = step === 0 ? ONBOARDING_HERO_LOGO_SIZE : ONBOARDING_COMPACT_LOGO_SIZE;
    setLogoFlyout({
      top: anchorRect.top - cardRect.top + (anchorRect.height - size) / 2,
      left: anchorRect.left - cardRect.left + (anchorRect.width - size) / 2,
      width: size,
      height: size,
      opacity: 1,
    });
  }, [step]);

  useLayoutEffect(() => {
    const node = stepMeasureRef.current;
    if (!node) return;
    const syncHeight = () => setStepHeight(node.offsetHeight);
    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [step, error]);

  useLayoutEffect(() => {
    syncLogoPosition();
    const card = cardRef.current;
    const stepNode = stepMeasureRef.current;
    const observer = new ResizeObserver(syncLogoPosition);
    if (card) observer.observe(card);
    if (stepNode) observer.observe(stepNode);
    window.addEventListener("resize", syncLogoPosition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncLogoPosition);
    };
  }, [syncLogoPosition, step, stepHeight]);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setAnimateStepHeight(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleNext = () => {
    setError("");
    if (step < STEPS.length - 1) setStep(step + 1);
  };

  const handleBack = () => {
    setError("");
    if (step > 0) setStep(step - 1);
  };

  const handleFinish = async () => {
    setSubmitting(true);
    setError("");
    try {
      const existingMusic = existingMusicPath.trim();
      const { token } = await parseResponse(
        onboardingClient.complete.$post({
          json: {
            authUser: authUser.trim() || "admin",
            authPassword: authPassword || undefined,
            security: { localNetworkBypass: { enabled: localNetworkBypass } },
            downloadFolderPath: downloadFolderPath.trim() || undefined,
            existingMusic: existingMusic ? { path: existingMusic, mode: existingMusicMode } : null,
          },
        }),
      );
      if (token) setStoredAuth({ token });
      invalidateBootstrapCache();
      navigate("/welcome", { replace: true });
      await refreshAuth();
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save"));
      setSubmitting(false);
    }
  };

  const isPrimaryDisabled = (currentStep === "admin" && !adminComplete) || submitting;
  const primaryAction = currentStep === "music" ? handleFinish : handleNext;
  const primaryLabel = submitting ? "Saving…" : "Next";

  return (
    <div className="onboarding-page">
      <div className="onboarding-card-shell">
        <form
          ref={cardRef}
          autoComplete="off"
          onSubmit={(e) => e.preventDefault()}
          className="onboarding-card"
        >
          <img
            src={logo.src}
            alt="Aurral"
            aria-hidden={step > 0}
            className={`onboarding-brand-mark${logo.className}${animateStepHeight ? " onboarding-brand-mark--animate" : ""}`}
            style={logoFlyout}
          />
          <div className="onboarding-progress">
            <div className="onboarding-progress__dots" aria-hidden="true">
              {Array.from({ length: ONBOARDING_STEP_COUNT }, (_, i) => (
                <div
                  key={i}
                  className={`onboarding-progress__dot${i <= step ? " is-complete" : ""}${i === step ? " is-current" : ""}`}
                />
              ))}
            </div>
            <div className="onboarding-progress__meta">
              {step > 0 ? (
                <div
                  ref={compactAnchorRef}
                  className="onboarding-logo-anchor onboarding-logo-anchor--compact"
                  aria-hidden="true"
                />
              ) : null}
              <span className="onboarding-progress__count">
                Step {step + 1} of {ONBOARDING_STEP_COUNT}
              </span>
            </div>
          </div>

          <div
            className={`onboarding-step-shell${animateStepHeight ? " onboarding-step-shell--animate" : ""}`}
            style={stepHeight != null ? { height: stepHeight } : undefined}
            aria-busy={submitting}
          >
            <div ref={stepMeasureRef} className="onboarding-step-measure">
              {currentStep === "admin" && (
                <OnboardingStep>
                  <div
                    ref={heroAnchorRef}
                    className="onboarding-logo-anchor onboarding-logo-anchor--hero"
                    aria-hidden="true"
                  />
                  <OnboardingStepHeader
                    title="Welcome to Aurral"
                    titleClassName="onboarding-title--hero"
                  />
                  <div className="onboarding-fields">
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-username">Username</label>
                      <input
                        className="artist-input"
                        id="onboarding-username"
                        type="text"
                        autoComplete="off"
                        placeholder="Username"
                        value={authUser}
                        onChange={(e) => setAuthUser(e.target.value)}
                      />
                    </div>
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-password">Password</label>
                      <input
                        className="artist-input"
                        id="onboarding-password"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Password"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        aria-invalid={passwordTooShort ? "true" : undefined}
                      />
                      {passwordTooShort ? (
                        <p className="onboarding-field__error" role="alert">
                          Password must be at least 8 characters.
                        </p>
                      ) : null}
                    </div>
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-password-confirm">Confirm password</label>
                      <input
                        className="artist-input"
                        id="onboarding-password-confirm"
                        type="password"
                        autoComplete="new-password"
                        placeholder="Confirm password"
                        value={authPasswordConfirm}
                        onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                        aria-invalid={passwordMismatch ? "true" : undefined}
                      />
                      {passwordMismatch ? (
                        <p className="onboarding-field__error" role="alert">
                          Passwords do not match.
                        </p>
                      ) : null}
                    </div>
                    <div className="onboarding-toggle-row">
                      <span>Auto-login on local network</span>
                      <PillToggle
                        checked={localNetworkBypass}
                        onChange={(e) => setLocalNetworkBypass(e.target.checked)}
                        aria-label="Auto-login on local network"
                      />
                    </div>
                    <OnboardingHint>
                      Skip sign-in on your local network. Change this in Settings → Users.
                    </OnboardingHint>
                  </div>
                </OnboardingStep>
              )}

              {currentStep === "music" && (
                <OnboardingStep>
                  <OnboardingStepHeader title="Your music" />
                  <div className="onboarding-fields">
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-existing-music">Music you already have</label>
                      <DownloadFolderField
                        id="onboarding-existing-music"
                        value={existingMusicPath}
                        suggestFolder={false}
                        createOnConfirm={false}
                        onChange={setExistingMusicPath}
                      />
                    </div>
                    <div
                      className="artist-segmented"
                      role="group"
                      aria-label="How Aurral uses this music"
                    >
                      {EXISTING_MUSIC_MODES.map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          className={`artist-segmented-button${existingMusicMode === value ? " is-active" : ""}`}
                          aria-pressed={existingMusicMode === value}
                          onClick={() => setExistingMusicMode(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <OnboardingHint>{EXISTING_MUSIC_HINTS[existingMusicMode]}</OnboardingHint>
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-download-folder">Library folder</label>
                      <DownloadFolderField
                        id="onboarding-download-folder"
                        value={downloadFolderPath}
                        onChange={setDownloadFolderPath}
                      />
                    </div>
                    <OnboardingHint>
                      Where Aurral keeps the music it adds. Change folders later in Settings.
                    </OnboardingHint>
                  </div>
                </OnboardingStep>
              )}

              {error && (
                <p className="onboarding-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </div>

          <div className="onboarding-actions">
            {step > 0 && (
              <button type="button" onClick={handleBack} className="btn btn-secondary">
                <ChevronLeft className="artist-icon-xs" />
                Back
              </button>
            )}
            <button
              type="button"
              onClick={primaryAction}
              disabled={isPrimaryDisabled}
              className="btn btn-primary btn--grow"
              aria-busy={submitting}
            >
              {primaryLabel === "Next" ? (
                <>
                  Next
                  <ChevronRight className="artist-icon-xs" />
                </>
              ) : (
                <>
                  {submitting ? <DotLoader size="sm" label={null} /> : null}
                  {primaryLabel}
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default Onboarding;
