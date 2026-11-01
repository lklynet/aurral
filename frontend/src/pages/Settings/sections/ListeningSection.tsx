import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferRequestType, type InferResponseType } from "hono/client";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import {
  listeningHistoryQueryOptions,
  spotifyHistoryQueryOptions,
} from "../../../queryOptions.ts";
import { discoveryClient } from "../../../utils/api/clients/discovery.ts";
import { scrobblingClient } from "../../../utils/api/clients/scrobbling.ts";
import { usersClient } from "../../../utils/api/clients/users.ts";
import { DotLoader } from "../../../components/DotLoader";
import { SettingsCommitInput, SettingsInput } from "../components/SettingsField";
import { readApiError } from "../utils/apiError.ts";
import { formatDate } from "../../../utils/dateTime.ts";
import { readSpotifyExport } from "../../../utils/spotifyExportFiles.ts";
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
type ListenHistoryUpdate = InferRequestType<
  (typeof usersClient.me)["listening-history"]["$patch"]
>["json"];

const PROVIDERS = ["lastfm", "listenbrainz", "koito"] as const;
type ScrobbleProvider = (typeof PROVIDERS)[number];
const PROVIDER_LABELS: Record<ScrobbleProvider, string> = {
  lastfm: "Last.fm",
  listenbrainz: "ListenBrainz",
  koito: "Koito",
};

function useScrobbleStatus() {
  return useQuery({
    queryKey: queryKeys.scrobbleStatus,
    queryFn: ({ signal }) => parseResponse(scrobblingClient.status.$get({}, { init: { signal } })),
  });
}

function useListenHistory() {
  const { user } = useAuth();
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery(listeningHistoryQueryOptions(user?.id));
  const { mutate } = useMutation({
    mutationFn: (json: ListenHistoryUpdate) =>
      parseResponse(usersClient.me["listening-history"].$patch({ json })),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.listeningHistory(user?.id), next),
    onError: (error) => {
      const failure = readApiError(error);
      showError(failure.error || failure.text || "Couldn't save listening history");
    },
  });
  return { history: data, save: mutate };
}

const connectedLabel = (status: ConnectionStatus) =>
  status?.displayName ? `Connected as ${status.displayName}` : "Connected";

function serviceStatus(history: string | null, scrobbling: ConnectionStatus): ServiceStatus {
  const on = [history ? "history" : null, scrobbling?.connected ? "scrobbling" : null]
    .filter((part) => part !== null)
    .join(", ");
  if (!on) return { label: "Not set up", tone: "muted" };
  return { label: on[0].toUpperCase() + on.slice(1) };
}

function useScrobbleActions(provider: ScrobbleProvider) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.scrobbleStatus }),
      queryClient.invalidateQueries({ queryKey: queryKeys.listeningHistory(user?.id) }),
    ]);

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
      <SettingsGroup title="Scrobbling">
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
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Scrobbling"
      note={
        status?.connected
          ? `${connectedLabel(status)}.`
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
  const label = PROVIDER_LABELS[provider];

  const connect = async () => {
    const linked = await run(
      () =>
        provider === "koito"
          ? parseResponse(scrobblingClient.koito.link.$put({ json: { token } }))
          : parseResponse(scrobblingClient.listenbrainz.link.$put({ json: { token } })),
      `${label} connected.`,
      `Couldn't connect ${label}`,
    );
    if (linked) setToken("");
  };

  return (
    <SettingsGroup
      title="Scrobbling"
      note={
        connected
          ? `${connectedLabel(status)}.`
          : provider === "koito"
            ? "Uses the Koito URL above."
            : undefined
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
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

function ServiceDetail({ provider }: { provider: ScrobbleProvider }) {
  const { hasPermission } = useAuth();
  const { history, save } = useListenHistory();
  const scrobbleStatus = useScrobbleStatus();
  const canScrobble = provider !== "koito" || hasPermission("accessSettings");
  const inputId = `listening-history-${provider}`;

  return (
    <SettingsPage title={PROVIDER_LABELS[provider]} back="Listening">
      <SettingsGroup title="History">
        <SettingsRow
          label={provider === "koito" ? "Koito URL" : "Username"}
          htmlFor={inputId}
          help={
            canScrobble && provider !== "koito"
              ? "Filled in when you connect scrobbling."
              : undefined
          }
        >
          <SettingsCommitInput
            id={inputId}
            type={provider === "koito" ? "url" : "text"}
            placeholder={provider === "koito" ? "https://koito.example.com:4110" : undefined}
            autoComplete="off"
            disabled={!history}
            value={history?.[provider] ?? ""}
            onCommit={(value) => save({ [provider]: value.trim() || null })}
          />
        </SettingsRow>
      </SettingsGroup>
      {!canScrobble ? null : scrobbleStatus.isError ? (
        <SettingsNote tone="warning">Couldn&apos;t load scrobbling.</SettingsNote>
      ) : !scrobbleStatus.data ? null : provider === "lastfm" ? (
        <LastfmDetail status={scrobbleStatus.data.lastfm} />
      ) : (
        <TokenDetail provider={provider} status={scrobbleStatus.data[provider]} />
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

const SPOTIFY_PRIVACY_URL = "https://www.spotify.com/account/privacy/";

type SpotifyHistorySummary = InferResponseType<
  (typeof discoveryClient)["spotify-import"]["$get"],
  200
>["summary"];

const spotifyHistoryHelp = (summary: NonNullable<SpotifyHistorySummary>) =>
  [
    summary.plays ? `${summary.plays.toLocaleString()} plays` : null,
    `${summary.artists.toLocaleString()} artists`,
    formatDate(new Date(summary.importedAt), { month: "short", day: "numeric", year: "numeric" }),
  ]
    .filter(Boolean)
    .join(" · ");

function SpotifyDetail() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const query = spotifyHistoryQueryOptions(user?.id);
  const { data: summary } = useQuery(query);

  const run = async (action: () => Promise<{ summary: SpotifyHistorySummary }>, done: string) => {
    setBusy(true);
    try {
      queryClient.setQueryData(query.queryKey, (await action()).summary);
      showSuccess(done);
    } catch (error) {
      const failure = readApiError(error);
      showError(failure.error || failure.text || "Couldn't update your Spotify history");
    } finally {
      setBusy(false);
    }
  };

  const importFiles = (files: File[]) =>
    run(async () => {
      const artists = await readSpotifyExport(files);
      if (artists.length === 0) throw new Error("No Spotify listening history in those files.");
      return parseResponse(discoveryClient["spotify-import"].$put({ json: { artists } }));
    }, "Spotify history imported. Your recommendations are rebuilding.");

  const remove = () => {
    if (!window.confirm("Remove your Spotify history from your recommendations?")) return;
    void run(
      () => parseResponse(discoveryClient["spotify-import"].$delete()),
      "Spotify history removed.",
    );
  };

  return (
    <SettingsPage title="Spotify" back="Listening">
      <SettingsGroup title="History">
        <SettingsRow
          label="Data export"
          help={
            summary ? (
              spotifyHistoryHelp(summary)
            ) : (
              <>
                Choose your Spotify data export.{" "}
                <a
                  href={SPOTIFY_PRIVACY_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="settings-link"
                >
                  Request it
                </a>
              </>
            )
          }
        >
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length) void importFiles(files);
            }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || summary === undefined}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? <DotLoader size="xs" label={null} /> : null}
            {summary ? "Replace" : "Import"}
          </button>
          {summary ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={remove}
            >
              Remove
            </button>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

export function ListeningSection() {
  const { user, hasPermission } = useAuth();
  const { history } = useListenHistory();
  const scrobbleStatus = useScrobbleStatus();
  const item = useSettingsItem();
  const provider = PROVIDERS.find((id) => id === item);

  const { data: spotify } = useQuery(spotifyHistoryQueryOptions(user?.id));

  if (provider) return <ServiceDetail provider={provider} />;
  if (item === "spotify") return <SpotifyDetail />;

  return (
    <SettingsPage title="Listening">
      <SettingsGroup
        title="Services"
        note="Your history shapes recommendations. Scrobbling sends what you play."
      >
        {scrobbleStatus.isError ? (
          <SettingsNote tone="warning">Couldn&apos;t load your scrobbling services.</SettingsNote>
        ) : null}
        {PROVIDERS.map((id) => (
          <SettingsServiceRow
            key={id}
            to={`listening/${id}`}
            name={PROVIDER_LABELS[id]}
            status={
              history && scrobbleStatus.data
                ? serviceStatus(
                    history[id],
                    id === "koito" && !hasPermission("accessSettings")
                      ? undefined
                      : scrobbleStatus.data[id],
                  )
                : null
            }
          />
        ))}
        <SettingsServiceRow
          to="listening/spotify"
          name="Spotify"
          status={
            spotify === undefined
              ? null
              : spotify
                ? { label: "History" }
                : { label: "Not set up", tone: "muted" }
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Discovery tastes">
        <ResetTastesRow />
      </SettingsGroup>
    </SettingsPage>
  );
}
