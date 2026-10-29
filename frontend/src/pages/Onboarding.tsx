import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { parseResponse } from "hono/client";
import { onboardingClient } from "../utils/api/clients/onboarding.ts";
import { invalidateBootstrapCache } from "../utils/appHealth.ts";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSiteLogo } from "../hooks/useSiteLogo";
import { OnboardingStep, OnboardingStepHeader, OnboardingHint } from "./onboardingUtils.tsx";
import PillToggle from "../components/PillToggle";
import DownloadFolderField from "../components/DownloadFolderField";
import { buildOnboardingPayload } from "../utils/onboardingPayload.ts";
import { DotLoader } from "../components/DotLoader";
import {
  getApiErrorMessage,
  ONBOARDING_HERO_LOGO_SIZE,
  ONBOARDING_COMPACT_LOGO_SIZE,
  STEPS,
} from "./onboardingUtils.tsx";

import { ChevronRight, ChevronLeft } from "../components/icons";
function Onboarding() {
  useDocumentTitle("Setup");
  const logo = useSiteLogo();
  const [step, setStep] = useState(0);
  const [authUser, setAuthUser] = useState("admin");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [localNetworkBypass, setLocalNetworkBypass] = useState(false);
  const [lidarrUrl, setLidarrUrl] = useState("");
  const [lidarrApiKey, setLidarrApiKey] = useState("");
  const [lidarrQualityProfileId, setLidarrQualityProfileId] = useState<number | null>(null);
  const [lidarrMetadataProfileId, setLidarrMetadataProfileId] = useState<number | null>(null);
  const [lidarrTestSuccess, setLidarrTestSuccess] = useState(false);
  const [testingLidarr, setTestingLidarr] = useState(false);
  const [skipLidarr, setSkipLidarr] = useState(false);
  const [downloadFolderPath, setDownloadFolderPath] = useState("");
  const lidarrModeChangedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const cardRef = useRef<HTMLFormElement>(null);
  const stepMeasureRef = useRef<HTMLDivElement>(null);
  const heroAnchorRef = useRef<HTMLDivElement>(null);
  const compactAnchorRef = useRef<HTMLDivElement>(null);
  const lidarrTestVersionRef = useRef(0);
  const [stepHeight, setStepHeight] = useState<number | null>(null);
  const [animateStepHeight, setAnimateStepHeight] = useState(false);
  const [logoFlyout, setLogoFlyout] = useState<CSSProperties>({ opacity: 0 });
  const { refreshAuth } = useAuth();
  const { showSuccess } = useToast();

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

  useEffect(() => {
    if (!lidarrModeChangedRef.current) return;
    lidarrModeChangedRef.current = false;
    const firstFieldId = skipLidarr ? "onboarding-download-folder" : "onboarding-lidarr-url";
    document.getElementById(firstFieldId)?.focus();
  }, [skipLidarr]);

  const handleLidarrMode = (nextSkip: boolean) => {
    setError("");
    lidarrTestVersionRef.current += 1;
    setTestingLidarr(false);
    lidarrModeChangedRef.current = true;
    setSkipLidarr(nextSkip);
  };

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
      const json = { url: testUrl, apiKey: testApiKey };
      await parseResponse(onboardingClient.lidarr.test.$post({ json }));
      const [profiles, metadataProfiles] = await Promise.all([
        parseResponse(onboardingClient.lidarr.profiles.$post({ json })),
        parseResponse(onboardingClient.lidarr["metadata-profiles"].$post({ json })),
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
    if (!skipLidarr && !lidarrTestSuccess) {
      await handleTestLidarr();
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await parseResponse(
        onboardingClient.complete.$post({
          json: buildOnboardingPayload({
            authUser,
            authPassword,
            localNetworkBypass,
            downloadFolderPath,
            lidarr: skipLidarr
              ? null
              : {
                  url: lidarrUrl,
                  apiKey: lidarrApiKey,
                  qualityProfileId: lidarrQualityProfileId,
                  metadataProfileId: lidarrMetadataProfileId,
                },
          }),
        }),
      );
      invalidateBootstrapCache();
      await refreshAuth();
      showSuccess("Setup complete. Sign in.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save"));
    } finally {
      setSubmitting(false);
    }
  };

  const isPrimaryDisabled =
    (currentStep === "admin" && !adminComplete) ||
    (currentStep === "lidarr" &&
      ((!skipLidarr && !lidarrTestSuccess && (!lidarrUrl.trim() || !lidarrApiKey.trim())) ||
        testingLidarr ||
        submitting));

  const primaryAction = currentStep === "lidarr" ? handleFinish : handleNext;
  const primaryLabel =
    currentStep === "admin"
      ? "Next"
      : skipLidarr || lidarrTestSuccess
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
            src={logo.src}
            alt="Aurral"
            aria-hidden={step > 0}
            className={`onboarding-brand-mark${logo.className}${animateStepHeight ? " onboarding-brand-mark--animate" : ""}`}
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

              {currentStep === "lidarr" && skipLidarr && (
                <OnboardingStep>
                  <OnboardingStepHeader title="Use Aurral without Lidarr" />
                  <div className="onboarding-fields">
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-download-folder">Downloads folder</label>
                      <DownloadFolderField
                        id="onboarding-download-folder"
                        value={downloadFolderPath}
                        onChange={setDownloadFolderPath}
                      />
                    </div>
                    <OnboardingHint>
                      Stores downloaded music. Change the folder or connect Lidarr later in
                      Settings.
                    </OnboardingHint>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleLidarrMode(false)}
                    >
                      Connect Lidarr instead
                    </button>
                  </div>
                </OnboardingStep>
              )}

              {currentStep === "lidarr" && !skipLidarr && (
                <OnboardingStep>
                  <OnboardingStepHeader title="Connect Lidarr" />
                  <div className="onboarding-fields">
                    <div className="onboarding-field">
                      <label htmlFor="onboarding-lidarr-url">Lidarr URL</label>
                      <input
                        className="artist-input"
                        id="onboarding-lidarr-url"
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
                      <input
                        className="artist-input"
                        id="onboarding-lidarr-api-key"
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
                    <OnboardingHint>In Lidarr: Settings → General → Security.</OnboardingHint>
                    {lidarrTestSuccess ? (
                      <p className="onboarding-status onboarding-status--success" role="status">
                        Connected to Lidarr.
                      </p>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => handleLidarrMode(true)}
                    >
                      Skip for now
                    </button>
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
