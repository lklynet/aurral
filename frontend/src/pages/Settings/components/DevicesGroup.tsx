import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useToast } from "../../../contexts/ToastContext";
import { queryKeys } from "../../../queryClient.ts";
import { authClient } from "../../../utils/api/clients/auth.ts";
import { readApiError } from "../../../utils/api/errors.ts";
import { formatRelativeTime, formatTime } from "../../../utils/dateTime.ts";
import { HOSTED, serverUrl } from "../../../utils/server.ts";
import { SettingsGroup, SettingsRow } from "../SettingsLayout";

const HTTPS_DOCS = "https://docs.aurral.org/using/music-aurral-org/";

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
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const issueCode = () => parseResponse(authClient["pairing-codes"].$post());
  const getCode = useMutation({
    mutationFn: issueCode,
    onSuccess: setCode,
    onError: (error) => showError(readApiError(error).error || "Couldn't make a code"),
  });
  const openHosted = (appOrigin: string) => {
    const popup = window.open("", "_blank");
    issueCode().then(
      (issued) => {
        if (!popup) return;
        popup.opener = null;
        popup.location.href = `${appOrigin}/pair#${issued.code}.${serverUrl("")}`;
      },
      (error) => {
        popup?.close();
        showError(readApiError(error).error || "Couldn't make a code");
      },
    );
  };
  const rows = sessions.data?.sessions ?? [];
  const appOrigin = sessions.data?.appOrigin;
  const reachable = window.location.protocol === "https:" || appOrigin?.startsWith("http:");
  return (
    <SettingsGroup title="Devices">
      {appOrigin && !HOSTED ? (
        <SettingsRow
          label={new URL(appOrigin).host}
          help={
            reachable ? (
              "Use Aurral from any browser, signed in to this server."
            ) : (
              <>
                Needs this server on an HTTPS address.{" "}
                <a href={HTTPS_DOCS} target="_blank" rel="noopener noreferrer">
                  How to get one
                </a>
              </>
            )
          }
        >
          {reachable ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => openHosted(appOrigin)}
            >
              Open
            </button>
          ) : null}
        </SettingsRow>
      ) : null}
      <SettingsRow
        label="Pair a device"
        help={
          code ? (
            <>
              <span className="devices-code">{code.code}</span> works once, until{" "}
              {formatTime(new Date(code.expiresAt), { hour: "numeric", minute: "2-digit" })}.
            </>
          ) : (
            "A one-time code for another browser or app."
          )
        }
      >
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={getCode.isPending}
          onClick={() => getCode.mutate()}
        >
          {code ? "New code" : "Get code"}
        </button>
      </SettingsRow>
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
