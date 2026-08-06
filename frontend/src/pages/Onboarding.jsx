import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  completeOnboarding,
  getLidarrMetadataProfilesOnboarding,
  getLidarrProfilesOnboarding,
  testLidarrOnboarding,
} from "../utils/api/endpoints/auth.js";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { SettingsInput } from "./Settings/components/SettingsField";
import { OnboardingStep, OnboardingStepHeader, OnboardingHint } from "./onboardingUtils.jsx";
import PillToggle from "../components/PillToggle";
import {
  getApiErrorMessage,
  ONBOARDING_HERO_LOGO_SIZE,
  ONBOARDING_COMPACT_LOGO_SIZE,
  STEPS,
} from "./onboardingUtils.jsx";

import { ChevronRight, ChevronLeft } from "lucide-react";
function Onboarding() {
  useDocumentTitle("Setup");
  const [step, setStep] = useState(0);
  const [authUser, setAuthUser] = useState("admin");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [localNetworkBypass, setLocalNetworkBypass] = useState(false);
  const [lidarrUrl, setLidarrUrl] = useState("");
  const [lidarrApiKey, setLidarrApiKey] = useState("");
  const [lidarrQualityProfileId, setLidarrQualityProfileId] = useState(null);
  const [lidarrMetadataProfileId, setLidarrMetadataProfileId] = useState(null);
  const [lidarrTestSuccess, setLidarrTestSuccess] = useState(false);
  const [testingLidarr, setTestingLidarr] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const cardRef = useRef(null);
  const stepMeasureRef = useRef(null);
  const heroAnchorRef = useRef(null);
  const compactAnchorRef = useRef(null);
  const [stepHeight, setStepHeight] = useState(null);
  const [animateStepHeight, setAnimateStepHeight] = useState(false);
  const [logoFlyout, setLogoFlyout] = useState({ opacity: 0 });
  const { refreshAuth } = useAuth();
  const { showSuccess } = useToast();

  const currentStep = STEPS[step];
  const passwordTooShort = authPassword.length > 0 && authPassword.length < 8;
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

  const handleTestLidarr = async () => {
    if (!lidarrUrl.trim() || !lidarrApiKey.trim()) {
      setError("Enter Lidarr URL and API key first");
      return;
    }
    setTestingLidarr(true);
    setError("");
    try {
      await testLidarrOnboarding(lidarrUrl.trim(), lidarrApiKey.trim());
      const [profiles, metadataProfiles] = await Promise.all([
        getLidarrProfilesOnboarding(lidarrUrl.trim(), lidarrApiKey.trim()),
        getLidarrMetadataProfilesOnboarding(lidarrUrl.trim(), lidarrApiKey.trim()),
      ]);
      setLidarrQualityProfileId(profiles?.[0]?.id ?? null);
      setLidarrMetadataProfileId(metadataProfiles?.[0]?.id ?? null);
      setLidarrTestSuccess(true);
      showSuccess("Lidarr connection successful");
    } catch (e) {
      setLidarrTestSuccess(false);
      setError(getApiErrorMessage(e, "Lidarr connection failed"));
    } finally {
      setTestingLidarr(false);
    }
  };

  const handleFinish = async () => {
    if (!lidarrTestSuccess) {
      await handleTestLidarr();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await completeOnboarding({
        authUser: authUser.trim() || "admin",
        authPassword: authPassword || undefined,
        security: {
          localNetworkBypass: { enabled: localNetworkBypass === true },
        },
        lidarr: {
          url: lidarrUrl.trim().replace(/\/+$/, ""),
          apiKey: lidarrApiKey.trim(),
          qualityProfileId: lidarrQualityProfileId,
          metadataProfileId: lidarrMetadataProfileId,
          defaultMonitorOption: "none",
          searchOnAdd: false,
        },
      });
      await refreshAuth();
      showSuccess("Setup complete. Sign in with your admin account.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save"));
    } finally {
      setSubmitting(false);
    }
  };

  const isPrimaryDisabled =
    (currentStep === "admin" && !adminComplete) ||
    (currentStep === "lidarr" &&
      ((!lidarrTestSuccess && (!lidarrUrl.trim() || !lidarrApiKey.trim())) ||
        testingLidarr ||
        submitting));

  const primaryAction = currentStep === "lidarr" ? handleFinish : handleNext;
  const primaryLabel =
    currentStep === "admin"
      ? "Next"
      : lidarrTestSuccess
        ? submitting
          ? "Saving…"
          : "Go to Aurral"
        : testingLidarr
          ? "Testing…"
          : "Test connection";

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
            src="/arralogo.svg"
            alt="Aurral"
            aria-hidden={step > 0}
            className={`onboarding-brand-mark${animateStepHeight ? " onboarding-brand-mark--animate" : ""}`}
            style={logoFlyout}
          />
          <div className="onboarding-progress">
            <div className="onboarding-progress__dots">
              {STEPS.map((s, i) => (
                <div
                  key={s}
                  className="onboarding-progress__dot"
                  style={{
                    backgroundColor: i <= step ? "var(--aurral-control-on)" : "var(--aurral-text-subtle)",
                  }}
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
                {step + 1} / {STEPS.length}
              </span>
            </div>
          </div>

          <div
            className={`onboarding-step-shell${animateStepHeight ? " onboarding-step-shell--animate" : ""}`}
            style={stepHeight != null ? { height: stepHeight } : undefined}
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
                    copy="Create your admin account. Connect Lidarr next, then finish the rest in Settings."
                  />
                  <div className="onboarding-fields">
                    <SettingsInput
                      legacyStyle
                      type="text"
                      autoComplete="off"
                      placeholder="Username"
                      value={authUser}
                      onChange={(e) => setAuthUser(e.target.value)}
                    />
                    <SettingsInput
                      legacyStyle
                      type="password"
                      autoComplete="new-password"
                      placeholder="Password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                    />
                    <SettingsInput
                      legacyStyle
                      type="password"
                      autoComplete="new-password"
                      placeholder="Confirm password"
                      value={authPasswordConfirm}
                      onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                    />
                    <OnboardingHint>Password must be at least 8 characters long.</OnboardingHint>
                    <div className="onboarding-toggle-row">
                      <span>Auto-login on local network</span>
                      <PillToggle
                        checked={localNetworkBypass}
                        onChange={(e) => setLocalNetworkBypass(e.target.checked)}
                        aria-label="Auto-login on local network"
                      />
                    </div>
                    <OnboardingHint>
                      Skip the login screen from devices on your LAN. You can change this later in
                      Settings → Users.
                    </OnboardingHint>
                  </div>
                </OnboardingStep>
              )}

              {currentStep === "lidarr" && (
                <OnboardingStep>
                  <OnboardingStepHeader
                    title="Connect Lidarr"
                    copy="Aurral is a Lidarr companion. Connect Lidarr to manage your library."
                  />
                  <div className="onboarding-fields">
                    <SettingsInput
                      legacyStyle
                      type="url"
                      autoComplete="off"
                      placeholder="Lidarr URL (e.g. http://localhost:8686)"
                      value={lidarrUrl}
                      onChange={(e) => {
                        setLidarrUrl(e.target.value);
                        setLidarrTestSuccess(false);
                      }}
                    />
                    <SettingsInput
                      legacyStyle
                      type="password"
                      autoComplete="off"
                      placeholder="API key"
                      value={lidarrApiKey}
                      onChange={(e) => {
                        setLidarrApiKey(e.target.value);
                        setLidarrTestSuccess(false);
                      }}
                    />
                    <OnboardingHint>
                      Find your API key in Lidarr under Settings → General → Security. Downloads
                      folder, playback, and other clients are configured in Settings after setup.
                    </OnboardingHint>
                  </div>
                </OnboardingStep>
              )}

              {error && <p className="onboarding-error">{error}</p>}
            </div>
          </div>

          <div className="onboarding-actions">
            {step > 0 && (
              <button type="button" onClick={handleBack} className="btn btn-secondary btn--bold">
                <ChevronLeft className="artist-icon-xs" />
                Back
              </button>
            )}
            <button
              type="button"
              onClick={primaryAction}
              disabled={isPrimaryDisabled}
              className="btn btn-secondary btn--bold btn--grow"
            >
              {primaryLabel === "Next" ? (
                <>
                  Next
                  <ChevronRight className="artist-icon-xs" />
                </>
              ) : (
                primaryLabel
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default Onboarding;
