import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ChevronRight, ChevronLeft, CheckCircle2 } from "lucide-react";
import {
  applyLidarrCommunityGuideOnboarding,
  completeOnboarding,
  getLidarrMetadataProfilesOnboarding,
  getLidarrProfilesOnboarding,
  testLidarrLibraryAccessOnboarding,
  testLidarrOnboarding,
  testNavidromeOnboarding,
  testSlskdOnboarding,
} from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { LidarrLibraryAccessCheck } from "./Settings/components/LidarrLibraryAccessCheck";
import { CommunityGuideModal } from "./Settings/components/CommunityGuideModal";
import {
  SettingsInput,
  SettingsSelect,
} from "./Settings/components/SettingsField";
import DownloadFolderField from "../components/DownloadFolderField";

function OnboardingStep({ centered = false, children }) {
  return (
    <div
      className={`onboarding-step${centered ? " onboarding-step--center" : ""}`}
    >
      {children}
    </div>
  );
}

function OnboardingStepHeader({
  title,
  titleClassName = "",
  copy,
  centered = false,
}) {
  return (
    <div
      className={`onboarding-step__header${centered ? " onboarding-step__header--center" : ""}`}
    >
      <h2
        className={`onboarding-title${titleClassName ? ` ${titleClassName}` : ""}`}
      >
        {title}
      </h2>
      {copy ? <p className="onboarding-copy">{copy}</p> : null}
    </div>
  );
}

function OnboardingHint({ children, center = false }) {
  if (!children) return null;
  return (
    <p className={`onboarding-hint${center ? " onboarding-hint--center" : ""}`}>
      {children}
    </p>
  );
}

function OnboardingFieldGroup({ label, hint, children }) {
  return (
    <div className="onboarding-field-group">
      {label ? <span className="onboarding-label">{label}</span> : null}
      {children}
      {hint ? <OnboardingHint>{hint}</OnboardingHint> : null}
    </div>
  );
}

const getApiErrorMessage = (error, fallback) =>
  error?.response?.data?.message ||
  error?.response?.data?.error ||
  error?.message ||
  fallback;

const ONBOARDING_HERO_LOGO_SIZE = 56;
const ONBOARDING_COMPACT_LOGO_SIZE = 28;

const STEPS = [
  "welcome",
  "admin",
  "downloads",
  "lidarr-connect",
  "lidarr-library",
  "lidarr-davo",
  "lidarr-preferences",
  "navidrome",
  "lastfm",
  "slskd",
  "ticketmaster",
  "brainzmash",
];

function Onboarding() {
  useDocumentTitle("Setup");
  const [step, setStep] = useState(0);
  const [authUser, setAuthUser] = useState("admin");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [downloadFolderPath, setDownloadFolderPath] = useState("");
  const [lidarrUrl, setLidarrUrl] = useState("");
  const [lidarrApiKey, setLidarrApiKey] = useState("");
  const [lidarrQualityProfileId, setLidarrQualityProfileId] = useState("");
  const [lidarrMetadataProfileId, setLidarrMetadataProfileId] = useState("");
  const [lidarrDefaultMonitorOption, setLidarrDefaultMonitorOption] =
    useState("none");
  const [lidarrSearchOnAdd, setLidarrSearchOnAdd] = useState(false);
  const [lidarrProfiles, setLidarrProfiles] = useState([]);
  const [lidarrMetadataProfiles, setLidarrMetadataProfiles] = useState([]);
  const [loadingLidarrProfiles, setLoadingLidarrProfiles] = useState(false);
  const [navidromeUrl, setNavidromeUrl] = useState("");
  const [navidromeUsername, setNavidromeUsername] = useState("");
  const [navidromePassword, setNavidromePassword] = useState("");
  const [lastfmUsername, setLastfmUsername] = useState("");
  const [lastfmApiKey, setLastfmApiKey] = useState("");
  const [slskdUrl, setSlskdUrl] = useState("");
  const [slskdApiKey, setSlskdApiKey] = useState("");
  const [ticketmasterApiKey, setTicketmasterApiKey] = useState("");
  const [ticketmasterSearchRadiusMiles, setTicketmasterSearchRadiusMiles] =
    useState(250);
  const [lidarrTestSuccess, setLidarrTestSuccess] = useState(false);
  const [testingLidarr, setTestingLidarr] = useState(false);
  const [testingLidarrLibraryAccess, setTestingLidarrLibraryAccess] =
    useState(false);
  const [lidarrLibraryAccessResult, setLidarrLibraryAccessResult] =
    useState(null);
  const [showCommunityGuideModal, setShowCommunityGuideModal] = useState(false);
  const [applyingCommunityGuide, setApplyingCommunityGuide] = useState(false);
  const [davoApplied, setDavoApplied] = useState(false);
  const [navidromeTestSuccess, setNavidromeTestSuccess] = useState(false);
  const [testingNavidrome, setTestingNavidrome] = useState(false);
  const [slskdTestSuccess, setSlskdTestSuccess] = useState(false);
  const [testingSlskd, setTestingSlskd] = useState(false);
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
  const { showSuccess, showInfo } = useToast();

  const currentStep = STEPS[step];
  const hasNavidrome =
    navidromeUrl.trim() && navidromeUsername.trim() && navidromePassword;
  const hasLastfm = !!lastfmUsername.trim() && !!lastfmApiKey.trim();
  const hasSlskd = !!slskdUrl.trim() && !!slskdApiKey.trim();
  const hasTicketmaster = !!ticketmasterApiKey.trim();
  const passwordTooShort = authPassword.length > 0 && authPassword.length < 8;
  const adminComplete =
    authUser.trim() &&
    authPassword &&
    !passwordTooShort &&
    authPassword === authPasswordConfirm;
  const downloadsComplete = !!downloadFolderPath.trim();
  const lidarrPreferencesComplete =
    !!lidarrQualityProfileId && !!lidarrMetadataProfileId;

  const syncLogoPosition = useCallback(() => {
    const card = cardRef.current;
    const anchor =
      step === 0 ? heroAnchorRef.current : compactAnchorRef.current;
    if (!card || !anchor) return;

    const cardRect = card.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const size =
      step === 0 ? ONBOARDING_HERO_LOGO_SIZE : ONBOARDING_COMPACT_LOGO_SIZE;

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

    const syncHeight = () => {
      setStepHeight(node.offsetHeight);
    };

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

  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimateStepHeight(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const loadLidarrProfiles = useCallback(async () => {
    if (!lidarrUrl.trim() || !lidarrApiKey.trim()) return;
    setLoadingLidarrProfiles(true);
    try {
      const [profiles, metadataProfiles] = await Promise.all([
        getLidarrProfilesOnboarding(lidarrUrl.trim(), lidarrApiKey.trim()),
        getLidarrMetadataProfilesOnboarding(
          lidarrUrl.trim(),
          lidarrApiKey.trim(),
        ),
      ]);
      setLidarrProfiles(Array.isArray(profiles) ? profiles : []);
      setLidarrMetadataProfiles(
        Array.isArray(metadataProfiles) ? metadataProfiles : [],
      );
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to load Lidarr profiles"));
    } finally {
      setLoadingLidarrProfiles(false);
    }
  }, [lidarrApiKey, lidarrUrl]);

  useEffect(() => {
    if (currentStep !== "lidarr-preferences" || !lidarrTestSuccess) return;
    loadLidarrProfiles();
  }, [currentStep, lidarrTestSuccess, loadLidarrProfiles]);

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
      setLidarrTestSuccess(true);
      showSuccess("Lidarr connection successful");
    } catch (e) {
      setError(getApiErrorMessage(e, "Connection failed"));
    } finally {
      setTestingLidarr(false);
    }
  };

  const handleLidarrConnectAction = async () => {
    if (lidarrTestSuccess) {
      handleNext();
      return;
    }
    await handleTestLidarr();
  };

  const handleTestLidarrLibraryAccess = async () => {
    if (!lidarrUrl.trim() || !lidarrApiKey.trim()) {
      setError("Enter Lidarr URL and API key first");
      return;
    }
    setTestingLidarrLibraryAccess(true);
    setLidarrLibraryAccessResult(null);
    setError("");
    try {
      const result = await testLidarrLibraryAccessOnboarding(
        lidarrUrl.trim(),
        lidarrApiKey.trim(),
      );
      setLidarrLibraryAccessResult(result);
      if (result.ok) {
        showSuccess("Library access check passed");
      } else {
        setError("Library access check failed. See the results below.");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Library access check failed"));
    } finally {
      setTestingLidarrLibraryAccess(false);
    }
  };

  const handleApplyCommunityGuide = async () => {
    setShowCommunityGuideModal(false);
    setApplyingCommunityGuide(true);
    setError("");
    try {
      const result = await applyLidarrCommunityGuideOnboarding(
        lidarrUrl.trim(),
        lidarrApiKey.trim(),
      );
      setDavoApplied(true);
      showSuccess("Community guide settings applied successfully");
      if (result.results?.qualityProfile?.id) {
        setLidarrQualityProfileId(String(result.results.qualityProfile.id));
      }
      if (result.results?.metadataProfile?.id) {
        setLidarrMetadataProfileId(String(result.results.metadataProfile.id));
      }
      await loadLidarrProfiles();
      if (result.results?.qualityProfile?.name) {
        showInfo(
          `Default quality profile set to '${result.results.qualityProfile.name}'`,
        );
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to apply community guide"));
    } finally {
      setApplyingCommunityGuide(false);
    }
  };

  const handleTestNavidrome = async () => {
    if (!hasNavidrome) return;
    setTestingNavidrome(true);
    setError("");
    try {
      await testNavidromeOnboarding(
        navidromeUrl.trim(),
        navidromeUsername.trim(),
        navidromePassword,
      );
      setNavidromeTestSuccess(true);
      showSuccess("Navidrome connection successful");
    } catch (e) {
      setError(getApiErrorMessage(e, "Connection failed"));
    } finally {
      setTestingNavidrome(false);
    }
  };

  const handleNavidromeStepAction = async () => {
    if (!hasNavidrome) {
      handleNext();
      return;
    }
    if (navidromeTestSuccess) {
      handleNext();
      return;
    }
    await handleTestNavidrome();
  };

  const handleTestSlskd = async () => {
    if (!hasSlskd) return;
    setTestingSlskd(true);
    setError("");
    try {
      const result = await testSlskdOnboarding(
        slskdUrl.trim(),
        slskdApiKey.trim(),
      );
      setSlskdTestSuccess(true);
      if (result.warning || result.soulseekConnected === false) {
        showInfo(
          result.message ||
            "slskd API is reachable, but Soulseek is not connected",
        );
      } else {
        showSuccess(result.message || "slskd connection successful");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Connection failed"));
    } finally {
      setTestingSlskd(false);
    }
  };

  const handleSlskdStepAction = async () => {
    if (!hasSlskd) {
      handleNext();
      return;
    }
    if (slskdTestSuccess) {
      handleNext();
      return;
    }
    await handleTestSlskd();
  };

  const handleFinish = async () => {
    setSubmitting(true);
    setError("");
    try {
      await completeOnboarding({
        authUser: authUser.trim() || "admin",
        authPassword: authPassword || undefined,
        lidarr:
          lidarrUrl.trim() && lidarrApiKey.trim()
            ? {
                url: lidarrUrl.trim().replace(/\/+$/, ""),
                apiKey: lidarrApiKey.trim(),
                qualityProfileId: lidarrQualityProfileId
                  ? parseInt(lidarrQualityProfileId, 10)
                  : null,
                metadataProfileId: lidarrMetadataProfileId
                  ? parseInt(lidarrMetadataProfileId, 10)
                  : null,
                defaultMonitorOption: lidarrDefaultMonitorOption,
                searchOnAdd: lidarrSearchOnAdd,
              }
            : undefined,
        navidrome:
          navidromeUrl.trim() && navidromeUsername.trim() && navidromePassword
            ? {
                url: navidromeUrl.trim().replace(/\/+$/, ""),
                username: navidromeUsername.trim(),
                password: navidromePassword,
              }
            : undefined,
        lastfm:
          lastfmUsername.trim() && lastfmApiKey.trim()
            ? {
                username: lastfmUsername.trim(),
                apiKey: lastfmApiKey.trim(),
              }
            : undefined,
        slskd:
          slskdUrl.trim() && slskdApiKey.trim()
            ? {
                url: slskdUrl.trim().replace(/\/+$/, ""),
                apiKey: slskdApiKey.trim(),
              }
            : undefined,
        ticketmaster: hasTicketmaster
          ? {
              apiKey: ticketmasterApiKey.trim(),
              searchRadiusMiles: Math.max(
                5,
                Math.min(250, Math.floor(ticketmasterSearchRadiusMiles)),
              ),
            }
          : undefined,
        downloadFolderPath: downloadFolderPath.trim(),
      });
      await refreshAuth();
      showSuccess("Setup complete. Sign in with your admin account.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save"));
    } finally {
      setSubmitting(false);
    }
  };

  const isPrimaryDisabled = (() => {
    if (currentStep === "brainzmash") return submitting;
    if (currentStep === "admin") return !adminComplete;
    if (currentStep === "downloads") return !downloadsComplete;
    if (currentStep === "lidarr-connect") {
      return (
        !lidarrTestSuccess &&
        (!lidarrUrl.trim() || !lidarrApiKey.trim() || testingLidarr)
      );
    }
    if (currentStep === "lidarr-library") {
      return testingLidarrLibraryAccess;
    }
    if (currentStep === "lidarr-davo") {
      return applyingCommunityGuide;
    }
    if (currentStep === "lidarr-preferences") {
      return !lidarrPreferencesComplete || loadingLidarrProfiles;
    }
    if (currentStep === "navidrome") return testingNavidrome;
    if (currentStep === "slskd") return testingSlskd;
    return false;
  })();

  const primaryAction = (() => {
    if (currentStep === "brainzmash") return handleFinish;
    if (currentStep === "lidarr-connect") return handleLidarrConnectAction;
    if (currentStep === "navidrome") return handleNavidromeStepAction;
    if (currentStep === "slskd") return handleSlskdStepAction;
    return handleNext;
  })();

  const primaryLabel = (() => {
    if (currentStep === "brainzmash") {
      return submitting ? "Saving…" : "Go to Aurral";
    }
    if (currentStep === "welcome") return "Get started";
    if (currentStep === "lidarr-connect") {
      if (lidarrTestSuccess) {
        return "Next";
      }
      return testingLidarr ? "Testing…" : "Test connection";
    }
    if (currentStep === "lidarr-library") {
      return lidarrLibraryAccessResult?.ok ? "Next" : "Skip for now";
    }
    if (currentStep === "lidarr-davo") {
      return davoApplied ? "Next" : "Skip for now";
    }
    if (currentStep === "navidrome") {
      if (!hasNavidrome) return "Skip";
      if (navidromeTestSuccess) return "Next";
      return testingNavidrome ? "Testing…" : "Test connection";
    }
    if (currentStep === "lastfm") {
      return hasLastfm ? "Next" : "Skip";
    }
    if (currentStep === "slskd") {
      if (!hasSlskd) return "Skip";
      if (slskdTestSuccess) return "Next";
      return testingSlskd ? "Testing…" : "Test connection";
    }
    if (currentStep === "ticketmaster") {
      return hasTicketmaster ? "Next" : "Skip";
    }
    return "Next";
  })();

  return (
    <div className="onboarding-page">
      <CommunityGuideModal
        show={showCommunityGuideModal}
        onClose={() => setShowCommunityGuideModal(false)}
        onApply={handleApplyCommunityGuide}
      />
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
            {STEPS.slice(0, -1).map((s, i) => (
              <div
                key={s}
                className="onboarding-progress__dot"
                style={{
                  backgroundColor:
                    i <= step ? "var(--aurral-green)" : "var(--aurral-gray)",
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
            {currentStep === "welcome" && (
              <OnboardingStep centered>
                <div
                  ref={heroAnchorRef}
                  className="onboarding-logo-anchor onboarding-logo-anchor--hero"
                  aria-hidden="true"
                />
                <OnboardingStepHeader
                  centered
                  title="Welcome to Aurral"
                  titleClassName="onboarding-title--hero"
                  copy="Let's set up your admin account and connect services."
                />
              </OnboardingStep>
            )}

            {currentStep === "admin" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Admin account"
                  copy="Create a local account to sign in to Aurral."
                />
                <div className="onboarding-fields">
                  <SettingsInput
                    type="text"
                    autoComplete="off"
                    placeholder="Username"
                    value={authUser}
                    onChange={(e) => setAuthUser(e.target.value)}
                  />
                  <SettingsInput
                    type="password"
                    autoComplete="new-password"
                    placeholder="Password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                  />
                  <SettingsInput
                    type="password"
                    autoComplete="new-password"
                    placeholder="Confirm password"
                    value={authPasswordConfirm}
                    onChange={(e) => setAuthPasswordConfirm(e.target.value)}
                  />
                  <OnboardingHint>
                    Password must be at least 8 characters long.
                  </OnboardingHint>
                </div>
              </OnboardingStep>
            )}

            {currentStep === "downloads" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Downloads folder"
                  copy="Choose where Aurral writes generated flows and imported playlists. Mount this path into Navidrome and slskd as well."
                />
                <div className="onboarding-fields">
                  <OnboardingFieldGroup label="Path">
                    <DownloadFolderField
                      value={downloadFolderPath}
                      onChange={setDownloadFolderPath}
                      helperText="Folder where Aurral writes generated flows and imported playlists. Use the same mounted path in Navidrome and slskd."
                    />
                  </OnboardingFieldGroup>
                </div>
              </OnboardingStep>
            )}

            {currentStep === "lidarr-connect" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Connect Lidarr"
                  copy="Aurral uses Lidarr to manage your music library and downloads."
                />
                <div className="onboarding-fields">
                  <SettingsInput
                    type="url"
                    autoComplete="off"
                    placeholder="Lidarr URL (e.g. http://localhost:8686)"
                    value={lidarrUrl}
                    onChange={(e) => {
                      setLidarrUrl(e.target.value);
                      setLidarrTestSuccess(false);
                      setLidarrLibraryAccessResult(null);
                      setLidarrQualityProfileId("");
                      setLidarrMetadataProfileId("");
                      setDavoApplied(false);
                    }}
                  />
                  <SettingsInput
                    type="password"
                    autoComplete="off"
                    placeholder="API key"
                    value={lidarrApiKey}
                    onChange={(e) => {
                      setLidarrApiKey(e.target.value);
                      setLidarrTestSuccess(false);
                      setLidarrLibraryAccessResult(null);
                      setLidarrQualityProfileId("");
                      setLidarrMetadataProfileId("");
                      setDavoApplied(false);
                    }}
                  />
                  <OnboardingHint>
                    Find your API key in Lidarr under Settings → General →
                    Security.
                  </OnboardingHint>
                </div>
              </OnboardingStep>
            )}

            {currentStep === "lidarr-library" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Library access"
                  copy="Verify we can read files from Lidarr's library paths for playback and playlist reuse."
                />
                <div className="onboarding-fields">
                  <button
                    type="button"
                    className="btn btn-secondary btn--bold"
                    onClick={handleTestLidarrLibraryAccess}
                    disabled={
                      testingLidarrLibraryAccess ||
                      !lidarrUrl.trim() ||
                      !lidarrApiKey.trim()
                    }
                  >
                    {testingLidarrLibraryAccess
                      ? "Checking library access..."
                      : "Test library access"}
                  </button>
                  <LidarrLibraryAccessCheck
                    result={lidarrLibraryAccessResult}
                  />
                </div>
              </OnboardingStep>
            )}

            {currentStep === "lidarr-davo" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Recommended Lidarr settings"
                  copy="Optionally apply Davo's Community Lidarr Guide settings. This creates an Aurral-friendly quality profile, custom formats, and naming scheme."
                />
                <div className="onboarding-fields">
                  <button
                    type="button"
                    className="btn btn-primary btn--bold"
                    onClick={() => setShowCommunityGuideModal(true)}
                    disabled={applyingCommunityGuide}
                  >
                    {applyingCommunityGuide
                      ? "Applying..."
                      : "Apply Davo's Recommended Settings"}
                  </button>
                  <OnboardingHint>
                    <a
                      href="https://wiki.servarr.com/lidarr/community-guide"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="settings-page__link"
                    >
                      Read the full Community Lidarr Guide
                    </a>{" "}
                    for naming, custom formats, and profile details.
                  </OnboardingHint>
                  {davoApplied ? (
                    <OnboardingHint>
                      Community guide settings were applied successfully.
                    </OnboardingHint>
                  ) : null}
                </div>
              </OnboardingStep>
            )}

            {currentStep === "lidarr-preferences" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Lidarr defaults"
                  copy="Choose the profiles Aurral uses when adding artists and albums."
                />
                <div className="onboarding-fields">
                  <OnboardingFieldGroup label="Default quality profile">
                    <SettingsSelect
                      value={lidarrQualityProfileId}
                      onChange={(e) =>
                        setLidarrQualityProfileId(e.target.value)
                      }
                      disabled={loadingLidarrProfiles}
                    >
                      <option value="">
                        {loadingLidarrProfiles
                          ? "Loading profiles..."
                          : lidarrProfiles.length === 0
                            ? "No profiles available"
                            : "Select a profile"}
                      </option>
                      {lidarrProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </SettingsSelect>
                  </OnboardingFieldGroup>
                  <OnboardingFieldGroup label="Default metadata profile">
                    <SettingsSelect
                      value={lidarrMetadataProfileId}
                      onChange={(e) =>
                        setLidarrMetadataProfileId(e.target.value)
                      }
                      disabled={loadingLidarrProfiles}
                    >
                      <option value="">
                        {loadingLidarrProfiles
                          ? "Loading profiles..."
                          : lidarrMetadataProfiles.length === 0
                            ? "No profiles available"
                            : "Select a profile"}
                      </option>
                      {lidarrMetadataProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </SettingsSelect>
                  </OnboardingFieldGroup>
                  <OnboardingFieldGroup
                    label="Default monitoring option"
                    hint="Aurral uses a pick-and-choose album workflow. We recommend None (Artist Only) so new artists are not fully monitored automatically."
                  >
                    <SettingsSelect
                      value={lidarrDefaultMonitorOption}
                      onChange={(e) =>
                        setLidarrDefaultMonitorOption(e.target.value)
                      }
                    >
                      <option value="none">None (Artist Only)</option>
                      <option value="existing">Existing Albums</option>
                      <option value="all">All Albums</option>
                      <option value="future">Future Albums</option>
                      <option value="missing">Missing Albums</option>
                      <option value="latest">Latest Album</option>
                      <option value="first">First Album</option>
                    </SettingsSelect>
                  </OnboardingFieldGroup>
                  <label className="onboarding-checkbox-row">
                    <input
                      type="checkbox"
                      className="artist-checkbox"
                      checked={lidarrSearchOnAdd}
                      onChange={(e) => setLidarrSearchOnAdd(e.target.checked)}
                    />
                    <span>Search on add</span>
                  </label>
                  <OnboardingHint>
                    When enabled, Lidarr searches for albums as soon as they are
                    added. Aurral usually triggers searches when you request
                    specific albums, so leaving this off is fine.
                  </OnboardingHint>
                </div>
              </OnboardingStep>
            )}

            {currentStep === "navidrome" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Navidrome (optional)"
                  copy="Recommended for streaming and playlists. Leave blank to skip and add later in settings."
                />
                <div className="onboarding-fields">
                  <SettingsInput
                    type="url"
                    autoComplete="off"
                    placeholder="Navidrome URL"
                    value={navidromeUrl}
                    onChange={(e) => {
                      setNavidromeUrl(e.target.value);
                      setNavidromeTestSuccess(false);
                    }}
                  />
                  <SettingsInput
                    type="text"
                    autoComplete="off"
                    placeholder="Username"
                    value={navidromeUsername}
                    onChange={(e) => {
                      setNavidromeUsername(e.target.value);
                      setNavidromeTestSuccess(false);
                    }}
                  />
                  <SettingsInput
                    type="password"
                    autoComplete="off"
                    placeholder="Password"
                    value={navidromePassword}
                    onChange={(e) => {
                      setNavidromePassword(e.target.value);
                      setNavidromeTestSuccess(false);
                    }}
                  />
                </div>
              </OnboardingStep>
            )}

            {currentStep === "lastfm" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Last.fm (optional)"
                  copy="Recommended for personalized discovery, related artists, full tag search, and flows. If you skip it, Discover will use ListenBrainz trending artists and default genre shelves."
                />
                <div className="onboarding-fields">
                  <SettingsInput
                    type="text"
                    autoComplete="off"
                    placeholder="Last.fm username"
                    value={lastfmUsername}
                    onChange={(e) => setLastfmUsername(e.target.value)}
                  />
                  <SettingsInput
                    type="password"
                    autoComplete="off"
                    placeholder="Last.fm API key"
                    value={lastfmApiKey}
                    onChange={(e) => setLastfmApiKey(e.target.value)}
                  />
                </div>
              </OnboardingStep>
            )}

            {currentStep === "slskd" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="slskd (optional)"
                  copy="Recommended for Soulseek-based downloads in flows and playlists. Leave blank to skip and add later in settings."
                />
                <div className="onboarding-fields">
                  <SettingsInput
                    type="url"
                    autoComplete="off"
                    placeholder="slskd URL (e.g. http://localhost:5030)"
                    value={slskdUrl}
                    onChange={(e) => {
                      setSlskdUrl(e.target.value);
                      setSlskdTestSuccess(false);
                    }}
                  />
                  <SettingsInput
                    type="password"
                    autoComplete="off"
                    placeholder="API key"
                    value={slskdApiKey}
                    onChange={(e) => {
                      setSlskdApiKey(e.target.value);
                      setSlskdTestSuccess(false);
                    }}
                  />
                </div>
              </OnboardingStep>
            )}

            {currentStep === "ticketmaster" && (
              <OnboardingStep>
                <OnboardingStepHeader
                  title="Ticketmaster (optional)"
                  copy="Recommended for nearby shows on the Discover page."
                />
                <div className="onboarding-fields">
                  <div className="onboarding-callout">
                    <p>
                      Register on the{" "}
                      <a
                        href="https://developer-acct.ticketmaster.com/user/login"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="settings-page__link"
                      >
                        Ticketmaster developer portal
                      </a>{" "}
                      to get a Consumer Key used for authentication.
                    </p>
                  </div>
                  <SettingsInput
                    type="password"
                    autoComplete="off"
                    placeholder="Consumer key"
                    value={ticketmasterApiKey}
                    onChange={(e) => setTicketmasterApiKey(e.target.value)}
                  />
                  <OnboardingFieldGroup
                    label="Search radius (miles)"
                    hint="How far from your location to search for nearby shows."
                  >
                    <SettingsInput
                      type="number"
                      min={5}
                      max={250}
                      step={5}
                      value={ticketmasterSearchRadiusMiles}
                      onChange={(e) => {
                        const raw = Number(e.target.value);
                        setTicketmasterSearchRadiusMiles(
                          Number.isFinite(raw)
                            ? Math.max(5, Math.min(250, Math.floor(raw)))
                            : 250,
                        );
                      }}
                    />
                  </OnboardingFieldGroup>
                </div>
              </OnboardingStep>
            )}

            {currentStep === "brainzmash" && (
              <OnboardingStep centered>
                <CheckCircle2 className="onboarding-success-icon" />
                <OnboardingStepHeader
                  centered
                  title="Powered by BrainzMash"
                  copy="Aurral uses BrainzMash as its metadata provider for artist and album discovery, cover art, and Lidarr-compatible metadata."
                />
                <div className="onboarding-step__body">
                  <p className="onboarding-copy onboarding-copy--center">
                    Special thanks to the BrainzMash team for the open-source
                    work behind that experience. If Aurral has been useful,
                    consider checking out the project, starring the repo, and
                    joining the community.
                  </p>
                  <p className="onboarding-copy onboarding-copy--center">
                    <a
                      href="https://github.com/statichum/brainzmash-hearring-aid"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="settings-page__link"
                    >
                      statichum/brainzmash-hearring-aid
                    </a>
                  </p>
                  <OnboardingHint center>
                    Finish setup to sign in with your admin account and open
                    Aurral.
                  </OnboardingHint>
                </div>
              </OnboardingStep>
            )}

            {error && <p className="onboarding-error">{error}</p>}
          </div>
        </div>

        <div className="onboarding-actions">
          {step > 0 && currentStep !== "brainzmash" && (
            <button
              type="button"
              onClick={handleBack}
              className="btn btn-secondary btn--bold"
            >
              <ChevronLeft className="artist-icon-xs" />
              Back
            </button>
          )}
          <button
            type="button"
            onClick={primaryAction}
            disabled={isPrimaryDisabled}
            className={`btn btn--bold btn--grow${isPrimaryDisabled ? " btn-secondary" : " btn-primary"}`}
          >
            {primaryLabel === "Next" || primaryLabel === "Skip" ? (
              <>
                {primaryLabel}
                {primaryLabel === "Next" && (
                  <ChevronRight className="artist-icon-xs" />
                )}
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
