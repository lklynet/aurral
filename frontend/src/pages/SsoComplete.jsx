import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { setStoredAuth } from "../utils/api/core.js";
import { exchangeOidcCode, exchangeGoogleCode } from "../utils/api/endpoints/auth.js";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { DotLoader } from "../components/DotLoader";

const readHashParams = () => {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  return new URLSearchParams(hash);
};

let consumedSsoParams = null;

const consumeSsoParams = () => {
  if (consumedSsoParams) return consumedSsoParams;
  const params = readHashParams();
  const code = params.get("code");
  const error = params.get("error");
  const provider = params.get("provider") || "oidc";
  consumedSsoParams = { code, error, provider };
  if (code || error) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return consumedSsoParams;
};

const SsoComplete = () => {
  useDocumentTitle("Signing in");
  const navigate = useNavigate();
  const { refreshAuth } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const { code, error: hashError, provider } = consumeSsoParams();

    if (hashError) {
      setError(hashError);
      return undefined;
    }

    if (!code) {
      setError("Missing SSO session");
      return undefined;
    }

    const exchange = provider === "google" ? exchangeGoogleCode : exchangeOidcCode;

    exchange(code)
      .then((result) => {
        if (result?.linked) {
          if (!cancelled) {
            navigate("/settings/account?connected=google", { replace: true });
          }
          return null;
        }
        if (!result?.token) throw new Error("Missing SSO session token");
        setStoredAuth({ token: result.token });
        return refreshAuth();
      })
      .then((refreshed) => {
        if (cancelled || refreshed === null) return;
        if (refreshed) {
          navigate("/", { replace: true });
        } else {
          setError("Signed in, but couldn't load your account. Please try again.");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to complete SSO sign-in");
      });

    return () => {
      cancelled = true;
    };
  }, [navigate, refreshAuth]);

  if (error) {
    return (
      <main className="login-page sso-complete-page">
        <div className="login-card">
          <div className="login-header">
            <img src="/arralogo.svg" alt="Aurral" className="login-logo" />
            <h1 className="login-title">Sign-in failed</h1>
            <p className="login-subtitle login-subtitle--error" role="alert">
              {error}
            </p>
          </div>
          <p className="sso-complete-error">
            <Link to="/">Back to sign in</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="login-page sso-complete-page">
      <div className="login-card sso-complete-card">
        <div className="login-header">
          <img src="/arralogo.svg" alt="Aurral" className="login-logo" />
          <h1 className="login-title">Signing you in</h1>
          <p className="login-subtitle" role="status" aria-live="polite">
            Completing your SSO session…
          </p>
        </div>
        <DotLoader size="sm" label="Completing sign-in" className="sso-complete-loader" />
      </div>
    </main>
  );
};

export default SsoComplete;
