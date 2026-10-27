import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { SettingsSelect } from "./SettingsField";
import { DotLoader } from "../../../components/DotLoader";
import { parseResponse, type InferResponseType } from "hono/client";
import { userPlexLinkClient } from "../../../utils/api/clients/userPlexLink.ts";
import type { usersClient } from "../../../utils/api/clients/users.ts";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.ts";
import { queryKeys } from "../../../queryClient.ts";
import { readApiError } from "../utils/apiError.ts";
import type { userOps } from "../../../../../backend/db/helpers/users.ts";
import type { useToast } from "../../../contexts/ToastContext";

type Toast = ReturnType<typeof useToast>["showSuccess"];
type SettingsUser = ReturnType<typeof userOps.getAllUsers>[number] &
  Partial<
    Pick<InferResponseType<typeof usersClient.$get, 200>[number], "plexLink" | "plexGlobalAccount">
  >;

const unlinkPlex = (userId: number, force = false) =>
  parseResponse(
    userPlexLinkClient[":id"]["plex-link"].$delete({
      param: { id: String(userId) },
      query: force ? { force: "true" } : {},
    }),
  );

export function AdminPlexLinkField({
  user,
  onChanged,
  showSuccess,
  showError,
}: {
  user: SettingsUser;
  onChanged?: () => unknown;
  showSuccess: Toast;
  showError: Toast;
}) {
  const queryClient = useQueryClient();
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
          showError?.(failure.message || failure.error || "Failed to load Plex Home users");
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

  const plexLink = user.plexLink || { connected: false };

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
      showSuccess?.(
        `Linked ${user.username} to Plex user "${picked?.title || selectedPlexUserId}".`,
      );
      setShowHomeUsers(false);
      setSelectedPlexUserId("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.plexHomeUsers });
      await onChanged?.();
    } catch (err) {
      const failure = readApiError(err);
      showError?.(failure.message || failure.error || "Failed to link Plex user");
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      await unlinkPlex(user.id);
      showSuccess?.(`Unlinked ${user.username}'s Plex account.`);
      await onChanged?.();
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
        showSuccess?.(
          `Forcibly unlinked ${user.username}'s final sign-in method. The account can no longer sign in.`,
        );
        await onChanged?.();
      } else {
        showError?.(failure.message || "Failed to unlink Plex");
      }
    } finally {
      setUnlinking(false);
    }
  };

  if (plexLink.connected) {
    return (
      <div className="settings-page__inline-row">
        <span className="settings-page__muted-copy">
          {plexLink.linkType === "managed" ? "Managed user: " : "Self-linked: "}
          <strong>{String(plexLink.plexUsername || "unknown")}</strong>
        </span>
        {plexLink.lastError && (
          <span className="settings-page__hint settings-page__hint--warning">
            Reconnect needed: {plexLink.lastError.message}
          </span>
        )}
        <button
          type="button"
          className="arr-btn arr-btn--ghost"
          onClick={handleUnlink}
          disabled={unlinking}
        >
          {unlinking ? "Unlinking…" : "Unlink"}
        </button>
      </div>
    );
  }

  if (!user.plexGlobalAccount?.configured) {
    return (
      <p className="settings-page__hint">
        Connect the global Plex account in{" "}
        <Link to="/settings/playback" className="settings-page__link">
          Settings → Playback → Plex
        </Link>{" "}
        before linking a managed Plex user.
      </p>
    );
  }

  if (homeUsers === null) {
    return (
      <button
        type="button"
        className="arr-btn arr-btn--ghost"
        onClick={() => setShowHomeUsers(true)}
        disabled={loadingHomeUsers}
      >
        {loadingHomeUsers ? (
          <>
            <DotLoader size="sm" label={null} /> Loading Plex Home users…
          </>
        ) : (
          "Link managed Plex user"
        )}
      </button>
    );
  }

  const availableUsers = homeUsers.filter((u) => !u.alreadyLinked);

  return (
    <div className="settings-page__inline-row">
      <SettingsSelect
        value={selectedPlexUserId}
        onChange={(e) => setSelectedPlexUserId(e.target.value)}
      >
        <option value="">
          {availableUsers.length ? "Select a Plex Home user…" : "No unlinked Plex Home users found"}
        </option>
        {availableUsers.map((u) => (
          <option key={u.id} value={String(u.id)}>
            {u.title || u.username || u.id}
          </option>
        ))}
      </SettingsSelect>
      <button
        type="button"
        className="arr-btn arr-btn--primary"
        onClick={handleLink}
        disabled={!selectedPlexUserId || linking}
      >
        {linking ? "Linking…" : "Link"}
      </button>
      <button type="button" className="arr-btn" onClick={() => setShowHomeUsers(false)}>
        Cancel
      </button>
    </div>
  );
}
