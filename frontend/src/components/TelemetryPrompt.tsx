import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useAuth } from "../contexts/AuthContext";
import { useToast } from "../contexts/ToastContext";
import { queryKeys } from "../queryClient.ts";
import { telemetryClient } from "../utils/api/clients/telemetry.ts";
import { invalidateBootstrapCache } from "../utils/appHealth.ts";

export default function TelemetryPrompt() {
  const { user, refreshAuth } = useAuth();
  const { addToast, showError } = useToast();
  const queryClient = useQueryClient();
  const asked = useRef(false);
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (!isAdmin || asked.current) return;
    asked.current = true;
    parseResponse(telemetryClient.ask.$post())
      .then(({ ask }) => {
        if (!ask) return;
        addToast(
          {
            title: "Share anonymous usage stats?",
            message: "Helps decide what to build and what to cut. No names, paths, or addresses.",
            action: {
              label: "Turn on",
              onClick: () => {
                parseResponse(telemetryClient.$put({ json: { enabled: true } }))
                  .then(() => {
                    invalidateBootstrapCache();
                    return Promise.all([
                      queryClient.invalidateQueries({ queryKey: queryKeys.telemetry }),
                      refreshAuth(),
                    ]);
                  })
                  .catch(() => showError("Couldn't turn on usage stats"));
              },
            },
          },
          "info",
          Infinity,
        );
      })
      .catch(() => {});
  }, [addToast, isAdmin, queryClient, refreshAuth, showError]);

  return null;
}
