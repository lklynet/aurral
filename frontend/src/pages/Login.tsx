import { useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSiteLogo } from "../hooks/useSiteLogo";
import { getAppBasePath } from "../utils/basePath.ts";
import { DotLoader } from "../components/DotLoader";
import { rememberShareImport } from "../utils/shareLink.ts";
import { activeServer, forgetActiveServer, HOSTED, hostOf } from "../utils/server.ts";
import { consumeHostedLoginNotice } from "../hosted/connectAuth.ts";
import { asApiError, setStoredAuth } from "../utils/api/core.ts";
import { authClient } from "../utils/api/clients/auth.ts";
import { parseResponse } from "hono/client";

const buildApiUrl = (path: string) => {
  const basePath = getAppBasePath();
  const prefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");
  return `${prefix}${path}`;
};

const Login = () => {
  useDocumentTitle("Sign in");
  const logo = useSiteLogo();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [showLocalForm, setShowLocalForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startingSso, setStartingSso] = useState(false);
  const [usingCode, setUsingCode] = useState(false);
  const [code, setCode] = useState("");
  const [connectNotice] = useState(() =>
    HOSTED && activeServer ? consumeHostedLoginNotice(activeServer.address) : null,
  );
  const { login, bootstrap } = useAuth();
  const oidcEnabled = !HOSTED && !!bootstrap?.oidcEnabled;
  const googleEnabled = !HOSTED && !!bootstrap?.googleLoginEnabled;
  const hasSsoOption = oidcEnabled || googleEnabled;
  const localFormVisible = !hasSsoOption || showLocalForm;
  const title = activeServer
    ? `Sign in to ${activeServer.name || hostOf(activeServer.address)}`
    : "Sign in";

  const handleCodeSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const { token } = await parseResponse(authClient.pair.$post({ json: { code } }));
      setStoredAuth({ token });
      window.location.reload();
    } catch (failure) {
      setError(
        asApiError(failure)?.response?.status === 429
          ? "Too many sign-in attempts. Wait a few minutes, then try again."
          : "That code is wrong or has expired",
      );
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await login(password, username);

      if (result.ok) {
        setError("");
      } else if (result.status === 429) {
        setError("Too many sign-in attempts. Wait a few minutes, then try again.");
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
    rememberShareImport();
    window.location.assign(buildApiUrl("/api/auth/oidc/login"));
  };

  const handleGoogleLogin = () => {
    rememberShareImport();
    window.location.assign(buildApiUrl("/api/auth/google/login"));
  };

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-header">
          <img src={logo.src} alt="Aurral" className={`login-logo${logo.className}`} />
          <h1 className="login-title">{title}</h1>
          {activeServer?.name ? (
            <p className="hosted-address">{hostOf(activeServer.address)}</p>
          ) : null}
          {connectNotice ? <p className="login-subtitle">{connectNotice}</p> : null}
        </div>

        {hasSsoOption && (
          <div className="login-sso">
            {oidcEnabled && (
              <button
                type="button"
                className="btn btn-secondary btn--full login-sso-button"
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
                className="btn btn-secondary btn--full login-sso-button"
                onClick={handleGoogleLogin}
              >
                Sign in with Google
              </button>
            )}
            {localFormVisible && (
              <div className="login-divider">
                <span>or</span>
              </div>
            )}
          </div>
        )}

        {usingCode ? (
          <form className="login-form" onSubmit={handleCodeSubmit}>
            <div className="login-field">
              <label htmlFor="pairing-code" className="sr-only">
                Code
              </label>
              <input
                id="pairing-code"
                name="code"
                type="text"
                required
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                className="login-input"
                placeholder="Code from Settings, Profile"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                aria-invalid={error ? "true" : undefined}
                aria-describedby={error ? "login-error" : undefined}
              />
            </div>
            {error && (
              <p id="login-error" className="login-error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="btn btn-primary btn--full login-submit"
            >
              {submitting ? <DotLoader size="sm" label={null} /> : null}
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : localFormVisible ? (
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
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="next"
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
                  enterKeyHint="go"
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
              className="btn btn-primary btn--full login-submit"
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

        {HOSTED && (
          <div className="hosted-actions login-hosted">
            <div className="login-divider">
              <span>or</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn--full login-submit"
              onClick={() => {
                setError("");
                setUsingCode(!usingCode);
              }}
            >
              {usingCode ? "Use a password" : "Use a code from Settings"}
            </button>
            <button type="button" className="login-local-toggle" onClick={forgetActiveServer}>
              Use another server
            </button>
          </div>
        )}
      </div>
    </main>
  );
};

export default Login;
