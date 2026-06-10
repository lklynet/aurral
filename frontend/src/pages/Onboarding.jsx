import { useState } from "react";
import { ChevronRight, ChevronLeft, CheckCircle2 } from "lucide-react";
import {
  completeOnboarding,
  testLidarrOnboarding,
  testLidarrLibraryAccessOnboarding,
  testNavidromeOnboarding,
} from "../utils/api";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { LidarrLibraryAccessCheck } from "./Settings/components/LidarrLibraryAccessCheck";

const getApiErrorMessage = (error, fallback) =>
  error?.response?.data?.message ||
  error?.response?.data?.error ||
  error?.message ||
  fallback;

const STEPS = [
  "welcome",
  "admin",
  "lidarr",
  "navidrome",
  "lastfm",
  "done",
];

function Onboarding() {
  useDocumentTitle("Setup");
  const [step, setStep] = useState(0);
  const [authUser, setAuthUser] = useState("admin");
  const [authPassword, setAuthPassword] = useState("");
  const [authPasswordConfirm, setAuthPasswordConfirm] = useState("");
  const [lidarrUrl, setLidarrUrl] = useState("");
  const [lidarrApiKey, setLidarrApiKey] = useState("");
  const [navidromeUrl, setNavidromeUrl] = useState("");
  const [navidromeUsername, setNavidromeUsername] = useState("");
  const [navidromePassword, setNavidromePassword] = useState("");
  const [lastfmUsername, setLastfmUsername] = useState("");
  const [lastfmApiKey, setLastfmApiKey] = useState("");
  const [lidarrTestSuccess, setLidarrTestSuccess] = useState(false);
  const [testingLidarr, setTestingLidarr] = useState(false);
  const [testingLidarrLibraryAccess, setTestingLidarrLibraryAccess] =
    useState(false);
  const [lidarrLibraryAccessResult, setLidarrLibraryAccessResult] =
    useState(null);
  const [navidromeTestSuccess, setNavidromeTestSuccess] = useState(false);
  const [testingNavidrome, setTestingNavidrome] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const { refreshAuth } = useAuth();
  const { showSuccess } = useToast();

  const currentStep = STEPS[step];
  const hasNavidrome =
    navidromeUrl.trim() && navidromeUsername.trim() && navidromePassword;
  const hasLastfm =
    !!lastfmUsername.trim() && !!lastfmApiKey.trim();
  const passwordTooShort =
    authPassword.length > 0 && authPassword.length < 8;
  const adminComplete =
    authUser.trim() &&
    authPassword &&
    !passwordTooShort &&
    authPassword === authPasswordConfirm;
  const canNext =
    currentStep === "welcome" ||
    currentStep === "done" ||
    (currentStep === "admin" && adminComplete) ||
    (currentStep === "lidarr" && lidarrTestSuccess) ||
    (currentStep === "navidrome" && (!hasNavidrome || navidromeTestSuccess)) ||
    currentStep === "lastfm";
  const isPrimaryDisabled =
    currentStep === "done"
      ? submitting
      : currentStep === "lidarr"
        ? !lidarrTestSuccess &&
          (!lidarrUrl.trim() || !lidarrApiKey.trim() || testingLidarr)
        : currentStep === "navidrome"
          ? testingNavidrome
          : currentStep === "admin"
            ? !adminComplete
            : currentStep !== "welcome" && currentStep !== "lastfm" && !canNext;

  const handleNext = () => {
    setError("");
    if (currentStep === "done") return;
    if (step < STEPS.length - 1) setStep(step + 1);
  };

  const handleLidarrStepAction = async () => {
    if (lidarrTestSuccess) {
      handleNext();
      return;
    }
    await handleTestLidarr();
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
      if (!result.ok) {
        setError("Library access check failed. See the results below.");
      }
    } catch (e) {
      setError(getApiErrorMessage(e, "Library access check failed"));
    } finally {
      setTestingLidarrLibraryAccess(false);
    }
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
      });
      await refreshAuth();
      showSuccess("Setup complete. Sign in with your admin account.");
    } catch (e) {
      setError(getApiErrorMessage(e, "Failed to save"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="onboarding-page">
      <form
        autoComplete="off"
        onSubmit={(e) => e.preventDefault()}
        className="onboarding-card"
      >
        <div className="onboarding-progress">
          <div className="onboarding-progress__dots">
            {STEPS.slice(0, -1).map((s, i) => (
              <div
                key={s}
                className="onboarding-progress__dot"
                style={{
                  backgroundColor: i <= step ? "var(--aurral-green)" : "var(--aurral-gray)",
                }}
              />
            ))}
          </div>
          <span className="onboarding-progress__count">
            {step + 1} / {STEPS.length}
          </span>
        </div>

        {currentStep === "welcome" && (
          <div className="onboarding-step-center">
            <img
              src="/arralogo.svg"
              alt="Aurral Logo"
              className="onboarding-logo"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(45%) sepia(8%) saturate(800%) hue-rotate(60deg) brightness(95%) contrast(85%)",
              }}
            />
            <h2 className="onboarding-title onboarding-title--hero">
              Welcome to Aurral
            </h2>
            <p className="onboarding-copy onboarding-copy--center">
              Set up your admin account and connect Lidarr. Navidrome and
              Last.fm are optional but recommended.
            </p>
          </div>
        )}

        {currentStep === "admin" && (
          <>
            <div className="onboarding-title-row">
              <h2 className="onboarding-title">Admin account</h2>
            </div>
            <p className="onboarding-copy">
              Create a local account to sign in to Aurral.
            </p>
            <div className="onboarding-fields">
              <input
                type="text"
                autoComplete="off"
                className="onboarding-input"
                placeholder="Username"
                value={authUser}
                onChange={(e) => setAuthUser(e.target.value)}
              />
              <input
                type="password"
                autoComplete="new-password"
                className="onboarding-input"
                placeholder="Password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
              />
              <input
                type="password"
                autoComplete="new-password"
                className="onboarding-input"
                placeholder="Confirm password"
                value={authPasswordConfirm}
                onChange={(e) => setAuthPasswordConfirm(e.target.value)}
              />
              <p className="onboarding-copy onboarding-copy--xs">
                Password must be at least 8 characters long.
              </p>
            </div>
          </>
        )}

        {currentStep === "lidarr" && (
          <>
            <div className="onboarding-title-row">
              <h2 className="onboarding-title">Connect Lidarr</h2>
            </div>
            <p className="onboarding-copy">
              Aurral uses Lidarr to manage your music library and downloads.
            </p>
            <div className="onboarding-fields">
              <input
                type="url"
                autoComplete="off"
                className="onboarding-input"
                placeholder="Lidarr URL (e.g. http://localhost:8686)"
                value={lidarrUrl}
                onChange={(e) => {
                  setLidarrUrl(e.target.value);
                  setLidarrTestSuccess(false);
                  setLidarrLibraryAccessResult(null);
                }}
              />
              <input
                type="password"
                autoComplete="off"
                className="onboarding-input"
                placeholder="API key"
                value={lidarrApiKey}
                onChange={(e) => {
                  setLidarrApiKey(e.target.value);
                  setLidarrTestSuccess(false);
                  setLidarrLibraryAccessResult(null);
                }}
              />
              <button
                type="button"
                className="btn btn-secondary onboarding-library-access-btn"
                onClick={handleTestLidarrLibraryAccess}
                disabled={
                  testingLidarrLibraryAccess ||
                  testingLidarr ||
                  !lidarrUrl.trim() ||
                  !lidarrApiKey.trim()
                }
              >
                {testingLidarrLibraryAccess
                  ? "Checking library access..."
                  : "Test library access (optional)"}
              </button>
              <LidarrLibraryAccessCheck result={lidarrLibraryAccessResult} />
            </div>
          </>
        )}

        {currentStep === "navidrome" && (
          <>
            <div className="onboarding-title-row">
              <h2 className="onboarding-title">Navidrome (optional)</h2>
            </div>
            <p className="onboarding-copy">
              Recommended for streaming and playlists. Leave blank to skip and
              add later in settings.
            </p>
            <div className="onboarding-fields">
              <input
                type="url"
                autoComplete="off"
                className="onboarding-input"
                placeholder="Navidrome URL"
                value={navidromeUrl}
                onChange={(e) => {
                  setNavidromeUrl(e.target.value);
                  setNavidromeTestSuccess(false);
                }}
              />
              <input
                type="text"
                autoComplete="off"
                className="onboarding-input"
                placeholder="Username"
                value={navidromeUsername}
                onChange={(e) => {
                  setNavidromeUsername(e.target.value);
                  setNavidromeTestSuccess(false);
                }}
              />
              <input
                type="password"
                autoComplete="off"
                className="onboarding-input"
                placeholder="Password"
                value={navidromePassword}
                onChange={(e) => {
                  setNavidromePassword(e.target.value);
                  setNavidromeTestSuccess(false);
                }}
              />
            </div>
          </>
        )}

        {currentStep === "lastfm" && (
          <>
            <div className="onboarding-title-row">
              <h2 className="onboarding-title">Last.fm (optional)</h2>
            </div>
            <p className="onboarding-copy">
              Recommended for personalized discovery, related artists, full tag
              search, and flows. If you skip it, Discover will use ListenBrainz
              trending artists and default genre shelves.
            </p>
            <div className="onboarding-fields">
              <input
                type="text"
                autoComplete="off"
                className="onboarding-input"
                placeholder="Last.fm username"
                value={lastfmUsername}
                onChange={(e) => setLastfmUsername(e.target.value)}
              />
              <input
                type="password"
                autoComplete="off"
                className="onboarding-input"
                placeholder="Last.fm API key"
                value={lastfmApiKey}
                onChange={(e) => setLastfmApiKey(e.target.value)}
              />
            </div>
          </>
        )}

        {currentStep === "done" && (
          <div className="onboarding-step-center">
            <CheckCircle2 className="onboarding-success-icon" />
            <h2 className="onboarding-title">You&apos;re all set</h2>
            <p className="onboarding-copy onboarding-copy--center">
              Sign in with your admin account to start using Aurral.
            </p>
          </div>
        )}

        {error && <p className="onboarding-error">{error}</p>}

        <div className="onboarding-actions">
          {step > 0 && currentStep !== "done" && (
            <button
              type="button"
              onClick={handleBack}
              className="btn btn-secondary btn-sm btn--bold"
            >
              <ChevronLeft className="artist-icon-xs" />
              Back
            </button>
          )}
          <button
            type="button"
            onClick={
              currentStep === "done"
                ? handleFinish
                : currentStep === "lidarr"
                  ? handleLidarrStepAction
                  : currentStep === "navidrome"
                    ? handleNavidromeStepAction
                    : handleNext
            }
            disabled={isPrimaryDisabled}
            className={`btn btn-sm btn--bold btn--grow${isPrimaryDisabled ? " btn-secondary" : " btn-primary"}`}
          >
            {currentStep === "done" ? (
              submitting ? (
                "Saving…"
              ) : (
                "Go to Aurral"
              )
            ) : currentStep === "lidarr" ? (
              lidarrTestSuccess ? (
                <>
                  Next
                  <ChevronRight className="artist-icon-xs" />
                </>
              ) : testingLidarr ? (
                "Testing…"
              ) : (
                "Test"
              )
            ) : currentStep === "navidrome" ? (
              !hasNavidrome ? (
                "Skip"
              ) : navidromeTestSuccess ? (
                <>
                  Next
                  <ChevronRight className="artist-icon-xs" />
                </>
              ) : testingNavidrome ? (
                "Testing…"
              ) : (
                "Test"
              )
            ) : currentStep === "lastfm" ? (
              hasLastfm ? (
                <>
                  Next
                  <ChevronRight className="artist-icon-xs" />
                </>
              ) : (
                "Skip"
              )
            ) : currentStep === "welcome" ? (
              "Get started"
            ) : (
              <>
                Next
                <ChevronRight className="artist-icon-xs" />
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}

export default Onboarding;
