import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../contexts/AuthContext";
import { ModalShell } from "./PlaylistModals";
import { ConfirmModal } from "./ConfirmModal";
import { DotLoader } from "./DotLoader";
import { createAppPassword, getAppPasswords, revokeAppPassword } from "../utils/api/endpoints/auth.js";
import { isReauthRequiredError, promptReauth } from "../utils/reauth.js";
import { getAppBasePath } from "../utils/basePath.js";
import "./AppPasswordsModal.css";

const errorMessage = (error) => error.response?.data?.error || error.message || "Request failed. Try again.";
const formatDate = (value) => value ? new Date(value).toLocaleString() : "Never";
const browserServerUrl = () => `${window.location.origin}${getAppBasePath().replace(/\/$/, "")}`;

export default function AppPasswordsModal({ onClose }) {
  const { user } = useAuth();
  const nameRef = useRef(null);
  const [devices, setDevices] = useState([]);
  const [allUsers, setAllUsers] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [server, setServer] = useState(browserServerUrl);
  const serverEdited = useRef(false);
  const [created, setCreated] = useState(null);
  const [qrCode, setQrCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    getAppPasswords(allUsers)
      .then((result) => {
        if (!active) return;
        setDevices(result.devices);
        if (result.serverUrl && !serverEdited.current) setServer(result.serverUrl);
      })
      .catch((requestError) => { if (active) setLoadError(`Could not load devices. ${errorMessage(requestError)}`); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [allUsers, reload]);

  useEffect(() => {
    if (!created) return undefined;
    let active = true;
    const parameters = new URLSearchParams({ server: created.server, user: user.username, token: created.secret });
    import("qrcode-generator")
      .then(({ default: qrcode }) => {
        const code = qrcode(0, "M");
        code.addData(`aurral://connect?${parameters}`);
        code.make();
        return code.createDataURL(4, 16);
      })
      .then((result) => { if (active) setQrCode(result); })
      .catch(() => {
        if (!active) return;
        setQrCode(null);
        setError("The app password was created, but the QR code failed. Copy the password below.");
      });
    return () => { active = false; };
  }, [created, user.username]);

  const connect = async (event) => {
    event.preventDefault();
    let serverUrl;
    try {
      const parsed = new URL(server.trim());
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
      serverUrl = parsed.toString().replace(/\/$/, "");
    } catch {
      setError("Enter the HTTP or HTTPS server address your app can reach.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let result;
      try {
        result = await createAppPassword(name.trim());
      } catch (requestError) {
        if (!isReauthRequiredError(requestError)) throw requestError;
        if (!await promptReauth()) return;
        result = await createAppPassword(name.trim());
      }
      setCreated({ ...result, server: serverUrl });
      setReload((value) => value + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(created.secret);
      setCopied(true);
    } catch {
      setError("Could not copy the password. Select and copy it below.");
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError("");
    try {
      await revokeAppPassword(revokeTarget.id);
      setDevices((current) => current.filter((device) => device.id !== revokeTarget.id));
      if (created?.device.id === revokeTarget.id) setCreated(null);
      setRevokeTarget(null);
    } catch (requestError) {
      setError(errorMessage(requestError));
      setRevokeTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <ModalShell open initialFocusRef={nameRef} title="Connect an app" description="Give each app its own password. Revoke a device here when it no longer needs access." onClose={onClose} disableClose={busy} footer={<button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>Done</button>}>
        {error ? <p className="app-passwords__error" role="alert">{error}</p> : null}
        {created ? (
          <div className="app-passwords__secret">
            <p role="status">App password created for {created.device.name}. This password appears only once.</p>
            {qrCode ? <img src={qrCode} alt="Scan this QR code in the Aurral app to sign in" className="app-passwords__qr" /> : qrCode === "" ? <DotLoader label="Creating QR code" /> : null}
            <label className="artist-field-label" htmlFor="app-password-secret">App password</label>
            <input id="app-password-secret" className="artist-input" readOnly value={created.secret} autoComplete="off" />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyPassword()}>{copied ? "Copied" : "Copy password"}</button>
            <p className="app-passwords__meta">Server: {created.server}<br />Username: {user.username}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setCreated(null); setQrCode(""); setCopied(false); setName(""); }}>Connect another app</button>
          </div>
        ) : (
          <form className="app-passwords__form" onSubmit={(event) => void connect(event)}>
            <label className="artist-field-label" htmlFor="app-device-name">Device name</label>
            <input ref={nameRef} id="app-device-name" className="artist-input" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="For example, iPhone" disabled={busy} />
            <label className="artist-field-label" htmlFor="app-server-url">Server address</label>
            <input id="app-server-url" className="artist-input" required type="url" value={server} onChange={(event) => { serverEdited.current = true; setServer(event.target.value); }} disabled={busy} />
            <p className="app-passwords__meta">Use the address your phone or desktop app can reach.</p>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>{busy ? <DotLoader size="sm" label={null} /> : null}Create app password</button>
          </form>
        )}
        <section className="app-passwords__devices" aria-label="Connected devices">
          <h4>Connected devices</h4>
          {user.role === "admin" ? <label className="app-passwords__all"><input type="checkbox" checked={allUsers} onChange={(event) => setAllUsers(event.target.checked)} />Show all users&apos; devices</label> : null}
          {loading ? <DotLoader label="Loading devices" /> : loadError ? (
            <div className="app-passwords__load-error">
              <p className="app-passwords__error" role="alert">{loadError}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReload((value) => value + 1)}>Retry</button>
            </div>
          ) : devices.length === 0 ? <p className="app-passwords__meta">No connected devices.</p> : <ul className="app-passwords__list">{devices.map((device) => (
            <li key={device.id} className="app-passwords__device">
              <div><strong>{device.name}</strong>{allUsers ? <span className="app-passwords__meta"> · {device.username}</span> : null}<p className="app-passwords__meta">Created {formatDate(device.createdAt)}<br />Last used {formatDate(device.lastUsedAt)}</p></div>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRevokeTarget(device)} aria-label={`Revoke ${device.name}`}>Revoke</button>
            </li>
          ))}</ul>}
        </section>
      </ModalShell>
      <ConfirmModal open={Boolean(revokeTarget)} title={`Revoke ${revokeTarget?.name || "device"}?`} body="This app will lose access immediately. Connect it again to use a new password." confirmLabel="Revoke device" busyLabel="Revoking" busy={busy} onCancel={() => setRevokeTarget(null)} onConfirm={() => void revoke()} />
    </>,
    document.body,
  );
}
