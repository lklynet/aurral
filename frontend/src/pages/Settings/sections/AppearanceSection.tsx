import { useState } from "react";
import PillToggle from "../../../components/PillToggle";
import {
  getSidebarStageBackdropEnabled,
  resolveSidebarStageBackdropVariant,
  setSidebarStageBackdropEnabled,
} from "../../../components/SidebarStageBackdrop";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { ThemeSettings } from "../components/ThemeSettings";
import { SettingsGroup, SettingsPage, SettingsRow } from "../SettingsLayout";

export function AppearanceSection() {
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const [sidebarArt, setSidebarArt] = useState(() => getSidebarStageBackdropEnabled(user?.id));

  return (
    <SettingsPage title="Appearance">
      <ThemeSettings showSuccess={showSuccess} showError={showError} />
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
