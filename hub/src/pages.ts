import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { HandleClaim } from "./handles.ts";

type Page = HtmlEscapedString | Promise<HtmlEscapedString>;

export const STYLE = `@font-face{font-family:Manrope;src:url("/fonts/manrope-latin.woff2") format("woff2");font-weight:400 800;font-display:swap}
:root{color-scheme:dark;--text:#fff;--muted:#b4b4b4;--field:#151515;--danger:#f87171}
*{box-sizing:border-box}
body{margin:0;background:#000;color:var(--text);font:400 14px/1.5 Manrope,ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.top{max-width:420px;margin:auto;padding:16px 20px 0;font-size:16px;font-weight:750;letter-spacing:-.5px}
.top a{color:inherit;text-decoration:none}
main{max-width:340px;margin:auto;padding:40px 20px;display:grid;gap:14px}
h1{margin:0;font-size:24px;letter-spacing:-.4px}
h2{margin:12px 0 0;font-size:15px}
p{margin:0}
.muted{color:var(--muted);font-size:13px}
.error{color:var(--danger);font-size:13px}
.button{display:block;width:100%;border:0;border-radius:6px;padding:11px;font:inherit;font-weight:600;line-height:1.2;text-align:center;text-decoration:none;cursor:pointer;background:var(--field);color:var(--text)}
.primary{background:var(--text);color:#000}
.danger{color:var(--danger)}
.link{background:none;padding-left:0;text-align:left;width:auto}
input{width:100%;border:0;border-radius:8px;padding:11px 12px;background:var(--field);color:var(--text);font:inherit}
form{display:grid;gap:10px;margin:0}
a{color:inherit}
:focus-visible{outline:2px solid var(--text);outline-offset:3px}`;

const layout = (title: string, body: Page) =>
  html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · aurral</title>
        <link rel="stylesheet" href="/account/style.css" />
      </head>
      <body>
        <div class="top"><a href="/">aurral</a></div>
        <main>${body}</main>
      </body>
    </html>`;

const LEGAL = html`<p class="muted">
  From GitHub or Discord we keep only your account ID. <a href="/privacy">Privacy</a> ·
  <a href="/terms">Terms</a>
</p>`;

export const signInPage = (providers: { id: string; label: string }[], failed: boolean) =>
  layout(
    "Sign in",
    html`<h1>Sign in to aurral.org</h1>
      <p class="muted">To link your Aurral and publish playlists.</p>
      ${failed ? html`<p class="error" role="alert">Sign-in didn't finish. Try again.</p>` : ""}
      ${providers.map(
        ({ id, label }) =>
          html`<a class="button" href="/account/sign-in/${id}">Continue with ${label}</a>`,
      )}
      ${LEGAL}`,
  );

const HANDLE_ERRORS: Record<Exclude<HandleClaim, "claimed">, string> = {
  invalid: "Use 3 to 20 lowercase letters, numbers, or underscores.",
  reserved: "That handle is reserved.",
  not_allowed: "That handle isn't allowed.",
  taken: "That handle is taken.",
};

export const handlePage = (value = "", problem: Exclude<HandleClaim, "claimed"> | null = null) =>
  layout(
    "Pick a handle",
    html`<h1>Pick a handle</h1>
      <p class="muted">
        Shown on playlists you publish. 3 to 20 lowercase letters, numbers, or underscores.
      </p>
      <form method="post" action="/account/handle">
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
      </form>`,
  );

export const accountPage = (handle: string, provider: string) =>
  layout(
    `@${handle}`,
    html`<h1>@${handle}</h1>
      <p class="muted">Signed in with ${provider}</p>
      <h2>Linked servers</h2>
      <p class="muted">None yet. Link one from Settings in Aurral.</p>
      <form method="post" action="/account/sign-out">
        <button class="button">Sign out</button>
      </form>
      <a class="button danger link" href="/account/delete">Delete account</a>`,
  );

export const deletePage = (handle: string) =>
  layout(
    "Delete account",
    html`<h1>Delete @${handle}?</h1>
      <p class="muted">
        This deletes your aurral.org account and unlinks every server. @${handle} can't be claimed
        by anyone for 90 days.
      </p>
      <form method="post" action="/account/delete">
        <button class="button danger">Delete account</button>
      </form>
      <a class="button" href="/account">Cancel</a>`,
  );
