import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import PillToggle from "../../../../components/PillToggle";
import { useAuth } from "../../../../contexts/AuthContext";
import { useToast } from "../../../../contexts/ToastContext";
import { queryKeys } from "../../../../queryClient.ts";
import { historyServersClient } from "../../../../utils/api/clients/historyServers.ts";
import { plexClient } from "../../../../utils/api/clients/plex.ts";
import { SettingsInput } from "../../components/SettingsField";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../../SettingsLayout";
import { HistoryServerActions, historyNote, useHistoryServers } from "./HistoryServers";
import { readApiError } from "../../../../utils/api/errors.ts";

const POLL_MS = 2000;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

export function usePlex() {
  const { user } = useAuth();
  return useQuery({
    queryKey: queryKeys.plex(user?.id),
    queryFn: ({ signal }) => parseResponse(plexClient.$get({}, { init: { signal } })),
  });
}

async function signInWithPlex(serverUrl?: string) {
  const popup = window.open("", "plex-sign-in", "width=600,height=700");
  if (!popup) throw new Error("Allow pop-ups to sign in with Plex");
  try {
    const { id, authUrl } = await parseResponse(plexClient["sign-in"].$post());
    popup.location.href = authUrl;
    for (const deadline = Date.now() + SIGN_IN_TIMEOUT_MS; Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const { done } = await parseResponse(
        plexClient["sign-in"][":id"].$post({ param: { id }, json: { serverUrl } }),
      );
      if (done) return;
      if (popup.closed) throw new Error("The Plex sign-in was closed");
    }
    throw new Error("The Plex sign-in timed out");
  } finally {
    popup.close();
  }
}

export function PlexDetail() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const queryClient = useQueryClient();
  const plex = usePlex();
  const servers = useHistoryServers();
  const history = servers.data?.servers.find((entry) => entry.provider === "plex");
  const [serverUrl, setServerUrl] = useState("");
  const isAdmin = user?.role === "admin";
  const server = plex.data?.server;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.plex(user?.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.historyServers(user?.id) }),
    ]);
  const fail = (fallback: string) => (error: unknown) => {
    const failure = readApiError(error);
    showError(failure.error || failure.text || fallback);
  };

  const signIn = useMutation({
    mutationFn: signInWithPlex,
    onSuccess: async () => {
      setServerUrl("");
      await refresh();
      showSuccess("Plex connected. Importing plays.");
    },
    onError: fail("Couldn't sign in with Plex"),
  });
  const sendPlaylists = useMutation({
    mutationFn: (next: boolean) =>
      plexClient.$patch({ json: { sendPlaylists: next } }).then(parseResponse),
    onSuccess: refresh,
    onError: fail("Couldn't save Plex"),
  });
  const disconnectServer = useMutation({
    mutationFn: () => plexClient.$delete().then(parseResponse),
    onSuccess: async () => {
      await refresh();
      showSuccess("Plex server disconnected.");
    },
    onError: fail("Couldn't disconnect Plex"),
  });
  const sync = useMutation({
    mutationFn: () => historyServersClient[":provider"].sync.$post({ param: { provider: "plex" } }),
    onSuccess: () => showSuccess("Importing Plex plays."),
    onError: fail("Couldn't sync Plex"),
  });
  const disconnect = useMutation({
    mutationFn: () => historyServersClient[":provider"].$delete({ param: { provider: "plex" } }),
    onSuccess: async () => {
      await refresh();
      showSuccess("Plex disconnected.");
    },
    onError: fail("Couldn't disconnect Plex"),
  });
  const busy =
    signIn.isPending ||
    sendPlaylists.isPending ||
    disconnectServer.isPending ||
    sync.isPending ||
    disconnect.isPending;

  return (
    <SettingsPage title="Plex" back="Listening">
      {plex.isError || servers.isError ? (
        <SettingsNote tone="warning">Couldn&apos;t load Plex.</SettingsNote>
      ) : null}
      {isAdmin && plex.data ? (
        <SettingsGroup
          title="Server"
          note={server ? null : "Sign in with the Plex account that owns the server."}
        >
          {server ? (
            <>
              {server.playlistError ? (
                <SettingsNote tone="warning">{server.playlistError}</SettingsNote>
              ) : null}
              {server.playlistNote ? <SettingsNote>{server.playlistNote}</SettingsNote> : null}
              <SettingsRow label="Server URL">
                <span className="settings-row__value">{server.url}</span>
              </SettingsRow>
              <SettingsRow
                label="Send playlists"
                htmlFor="plex-send-playlists"
                help="Adds every flow and playlist to the server owner's Plex account."
              >
                <PillToggle
                  id="plex-send-playlists"
                  aria-label="Send playlists"
                  checked={sendPlaylists.isPending ? sendPlaylists.variables : server.sendPlaylists}
                  disabled={busy}
                  onChange={(event) => sendPlaylists.mutate(event.target.checked)}
                />
              </SettingsRow>
              <SettingsActions>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Disconnect the Plex server? Aurral removes the playlists it added to Plex.",
                      )
                    ) {
                      disconnectServer.mutate();
                    }
                  }}
                >
                  Disconnect server
                </button>
              </SettingsActions>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                signIn.mutate(serverUrl);
              }}
            >
              <SettingsRow label="Server URL" htmlFor="plex-server-url">
                <SettingsInput
                  id="plex-server-url"
                  type="url"
                  placeholder="http://plex:32400"
                  autoComplete="off"
                  value={serverUrl}
                  onChange={(event) => setServerUrl(event.target.value)}
                />
              </SettingsRow>
              <SettingsActions>
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm"
                  disabled={busy || !serverUrl.trim()}
                >
                  Sign in with Plex
                </button>
              </SettingsActions>
            </form>
          )}
        </SettingsGroup>
      ) : null}
      {plex.data?.connected || history ? (
        <SettingsGroup
          title="History"
          note={history ? historyNote(history) : "Imports the plays Plex records for you."}
        >
          {history?.lastError ? (
            <SettingsNote tone="warning">{history.lastError}</SettingsNote>
          ) : null}
          <SettingsActions>
            {history ? (
              <HistoryServerActions
                busy={busy}
                label="Plex"
                onSync={() => sync.mutate()}
                onDisconnect={() => disconnect.mutate()}
              />
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() => signIn.mutate(undefined)}
              >
                Sign in with Plex
              </button>
            )}
          </SettingsActions>
        </SettingsGroup>
      ) : !isAdmin && plex.data ? (
        <SettingsNote>An admin has to connect the Plex server first.</SettingsNote>
      ) : null}
    </SettingsPage>
  );
}
