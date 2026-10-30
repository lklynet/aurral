import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { SettingsSelect } from "./SettingsField";
import { DotLoader } from "../../../components/DotLoader";
import { useToast } from "../../../contexts/ToastContext";
import { userPlexLinkClient } from "../../../utils/api/clients/userPlexLink.ts";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.ts";
import { queryKeys } from "../../../queryClient.ts";
import { readApiError } from "../utils/apiError.ts";
import { refreshUsers, type SettingsUser } from "../hooks/useSettingsUsers";
import { SettingsLink } from "../settingsRoute";
import { SettingsActions, SettingsGroup, SettingsNote, SettingsRow } from "../SettingsLayout";

const unlinkPlex = (userId: number, force = false) =>
  parseResponse(
    userPlexLinkClient[":id"]["plex-link"].$delete({
      param: { id: String(userId) },
      query: force ? { force: "true" } : {},
    }),
  );

function plexNote({ role, id, plexLink, plexGlobalAccount }: SettingsUser) {
  if (plexLink.connected) {
    return `${plexLink.linkType === "managed" ? "Managed user" : "Self-linked"}: ${
      plexLink.plexUsername || "unknown"
    }.`;
  }
  const ownsGlobalAccount =
    role === "admin" &&
    plexGlobalAccount.configured &&
    (plexGlobalAccount.configuredByUserId == null ||
      Number(plexGlobalAccount.configuredByUserId) === Number(id));
  if (ownsGlobalAccount) {
    return `Uses Aurral's Plex connection${
      plexGlobalAccount.plexUsername ? `, ${plexGlobalAccount.plexUsername}` : ""
    }.`;
  }
  return "Use a Plex Home managed user for this account's flows and playlists.";
}

export function AdminPlexLinkField({ user }: { user: SettingsUser }) {
  const selectId = useId();
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToast();
  const [showHomeUsers, setShowHomeUsers] = useState(false);
  const homeUsersQuery = useQuery({
    queryKey: queryKeys.plexHomeUsers,
    queryFn: async ({ signal }) => {
      try {
        const { users } = await parseResponse(
          userPlexLinkClient["plex-link"]["home-users"].$get({}, { init: { signal } }),
        );
        return users || [];
      } catch (err) {
        if (!signal.aborted) {
          const failure = readApiError(err);
          showError(failure.message || failure.error || "Failed to load Plex Home users");
        }
        throw err;
      }
    },
    enabled: showHomeUsers,
    staleTime: 0,
  });
  const loadingHomeUsers = showHomeUsers && homeUsersQuery.isFetching;
  const homeUsers =
    showHomeUsers && !homeUsersQuery.isFetching ? (homeUsersQuery.data ?? []) : null;
  const [selectedPlexUserId, setSelectedPlexUserId] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const { plexLink } = user;

  const handleLink = async () => {
    if (!selectedPlexUserId) return;
    if (plexLink.connected && plexLink.linkType === "self") {
      const confirmed = window.confirm(
        `Replace ${user.username}'s linked Plex account "${
          plexLink.plexUsername || "unknown"
        }" with this managed user?`,
      );
      if (!confirmed) return;
    }
    const picked = homeUsers?.find((u) => String(u.id) === selectedPlexUserId);
    setLinking(true);
    try {
      await parseResponse(
        userPlexLinkClient[":id"]["plex-link"].managed.$post({
          param: { id: String(user.id) },
          json: {
            plexUserId: picked?.id ?? selectedPlexUserId,
            plexUsername: picked?.title || picked?.username || null,
            plexUuid: picked?.uuid || null,
          },
        }),
      );
      showSuccess(`Linked ${user.username} to Plex user "${picked?.title || selectedPlexUserId}".`);
      setShowHomeUsers(false);
      setSelectedPlexUserId("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.plexHomeUsers });
      await refreshUsers();
    } catch (err) {
      const failure = readApiError(err);
      showError(failure.message || failure.error || "Failed to link Plex user");
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      await unlinkPlex(user.id);
      showSuccess(`Unlinked ${user.username}'s Plex account.`);
      await refreshUsers();
    } catch (err) {
      const failure = readApiError(err);
      if (
        failure.status === 409 &&
        failure.error === "last_auth_method" &&
        failure.body &&
        "requiresForce" in failure.body &&
        failure.body.requiresForce
      ) {
        const confirmed = window.confirm(
          `Unlink Plex for ${user.username}? They will be unable to sign in until an admin sets a password or links another account.`,
        );
        if (!confirmed) return;
        const forceUnlink = () => unlinkPlex(user.id, true);
        try {
          await forceUnlink();
        } catch (forceError) {
          if (!isReauthRequiredError(forceError) || !(await promptReauth())) throw forceError;
          await forceUnlink();
        }
        showSuccess(
          `Forcibly unlinked ${user.username}'s final sign-in method. The account can no longer sign in.`,
        );
        await refreshUsers();
      } else {
        showError(failure.message || "Failed to unlink Plex");
      }
    } finally {
      setUnlinking(false);
    }
  };

  const availableUsers = homeUsers?.filter((u) => !u.alreadyLinked) ?? [];

  return (
    <SettingsGroup title="Plex account" note={plexNote(user)}>
      {plexLink.connected ? (
        <>
          {plexLink.lastError ? (
            <SettingsNote tone="warning">
              Reconnect needed: {plexLink.lastError.message}
            </SettingsNote>
          ) : null}
          <SettingsActions>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleUnlink}
              disabled={unlinking}
            >
              {unlinking ? "Unlinking…" : "Unlink"}
            </button>
          </SettingsActions>
        </>
      ) : !user.plexGlobalAccount.configured ? (
        <SettingsNote>
          Connect Plex in{" "}
          <SettingsLink to="playback/plex" className="settings-link">
            Playback
          </SettingsLink>{" "}
          before linking a managed Plex user.
        </SettingsNote>
      ) : homeUsers === null ? (
        <SettingsActions>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setShowHomeUsers(true)}
            disabled={loadingHomeUsers}
          >
            {loadingHomeUsers ? <DotLoader size="xs" label={null} /> : null}
            Link managed Plex user
          </button>
        </SettingsActions>
      ) : (
        <SettingsRow label="Plex Home user" htmlFor={selectId}>
          <SettingsSelect
            id={selectId}
            value={selectedPlexUserId}
            onChange={(e) => setSelectedPlexUserId(e.target.value)}
          >
            <option value="">
              {availableUsers.length ? "Select a Plex Home user…" : "No unlinked Plex Home users"}
            </option>
            {availableUsers.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.title || u.username || u.id}
              </option>
            ))}
          </SettingsSelect>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={handleLink}
            disabled={!selectedPlexUserId || linking}
          >
            {linking ? "Linking…" : "Link"}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowHomeUsers(false)}
          >
            Cancel
          </button>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
