import * as v from "valibot";

const DEFAULT_POLAR_API_ORIGIN = "https://api.polar.sh";
const WEBHOOK_TOLERANCE_SEC = 300;
const WEBHOOK_SECRET_PREFIX = "whsec_";
const encoder = new TextEncoder();

export const POLAR_SUBSCRIPTION_EVENTS = new Set([
  "subscription.created",
  "subscription.active",
  "subscription.updated",
  "subscription.past_due",
  "subscription.canceled",
  "subscription.revoked",
  "subscription.uncanceled",
]);

export type PolarBillingPlan = "monthly" | "yearly";
export type PolarBillingInterval = "month" | "year";

export type PolarEnv = {
  POLAR_API_ORIGIN?: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_WEBHOOK_SECRET?: string;
  POLAR_PRODUCT_MONTHLY_ID?: string;
  POLAR_PRODUCT_YEARLY_ID?: string;
  POLAR_PORTAL_URL?: string;
};

export type PolarConfig = {
  apiOrigin: string;
  accessToken: string | null;
  webhookSecret: string | null;
  monthlyProductId: string | null;
  yearlyProductId: string | null;
  portalUrl: string | null;
};

const clean = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function polarConfig(env: PolarEnv): PolarConfig {
  const apiOrigin = (clean(env.POLAR_API_ORIGIN) ?? DEFAULT_POLAR_API_ORIGIN).replace(/\/+$/, "");
  const rawPortalUrl = clean(env.POLAR_PORTAL_URL);
  return {
    apiOrigin,
    accessToken: clean(env.POLAR_ACCESS_TOKEN),
    webhookSecret: clean(env.POLAR_WEBHOOK_SECRET),
    monthlyProductId: clean(env.POLAR_PRODUCT_MONTHLY_ID),
    yearlyProductId: clean(env.POLAR_PRODUCT_YEARLY_ID),
    portalUrl: rawPortalUrl && isSafePolarUrl(rawPortalUrl) ? rawPortalUrl : null,
  };
}

export function allowedPolarProductIds(config: PolarConfig): string[] {
  return [config.monthlyProductId, config.yearlyProductId].filter(
    (id): id is string => id !== null,
  );
}

function decodeBase64(input: string): Uint8Array<ArrayBuffer> | null {
  if (!input || !/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 !== 0) {
    return null;
  }
  try {
    const binary = atob(input);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function decodePolarWebhookSecret(secret: string | null): Uint8Array<ArrayBuffer> | null {
  if (!secret || !secret.startsWith(WEBHOOK_SECRET_PREFIX)) return null;
  const decoded = decodeBase64(secret.slice(WEBHOOK_SECRET_PREFIX.length));
  return decoded && decoded.length > 0 ? decoded : null;
}

export function isPolarBillingConfigured(config: PolarConfig): boolean {
  return Boolean(config.accessToken && decodePolarWebhookSecret(config.webhookSecret));
}

export function isPolarPortalConfigured(config: PolarConfig): boolean {
  return Boolean(config.accessToken);
}

export async function verifyPolarWebhookSignature(
  rawBody: string,
  headers: {
    webhookId: string | null;
    webhookTimestamp: string | null;
    webhookSignature: string | null;
  },
  secretKey: Uint8Array<ArrayBuffer>,
  nowMs = Date.now(),
): Promise<{ valid: true; webhookId: string; timestampMs: number } | { valid: false }> {
  const webhookId = headers.webhookId?.trim() ?? "";
  const webhookTimestamp = headers.webhookTimestamp?.trim() ?? "";
  const webhookSignature = headers.webhookSignature?.trim() ?? "";
  if (!webhookId || !webhookTimestamp || !webhookSignature || !/^\d+$/.test(webhookTimestamp)) {
    return { valid: false };
  }
  const timestampSec = Number(webhookTimestamp);
  const nowSec = Math.floor(nowMs / 1000);
  if (
    !Number.isSafeInteger(timestampSec) ||
    Math.abs(nowSec - timestampSec) > WEBHOOK_TOLERANCE_SEC
  ) {
    return { valid: false };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    secretKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const message = encoder.encode(`${webhookId}.${webhookTimestamp}.${rawBody}`);

  for (const token of webhookSignature.split(/\s+/)) {
    const comma = token.indexOf(",");
    if (comma <= 0) continue;
    const version = token.slice(0, comma);
    if (version !== "v1") continue;
    const signature = decodeBase64(token.slice(comma + 1));
    if (!signature) continue;
    if (await crypto.subtle.verify("HMAC", key, signature, message)) {
      return { valid: true, webhookId, timestampMs: timestampSec * 1000 };
    }
  }
  return { valid: false };
}

const webhookEnvelopeSchema = v.looseObject({
  type: v.string(),
  data: v.unknown(),
});

const polarSubscriptionDataSchema = v.looseObject({
  id: v.pipe(v.string(), v.minLength(1)),
  status: v.pipe(v.string(), v.minLength(1)),
  product_id: v.optional(v.nullable(v.string())),
  customer_id: v.optional(v.nullable(v.string())),
  recurring_interval: v.optional(v.nullable(v.string())),
  current_period_end: v.optional(v.nullable(v.string())),
  ends_at: v.optional(v.nullable(v.string())),
  ended_at: v.optional(v.nullable(v.string())),
  canceled_at: v.optional(v.nullable(v.string())),
  cancel_at_period_end: v.optional(v.nullable(v.boolean())),
  modified_at: v.optional(v.nullable(v.string())),
  created_at: v.optional(v.nullable(v.string())),
  metadata: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
  customer: v.optional(
    v.nullable(
      v.looseObject({
        id: v.optional(v.nullable(v.string())),
        external_id: v.optional(v.nullable(v.string())),
      }),
    ),
  ),
});

export type PolarSubscriptionEvent = {
  type: string;
  subscriptionId: string;
  subscriptionCreatedAt: number | null;
  status: string;
  productId: string | null;
  polarCustomerId: string | null;
  metadataAccountId: string | null;
  customerExternalId: string | null;
  billingInterval: PolarBillingInterval | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  eventTimestamp: number | null;
};

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInterval(value: string | null | undefined): PolarBillingInterval | null {
  if (value === "month" || value === "year") return value;
  return null;
}

export function parsePolarWebhookEvent(
  rawBody: string,
):
  | { kind: "subscription"; event: PolarSubscriptionEvent }
  | { kind: "ignored"; type: string }
  | { kind: "invalid" } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid" };
  }
  const envelope = v.safeParse(webhookEnvelopeSchema, decoded);
  if (!envelope.success) return { kind: "invalid" };
  if (!POLAR_SUBSCRIPTION_EVENTS.has(envelope.output.type)) {
    return { kind: "ignored", type: envelope.output.type };
  }
  const data = v.safeParse(polarSubscriptionDataSchema, envelope.output.data);
  if (!data.success) return { kind: "invalid" };

  const sub = data.output;
  const metadataAccountId =
    sub.metadata && typeof sub.metadata.account_id === "string"
      ? sub.metadata.account_id.trim() || null
      : null;
  const customerExternalId = sub.customer?.external_id?.trim() || null;
  const polarCustomerId = sub.customer_id?.trim() || sub.customer?.id?.trim() || null;
  const currentPeriodEnd =
    parseIsoTimestamp(sub.current_period_end) ?? parseIsoTimestamp(sub.ends_at);
  const subscriptionCreatedAt = parseIsoTimestamp(sub.created_at);
  const timestamps = [
    parseIsoTimestamp(sub.modified_at),
    parseIsoTimestamp(sub.ended_at),
    parseIsoTimestamp(sub.canceled_at),
    subscriptionCreatedAt,
  ].filter((ts): ts is number => ts !== null);
  const eventTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;

  return {
    kind: "subscription",
    event: {
      type: envelope.output.type,
      subscriptionId: sub.id,
      subscriptionCreatedAt,
      status: sub.status.toLowerCase(),
      productId: sub.product_id?.trim() || null,
      polarCustomerId,
      metadataAccountId,
      customerExternalId,
      billingInterval: normalizeInterval(sub.recurring_interval),
      currentPeriodEnd,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      eventTimestamp,
    },
  };
}

const checkoutResponseSchema = v.looseObject({
  url: v.string(),
});

const portalResponseSchema = v.looseObject({
  customer_portal_url: v.string(),
});

function isSafePolarUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "polar.sh" || parsed.hostname.endsWith(".polar.sh"))
    );
  } catch {
    return false;
  }
}

export function polarProductsForPlan(config: PolarConfig, plan: PolarBillingPlan): string[] {
  const ordered =
    plan === "yearly"
      ? [config.yearlyProductId, config.monthlyProductId]
      : [config.monthlyProductId, config.yearlyProductId];
  return [...new Set(ordered.filter((id): id is string => id !== null))];
}

export async function createPolarCheckout(
  config: PolarConfig,
  params: {
    accountId: string;
    plan: PolarBillingPlan;
    successUrl: string;
    returnUrl: string;
  },
): Promise<{ ok: true; url: string } | { ok: false; error: "unconfigured" | "polar_error" }> {
  const products = polarProductsForPlan(config, params.plan);
  if (!isPolarBillingConfigured(config) || products.length === 0) {
    return { ok: false, error: "unconfigured" };
  }
  let response: Response;
  try {
    response = await fetch(`${config.apiOrigin}/v1/checkouts/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        products,
        external_customer_id: params.accountId,
        metadata: { account_id: params.accountId },
        success_url: params.successUrl,
        return_url: params.returnUrl,
        allow_discount_codes: true,
      }),
    });
  } catch {
    return { ok: false, error: "polar_error" };
  }
  if (!response.ok) return { ok: false, error: "polar_error" };
  const parsed = v.safeParse(checkoutResponseSchema, await response.json().catch(() => null));
  if (!parsed.success || !isSafePolarUrl(parsed.output.url)) {
    return { ok: false, error: "polar_error" };
  }
  return { ok: true, url: parsed.output.url };
}

export async function createPolarCustomerPortal(
  config: PolarConfig,
  params: {
    polarCustomerId: string;
    returnUrl: string;
  },
): Promise<{ ok: true; url: string } | { ok: false; error: "unconfigured" | "polar_error" }> {
  if (!config.accessToken) return { ok: false, error: "unconfigured" };

  let response: Response;
  try {
    response = await fetch(`${config.apiOrigin}/v1/customer-sessions/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customer_id: params.polarCustomerId,
        return_url: params.returnUrl,
      }),
    });
  } catch {
    return { ok: false, error: "polar_error" };
  }
  if (!response.ok) return { ok: false, error: "polar_error" };
  const parsed = v.safeParse(portalResponseSchema, await response.json().catch(() => null));
  if (!parsed.success || !isSafePolarUrl(parsed.output.customer_portal_url)) {
    return { ok: false, error: "polar_error" };
  }
  return { ok: true, url: parsed.output.customer_portal_url };
}
