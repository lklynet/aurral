import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { SettingsSelect } from "./SettingsField";
import { DotLoader } from "../../../components/DotLoader";
import {
  getPlexHomeUsersForAdmin,
  linkManagedPlexUser,
  adminUnlinkPlex,
} from "../../../utils/api/endpoints/auth.js";
import { isReauthRequiredError, promptReauth } from "../../../utils/reauth.js";
import { queryKeys } from "../../../queryClient.js";

export function AdminPlexLinkField({ user, onChanged, showSuccess, showError }) {
  const queryClient = useQueryClient();
  const [showHomeUsers, setShowHomeUsers] = useState(false);
  const homeUsersQuery = useQuery({
    queryKey: queryKeys.plexHomeUsers,
    queryFn: async ({ signal }) => {
      try {
        const { users } = await getPlexHomeUsersForAdmin({ signal });
        return users || [];
      } catch (err) {
        if (!signal.aborted) {
          showError?.(
            err.response?.data?.message || err.response?.data?.error || "Failed to load Plex Home users",
          );
        }
        throw err;
      }
    },
    enabled: showHomeUsers,
    staleTime: 0,
  });
  const loadingHomeUsers = showHomeUsers && homeUsersQuery.isFetching;
  const homeUsers =
    showHomeUsers && !homeUsersQuery.isFetching ? homeUsersQuery.data ?? [] : null;
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
      await linkManagedPlexUser(user.id, picked?.id ?? selectedPlexUserId, {
        plexUsername: picked?.title || picked?.username || null,
        plexUuid: picked?.uuid || null,
      });
      showSuccess?.(
        `Linked ${user.username} to Plex user "${picked?.title || selectedPlexUserId}".`,
      );
      setShowHomeUsers(false);
      setSelectedPlexUserId("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.plexHomeUsers });
      await onChanged?.();
    } catch (err) {
      showError?.(
        err.response?.data?.message || err.response?.data?.error || "Failed to link Plex user",
      );
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    setUnlinking(true);
    try {
      await adminUnlinkPlex(user.id);
      showSuccess?.(`Unlinked ${user.username}'s Plex account.`);
      await onChanged?.();
    } catch (err) {
      if (
        err.response?.status === 409 &&
        err.response?.data?.error === "last_auth_method" &&
        err.response?.data?.requiresForce
      ) {
        const confirmed = window.confirm(
          `Unlink Plex for ${user.username}? They will be unable to sign in until an admin sets a password or links another account.`,
        );
        if (!confirmed) return;
        const forceUnlink = () => adminUnlinkPlex(user.id, { force: true });
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
        showError?.(err.response?.data?.message || "Failed to unlink Plex");
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
          <strong>{plexLink.plexUsername || "unknown"}</strong>
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
        ) : "Link managed Plex user"}
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
