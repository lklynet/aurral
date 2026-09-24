import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { getAppBasePath } from "../utils/basePath.js";
import { clearAuthStorage, setStoredAuth } from "../utils/api/core.js";
import { startPlexLoginPin, completePlexLogin } from "../utils/api/endpoints/auth.js";
import { DotLoader } from "../components/DotLoader";

const buildApiUrl = (path) => {
  const basePath = getAppBasePath();
  const prefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");
  return `${prefix}${path}`;
};

const Login = () => {
  useDocumentTitle("Sign in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showLocalForm, setShowLocalForm] = useState(false);
  const [plexConnecting, setPlexConnecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startingSso, setStartingSso] = useState(false);
  const { login, refreshAuth, bootstrap } = useAuth();
  const oidcEnabled = !!bootstrap?.oidcEnabled;
  const googleEnabled = !!bootstrap?.googleLoginEnabled;
  const plexEnabled = !!bootstrap?.plexLoginEnabled;
  const ssoOnly = !!bootstrap?.ssoOnly;
  const hasSsoOption = oidcEnabled || googleEnabled || plexEnabled;
  const localFormVisible = !ssoOnly || !hasSsoOption || showLocalForm;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const success = await login(password, username);

      if (success) {
        setError("");
      } else {
        setError("Invalid username or password");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleOidcLogin = () => {
    if (startingSso) return;
    setStartingSso(true);
    window.location.assign(buildApiUrl("/api/auth/oidc/login"));
  };

  const handleGoogleLogin = () => {
    window.location.assign(buildApiUrl("/api/auth/google/login"));
  };

  const handlePlexLogin = async () => {
    setError("");
    const popup = window.open("about:blank", "plex-login", "width=600,height=700");
    if (!popup) {
      setError("Your browser blocked the Plex sign-in popup. Please allow popups for this site and try again.");
      return;
    }
    setPlexConnecting(true);
    try {
      let pin;
      try {
        pin = await startPlexLoginPin();
      } catch (err) {
        if (popup && !popup.closed) popup.close();
        setError(
          err.response?.data?.message || err.response?.data?.error || "Failed to start Plex sign-in",
        );
        return;
      }
      popup.location.href = pin.authUrl;
      const deadline = Date.now() + 3 * 60 * 1000;
      let result = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        try {
          const res = await completePlexLogin();
          if (res.pending) continue;
          result = res;
          break;
        } catch (err) {
          if (err.response?.data?.retryable) continue;
          if (popup && !popup.closed) popup.close();
          setError(
            err.response?.data?.message ||
              err.response?.data?.error ||
              "Plex sign-in failed",
          );
          return;
        }
      }
      if (popup && !popup.closed) popup.close();
      if (!result?.token) {
        setError("Plex sign-in timed out. Please try again.");
        return;
      }
      setStoredAuth({ token: result.token });
      const refreshed = await refreshAuth();
      if (!refreshed) {
        clearAuthStorage();
        setError("Signed in with Plex, but couldn't load your account. Please try again.");
      }
    } finally {
      setPlexConnecting(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-header">
          <img src="/arralogo.svg" alt="Aurral" className="login-logo" />
          <h1 className="login-title">Sign in</h1>
        </div>

        {hasSsoOption && (
          <div className="login-sso">
            {oidcEnabled && (
              <button
                type="button"
                className="btn btn-secondary btn--full btn--bold login-sso-button"
                onClick={handleOidcLogin}
                disabled={startingSso}
              >
                {startingSso ? <DotLoader size="sm" label={null} /> : null}
                {startingSso ? "Opening SSO…" : "Sign in with SSO"}
              </button>
            )}
            {googleEnabled && (
              <button
                type="button"
                className="btn btn-secondary btn--full btn--bold login-sso-button"
                onClick={handleGoogleLogin}
              >
                Sign in with Google
              </button>
            )}
            {plexEnabled && (
              <button
                type="button"
                className="btn btn-secondary btn--full btn--bold login-sso-button"
                onClick={handlePlexLogin}
                disabled={plexConnecting}
              >
                {plexConnecting ? "Waiting for Plex…" : "Sign in with Plex"}
              </button>
            )}
            {localFormVisible && (
              <div className="login-divider">
                <span>or</span>
              </div>
            )}
          </div>
        )}

        {localFormVisible ? (
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-fields">
              <div className="login-field">
                <label htmlFor="username" className="sr-only">
                  Username
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  required
                  autoComplete="username"
                  className="login-input"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? "login-error" : undefined}
                />
              </div>
              <div className="login-field">
                <label htmlFor="password" className="sr-only">
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="login-input"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? "login-error" : undefined}
                />
              </div>
            </div>

            {error && (
              <p id="login-error" className="login-error" role="alert">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="btn btn-primary btn--full btn--bold login-submit"
            >
              {submitting ? <DotLoader size="sm" label={null} /> : null}
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <>
            {error && (
              <p id="login-error" className="login-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="login-local-toggle"
              onClick={() => setShowLocalForm(true)}
            >
              Sign in with a local account instead
            </button>
          </>
        )}
      </div>
    </main>
  );
};

export default Login;
