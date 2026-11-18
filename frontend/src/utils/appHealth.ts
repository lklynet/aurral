import { parseResponse, type InferResponseType } from "hono/client";
import { healthClient } from "./api/clients/health.ts";
import { queryClient, queryKeys } from "../queryClient.ts";
import { activeServer, HOSTED, updateActiveServer } from "./server.ts";

export type BootstrapPayload = InferResponseType<typeof healthClient.bootstrap.$get, 200>;
export type HealthResponse = InferResponseType<typeof healthClient.$get, 200>;

export const fetchHealth = (signal?: AbortSignal) =>
  parseResponse(healthClient.$get({}, { init: { signal } }));

export const refetchHealth = () =>
  queryClient.fetchQuery({
    queryKey: queryKeys.appHealth,
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: 0,
  });

export const invalidateBootstrapCache = () => {
  queryClient.removeQueries({ queryKey: queryKeys.authBootstrap });
};

export const getBootstrapStatus = () =>
  queryClient.fetchQuery({
    queryKey: queryKeys.authBootstrap,
    queryFn: async ({ signal }) => {
      const bootstrap = await parseResponse(healthClient.bootstrap.$get({}, { init: { signal } }));
      const username = bootstrap.user?.username;
      if (HOSTED && username && username !== activeServer?.username) {
        updateActiveServer({ username });
      }
      return bootstrap;
    },
    staleTime: 25_000,
  });
