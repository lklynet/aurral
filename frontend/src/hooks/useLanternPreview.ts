import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../contexts/AuthContext.tsx";
import { setLanternPreview } from "../utils/api/endpoints/wrapped.ts";
import { isWrappedPreviewBuild } from "../../../lib/wrapped.ts";

export function useLanternPreview() {
  const { bootstrap, user, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  useEffect(() => {
    if (!isWrappedPreviewBuild(bootstrap?.appVersion ?? "") || !(user?.id && user.id > 0)) return;
    let active = true;
    const aurralLantern = async (enabled = true) => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const data = await setLanternPreview(timeZone, enabled);
      if (!active) return null;
      await client.invalidateQueries({ queryKey: ["wrapped-announcement", user.id] });
      await client.invalidateQueries({ queryKey: ["wrapped", user.id] });
      if (data.report) client.setQueryData(["wrapped", user.id, data.report.year, timeZone], data);
      if (!(await refreshAuth())) throw new Error("The session could not be refreshed. Try again.");
      if (!active) return data.report;
      navigate(enabled ? "/wrapped" : "/", {
        state: { wrappedFrom: `${location.pathname}${location.search}${location.hash}` },
      });
      return data.report;
    };
    Object.assign(window, { aurralLantern });
    return () => {
      active = false;
      if (Reflect.get(window, "aurralLantern") === aurralLantern)
        Reflect.deleteProperty(window, "aurralLantern");
    };
  }, [bootstrap?.appVersion, client, location, navigate, refreshAuth, user?.id]);
}
