import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/opsz.css";
import "../index.css";
import { isRecord } from "../../../lib/isRecord.ts";
import { DotLoader } from "../components/DotLoader";
import { ChevronRight } from "../components/icons";
import { useSiteLogo } from "../hooks/useSiteLogo.ts";
import { initializeTheme } from "../utils/theme.ts";
import { hostOf, normalizeAddress, saveServer } from "../utils/server.ts";
import { checkServer } from "./checkServer.ts";
import {
  completeConnectCallback,
  exchangeServerSession,
  fetchConnectServers,
  readConnectSession,
  setHostedLoginNotice,
  signOutConnect,
  startConnectSignIn,
  type ConnectDiscoveredServer,
  type ConnectSession,
} from "./connectAuth.ts";

export type HostedScreen =
  | { kind: "connect"; initialError?: string }
  | { kind: "connectCallback"; code: string; state: string }
  | { kind: "pair"; code: string; address: string }
  | { kind: "unreachable"; address: string; name?: string; isConnect?: boolean }
  | { kind: "ownAddress"; address: string; setup: boolean }
  | { kind: "unsupported"; address: string; version: string };

const HTTPS_DOCS = "https://docs.aurral.org/using/music-aurral-org/";

const continueAfterConnecting = () => {
  const { pathname } = window.location;
  if (pathname === "/connect" || pathname === "/connect/callback" || pathname === "/pair") {
    window.location.assign("/");
  } else {
    window.location.reload();
  }
};

const useAnotherServer = () => window.location.assign("/connect");

function Card({
  title,
  subtitle,
  address,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  address?: string;
  children: ReactNode;
}) {
  const logo = useSiteLogo();
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-header">
          <img src={logo.src} alt="Aurral" className={`login-logo${logo.className}`} />
          <h1 className="login-title">{title}</h1>
          {address ? <p className="hosted-address">{address}</p> : null}
          {subtitle ? <p className="login-subtitle">{subtitle}</p> : null}
        </div>
        <div className="login-form">{children}</div>
      </div>
    </main>
  );
}

function UnreachableCauses({ isConnect }: { isConnect?: boolean }) {
  if (isConnect) {
    return (
      <ul className="hosted-list">
        <li>The server is off or asleep</li>
        <li>Its internet connection dropped</li>
      </ul>
    );
  }
  return (
    <ul className="hosted-list">
      <li>The server is off, or this device can&apos;t reach it</li>
      <li>Chrome asked to access devices on your network, and it wasn&apos;t allowed</li>
      <li>The server runs a version of Aurral from before music.aurral.org</li>
      <li>A sign-in proxy like Authelia or Authentik sits in front of it</li>
    </ul>
  );
}

function UnreachableCard({
  address,
  name,
  isConnect,
  onRetry,
  onUseAnother,
}: {
  address: string;
  name?: string;
  isConnect?: boolean;
  onRetry: () => void;
  onUseAnother: () => void;
}) {
  const host = hostOf(address);
  return (
    <Card title={`Couldn't reach ${name || host}`} address={name ? host : undefined}>
      <UnreachableCauses isConnect={isConnect} />
      <div className="hosted-actions">
        <button type="button" className="btn btn-primary btn--full login-submit" onClick={onRetry}>
          Try again
        </button>
        <button
          type="button"
          className="btn btn-secondary btn--full login-submit"
          onClick={onUseAnother}
        >
          Use another server
        </button>
      </div>
    </Card>
  );
}

function ConnectPicker({
  session,
  autoConnectSingle,
  onManualEntry,
  onSignedOut,
}: {
  session: ConnectSession;
  autoConnectSingle: boolean;
  onManualEntry: () => void;
  onSignedOut: (message?: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [handle, setHandle] = useState<string | null>(session.handle);
  const [servers, setServers] = useState<ConnectDiscoveredServer[]>([]);
  const [connecting, setConnecting] = useState<ConnectDiscoveredServer | null>(null);
  const [offlineServer, setOfflineServer] = useState<ConnectDiscoveredServer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  const openServer = useCallback(
    async (server: ConnectDiscoveredServer) => {
      const current = ++attempt.current;
      setError(null);
      setOfflineServer(null);
      setConnecting(server);
      const result = await exchangeServerSession(session.token, server);
      if (current !== attempt.current) return;
      if (result.ok) {
        saveServer({
          address: server.connectUrl,
          token: result.sessionToken,
          username: result.username,
          name: server.name,
        });
        continueAfterConnecting();
        return;
      }
      setConnecting(null);
      if (result.reason === "unauthorized") {
        onSignedOut("Your aurral.org sign-in expired. Sign in again.");
        return;
      }
      if (result.reason === "offline") {
        setOfflineServer(server);
        return;
      }
      if (result.reason === "sign_in_off" || result.reason === "account_not_linked") {
        const notice =
          result.reason === "sign_in_off"
            ? `Sign in with Aurral is off on ${server.name}. Use your username and password.`
            : `Your aurral.org account isn't linked to a user on ${server.name}. Sign in with your username and password.`;
        setHostedLoginNotice(server.connectUrl, notice);
        saveServer({ address: server.connectUrl, token: "", username: "", name: server.name });
        continueAfterConnecting();
        return;
      }
      if (result.reason === "ambiguous_link") {
        setHostedLoginNotice(
          server.connectUrl,
          `Multiple local accounts on ${server.name} share this aurral.org account. Sign in with your username and password.`,
        );
        saveServer({ address: server.connectUrl, token: "", username: "", name: server.name });
        continueAfterConnecting();
        return;
      }
      if (result.reason === "rate_limited") {
        setError("Too many attempts. Wait a minute, then try again.");
        return;
      }
      if (result.reason === "subscription_required") {
        setError(`Aurral Connect isn't active on ${server.name}.`);
        return;
      }
      setError(`Couldn't sign in to ${server.name}. Try again.`);
    },
    [onSignedOut, session.token],
  );

  const loadServers = useCallback(
    async (allowAuto: boolean) => {
      setLoading(true);
      setLoadFailed(false);
      setError(null);
      setOfflineServer(null);
      const result = await fetchConnectServers(session.token);
      if (!result.ok) {
        setLoading(false);
        if (result.reason === "unauthorized") {
          onSignedOut("Your aurral.org sign-in expired. Sign in again.");
          return;
        }
        setLoadFailed(true);
        return;
      }
      setHandle(result.data.account.handle);
      setServers(result.data.servers);
      setLoading(false);
      if (allowAuto && result.data.servers.length === 1 && result.data.servers[0]?.online) {
        void openServer(result.data.servers[0]);
      }
    },
    [onSignedOut, openServer, session.token],
  );

  useEffect(() => {
    void loadServers(autoConnectSingle);
  }, [autoConnectSingle, loadServers]);

  const handleSignOut = async () => {
    await signOutConnect();
    onSignedOut();
  };

  const footer = (
    <p className="hosted-footer">
      {handle ? `Signed in as @${handle}\u00A0·\u00A0` : null}
      <button type="button" className="hosted-footer__action" onClick={() => void handleSignOut()}>
        Sign out
      </button>
    </p>
  );

  if (connecting) {
    return (
      <Card title={`Connecting to ${connecting.name}…`} address={hostOf(connecting.connectUrl)}>
        <div className="hosted-actions">
          <button type="button" className="btn btn-primary btn--full login-submit" disabled>
            <DotLoader size="sm" label={null} />
            Connecting…
          </button>
          <button
            type="button"
            className="btn btn-secondary btn--full login-submit"
            onClick={() => {
              attempt.current += 1;
              setConnecting(null);
            }}
          >
            Choose another server
          </button>
        </div>
      </Card>
    );
  }

  if (offlineServer) {
    return (
      <UnreachableCard
        address={offlineServer.connectUrl}
        name={offlineServer.name}
        isConnect
        onRetry={() => void openServer(offlineServer)}
        onUseAnother={() => setOfflineServer(null)}
      />
    );
  }

  if (loading) {
    return (
      <Card title="Choose a server">
        <button type="button" className="btn btn-primary btn--full login-submit" disabled>
          <DotLoader size="sm" label={null} />
          Loading servers…
        </button>
      </Card>
    );
  }

  if (loadFailed) {
    return (
      <Card title="Couldn't load your servers">
        <p className="login-error" role="alert">
          Couldn&apos;t reach aurral.org. Check your connection and try again.
        </p>
        <div className="hosted-actions">
          <button
            type="button"
            className="btn btn-primary btn--full login-submit"
            onClick={() => void loadServers(false)}
          >
            Try again
          </button>
          <button
            type="button"
            className="btn btn-secondary btn--full login-submit"
            onClick={onManualEntry}
          >
            Connect by address
          </button>
        </div>
        {footer}
      </Card>
    );
  }

  if (servers.length === 0) {
    return (
      <Card
        title={handle ? `No servers on @${handle}` : "No Connect servers"}
        subtitle="Turn on Connect in Settings on your server, or enter its HTTPS address."
      >
        <div className="hosted-actions">
          <button
            type="button"
            className="btn btn-primary btn--full login-submit"
            onClick={() => void loadServers(true)}
          >
            Check again
          </button>
          <button
            type="button"
            className="btn btn-secondary btn--full login-submit"
            onClick={onManualEntry}
          >
            Connect by address
          </button>
        </div>
        {footer}
      </Card>
    );
  }

  return (
    <Card title="Choose a server">
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="hosted-server-list">
        {servers.map((server) => (
          <button
            key={server.instanceId}
            type="button"
            className="hosted-server-row"
            onClick={() => void openServer(server)}
          >
            <span className="hosted-server-row__main">
              <span
                className={`hosted-server-row__name${server.online ? "" : " hosted-server-row__name--offline"}`}
              >
                {server.name}
              </span>
              <span className="hosted-server-row__host">{hostOf(server.connectUrl)}</span>
            </span>
            <span className="hosted-server-row__meta">
              {!server.online ? <span>Offline</span> : null}
              <ChevronRight aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
      <div className="hosted-actions">
        <button
          type="button"
          className="btn btn-secondary btn--full login-submit"
          onClick={onManualEntry}
        >
          Connect by address
        </button>
      </div>
      {footer}
    </Card>
  );
}

function Connect({
  initialError,
  initialSession,
  autoConnectSingle = false,
}: {
  initialError?: string;
  initialSession?: ConnectSession | null;
  autoConnectSingle?: boolean;
}) {
  const [session, setSession] = useState<ConnectSession | null>(
    () => initialSession ?? readConnectSession(),
  );
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState("");
  const [failed, setFailed] = useState<string | null>(initialError ?? null);
  const [checking, setChecking] = useState(false);
  const [startingSignIn, setStartingSignIn] = useState(false);

  if (session && !manual) {
    return (
      <ConnectPicker
        session={session}
        autoConnectSingle={autoConnectSingle}
        onManualEntry={() => setManual(true)}
        onSignedOut={(message) => {
          setSession(null);
          setManual(false);
          if (message) setFailed(message);
        }}
      />
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeAddress(address);
    if (!normalized) return setFailed("Enter your server's HTTPS address.");
    setFailed(null);
    setChecking(true);
    const server = await checkServer(normalized).catch(() => null);
    setChecking(false);
    if (!server) return setFailed(`Couldn't reach ${hostOf(normalized)}.`);
    saveServer({ address: normalized, token: "", username: "" });
    continueAfterConnecting();
  };

  const handleSignIn = () => {
    if (startingSignIn) return;
    setStartingSignIn(true);
    setFailed(null);
    void startConnectSignIn().catch(() => {
      setStartingSignIn(false);
      setFailed("Couldn't start aurral.org sign-in. Try again.");
    });
  };

  return (
    <Card title="Connect your Aurral">
      {session ? (
        <button
          type="button"
          className="btn btn-primary btn--full login-submit"
          onClick={() => setManual(false)}
        >
          Choose from your servers
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn--full login-submit"
          disabled={startingSignIn}
          onClick={handleSignIn}
        >
          {startingSignIn ? <DotLoader size="sm" label={null} /> : null}
          {startingSignIn ? "Opening aurral.org…" : "Sign in with Aurral"}
        </button>
      )}
      <div className="login-divider">
        <span>or</span>
      </div>
      <form className="login-form" onSubmit={submit}>
        <div className="login-field">
          <label htmlFor="server-address" className="sr-only">
            Server address
          </label>
          <input
            id="server-address"
            type="text"
            inputMode="url"
            autoComplete="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="login-input"
            placeholder="https://music.example.com"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        {failed ? (
          <div className="login-error" role="alert">
            {failed}
            {failed.startsWith("Couldn't reach") ? <UnreachableCauses /> : null}
          </div>
        ) : null}
        <button
          type="submit"
          className="btn btn-secondary btn--full login-submit"
          disabled={checking}
        >
          {checking ? <DotLoader size="sm" label={null} /> : null}
          Continue
        </button>
      </form>
      <p className="login-subtitle">
        Needs an HTTPS address.{" "}
        <a href={HTTPS_DOCS} target="_blank" rel="noopener noreferrer" className="hosted-link">
          How to get one
        </a>
        . On an HTTPS server, you can also open Settings, Profile, Devices and choose Open next to
        music.aurral.org.
      </p>
    </Card>
  );
}

function ConnectCallback({ code, state }: { code: string; state: string }) {
  const [result, setResult] = useState<
    { kind: "pending" } | { kind: "ready"; session: ConnectSession } | { kind: "error" }
  >({ kind: "pending" });

  useEffect(() => {
    let active = true;
    void completeConnectCallback(code, state).then((outcome) => {
      if (!active) return;
      if (outcome.ok) setResult({ kind: "ready", session: outcome.session });
      else setResult({ kind: "error" });
    });
    return () => {
      active = false;
    };
  }, [code, state]);

  if (result.kind === "ready") {
    return <Connect initialSession={result.session} autoConnectSingle />;
  }
  if (result.kind === "error") {
    return <Connect initialError="Couldn't sign in. Try again." />;
  }
  return (
    <Card title="Signing in…">
      <button type="button" className="btn btn-primary btn--full login-submit" disabled>
        <DotLoader size="sm" label={null} />
        Signing in…
      </button>
    </Card>
  );
}

const pairError = (status: number | null) =>
  status === 401
    ? "This code has expired or was already used. Get a new one in Settings on your server."
    : status === 429
      ? "Too many attempts. Wait a few minutes, then try again."
      : status === null
        ? "Couldn't reach this server."
        : "Something went wrong. Try again.";

function Pair({ code, address }: { code: string; address: string }) {
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    setAdding(true);
    const response = await fetch(`${address}/api/auth/pair`, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const body: unknown = response?.ok ? await response.json().catch(() => null) : null;
    const user = isRecord(body) && isRecord(body.user) ? body.user : null;
    if (!isRecord(body) || typeof body.token !== "string" || typeof user?.username !== "string") {
      setAdding(false);
      return setError(pairError(response?.status ?? null));
    }
    saveServer({ address, token: body.token, username: user.username });
    continueAfterConnecting();
  };

  return (
    <Card title="Add this server?">
      <p className="hosted-address">{address}</p>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="hosted-actions">
        <button
          type="button"
          className="btn btn-primary btn--full login-submit"
          onClick={add}
          disabled={adding}
        >
          {adding ? <DotLoader size="sm" label={null} /> : null}
          Add server
        </button>
        <button
          type="button"
          className="btn btn-secondary btn--full login-submit"
          onClick={() => window.location.assign("/")}
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}

function OpenOwnAddress({ address }: { address: string }) {
  return (
    <div className="hosted-actions">
      <a href={address} className="btn btn-primary btn--full login-submit">
        Open {hostOf(address)}
      </a>
      <button
        type="button"
        className="btn btn-secondary btn--full login-submit"
        onClick={useAnotherServer}
      >
        Use another server
      </button>
    </div>
  );
}

function Screen({ screen }: { screen: HostedScreen }) {
  switch (screen.kind) {
    case "connect":
      return <Connect initialError={screen.initialError} />;
    case "connectCallback":
      return <ConnectCallback code={screen.code} state={screen.state} />;
    case "pair":
      return <Pair code={screen.code} address={screen.address} />;
    case "unreachable":
      return (
        <UnreachableCard
          address={screen.address}
          name={screen.name}
          isConnect={screen.isConnect}
          onRetry={() => window.location.reload()}
          onUseAnother={useAnotherServer}
        />
      );
    case "ownAddress":
      return (
        <Card
          title={
            screen.setup
              ? `Finish setting up ${hostOf(screen.address)}`
              : `${hostOf(screen.address)} has sign-in turned off`
          }
        >
          <p className="login-subtitle">
            {screen.setup
              ? "Create the first account at your server's own address, then come back."
              : "A server without sign-in can only be used at its own address."}
          </p>
          <OpenOwnAddress address={screen.address} />
        </Card>
      );
    case "unsupported":
      return (
        <Card title={`${hostOf(screen.address)} can't open here`}>
          <p className="login-subtitle">
            It runs Aurral {screen.version}, which music.aurral.org doesn&apos;t support. Update the
            server, or open it at its own address.
          </p>
          <OpenOwnAddress address={screen.address} />
        </Card>
      );
  }
}

export const mountScreen = (screen: HostedScreen) => {
  initializeTheme();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Screen screen={screen} />
    </StrictMode>,
  );
};
