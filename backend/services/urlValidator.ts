const ALWAYS_BLOCKED_HOSTS = new Set(["169.254.169.254"]);

type ExternalUrlValidation =
  | { valid: true; url: string; error?: undefined }
  | { valid: false; error: string; url?: undefined };

export const validateExternalUrl = (value: unknown): ExternalUrlValidation => {
  const raw = String(value || "").trim();
  if (!raw) {
    return { valid: false, error: "URL is required" };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { valid: false, error: "Only HTTP and HTTPS URLs are allowed" };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (ALWAYS_BLOCKED_HOSTS.has(hostname)) {
    return { valid: false, error: "Target host is blocked" };
  }
  return { valid: true, url: parsed.toString().replace(/\/+$/, "") };
};
