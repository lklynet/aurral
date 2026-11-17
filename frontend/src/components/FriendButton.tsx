import { useState } from "react";
import { ConfirmModal } from "./ConfirmModal";
import { useFriendActions, useFriends, useHubLink } from "./PlayerFriends";
import { SettingsLink } from "../navigation/settingsRoute";

export function FriendButton({ handle, local = false }: { handle: string; local?: boolean }) {
  const friends = useFriends();
  const link = useHubLink();
  const { add, remove, busy } = useFriendActions();
  const [confirming, setConfirming] = useState(false);
  const data = friends.data;
  if (!data || !link.data || data.state === "off") return null;
  if (data.state !== "linked") {
    return local ? null : (
      <SettingsLink to="profile" className="btn btn-secondary btn-sm">
        {data.state === "broken" ? "Relink aurral.org to add" : "Link aurral.org to add"}
      </SettingsLink>
    );
  }
  if (link.data.state === "linked" && link.data.handle === handle) {
    return local ? null : (
      <SettingsLink to="profile" className="btn btn-secondary btn-sm">
        Edit in Profile
      </SettingsLink>
    );
  }
  const has = (rows: { handle: string }[]) => rows.some((row) => row.handle === handle);
  const name = `@${handle}`;

  if (has(data.friends)) {
    return (
      <>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setConfirming(true)}
        >
          Remove friend
        </button>
        <ConfirmModal
          open={confirming}
          title={`Remove ${name}?`}
          body={
            local
              ? "You'll stop being friends on aurral.org. You still see each other on this server."
              : "You'll stop seeing each other's listening."
          }
          confirmLabel="Remove"
          busyLabel="Removing"
          busy={remove.isPending}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            remove.mutate(
              { handle, done: `Removed ${name}.` },
              { onSuccess: () => setConfirming(false) },
            )
          }
        />
      </>
    );
  }
  if (has(data.incoming)) {
    return (
      <span className="friend-button">
        <span className="friend-button__note">Wants to be friends</span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          onClick={() => add.mutate(handle)}
        >
          Accept
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => remove.mutate({ handle, done: `Declined ${name}.` })}
        >
          Decline
        </button>
      </span>
    );
  }
  if (has(data.outgoing)) {
    return (
      <span className="friend-button">
        <span className="friend-button__note">Requested</span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          onClick={() => remove.mutate({ handle, done: `Canceled your request to ${name}.` })}
        >
          Cancel request
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      disabled={busy}
      onClick={() => add.mutate(handle)}
    >
      Add friend
    </button>
  );
}
