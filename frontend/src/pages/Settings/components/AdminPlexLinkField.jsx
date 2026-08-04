import { useState } from "react";
import { Link } from "react-router-dom";
import { SettingsSelect } from "./SettingsField";
import {
  getPlexHomeUsersForAdmin,
  linkManagedPlexUser,
  adminUnlinkPlex,
} from "../../../utils/api/endpoints/auth.js";

export function AdminPlexLinkField({ user, onChanged, showSuccess, showError }) {
  const [homeUsers, setHomeUsers] = useState(null);
  const [loadingHomeUsers, setLoadingHomeUsers] = useState(false);
  const [selectedPlexUserId, setSelectedPlexUserId] = useState("");
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const plexLink = user.plexLink || { connected: false };

  const loadHomeUsers = async () => {
    setLoadingHomeUsers(true);
    try {
      const { users } = await getPlexHomeUsersForAdmin();
      setHomeUsers(users || []);
    } catch (err) {
      showError?.(
        err.response?.data?.message || err.response?.data?.error || "Failed to load Plex Home users",
      );
      setHomeUsers([]);
    } finally {
      setLoadingHomeUsers(false);
    }
  };

  const handleLink = async () => {
    if (!selectedPlexUserId) return;
    if (plexLink.connected && plexLink.linkType === "self") {
      const confirmed = window.confirm(
        `${user.username} already has their own Plex account linked ("${
          plexLink.plexUsername || "unknown"
        }"). Linking a managed Plex user will replace that self-link. Continue?`,
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
      setHomeUsers(null);
      setSelectedPlexUserId("");
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
      showError?.(err.response?.data?.message || "Failed to unlink Plex");
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
        onClick={loadHomeUsers}
        disabled={loadingHomeUsers}
      >
        {loadingHomeUsers ? "Loading Plex Home users…" : "Link managed Plex user"}
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
      <button type="button" className="arr-btn" onClick={() => setHomeUsers(null)}>
        Cancel
      </button>
    </div>
  );
}
