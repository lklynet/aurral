import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { useAuth } from "../../../../contexts/AuthContext";
import { useToast } from "../../../../contexts/ToastContext";
import { queryKeys } from "../../../../queryClient.ts";
import { historyServersClient } from "../../../../utils/api/clients/historyServers.ts";
import { formatDateTime } from "../../../../utils/dateTime.ts";
import { SettingsInput } from "../../components/SettingsField";
import { readApiError } from "../../utils/apiError.ts";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  type ServiceStatus,
} from "../../SettingsLayout";

export const HISTORY_SERVERS = ["navidrome", "plex", "jellyfin"] as const;
export type HistoryServerProvider = (typeof HISTORY_SERVERS)[number];
type HistoryServer = InferResponseType<typeof historyServersClient.$get, 200>["servers"][number];

const FIELDS: Record<
  HistoryServerProvider,
  { label: string; url: string; username: string; secret: string; help: string }
> = {
  navidrome: {
    label: "Navidrome",
    url: "http://navidrome:4533",
    username: "Username",
    secret: "Password",
    help: "Imports the plays Navidrome records for this user.",
  },
  plex: {
    label: "Plex",
    url: "http://plex:32400",
    username: "Plex account",
    secret: "Server owner token",
    help: "Imports the plays Plex records for this account.",
  },
  jellyfin: {
    label: "Jellyfin",
    url: "http://jellyfin:8096",
    username: "Username",
    secret: "API key",
    help: "Needs the Playback Reporting plugin. Create the API key in Dashboard, API Keys.",
  },
};

export const historyServerLabel = (provider: HistoryServerProvider) => FIELDS[provider].label;

export function useHistoryServers() {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.historyServers(user?.id),
    queryFn: ({ signal }) => parseResponse(historyServersClient.$get({}, { init: { signal } })),
    refetchInterval: ({ state }) =>
      state.data?.servers.some((server) => !server.lastSyncedAt) ? 2000 : false,
  });
}

export function historyServerStatus(server: HistoryServer | undefined): ServiceStatus {
  if (!server) return { label: "Not set up", tone: "muted" };
  if (server.lastError) return { label: "Sync failed", tone: "error" };
  return { label: "History" };
}

export function HistoryServerDetail({ provider }: { provider: HistoryServerProvider }) {
  const { user, hasPermission } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const servers = useHistoryServers();
  const server = servers.data?.servers.find((entry) => entry.provider === provider);
  const fields = FIELDS[provider];
  const canConnect = hasPermission("accessSettings");
  const [draft, setDraft] = useState<{ url?: string; username?: string; secret: string }>({
    secret: "",
  });
  const url = draft.url ?? server?.url ?? "";
  const username = draft.username ?? server?.username ?? "";
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.historyServers(user?.id) });
  const fail = (fallback: string) => (error: unknown) => {
    const failure = readApiError(error);
    showError(failure.error || failure.text || fallback);
  };
  const param = { provider };

  const connect = useMutation({
    mutationFn: () =>
      parseResponse(
        historyServersClient[":provider"].$put({
          param,
          json: { url, username, secret: draft.secret },
        }),
      ),
    onSuccess: async () => {
      setDraft({ secret: "" });
      await refresh();
      showSuccess(`${fields.label} connected. Importing plays.`);
    },
    onError: fail(`Couldn't connect ${fields.label}`),
  });
  const sync = useMutation({
    mutationFn: () => historyServersClient[":provider"].sync.$post({ param }),
    onSuccess: () => showSuccess(`Importing ${fields.label} plays.`),
    onError: fail(`Couldn't sync ${fields.label}`),
  });
  const disconnect = useMutation({
    mutationFn: () => historyServersClient[":provider"].$delete({ param }),
    onSuccess: async () => {
      setDraft({ secret: "" });
      await refresh();
      showSuccess(`${fields.label} disconnected.`);
    },
    onError: fail(`Couldn't disconnect ${fields.label}`),
  });
  const busy = connect.isPending || sync.isPending || disconnect.isPending;

  return (
    <SettingsPage title={fields.label} back="Listening">
      {servers.isError ? (
        <SettingsNote tone="warning">Couldn&apos;t load {fields.label}.</SettingsNote>
      ) : null}
      {server?.lastError ? <SettingsNote tone="warning">{server.lastError}</SettingsNote> : null}
      <SettingsGroup
        title="History"
        note={
          server
            ? [
                `${server.plays.toLocaleString()} ${server.plays === 1 ? "play" : "plays"} imported`,
                server.lastSyncedAt
                  ? `Last synced ${formatDateTime(new Date(server.lastSyncedAt))}`
                  : "Importing",
              ].join(". ")
            : fields.help
        }
      >
        {canConnect ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              connect.mutate();
            }}
          >
            <SettingsRow label="Server URL" htmlFor="history-server-url">
              <SettingsInput
                id="history-server-url"
                type="url"
                placeholder={fields.url}
                autoComplete="off"
                value={url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </SettingsRow>
            <SettingsRow label={fields.username} htmlFor="history-server-username">
              <SettingsInput
                id="history-server-username"
                type="text"
                autoComplete="off"
                value={username}
                onChange={(event) => setDraft({ ...draft, username: event.target.value })}
              />
            </SettingsRow>
            <SettingsRow label={fields.secret} htmlFor="history-server-secret">
              <SettingsInput
                id="history-server-secret"
                type="password"
                autoComplete="off"
                placeholder={server ? "••••••••••••" : undefined}
                value={draft.secret}
                onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
              />
            </SettingsRow>
            <SettingsActions>
              <button
                type="submit"
                className="btn btn-secondary btn-sm"
                disabled={busy || !url.trim() || !username.trim() || (!server && !draft.secret)}
              >
                {server ? `Update ${fields.label}` : `Connect ${fields.label}`}
              </button>
              {server ? (
                <HistoryServerActions
                  busy={busy}
                  onSync={() => sync.mutate()}
                  onDisconnect={() => disconnect.mutate()}
                  label={fields.label}
                />
              ) : null}
            </SettingsActions>
          </form>
        ) : server ? (
          <SettingsActions>
            <HistoryServerActions
              busy={busy}
              onSync={() => sync.mutate()}
              onDisconnect={() => disconnect.mutate()}
              label={fields.label}
            />
          </SettingsActions>
        ) : (
          <SettingsNote>Only admins can connect {fields.label}.</SettingsNote>
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

function HistoryServerActions({
  busy,
  label,
  onSync,
  onDisconnect,
}: {
  busy: boolean;
  label: string;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onSync}>
        Sync now
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => {
          if (window.confirm(`Disconnect ${label}? Aurral removes the plays it imported.`)) {
            onDisconnect();
          }
        }}
      >
        Disconnect
      </button>
    </>
  );
}
