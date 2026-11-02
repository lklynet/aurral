import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "../components/icons";
import TooltipButton from "../components/TooltipButton";
import { listeningHistoryQueryOptions, spotifyHistoryQueryOptions } from "../queryOptions.ts";
import { SettingsLink } from "./Settings/settingsRoute";

const dismissedKey = (userId: string | number) => `aurral:discover-history-prompt:${userId}`;

export function DiscoverHistoryPrompt({ userId }: { userId: string | number | undefined }) {
  const { data: history } = useQuery(listeningHistoryQueryOptions(userId));
  const { data: spotify } = useQuery(spotifyHistoryQueryOptions(userId));
  const [dismissed, setDismissed] = useState(
    () => userId != null && localStorage.getItem(dismissedKey(userId)) === "1",
  );
  const needsHistory = history != null && spotify === null && !Object.values(history).some(Boolean);
  if (userId == null || dismissed || !needsHistory) return null;

  const dismiss = () => {
    localStorage.setItem(dismissedKey(userId), "1");
    setDismissed(true);
  };

  return (
    <div className="discover-history-prompt">
      <p className="discover-history-prompt__message">
        Make Discover yours with your listening history.
      </p>
      <div className="discover-history-prompt__actions">
        <SettingsLink to="listening/lastfm" className="btn btn-secondary btn-sm">
          Last.fm
        </SettingsLink>
        <SettingsLink to="listening/listenbrainz" className="btn btn-secondary btn-sm">
          ListenBrainz
        </SettingsLink>
        <SettingsLink to="listening/spotify" className="btn btn-secondary btn-sm">
          Spotify
        </SettingsLink>
        <TooltipButton label="Dismiss" className="btn btn-ghost btn-icon" onClick={dismiss}>
          <X aria-hidden="true" />
        </TooltipButton>
      </div>
    </div>
  );
}
