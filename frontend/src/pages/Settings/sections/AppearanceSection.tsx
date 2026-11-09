import { useState } from "react";
import PillToggle from "../../../components/PillToggle";
import {
  getSidebarStageBackdropEnabled,
  resolveSidebarStageBackdropVariant,
  setSidebarStageBackdropEnabled,
} from "../../../components/SidebarStageBackdrop";
import { useAuth } from "../../../contexts/AuthContext";
import { setLegacyNav, useLegacyNav } from "../../../navigation/legacyNav.ts";
import { setArtistVideos, useArtistVideos } from "../../ArtistDetails/artistVideosSetting.ts";
import { useToast } from "../../../contexts/ToastContext";
import { ThemeSettings } from "../components/ThemeSettings";
import { SettingsGroup, SettingsPage, SettingsRow } from "../SettingsLayout";

export function AppearanceSection() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const [sidebarArt, setSidebarArt] = useState(() => getSidebarStageBackdropEnabled(user?.id));
  const legacyNav = useLegacyNav();
  const artistVideos = useArtistVideos();

  return (
    <SettingsPage title="Appearance">
      <ThemeSettings showSuccess={showSuccess} showError={showError} />
      <SettingsGroup title="Navigation">
        <SettingsRow
          label="Legacy navigation"
          help="The v1 sidebar with nested links instead of section tabs."
          htmlFor="appearance-nav-legacy"
        >
          <PillToggle
            id="appearance-nav-legacy"
            checked={legacyNav}
            aria-label="Legacy navigation"
            onChange={(event) => setLegacyNav(user?.id, event.target.checked)}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Artist pages">
        <SettingsRow
          label="YouTube videos"
          help="Music videos for an artist's popular tracks."
          htmlFor="appearance-artist-videos"
        >
          <PillToggle
            id="appearance-artist-videos"
            checked={artistVideos}
            aria-label="YouTube videos"
            onChange={(event) => setArtistVideos(user?.id, event.target.checked)}
          />
        </SettingsRow>
      </SettingsGroup>
      {resolveSidebarStageBackdropVariant() ? (
        <SettingsGroup title="Sidebar">
          <SettingsRow label="Environment art" htmlFor="appearance-sidebar-art">
            <PillToggle
              id="appearance-sidebar-art"
              checked={sidebarArt}
              aria-label="Environment art"
              onChange={(event) =>
                setSidebarArt(setSidebarStageBackdropEnabled(user?.id, event.target.checked))
              }
            />
          </SettingsRow>
        </SettingsGroup>
      ) : null}
    </SettingsPage>
  );
}
