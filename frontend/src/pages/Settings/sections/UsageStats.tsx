import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import PillToggle from "../../../components/PillToggle";
import { useAuth } from "../../../contexts/AuthContext";
import { queryKeys } from "../../../queryClient.ts";
import { telemetryClient } from "../../../utils/api/clients/telemetry.ts";
import { invalidateBootstrapCache } from "../../../utils/appHealth.ts";
import { formatDate } from "../../../utils/dateTime.ts";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsServiceRow } from "../SettingsLayout";

function useTelemetry() {
  const queryClient = useQueryClient();
  const { refreshAuth } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.telemetry,
    queryFn: ({ signal }) => parseResponse(telemetryClient.$get({}, { init: { signal } })),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => parseResponse(telemetryClient.$put({ json: { enabled } })),
    onSuccess: () => {
      invalidateBootstrapCache();
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.telemetry }),
        refreshAuth(),
      ]);
    },
  });
  return { telemetry: query.data, toggle };
}

export function UsageStatsGroup() {
  const { telemetry, toggle } = useTelemetry();
  return (
    <SettingsGroup
      title="Usage stats"
      note={telemetry?.official === false ? "This build never sends them." : null}
    >
      <SettingsRow
        label="Share anonymous usage stats"
        htmlFor="usage-stats"
        help="Sent to aurral.org every 3 days."
      >
        <PillToggle
          id="usage-stats"
          checked={toggle.isPending ? toggle.variables : telemetry?.enabled === true}
          disabled={!telemetry || toggle.isPending}
          onChange={(event) => toggle.mutate(event.target.checked)}
          aria-label="Share anonymous usage stats"
        />
      </SettingsRow>
      <SettingsServiceRow
        to="general/usage-stats"
        name="What's sent"
        status={
          telemetry
            ? {
                label: telemetry.lastSentAt
                  ? `Last sent ${formatDate(new Date(telemetry.lastSentAt))}`
                  : "Not sent yet",
                tone: "muted",
              }
            : null
        }
      />
    </SettingsGroup>
  );
}

export function UsageStatsDetail() {
  const { telemetry } = useTelemetry();
  return (
    <SettingsPage title="What's sent" back="General">
      <SettingsGroup note="The next report, exactly as aurral.org would receive it.">
        <SettingsRow stack>
          <pre className="settings-code usage-stats-report">
            {telemetry ? JSON.stringify(telemetry.report, null, 2) : null}
          </pre>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  );
}
