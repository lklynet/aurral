const DEFAULT_RESEND_API_ORIGIN = "https://api.resend.com";
const DEFAULT_EMAIL_FROM = "Aurral <noreply@aurral.org>";
const SYNTHETIC_EMAIL_DOMAIN = "users.aurral.org";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type EmailEnv = {
  RESEND_API_KEY?: string;
  RESEND_API_ORIGIN?: string;
  EMAIL_FROM?: string;
};

export type EmailConfig = {
  apiKey: string | null;
  apiOrigin: string;
  from: string;
};

const clean = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function emailConfig(env: EmailEnv): EmailConfig {
  return {
    apiKey: clean(env.RESEND_API_KEY),
    apiOrigin: (clean(env.RESEND_API_ORIGIN) ?? DEFAULT_RESEND_API_ORIGIN).replace(/\/+$/, ""),
    from: clean(env.EMAIL_FROM) ?? DEFAULT_EMAIL_FROM,
  };
}

export function isEmailSignInConfigured(env: EmailEnv): boolean {
  return emailConfig(env).apiKey !== null;
}

export function isSyntheticIdentityEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at < 0) return false;
  const domain = normalized.slice(at + 1);
  return domain === SYNTHETIC_EMAIL_DOMAIN || domain.endsWith(`.${SYNTHETIC_EMAIL_DOMAIN}`);
}

export function normalizeSignInEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  const at = email.lastIndexOf("@");
  const domain = email.slice(at + 1);
  if (domain === SYNTHETIC_EMAIL_DOMAIN || domain.endsWith(`.${SYNTHETIC_EMAIL_DOMAIN}`)) {
    return null;
  }
  return email;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendMagicLinkEmail(
  config: EmailConfig,
  params: { to: string; url: string },
): Promise<void> {
  if (!config.apiKey) throw new Error("email_unconfigured");
  const safeUrl = escapeHtml(params.url);
  const response = await fetch(`${config.apiOrigin}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [params.to],
      subject: "Sign in to aurral.org",
      text: `Open this link to sign in to aurral.org:\n\n${params.url}\n\nThis link expires in 15 minutes and can only be used once. If you didn't ask for it, you can ignore this email.`,
      html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5">
    <div style="max-width:400px;margin:0 auto">
      <p style="margin:0 0 16px;font-size:17px;font-weight:600">Aurral</p>
      <p style="margin:0 0 20px;color:#b4b4b4">Select the button below to sign in to aurral.org. This link expires in 15 minutes and can only be used once.</p>
      <p style="margin:0 0 20px">
        <a href="${safeUrl}" style="display:inline-block;padding:11px 18px;border-radius:6px;background:#fff;color:#000;font-weight:600;text-decoration:none">Sign in to aurral.org</a>
      </p>
      <p style="margin:0;color:#737373;font-size:12px">If you didn't ask for this email, you can ignore it.</p>
    </div>
  </body>
</html>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`resend_error_${response.status}`);
  }
}
