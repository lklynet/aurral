import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { authClient } from "../../../utils/api/clients/auth.ts";
import { readApiError } from "../../../utils/api/errors.ts";
import { formatRelativeTime } from "../../../utils/dateTime.ts";
import { SettingsGroup, SettingsRow } from "../SettingsLayout";

const BROWSERS = [
  ["Edg/", "Edge"],
  ["Firefox/", "Firefox"],
  ["Chrome/", "Chrome"],
  ["CriOS/", "Chrome"],
  ["Safari/", "Safari"],
] as const;

const SYSTEMS = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["Macintosh", "macOS"],
  ["Windows", "Windows"],
  ["Linux", "Linux"],
] as const;

const deviceName = (userAgent: string | null) => {
  if (!userAgent) return "Unknown device";
  const browser = BROWSERS.find(([marker]) => userAgent.includes(marker))?.[1];
  const system = SYSTEMS.find(([marker]) => userAgent.includes(marker))?.[1];
  const app = browser ?? userAgent.split(/[\s/(]/)[0];
  return system ? `${app} on ${system}` : app;
};

export function DevicesGroup({ userId }: { userId: number }) {
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.mySessions(userId);
  const sessions = useQuery({
    queryKey,
    queryFn: ({ signal }) => parseResponse(authClient.sessions.$get({}, { init: { signal } })),
  });
  const signOut = useMutation({
    mutationFn: (id: number) =>
      parseResponse(authClient.sessions[":id"].$delete({ param: { id: String(id) } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => showError(readApiError(error).error || "Couldn't sign that device out"),
  });
  const rows = sessions.data?.sessions ?? [];
  if (!rows.length) return null;
  return (
    <SettingsGroup title="Devices">
      {rows.map((session) => (
        <SettingsRow
          key={session.id}
          label={deviceName(session.userAgent)}
          help={
            session.current
              ? "This device"
              : `Active ${formatRelativeTime(new Date(session.lastUsedAt), { unit: "day" })}`
          }
        >
          {session.current ? null : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={signOut.isPending && signOut.variables === session.id}
              onClick={() => signOut.mutate(session.id)}
            >
              Sign out
            </button>
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}
