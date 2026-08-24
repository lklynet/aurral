import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { getAppBasePath } from "../utils/basePath.js";
import { DotLoader } from "../components/DotLoader";

const Login = () => {
  useDocumentTitle("Sign in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [startingSso, setStartingSso] = useState(false);
  const { login, bootstrap } = useAuth();
  const oidcEnabled = !!bootstrap?.oidcEnabled;

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
    const basePath = getAppBasePath();
    const prefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");
    window.location.assign(`${prefix}/api/auth/oidc/login`);
  };

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-header">
          <img src="/arralogo.svg" alt="Aurral" className="login-logo" />
          <h1 className="login-title">Sign in</h1>
          <p className="login-subtitle">Enter your credentials to access Aurral</p>
        </div>

        {oidcEnabled && (
          <div className="login-sso">
            <button
              type="button"
              className="btn btn-secondary btn--full btn--bold login-sso-button"
              onClick={handleOidcLogin}
              disabled={startingSso}
            >
              {startingSso ? <DotLoader size="sm" label={null} /> : null}
              {startingSso ? "Opening SSO…" : "Sign in with SSO"}
            </button>
            <div className="login-divider">
              <span>or</span>
            </div>
          </div>
        )}

        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-fields">
            <div className="login-field">
              <label htmlFor="username" className="login-label">
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
              <label htmlFor="password" className="login-label">
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
      </div>
    </main>
  );
};

export default Login;
