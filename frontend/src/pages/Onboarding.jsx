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
import { DotLoader } from "../components/DotLoader";
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
  const [authUsername, setAuthUsername] = useState("admin");
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
  const lidarrTestVersionRef = useRef(0);
  const [stepHeight, setStepHeight] = useState(null);
  const [animateStepHeight, setAnimateStepHeight] = useState(false);
  const [logoFlyout, setLogoFlyout] = useState({ opacity: 0 });
  const { refreshAuth } = useAuth();
  const { showSuccess } = useToast();

  const currentStep = STEPS[step];
  const passwordTooShort = authPassword.length > 0 && authPassword.length < 8;
  const passwordMismatch =
    authPasswordConfirm.length > 0 && authPassword !== authPasswordConfirm;
  const adminComplete =
    authUsername.trim() &&
    authPassword &&
    !passwordTooShort &&
    authPassword === authPasswordConfirm;

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
    const testVersion = ++lidarrTestVersionRef.current;
    const testUrl = lidarrUrl.trim();
    const testApiKey = lidarrApiKey.trim();
    setTestingLidarr(true);
    setError("");
    try {
      await testLidarrOnboarding(testUrl, testApiKey);
      const [profiles, metadataProfiles] = await Promise.all([
        getLidarrProfilesOnboarding(testUrl, testApiKey),
        getLidarrMetadataProfilesOnboarding(testUrl, testApiKey),
      ]);
      if (testVersion !== lidarrTestVersionRef.current) return;
      setLidarrQualityProfileId(profiles?.[0]?.id ?? null);
      setLidarrMetadataProfileId(metadataProfiles?.[0]?.id ?? null);
      setLidarrTestSuccess(true);
      showSuccess("Lidarr connection successful");
    } catch (e) {
      if (testVersion !== lidarrTestVersionRef.current) return;
      setLidarrTestSuccess(false);
      setError(getApiErrorMessage(e, "Lidarr connection failed"));
    } finally {
      if (testVersion === lidarrTestVersionRef.current) setTestingLidarr(false);
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
        auth: {
          username: authUsername.trim(),
          password: authPassword,
        },
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
            <div className="onboarding-progress__dots" aria-hidden="true">
              {STEPS.map((s, i) => (
                <div
                  key={s}
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
                Step {step + 1} of {STEPS.length}
              </span>
            </div>
          </div>

          <div
            className={`onboarding-step-shell${animateStepHeight ? " onboarding-step-shell--animate" : ""}`}
            style={stepHeight != null ? { height: stepHeight } : undefined}
            aria-busy={testingLidarr || submitting}
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
                      <SettingsInput
                        id="onboarding-username"
                        legacyStyle
                        type="text"
                        required
                        autoComplete="username"
                        placeholder="Username"
                        value={authUsername}
                        onChange={(e) => setAuthUsername(e.target.value)}
                      />
                    </div>
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-password">Password</label>
                      <SettingsInput
                        id="onboarding-password"
                        legacyStyle
                        type="password"
                        required
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
                      <SettingsInput
                        id="onboarding-password-confirm"
                        legacyStyle
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
                  />
                  <div className="onboarding-fields">
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-lidarr-url">Lidarr URL</label>
                      <SettingsInput
                        id="onboarding-lidarr-url"
                        legacyStyle
                        type="url"
                        autoComplete="off"
                        placeholder="http://localhost:8686"
                        value={lidarrUrl}
                        onChange={(e) => {
                          lidarrTestVersionRef.current += 1;
                          setLidarrUrl(e.target.value);
                          setLidarrQualityProfileId(null);
                          setLidarrMetadataProfileId(null);
                          setLidarrTestSuccess(false);
                          setTestingLidarr(false);
                        }}
                      />
                    </div>
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-lidarr-api-key">API key</label>
                      <SettingsInput
                        id="onboarding-lidarr-api-key"
                        legacyStyle
                        type="password"
                        autoComplete="off"
                        placeholder="Paste your Lidarr API key"
                        value={lidarrApiKey}
                        onChange={(e) => {
                          lidarrTestVersionRef.current += 1;
                          setLidarrApiKey(e.target.value);
                          setLidarrQualityProfileId(null);
                          setLidarrMetadataProfileId(null);
                          setLidarrTestSuccess(false);
                          setTestingLidarr(false);
                        }}
                      />
                    </div>
                    <OnboardingHint>
                      Find your API key in Lidarr under Settings → General → Security.
                    </OnboardingHint>
                    {lidarrTestSuccess ? (
                      <p className="onboarding-status onboarding-status--success" role="status">
                        Lidarr connection successful. You can finish setup.
                      </p>
                    ) : null}
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
              <button type="button" onClick={handleBack} className="btn btn-secondary btn--bold">
                <ChevronLeft className="artist-icon-xs" />
                Back
              </button>
            )}
            <button
              type="button"
              onClick={primaryAction}
              disabled={isPrimaryDisabled}
              className="btn btn-primary btn--bold btn--grow"
              aria-busy={testingLidarr || submitting}
            >
              {primaryLabel === "Next" ? (
                <>
                  Next
                  <ChevronRight className="artist-icon-xs" />
                </>
              ) : (
                <>
                  {testingLidarr || submitting ? <DotLoader size="sm" label={null} /> : null}
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
