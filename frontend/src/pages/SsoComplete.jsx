import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { getMe } from "../utils/api/endpoints/auth.js";
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
  consumedSsoParams = { code, error };
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
    const { error: hashError } = consumeSsoParams();

    if (hashError) {
      setError(hashError);
      return undefined;
    }

    const complete = getMe().then((session) => {
      if (!session?.user) throw new Error("Missing SSO session");
    });

    complete
      .then(() => refreshAuth())
      .then(() => {
        if (!cancelled) {
          navigate("/", { replace: true });
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
