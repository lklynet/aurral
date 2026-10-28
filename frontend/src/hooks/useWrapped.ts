import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { useAuth } from "../contexts/AuthContext.tsx";
import { wrappedClient } from "../utils/api/clients/wrapped.ts";

const PREVIEW_KEY = "aurral-lantern";

export type WrappedRecap = NonNullable<
  InferResponseType<typeof wrappedClient.$get, 200>["summary"]
>;

export const wrappedTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const previewEnabled = () => {
  try {
    return localStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
};

export function useWrappedSeason() {
  const { bootstrap } = useAuth();
  const season = bootstrap?.wrapped;
  return season && (!season.preview || previewEnabled()) ? season : null;
}

export function useWrapped() {
  const { user } = useAuth();
  const season = useWrappedSeason();
  const timeZone = wrappedTimeZone();
  return useQuery({
    queryKey: ["wrapped", user?.id ?? null, season?.year ?? null, timeZone],
    enabled: season !== null,
    queryFn: ({ signal }) =>
      parseResponse(wrappedClient.$get({ query: { timeZone } }, { init: { signal } })),
    refetchInterval: (query) => (query.state.data?.building ? 3000 : false),
  });
}

export function useLanternPreview() {
  const { bootstrap, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const preview = bootstrap?.wrapped?.preview === true;
  useEffect(() => {
    if (!preview) return;
    const aurralLantern = async (enabled = true) => {
      if (enabled) {
        localStorage.setItem(PREVIEW_KEY, "1");
        await parseResponse(wrappedClient.$post({ json: { timeZone: wrappedTimeZone() } }));
      } else {
        localStorage.removeItem(PREVIEW_KEY);
      }
      await client.invalidateQueries({ queryKey: ["wrapped"] });
      await refreshAuth();
      navigate(enabled ? "/wrapped" : "/");
    };
    Object.assign(window, { aurralLantern });
    return () => {
      Reflect.deleteProperty(window, "aurralLantern");
    };
  }, [client, navigate, preview, refreshAuth]);
}
