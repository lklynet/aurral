import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { CONNECT_SLUG_PATTERN } from "../../../../../lib/connectTokens.ts";
import { ConfirmModal } from "../../../components/ConfirmModal";
import { DotLoader } from "../../../components/DotLoader";
import PillToggle from "../../../components/PillToggle";
import TooltipButton from "../../../components/TooltipButton";
import { Check, Copy, ExternalLink } from "../../../components/icons";
import { useHubLink } from "../../../components/PlayerFriends";
import { useAuth } from "../../../contexts/AuthContext";
import { useToast } from "../../../contexts/ToastContext";
import { SettingsLink } from "../../../navigation/settingsRoute";
import { queryKeys } from "../../../queryClient.ts";
import { connectClient } from "../../../utils/api/clients/connect.ts";
import { readApiError } from "../../../utils/api/errors.ts";
import { HOSTED } from "../../../utils/server.ts";
import { copyText } from "../../../utils/shareLink.ts";
import { SettingsCommitInput, SettingsInput } from "../components/SettingsField";
import {
  SettingsActions,
  SettingsGroup,
  SettingsNote,
  SettingsPage,
  SettingsRow,
} from "../SettingsLayout";

type ConnectStatus = InferResponseType<typeof connectClient.$get, 200>;

const STATUS_POLL_MS = 3000;
const RETRYING_STATES = new Set<ConnectStatus["state"]>([
  "connecting",
  "error",
  "subscription_required",
]);
const SLUG_ERROR_CODES = new Set([
  "slug_invalid",
  "slug_reserved",
  "slug_not_allowed",
  "slug_taken",
]);

const normalizeSlugInput = (value: string) => value.trim().toLowerCase();

const hostOfUrl = (url: string | null, slug: string | null, domain: string) => {
  if (url) {
    try {
      return new URL(url).host;
    } catch {}
  }
  return slug ? `${slug}.${domain}` : domain;
};

export function useConnectNeedsAttention({ enabled = true }: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: queryKeys.connectStatus,
    queryFn: ({ signal }) => parseResponse(connectClient.$get({}, { init: { signal } })),
    enabled,
    staleTime: 60_000,
  });
  const data = query.data;
  return Boolean(
    data?.enabled &&
    (data.state === "subscription_required" || data.state === "replaced" || data.state === "error"),
  );
}

function connectErrorInfo(error: unknown) {
  const failure = readApiError(error);
  const code = failure.error;
  const message = failure.message || failure.text || "Couldn't reach aurral.org. Try again.";
  return { code, message, isSlugError: Boolean(code && SLUG_ERROR_CODES.has(code)) };
}

function LinkedBillingHelp({ handle, hubOrigin }: { handle: string | null; hubOrigin: string }) {
  const accountUrl = `${hubOrigin}/account`;
  if (!handle) {
    return (
      <a href={accountUrl} target="_blank" rel="noopener noreferrer" className="settings-link">
        Manage billing
      </a>
    );
  }
  return (
    <>
      Linked as @{handle}
      {"\u00A0·\u00A0"}
      <a href={accountUrl} target="_blank" rel="noopener noreferrer" className="settings-link">
        Manage billing
      </a>
    </>
  );
}

function ConnectAddressRow({ connectUrl }: { connectUrl: string }) {
  const { showError } = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyText(connectUrl))) {
      showError("Couldn't copy the address.");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <SettingsRow label="Address" help="Subsonic apps and listen links use this URL." stack>
      <code className="settings-code">{connectUrl}</code>
      <TooltipButton
        label={copied ? "Copied" : "Copy address"}
        className="btn btn-ghost btn-icon btn-sm"
        onClick={copy}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </TooltipButton>
    </SettingsRow>
  );
}

function SetupConnect({
  status,
  handle,
  userId,
  onEnabled,
}: {
  status: ConnectStatus;
  handle: string;
  userId: number | undefined;
  onEnabled: (next: ConnectStatus) => void;
}) {
  const formId = useId();
  const { showSuccess } = useToast();
  const [name, setName] = useState(status.name || "Home Server");
  const [slug, setSlug] = useState(status.slug || handle.replace(/_/g, "-"));
  const [allowHubSignIn, setAllowHubSignIn] = useState(true);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const accountQuery = useQuery({
    queryKey: queryKeys.connectAccount(userId),
    queryFn: ({ signal }) => parseResponse(connectClient.account.$get({}, { init: { signal } })),
    enabled: userId != null,
  });

  const enable = useMutation({
    mutationFn: (payload: {
      name: string;
      slug: string;
      allowHubSignIn: boolean;
      startTrial: boolean;
    }) => parseResponse(connectClient.enable.$post({ json: payload })),
    onSuccess: (next) => {
      setSlugError(null);
      setFormError(null);
      onEnabled(next);
      showSuccess("Connect enabled");
    },
    onError: (error) => {
      const info = connectErrorInfo(error);
      if (info.isSlugError) {
        setSlugError(info.message);
        setFormError(null);
      } else {
        setFormError(info.message);
      }
    },
  });

  const entitlement = accountQuery.data?.account?.entitlement ?? null;
  const serverCount = accountQuery.data?.account?.serverCount ?? 0;
  const alreadySubscribed = entitlement?.active === true;
  const trialAvailable = entitlement ? entitlement.trialAvailable : true;
  const normalizedSlug = normalizeSlugInput(slug);
  const slugValid = CONNECT_SLUG_PATTERN.test(normalizedSlug);
  const canSubmit = name.trim().length > 0 && slugValid && !enable.isPending;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!slugValid) {
      setSlugError("Use 3 to 32 lowercase letters, numbers, or hyphens.");
      return;
    }
    setSlugError(null);
    setFormError(null);
    enable.mutate({
      name: name.trim(),
      slug: normalizedSlug,
      allowHubSignIn,
      startTrial: !alreadySubscribed && trialAvailable,
    });
  };

  const setupNote = alreadySubscribed
    ? "Reach this server on music.aurral.org, mobile, desktop, and Subsonic without port forwarding."
    : "Reach this server on music.aurral.org, mobile, desktop, and Subsonic without port forwarding. $5/mo or $50/yr after a 14-day free trial.";

  const ctaLabel = alreadySubscribed
    ? "Enable Connect"
    : trialAvailable
      ? "Start 14-day trial"
      : "Enable Connect";

  return (
    <SettingsGroup title="Set up Connect" note={setupNote}>
      <form onSubmit={handleSubmit}>
        <SettingsRow
          label="Server name"
          htmlFor={`${formId}-name`}
          help="Shown in your server picker."
        >
          <SettingsInput
            id={`${formId}-name`}
            type="text"
            maxLength={64}
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingsRow>
        <SettingsRow
          label="Address prefix"
          htmlFor={`${formId}-slug`}
          help={
            slugError ??
            (normalizedSlug
              ? `Becomes https://${normalizedSlug}.${status.connectDomain}.`
              : "3 to 32 lowercase letters, numbers, or hyphens.")
          }
          tone={slugError ? "error" : "default"}
        >
          <SettingsInput
            id={`${formId}-slug`}
            type="text"
            maxLength={32}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
              if (slugError) setSlugError(null);
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Sign in with Aurral"
          htmlFor={`${formId}-hub-signin`}
          help="Let linked users sign in with their aurral.org account."
        >
          <PillToggle
            id={`${formId}-hub-signin`}
            checked={allowHubSignIn}
            aria-label="Sign in with Aurral"
            onChange={(event) => setAllowHubSignIn(event.target.checked)}
          />
        </SettingsRow>
        {formError ? (
          <SettingsNote tone="error">
            {formError}{" "}
            <a
              href={`${status.hubOrigin}/account`}
              target="_blank"
              rel="noopener noreferrer"
              className="settings-link"
            >
              Manage on aurral.org
            </a>
          </SettingsNote>
        ) : null}
        <SettingsActions>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!canSubmit}>
            {enable.isPending ? <DotLoader size="xs" label={null} /> : null}
            {enable.isPending ? "Enabling…" : ctaLabel}
          </button>
          <span className="settings-group__note">
            Linked as @{handle}
            {alreadySubscribed && entitlement
              ? `\u00A0·\u00A0${serverCount} of ${entitlement.maxServers} servers used`
              : ""}
          </span>
        </SettingsActions>
      </form>
    </SettingsGroup>
  );
}

function ActiveConnect({
  status,
  handle,
  onUpdated,
}: {
  status: ConnectStatus;
  handle: string | null;
  onUpdated: (next: ConnectStatus) => void;
}) {
  const formId = useId();
  const { showSuccess, showError } = useToast();
  const [slugDraft, setSlugDraft] = useState<string | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [confirmTurnOff, setConfirmTurnOff] = useState(false);

  const update = useMutation({
    mutationFn: (payload: { name?: string; slug?: string; allowHubSignIn?: boolean }) =>
      parseResponse(connectClient.$patch({ json: payload })),
    onSuccess: (next, variables) => {
      onUpdated(next);
      if (variables.slug !== undefined) {
        setPendingSlug(null);
        setSlugDraft(null);
        setSlugError(null);
        showSuccess("Connect address changed");
      } else if (variables.name !== undefined) {
        showSuccess("Server name saved");
      }
    },
    onError: (error, variables) => {
      const info = connectErrorInfo(error);
      if (variables.slug !== undefined) {
        setPendingSlug(null);
        setSlugError(info.message);
      } else {
        showError(info.message);
      }
    },
  });

  const reconnect = useMutation({
    mutationFn: () => parseResponse(connectClient.reconnect.$post()),
    onSuccess: (next) => {
      onUpdated(next);
      showSuccess("Reconnecting…");
    },
    onError: (error) => showError(connectErrorInfo(error).message),
  });

  const disable = useMutation({
    mutationFn: () => parseResponse(connectClient.disable.$post()),
    onSuccess: (next) => {
      setConfirmTurnOff(false);
      onUpdated(next);
      showSuccess("Connect turned off");
    },
    onError: (error) => showError(connectErrorInfo(error).message),
  });

  const currentSlug = status.slug ?? "";
  const currentHost = hostOfUrl(status.connectUrl, status.slug, status.connectDomain);
  const displayedSlug = slugDraft ?? currentSlug;
  const normalizedDraft = normalizeSlugInput(displayedSlug);
  const isEditingSlug = slugDraft !== null && normalizedDraft !== currentSlug;

  const commitSlugDraft = () => {
    if (slugDraft === null) return;
    const candidate = normalizeSlugInput(slugDraft);
    if (!candidate || candidate === currentSlug) {
      setSlugDraft(null);
      setSlugError(null);
      return;
    }
    if (!CONNECT_SLUG_PATTERN.test(candidate)) {
      setSlugError("Use 3 to 32 lowercase letters, numbers, or hyphens.");
      return;
    }
    setSlugError(null);
    setPendingSlug(candidate);
  };

  const billingUrl = `${status.hubOrigin}/account`;

  return (
    <>
      <SettingsGroup title="Connection">
        {status.state === "subscription_required" ? (
          <SettingsNote tone="warning">
            Renew on aurral.org to bring {currentHost} back online. Retries automatically.
          </SettingsNote>
        ) : null}
        {status.state === "replaced" ? (
          <SettingsNote tone="warning">
            Another copy of this server took over {currentHost}, likely from a restored backup.
            Remote access on this copy stopped.
          </SettingsNote>
        ) : null}
        {status.state === "error" ? (
          <SettingsNote tone="error">
            {status.lastError || "Couldn't reach aurral.org."} Trying again automatically.
          </SettingsNote>
        ) : null}

        {status.state === "online" ? (
          <SettingsRow
            label="Online"
            help={<LinkedBillingHelp handle={handle} hubOrigin={status.hubOrigin} />}
          >
            {!HOSTED ? (
              <a
                href={status.appOrigin}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary btn-sm"
              >
                Open {new URL(status.appOrigin).host}
                <ExternalLink aria-hidden="true" />
              </a>
            ) : null}
          </SettingsRow>
        ) : status.state === "connecting" ? (
          <SettingsRow
            label={
              <>
                <DotLoader size="xs" label={null} /> Connecting…
              </>
            }
            help={<LinkedBillingHelp handle={handle} hubOrigin={status.hubOrigin} />}
          />
        ) : status.state === "subscription_required" ? (
          <SettingsRow
            label="Subscription required"
            help={handle ? `Linked as @${handle}` : undefined}
          >
            <a
              href={billingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary btn-sm"
            >
              Manage billing
            </a>
          </SettingsRow>
        ) : status.state === "replaced" ? (
          <SettingsRow
            label="Disconnected"
            help={<LinkedBillingHelp handle={handle} hubOrigin={status.hubOrigin} />}
          >
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={reconnect.isPending}
              onClick={() => reconnect.mutate()}
            >
              {reconnect.isPending ? <DotLoader size="xs" label={null} /> : null}
              Reconnect here
            </button>
          </SettingsRow>
        ) : (
          <SettingsRow
            label="Offline"
            help={<LinkedBillingHelp handle={handle} hubOrigin={status.hubOrigin} />}
          />
        )}

        {status.connectUrl ? <ConnectAddressRow connectUrl={status.connectUrl} /> : null}
      </SettingsGroup>

      <SettingsGroup title="Server details">
        <SettingsRow
          label="Server name"
          htmlFor={`${formId}-name`}
          help="Shown in your server picker."
        >
          <SettingsCommitInput
            id={`${formId}-name`}
            type="text"
            maxLength={64}
            autoComplete="off"
            value={status.name ?? ""}
            disabled={update.isPending}
            onCommit={(nextName) => {
              const trimmed = nextName.trim();
              if (trimmed && trimmed !== status.name) update.mutate({ name: trimmed });
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Address prefix"
          htmlFor={`${formId}-slug`}
          help={
            slugError ??
            (isEditingSlug && normalizedDraft
              ? `Becomes https://${normalizedDraft}.${status.connectDomain}.`
              : "Used by Subsonic apps and listen links.")
          }
          tone={slugError ? "error" : "default"}
        >
          <SettingsInput
            id={`${formId}-slug`}
            type="text"
            maxLength={32}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={displayedSlug}
            disabled={update.isPending}
            onChange={(event) => {
              setSlugDraft(event.target.value);
              if (slugError) setSlugError(null);
            }}
            onBlur={commitSlugDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitSlugDraft();
              } else if (event.key === "Escape") {
                setSlugDraft(null);
                setSlugError(null);
              }
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Sign in with Aurral"
          htmlFor={`${formId}-hub-signin`}
          help={
            status.allowHubSignIn
              ? "Let linked users sign in with their aurral.org account."
              : "Off. Users sign in with their username and password."
          }
        >
          <PillToggle
            id={`${formId}-hub-signin`}
            checked={
              update.isPending && update.variables.allowHubSignIn !== undefined
                ? update.variables.allowHubSignIn
                : status.allowHubSignIn
            }
            disabled={update.isPending}
            aria-label="Sign in with Aurral"
            onChange={(event) => update.mutate({ allowHubSignIn: event.target.checked })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label="Turn off Connect"
          help="Remote access stops. Access on your local network keeps working."
        >
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => setConfirmTurnOff(true)}
          >
            Turn off
          </button>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmModal
        open={pendingSlug !== null}
        title="Change Connect address?"
        body={`Move to ${pendingSlug ?? ""}.${status.connectDomain}. Subsonic apps and listen links using ${currentHost} stop working, and the old address stays reserved for 90 days.`}
        confirmLabel="Change address"
        busyLabel="Changing…"
        busy={update.isPending}
        onCancel={() => {
          setPendingSlug(null);
          setSlugDraft(null);
          setSlugError(null);
        }}
        onConfirm={() => {
          if (pendingSlug) update.mutate({ slug: pendingSlug });
        }}
      />

      <ConfirmModal
        open={confirmTurnOff}
        title="Turn off Connect?"
        body={`Remote access at ${currentHost} stops. Local access keeps working. Your subscription stays active on aurral.org until you cancel it there.`}
        confirmLabel="Turn off"
        busyLabel="Turning off…"
        tone="danger"
        busy={disable.isPending}
        onCancel={() => setConfirmTurnOff(false)}
        onConfirm={() => disable.mutate()}
      />
    </>
  );
}

export function ConnectSection() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const hubLink = useHubLink();
  const statusQuery = useQuery({
    queryKey: queryKeys.connectStatus,
    queryFn: ({ signal }) => parseResponse(connectClient.$get({}, { init: { signal } })),
    refetchInterval: (query) =>
      query.state.data?.enabled && RETRYING_STATES.has(query.state.data.state)
        ? STATUS_POLL_MS
        : false,
  });

  const setStatus = (next: ConnectStatus) => {
    queryClient.setQueryData(queryKeys.connectStatus, next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.connectAccount(user?.id) });
  };

  const status = statusQuery.data;
  const linkedHandle = hubLink.data?.state === "linked" ? hubLink.data.handle : null;

  return (
    <SettingsPage title="Connect">
      {statusQuery.isPending ? (
        <SettingsGroup>
          <p className="settings-loading">
            <DotLoader size="sm" label={null} /> Loading Connect…
          </p>
        </SettingsGroup>
      ) : statusQuery.isError || !status ? (
        <SettingsGroup>
          <SettingsNote tone="error">
            Couldn&apos;t load Connect status.{" "}
            <button type="button" className="settings-link" onClick={() => statusQuery.refetch()}>
              Try again
            </button>
          </SettingsNote>
        </SettingsGroup>
      ) : status.enabled ? (
        <ActiveConnect status={status} handle={linkedHandle} onUpdated={setStatus} />
      ) : !status.available ? (
        <SettingsGroup>
          <SettingsNote>
            aurral.org accounts are off on this server.{" "}
            <SettingsLink to="users" className="settings-link">
              Turn them on in Users
            </SettingsLink>
            .
          </SettingsNote>
        </SettingsGroup>
      ) : hubLink.isPending ? (
        <SettingsGroup>
          <p className="settings-loading">
            <DotLoader size="sm" label={null} /> Checking aurral.org link…
          </p>
        </SettingsGroup>
      ) : !linkedHandle ? (
        <SettingsGroup title="Set up Connect">
          <SettingsRow label="Link your aurral.org account" help="Required to set up Connect.">
            <SettingsLink to="profile" className="btn btn-primary btn-sm">
              Open Profile
            </SettingsLink>
          </SettingsRow>
        </SettingsGroup>
      ) : (
        <SetupConnect
          status={status}
          handle={linkedHandle}
          userId={user?.id}
          onEnabled={setStatus}
        />
      )}
    </SettingsPage>
  );
}
