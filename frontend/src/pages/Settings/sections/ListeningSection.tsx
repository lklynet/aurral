import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { discoveryClient } from "../../../utils/api/clients/discovery.ts";
import { scrobblingClient } from "../../../utils/api/clients/scrobbling.ts";
import { DotLoader } from "../../../components/DotLoader";
import { SettingsInput } from "../components/SettingsField";
import { Select } from "../../../components/Select";
import { readApiError } from "../utils/apiError.ts";
import { useAccountSettingsContext } from "../SettingsProviders";
import { SettingsLink } from "../settingsRoute";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
  useSettingsItem,
  type ServiceStatus,
} from "../SettingsLayout";

type ScrobbleStatus = InferResponseType<typeof scrobblingClient.status.$get, 200>;
type ConnectionStatus = ScrobbleStatus[string] | undefined;

const PROVIDER_LABELS = {
  lastfm: "Last.fm",
  listenbrainz: "ListenBrainz",
  koito: "Koito",
} as const;
type ScrobbleProvider = keyof typeof PROVIDER_LABELS;

const isScrobbleProvider = (value: string | null): value is ScrobbleProvider =>
  value !== null && Object.hasOwn(PROVIDER_LABELS, value);

function useScrobbleStatus() {
  return useQuery({
    queryKey: queryKeys.scrobbleStatus,
    queryFn: ({ signal }) => parseResponse(scrobblingClient.status.$get({}, { init: { signal } })),
  });
}

function scrobbleServiceStatus(status: ConnectionStatus): ServiceStatus {
  if (!status?.connected) return { label: "Not set up", tone: "muted" };
  return { label: status.displayName ? `Connected as ${status.displayName}` : "Connected" };
}

function useScrobbleActions(provider: ScrobbleProvider) {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.scrobbleStatus });

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      showSuccess(success);
      return true;
    } catch (error) {
      const failed = readApiError(error);
      showError(failed.error || failed.text || failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () =>
    run(
      () => parseResponse(scrobblingClient[provider].link.$delete()),
      `${PROVIDER_LABELS[provider]} disconnected.`,
      `Couldn't disconnect ${PROVIDER_LABELS[provider]}`,
    );

  return { busy, run, refresh, disconnect };
}

function LastfmDetail({ status }: { status: ConnectionStatus }) {
  const { hasPermission } = useAuth();
  const { showError } = useToast();
  const { busy, refresh, disconnect } = useScrobbleActions("lastfm");
  const pollRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    [],
  );

  const connect = async () => {
    try {
      if (pollRef.current) window.clearInterval(pollRef.current);
      const result = await parseResponse(scrobblingClient.lastfm.link.$get());
      const popup = result.authorizeUrl
        ? window.open(result.authorizeUrl, "aurral-lastfm-link", "popup,width=600,height=700")
        : null;
      if (!popup) {
        showError(
          result.authorizeUrl ? "Allow popups to link Last.fm." : "Couldn't start Last.fm linking.",
        );
        return;
      }
      const deadline = Date.now() + 3 * 60 * 1000;
      pollRef.current = window.setInterval(() => {
        if (!popup.closed && Date.now() < deadline) return;
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        void refresh();
      }, 500);
    } catch (error) {
      const failure = readApiError(error);
      showError(failure.error || failure.text || "Couldn't start Last.fm linking");
    }
  };

  if (status?.configured !== true) {
    return (
      <SettingsNote>
        {hasPermission("accessSettings") ? (
          <>
            Add a Last.fm API key and secret in{" "}
            <SettingsLink to="discovery/lastfm" className="settings-link">
              Discovery
            </SettingsLink>{" "}
            first.
          </>
        ) : (
          "An admin needs to add a Last.fm API key before you can connect."
        )}
      </SettingsNote>
    );
  }

  return (
    <SettingsGroup
      note={
        status?.connected
          ? `${scrobbleServiceStatus(status).label}.`
          : "Sign in to Last.fm to send it your plays."
      }
    >
      <SettingsActions>
        <button type="button" className="btn btn-secondary btn-sm" onClick={connect}>
          {status.connected ? "Relink Last.fm" : "Connect Last.fm"}
        </button>
        {status.connected ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={disconnect}
          >
            Disconnect
          </button>
        ) : null}
      </SettingsActions>
    </SettingsGroup>
  );
}

function TokenDetail({
  provider,
  status,
}: {
  provider: "listenbrainz" | "koito";
  status: ConnectionStatus;
}) {
  const connected = status?.connected === true;
  const { busy, run, disconnect } = useScrobbleActions(provider);
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const label = PROVIDER_LABELS[provider];

  const connect = async () => {
    const linked = await run(
      () =>
        provider === "koito"
          ? parseResponse(scrobblingClient.koito.link.$put({ json: { token, url } }))
          : parseResponse(scrobblingClient.listenbrainz.link.$put({ json: { token } })),
      `${label} connected.`,
      `Couldn't connect ${label}`,
    );
    if (linked) setToken("");
  };

  return (
    <SettingsGroup
      note={
        connected
          ? `${scrobbleServiceStatus(status).label}.`
          : provider === "koito"
            ? "Koito uses the ListenBrainz format."
            : undefined
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        {provider === "koito" ? (
          <SettingsRow label="Koito URL" htmlFor="scrobble-koito-url">
            <SettingsInput
              id="scrobble-koito-url"
              type="url"
              placeholder="https://koito.example.com"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          label={provider === "koito" ? "API key" : "User token"}
          htmlFor="scrobble-token"
          help={provider === "listenbrainz" ? "Find it in your ListenBrainz settings." : undefined}
        >
          <SettingsInput
            id="scrobble-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </SettingsRow>
        <SettingsActions>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!token || busy}>
            {connected ? `Update ${label}` : `Connect ${label}`}
          </button>
          {connected ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={disconnect}
            >
              Disconnect
            </button>
          ) : null}
        </SettingsActions>
      </form>
    </SettingsGroup>
  );
}

function ScrobbleDetail({
  provider,
  status,
}: {
  provider: ScrobbleProvider;
  status: ScrobbleStatus;
}) {
  return (
    <SettingsPage title={PROVIDER_LABELS[provider]} back="Listening">
      {provider === "lastfm" ? (
        <LastfmDetail status={status.lastfm} />
      ) : (
        <TokenDetail provider={provider} status={status[provider]} />
      )}
    </SettingsPage>
  );
}

function ResetTastesRow() {
  const { showSuccess, showError } = useToast();
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    if (
      !window.confirm(
        "Reset all More like this and Less like this preferences? Blocked artists and genres stay.",
      )
    ) {
      return;
    }
    setResetting(true);
    try {
      await parseResponse(discoveryClient.feedback.reset.$post());
      showSuccess("Discovery tastes reset");
    } catch (error) {
      showError(readApiError(error).message || "Couldn't reset discovery tastes");
    } finally {
      setResetting(false);
    }
  };

  return (
    <SettingsRow
      label="Reset discovery tastes"
      help={
        <>
          Clears More like this and Less like this. Your{" "}
          <Link to="/blocklist" className="settings-link">
            Blocklist
          </Link>{" "}
          stays.
        </>
      }
    >
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={reset}
        disabled={resetting}
      >
        {resetting ? <DotLoader size="xs" label={null} /> : null}
        Reset
      </button>
    </SettingsRow>
  );
}

function HistoryGroup() {
  const account = useAccountSettingsContext();
  const provider = account.listenHistoryProvider;

  return (
    <SettingsGroup title="History">
      <SettingsRow
        label="Source"
        htmlFor="listening-history-source"
        help="Used for your recommendations."
      >
        <Select
          id="listening-history-source"
          value={provider}
          onChange={(next) => {
            account.setListenHistoryProvider(next);
            if (next === "local") {
              account.setListenHistoryUsername("");
              account.setListenHistoryUrl("");
            }
          }}
          options={[
            { value: "local", label: "Aurral plays only" },
            { value: "lastfm", label: "Last.fm" },
            { value: "listenbrainz", label: "ListenBrainz" },
            { value: "koito", label: "Koito" },
          ]}
        />
      </SettingsRow>
      {provider === "koito" ? (
        <SettingsRow label="Koito URL" htmlFor="listening-history-url">
          <SettingsInput
            id="listening-history-url"
            type="url"
            placeholder="https://koito.example.com:4110"
            autoComplete="off"
            value={account.listenHistoryUrl}
            onChange={(event) => account.setListenHistoryUrl(event.target.value)}
          />
        </SettingsRow>
      ) : provider !== "local" ? (
        <SettingsRow
          label={`${provider === "listenbrainz" ? "ListenBrainz" : "Last.fm"} username`}
          htmlFor="listening-history-username"
        >
          <SettingsInput
            id="listening-history-username"
            type="text"
            autoComplete="off"
            value={account.listenHistoryUsername}
            onChange={(event) => account.setListenHistoryUsername(event.target.value)}
          />
        </SettingsRow>
      ) : null}
    </SettingsGroup>
  );
}

export function ListeningSection() {
  const { hasPermission } = useAuth();
  const account = useAccountSettingsContext();
  const scrobbleStatus = useScrobbleStatus();
  const item = useSettingsItem();
  const providers: ScrobbleProvider[] = hasPermission("accessSettings")
    ? ["lastfm", "listenbrainz", "koito"]
    : ["lastfm", "listenbrainz"];

  if (isScrobbleProvider(item) && providers.includes(item) && scrobbleStatus.data) {
    return <ScrobbleDetail provider={item} status={scrobbleStatus.data} />;
  }

  return (
    <SettingsPage title="Listening">
      {account.loading ? (
        <p className="settings-loading">
          <DotLoader size="sm" label={null} /> Loading…
        </p>
      ) : (
        <HistoryGroup />
      )}
      <SettingsGroup title="Scrobbling" note="Send the songs you finish to a listening service.">
        {scrobbleStatus.isError ? (
          <SettingsNote tone="warning">Couldn&apos;t load your scrobbling services.</SettingsNote>
        ) : null}
        {providers.map((provider) => (
          <SettingsServiceRow
            key={provider}
            to={`listening/${provider}`}
            name={PROVIDER_LABELS[provider]}
            status={
              scrobbleStatus.data ? scrobbleServiceStatus(scrobbleStatus.data[provider]) : null
            }
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Discovery tastes">
        <ResetTastesRow />
      </SettingsGroup>
    </SettingsPage>
  );
}
