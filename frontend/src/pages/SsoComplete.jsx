import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { setStoredAuth } from "../utils/api/core.js";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

const readHashParams = () => {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  return new URLSearchParams(hash);
};

const SsoComplete = () => {
  useDocumentTitle("Signing in");
  const { refreshAuth } = useAuth();
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const params = readHashParams();
    const token = params.get("token");
    const hashError = params.get("error");

    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

    if (hashError) {
      setError(hashError);
      return undefined;
    }

    if (!token) {
      setError("Missing SSO session");
      return undefined;
    }

    setStoredAuth({ token });
    refreshAuth()
      .then(() => {
        if (!cancelled) {
          window.location.replace("/");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to complete SSO sign-in");
      });

    return () => {
      cancelled = true;
    };
  }, [refreshAuth]);

  if (error) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <img src="/arralogo.svg" alt="Aurral" className="login-logo" />
            <h1 className="login-title">Sign-in failed</h1>
            <p className="login-subtitle">{error}</p>
          </div>
          <p className="login-error">
            <Link to="/">Back to sign in</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-loading app-loading--screen">
      <div className="app-loading__spinner app-loading__spinner--lg" />
    </div>
  );
};

export default SsoComplete;
