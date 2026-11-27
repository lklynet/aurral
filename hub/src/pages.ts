import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import {
  hasManagedPolarSubscription,
  type ConnectBillingSummary,
  type OwnedConnectServer,
} from "./connect.ts";
import type { HandleClaim } from "./handles.ts";
import { formatCode } from "./links.ts";

type Page = HtmlEscapedString | Promise<HtmlEscapedString>;

export const STYLE = `:root{color-scheme:dark;--text:#fff;--muted:#b4b4b4;--field:#151515;--danger:#f87171;--warn:#fbbf24}
*{box-sizing:border-box}
body{margin:0;background:#000;color:var(--text);font:400 14px/1.5 ui-sans-serif,system-ui,-apple-system,blinkmacsystemfont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.top{max-width:420px;margin:auto;padding:16px 20px 0;font-size:17px;font-weight:600;letter-spacing:-.01em}
.top a{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:10px}
main{max-width:340px;margin:auto;padding:40px 20px;display:grid;gap:14px}
h1{margin:0;font-size:24px;letter-spacing:-.4px}
h2{margin:12px 0 0;font-size:15px}
p{margin:0}
.muted{color:var(--muted);font-size:13px}
.error{color:var(--danger);font-size:13px}
.warn{color:var(--warn);font-size:13px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.plans{display:grid;gap:8px}
.button{display:block;width:100%;border:0;border-radius:6px;padding:11px;font:inherit;font-weight:600;line-height:1.2;text-align:center;text-decoration:none;cursor:pointer;background:var(--field);color:var(--text)}
.primary{background:var(--text);color:#000}
.danger{color:var(--danger)}
.link{background:none;padding-left:0;text-align:left;width:auto}
input{width:100%;border:0;border-radius:6px;padding:11px 12px;background:var(--field);color:var(--text);font:inherit;font-size:16px}
form{display:grid;gap:10px;margin:0}
a{color:inherit}
ul{margin:0;padding-left:18px;display:grid;gap:6px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.row a{text-decoration:none;font-weight:600;flex-shrink:0}
:focus-visible{outline:2px solid var(--text);outline-offset:3px}`;

const layout = (title: string, body: Page) =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Aurral</title>
        <link rel="stylesheet" href="/account/style.css" />
      </head>
      <body>
        <div class="top">
          <a href="/"><img src="/favicon.svg" width="27" height="20" alt="" />Aurral</a>
        </div>
        <main>${body}</main>
      </body>
    </html>`;

const LEGAL = html`<p class="muted">
  From GitHub or Discord we keep only your account ID. <a href="/privacy">Privacy</a> ·
  <a href="/terms">Terms</a>
</p>`;

const codeField = (code: string | null) =>
  code ? html`<input type="hidden" name="code" value="${code}" />` : "";

const nextField = (next: string | null) =>
  next ? html`<input type="hidden" name="next" value="${next}" />` : "";

const querySuffix = (code: string | null, next: string | null) => {
  const params = new URLSearchParams();
  if (code) params.set("code", code);
  if (next) params.set("next", next);
  return params.size ? `?${params}` : "";
};

const signOut = (code: string | null, label = "Sign out", next: string | null = null) =>
  html`<form method="post" action="/account/sign-out">
    ${codeField(code)} ${nextField(next)}
    <button class="button">${label}</button>
  </form>`;

const leave = (code: string | null, next: string | null = null) =>
  html`${signOut(code, "Sign out", next)}
    <a class="button danger link" href="/account/delete">Delete account</a>`;

const shortDate = (time: number) =>
  new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export const signInPage = (
  providers: { id: string; label: string }[],
  failed: boolean,
  code: string | null,
  next: string | null = null,
) =>
  layout(
    "Sign in",
    html`<h1>Sign in to aurral.org</h1>
      <p class="muted">
        ${
          next
            ? "Sign in to connect to your Aurral server."
            : code
              ? "Sign in to link your Aurral."
              : "To link your Aurral and publish playlists."
        }
      </p>
      ${failed ? html`<p class="error" role="alert">Sign-in didn't finish. Try again.</p>` : ""}
      ${providers.map(
        ({ id, label }) =>
          html`<a class="button" href="/account/sign-in/${id}${querySuffix(code, next)}"
            >Continue with ${label}</a
          >`,
      )}
      ${LEGAL}`,
  );

const HANDLE_ERRORS: Record<Exclude<HandleClaim, "claimed">, string> = {
  invalid: "Use 3 to 20 lowercase letters, numbers, or underscores.",
  reserved: "That handle is reserved.",
  not_allowed: "That handle isn't allowed.",
  taken: "That handle is taken.",
};

export const handlePage = (
  value: string,
  problem: Exclude<HandleClaim, "claimed"> | null,
  code: string | null,
  next: string | null = null,
) =>
  layout(
    "Pick a handle",
    html`<h1>Pick a handle</h1>
      <p class="muted">
        Shown on playlists you publish. 3 to 20 lowercase letters, numbers, or underscores.
      </p>
      <form method="post" action="/account/handle">
        ${codeField(code)} ${nextField(next)}
        <input
          name="handle"
          value="${value}"
          aria-label="Handle"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          maxlength="21"
          required
        />
        ${problem ? html`<p class="error" role="alert">${HANDLE_ERRORS[problem]}</p>` : ""}
        <button class="button primary">Continue</button>
      </form>
      ${leave(code, next)}`,
  );

type LinkRow = { id: string; user_name: string; linked_at: number; public_count: number };

export type AccountBillingError = "unconfigured" | "checkout" | "portal";

export type AccountConnectView = {
  entitlement: ConnectBillingSummary;
  servers: OwnedConnectServer[];
  connectDomain: string;
  hasMonthlyPlan: boolean;
  hasYearlyPlan: boolean;
  portalConfigured: boolean;
  emailPortalUrl: string | null;
  checkoutSuccess: boolean;
  serverDisabled: boolean;
  billingError: AccountBillingError | null;
};

const BILLING_ERRORS: Record<AccountBillingError, string> = {
  unconfigured: "Billing isn't enabled on this hub yet.",
  checkout: "Couldn't start checkout right now. Try again in a moment.",
  portal: "Couldn't open billing right now. Try again in a moment.",
};

const publicPlaylists = (count: number) =>
  count === 1 ? "1 public playlist" : `${count} public playlists`;

const connectStatusBlock = (entitlement: ConnectBillingSummary, serverCount: number) => {
  const slots = `${serverCount} of ${entitlement.maxServers} servers`;
  const interval =
    entitlement.billingInterval === "year"
      ? "Yearly"
      : entitlement.billingInterval === "month"
        ? "Monthly"
        : null;
  if (entitlement.status === "active") {
    if (!entitlement.active && entitlement.polarSubscriptionId) {
      if (entitlement.cancelAtPeriodEnd) {
        return html`<p>
          Subscription ending<br /><span class="warn"
            >${
              entitlement.currentPeriodEnd
                ? `Ended ${shortDate(entitlement.currentPeriodEnd)}`
                : "Ending soon"
            }</span
          ><span class="muted"> · ${slots}</span>
        </p>`;
      }
      return html`<p>
        Active${interval ? ` · ${interval}` : ""}<br /><span class="muted"
          >Renewal pending · ${slots}</span
        >
      </p>`;
    }
    if (entitlement.active && entitlement.cancelAtPeriodEnd) {
      return html`<p>
        Active${interval ? ` · ${interval}` : ""}<br /><span class="warn"
          >${
            entitlement.currentPeriodEnd
              ? `Ends ${shortDate(entitlement.currentPeriodEnd)}`
              : "Cancels at period end"
          }</span
        ><span class="muted"> · ${slots}</span>
      </p>`;
    }
    if (entitlement.active) {
      return html`<p>
        Active${interval ? ` · ${interval}` : ""}<br /><span class="muted"
          >${
            entitlement.currentPeriodEnd
              ? `Renews ${shortDate(entitlement.currentPeriodEnd)} · `
              : ""
          }${slots}</span
        >
      </p>`;
    }
  }
  if (entitlement.status === "past_due") {
    return html`<p class="warn">Payment past due</p>
      <p class="muted">
        Update your payment method to keep Connect
        online.${
          entitlement.currentPeriodEnd
            ? ` Access ends ${shortDate(entitlement.currentPeriodEnd)}.`
            : ""
        }
      </p>`;
  }
  if (entitlement.status === "trial" && entitlement.active) {
    return html`<p>
      14-day trial<br /><span class="muted"
        >${
          entitlement.currentPeriodEnd ? `Ends ${shortDate(entitlement.currentPeriodEnd)} · ` : ""
        }${slots}</span
      >
    </p>`;
  }
  if (!entitlement.active && !entitlement.trialAvailable) {
    return html`<p class="error">
        ${entitlement.status === "trial" ? "Trial ended" : "Subscription ended"}
      </p>
      <p class="muted">Subscribe to bring your Connect servers back online.</p>`;
  }
  return html`<p class="muted">
    $5/mo or $50/yr after a 14-day free trial. Covers up to ${entitlement.maxServers} servers. Start
    a trial from Settings, Connect in Aurral, or subscribe here.
  </p>`;
};

const connectBillingActions = (connect: AccountConnectView) => {
  const { entitlement, hasMonthlyPlan, hasYearlyPlan, portalConfigured, emailPortalUrl } = connect;
  if (hasManagedPolarSubscription(entitlement)) {
    const highlight = entitlement.status === "past_due" || entitlement.cancelAtPeriodEnd;
    if (portalConfigured && entitlement.polarCustomerId) {
      return html`<form method="post" action="/account/connect/portal">
        <button class="button${highlight ? " primary" : ""}">Manage billing</button>
      </form>`;
    }
    if (emailPortalUrl) {
      return html`<a class="button${highlight ? " primary" : ""}" href="${emailPortalUrl}"
        >Manage billing</a
      >`;
    }
    return "";
  }

  const checkoutButtons =
    hasMonthlyPlan || hasYearlyPlan
      ? html`<div class="plans">
          ${
            hasMonthlyPlan
              ? html`<form method="post" action="/account/connect/checkout">
                  <input type="hidden" name="plan" value="monthly" />
                  <button class="button primary">Subscribe · $5/mo</button>
                </form>`
              : ""
          }
          ${
            hasYearlyPlan
              ? html`<form method="post" action="/account/connect/checkout">
                  <input type="hidden" name="plan" value="yearly" />
                  <button class="button${hasMonthlyPlan ? "" : " primary"}">
                    Subscribe · $50/yr (save $10)
                  </button>
                </form>`
              : ""
          }
        </div>`
      : "";

  const historyButton =
    portalConfigured && entitlement.polarCustomerId
      ? html`<form method="post" action="/account/connect/portal">
          <button class="button">Billing history</button>
        </form>`
      : "";

  return html`${checkoutButtons}${historyButton}`;
};

export const accountPage = (
  handle: string,
  provider: string,
  links: LinkRow[],
  connect: AccountConnectView,
) =>
  layout(
    `@${handle}`,
    html`<h1>@${handle}</h1>
      <p class="muted">Signed in with ${provider}</p>
      <h2>Aurral Connect</h2>
      ${
        connect.checkoutSuccess
          ? html`<p class="muted" role="status">
              ${
                connect.entitlement.status === "active" && connect.entitlement.active
                  ? "Aurral Connect is active."
                  : "Payment received. Refresh in a moment if your status hasn't updated yet."
              }
            </p>`
          : ""
      }
      ${
        connect.serverDisabled
          ? html`<p class="muted" role="status">
              Connect server disabled. An active tunnel can stay online for up to 15 minutes until
              its ticket expires.
            </p>`
          : ""
      }
      ${
        connect.billingError
          ? html`<p class="error" role="alert">${BILLING_ERRORS[connect.billingError]}</p>`
          : ""
      }
      ${connectStatusBlock(connect.entitlement, connect.servers.length)}
      ${connectBillingActions(connect)}
      ${
        connect.servers.length
          ? connect.servers.map(
              (server) =>
                html`<div class="row">
                  <p>
                    ${server.name}<br /><span class="muted mono"
                      >${server.slug}.${connect.connectDomain}</span
                    ><span class="muted"> · ${server.online ? "Online" : "Offline"}</span>
                  </p>
                  <a
                    class="danger"
                    href="/account/connect/servers/${encodeURIComponent(server.instanceId)}/disable"
                    >Disable</a
                  >
                </div>`,
            )
          : ""
      }
      <h2>Linked servers</h2>
      ${
        links.length
          ? links.map(
              (link) =>
                html`<div class="row">
                  <p>
                    Aurral user ${link.user_name}<br /><span class="muted"
                      >Linked
                      ${shortDate(link.linked_at)}${
                        link.public_count ? ` · ${publicPlaylists(link.public_count)}` : ""
                      }</span
                    >
                  </p>
                  <a class="danger" href="/account/unlink/${link.id}">Unlink</a>
                </div>`,
            )
          : html`<p class="muted">None yet. Link one from Settings in Aurral.</p>`
      }
      ${leave(null)}`,
  );

export const disableConnectServerPage = (server: OwnedConnectServer, connectDomain: string) =>
  layout(
    "Disable Connect server",
    html`<h1>Disable ${server.name}?</h1>
      <p class="muted">
        <span class="mono">${server.slug}.${connectDomain}</span> stops issuing new tunnel tickets
        immediately. An active tunnel can keep serving traffic for up to 15 minutes until its
        current ticket expires. The address stays reserved for 90 days, and local access to your
        server isn't affected.
      </p>
      <form
        method="post"
        action="/account/connect/servers/${encodeURIComponent(server.instanceId)}/disable"
      >
        <button class="button danger">Disable server</button>
      </form>
      <a class="button" href="/account">Cancel</a>`,
  );

export const unlinkPage = (link: LinkRow) =>
  layout(
    "Unlink",
    html`<h1>Unlink Aurral user ${link.user_name}?</h1>
      <p class="muted">
        That server can no longer publish as
        you.${
          link.public_count ? ` Its ${publicPlaylists(link.public_count)} stop being public.` : ""
        }
        You can link it again anytime.
      </p>
      <form method="post" action="/account/unlink/${link.id}">
        <button class="button danger">Unlink</button>
      </form>
      <a class="button" href="/account">Cancel</a>`,
  );

const LINK_ERRORS = {
  missing: "That code expired or doesn't exist. Start again in Aurral.",
  busy: "Too many tries. Wait a minute and try again.",
};

export const linkCodePage = (problem: keyof typeof LINK_ERRORS | null) =>
  layout(
    "Link a server",
    html`<h1>Link an Aurral server</h1>
      <p class="muted">Enter the code from Settings, Profile in Aurral.</p>
      <form method="get" action="/link">
        <input
          name="code"
          aria-label="Code"
          placeholder="XXXX-XXXX"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          maxlength="9"
          required
        />
        ${problem ? html`<p class="error" role="alert">${LINK_ERRORS[problem]}</p>` : ""}
        <button class="button primary">Continue</button>
      </form>
      <a class="button" href="/account">Cancel</a>`,
  );

export const linkConfirmPage = (handle: string, userName: string, code: string) =>
  layout(
    "Link a server",
    html`<h1>Link Aurral user ${userName} to @${handle}?</h1>
      <p class="muted">Code ${formatCode(code)}</p>
      <ul>
        <li>That server can publish playlists as @${handle}.</li>
        <li>
          It can add friends for you, share what you play with them, and read what they share.
        </li>
        <li>Its admin can do anything this link can.</li>
        <li>Linking gives aurral.org no access to your server.</li>
      </ul>
      <form method="post" action="/link">
        ${codeField(code)}
        <button class="button primary">Link to @${handle}</button>
      </form>
      <a class="button" href="/account">Cancel</a>
      ${signOut(code, `Not @${handle}? Sign out`)}`,
  );

export const deletePage = (handle: string | null, hasActiveSubscription = false) =>
  layout(
    "Delete account",
    html`<h1>Delete ${handle ? `@${handle}` : "your account"}?</h1>
      <p class="muted">
        This deletes your aurral.org account and unlinks every server.
        ${handle ? `@${handle} can't be claimed by anyone for 90 days.` : ""}
      </p>
      ${
        hasActiveSubscription
          ? html`<p class="warn">
              Cancel your Aurral Connect subscription in billing first so Polar stops charging you.
            </p>`
          : ""
      }
      <form method="post" action="/account/delete">
        <button class="button danger">Delete account</button>
      </form>
      <a class="button" href="/account">Cancel</a>`,
  );

export const connectAuthorizePage = (
  handle: string,
  clientLabel: string,
  params: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
    next: string;
  },
) =>
  layout(
    "Sign in to Aurral",
    html`<h1>Sign in to ${clientLabel} as @${handle}?</h1>
      <p class="muted">
        This lets ${clientLabel} find your Connect-enabled Aurral servers and sign into them as you.
      </p>
      <form method="post" action="/connect/authorize">
        <input type="hidden" name="client_id" value="${params.clientId}" />
        <input type="hidden" name="redirect_uri" value="${params.redirectUri}" />
        <input type="hidden" name="code_challenge" value="${params.codeChallenge}" />
        <input type="hidden" name="state" value="${params.state}" />
        <button class="button primary">Continue as @${handle}</button>
      </form>
      <a class="button" href="/account">Cancel</a>
      ${signOut(null, `Not @${handle}? Sign out`, params.next)}`,
  );

export const connectErrorPage = (message: string) =>
  layout(
    "Sign in error",
    html`<h1>Couldn't finish sign-in</h1>
      <p class="muted">${message}</p>
      <a class="button" href="/account">Back to account</a>`,
  );
