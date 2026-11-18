import { StrictMode, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/opsz.css";
import "../index.css";
import { isRecord } from "../../../lib/isRecord.ts";
import { DotLoader } from "../components/DotLoader";
import { useSiteLogo } from "../hooks/useSiteLogo.ts";
import { initializeTheme } from "../utils/theme.ts";
import { hostOf, normalizeAddress, saveServer } from "../utils/server.ts";
import { checkServer } from "./checkServer.ts";

export type HostedScreen =
  | { kind: "connect" }
  | { kind: "pair"; code: string; address: string }
  | { kind: "unreachable"; address: string }
  | { kind: "ownAddress"; address: string; setup: boolean }
  | { kind: "unsupported"; address: string; version: string };

const HTTPS_DOCS = "https://docs.aurral.org/using/music-aurral-org/";

const continueAfterConnecting = () => {
  const { pathname } = window.location;
  if (pathname === "/connect" || pathname === "/pair") window.location.assign("/");
  else window.location.reload();
};

const useAnotherServer = () => window.location.assign("/connect");

function Card({ title, children }: { title: string; children: ReactNode }) {
  const logo = useSiteLogo();
  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-header">
          <img src={logo.src} alt="Aurral" className={`login-logo${logo.className}`} />
          <h1 className="login-title">{title}</h1>
        </div>
        <div className="login-form">{children}</div>
      </div>
    </main>
  );
}

function UnreachableCauses() {
  return (
    <ul className="hosted-list">
      <li>The server is off, or this device can&apos;t reach it</li>
      <li>Chrome asked to access devices on your network, and it wasn&apos;t allowed</li>
      <li>The server runs a version of Aurral from before music.aurral.org</li>
      <li>A sign-in proxy like Authelia or Authentik sits in front of it</li>
    </ul>
  );
}

function Connect() {
  const [address, setAddress] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeAddress(address);
    if (!normalized) return setFailed("Enter your server's HTTPS address.");
    setChecking(true);
    const server = await checkServer(normalized).catch(() => null);
    setChecking(false);
    if (!server) return setFailed(`Couldn't reach ${hostOf(normalized)}.`);
    saveServer({ address: normalized, token: "", username: "" });
    continueAfterConnecting();
  };

  return (
    <Card title="Connect your Aurral">
      <ol className="hosted-list hosted-list--steps">
        <li>Open Aurral on your server</li>
        <li>Go to Settings, Profile</li>
        <li>Choose Open on music.aurral.org</li>
      </ol>
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
            {failed.startsWith("Couldn't") ? <UnreachableCauses /> : null}
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
      </p>
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
      return <Connect />;
    case "pair":
      return <Pair code={screen.code} address={screen.address} />;
    case "unreachable":
      return (
        <Card title={`Couldn't reach ${hostOf(screen.address)}`}>
          <UnreachableCauses />
          <div className="hosted-actions">
            <button
              type="button"
              className="btn btn-primary btn--full login-submit"
              onClick={() => window.location.reload()}
            >
              Try again
            </button>
            <button
              type="button"
              className="btn btn-secondary btn--full login-submit"
              onClick={useAnotherServer}
            >
              Use another server
            </button>
          </div>
        </Card>
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
