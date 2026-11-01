import { Suspense, lazy } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSiteLogo } from "../hooks/useSiteLogo";
import { appSettingsQueryOptions, listeningHistoryQueryOptions } from "../queryOptions.ts";
import { SettingsServiceRow } from "./Settings/SettingsLayout";
import { readSettingsPath } from "./Settings/settingsRoute";
import { normalizeSettings } from "./Settings/utils";
import { configuredStatus, connectedServices } from "./Settings/utils/serviceStatus";
import { OnboardingStep, OnboardingStepHeader, ONBOARDING_STEP_COUNT } from "./onboardingUtils.tsx";
import "./Settings/settings.css";

const SettingsModal = lazy(() => import("./Settings/SettingsModal"));

const HISTORY_SOURCES = [
  { provider: "lastfm", name: "Last.fm" },
  { provider: "listenbrainz", name: "ListenBrainz" },
] as const;

const SERVICES = [
  { id: "navidrome", name: "Navidrome", to: "playback/navidrome" },
  { id: "plex", name: "Plex", to: "playback/plex" },
  { id: "jellyfin", name: "Jellyfin", to: "playback/jellyfin" },
  { id: "lidarr", name: "Lidarr", to: "library/lidarr" },
] as const;

function ServiceRows() {
  const { data } = useQuery(appSettingsQueryOptions());
  const connected = data ? connectedServices(normalizeSettings(data).integrations) : null;
  return SERVICES.map(({ id, name, to }) => (
    <SettingsServiceRow
      key={id}
      to={to}
      name={name}
      status={connected ? configuredStatus(connected[id]) : null}
    />
  ));
}

export default function Welcome() {
  useDocumentTitle("Connect");
  const logo = useSiteLogo();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, hasPermission } = useAuth();
  const { data: history } = useQuery(listeningHistoryQueryOptions(user?.id));

  return (
    <div className="onboarding-page">
      <div className="onboarding-card-shell">
        <div className="onboarding-card">
          <div className="onboarding-progress">
            <div className="onboarding-progress__dots" aria-hidden="true">
              {Array.from({ length: ONBOARDING_STEP_COUNT }, (_, i) => (
                <div key={i} className="onboarding-progress__dot is-complete" />
              ))}
            </div>
            <div className="onboarding-progress__meta">
              <img
                src={logo.src}
                alt=""
                className={`onboarding-logo-anchor onboarding-logo-anchor--compact${logo.className}`}
              />
              <span className="onboarding-progress__count">
                Step {ONBOARDING_STEP_COUNT} of {ONBOARDING_STEP_COUNT}
              </span>
            </div>
          </div>
          <OnboardingStep>
            <OnboardingStepHeader title="Connect" />
            <section className="onboarding-section" aria-label="Listening history">
              <h3 className="onboarding-section__title">Listening history</h3>
              <div className="settings-card">
                {HISTORY_SOURCES.map(({ provider, name }) => (
                  <SettingsServiceRow
                    key={provider}
                    to={`listening/${provider}`}
                    name={name}
                    status={history ? configuredStatus(Boolean(history[provider])) : null}
                  />
                ))}
              </div>
            </section>
            {hasPermission("accessSettings") ? (
              <section className="onboarding-section" aria-label="Services">
                <h3 className="onboarding-section__title">Services</h3>
                <div className="settings-card">
                  <ServiceRows />
                </div>
              </section>
            ) : null}
          </OnboardingStep>
          <div className="onboarding-actions">
            <button
              type="button"
              className="btn btn-primary btn--grow"
              onClick={() => navigate("/", { replace: true })}
            >
              Go to Aurral
            </button>
          </div>
        </div>
      </div>
      {readSettingsPath(location.search) !== null ? (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      ) : null}
    </div>
  );
}
