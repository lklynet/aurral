import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const CODE_TTL_MS = 10 * 60 * 1000;

const codes = new Map<string, { userId: number; sessionId: number; expiresAt: number }>();

const normalize = (input: string) =>
  input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

export function createPairingCode(userId: number, sessionId: number) {
  const now = Date.now();
  for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code);
  const code = Array.from(crypto.randomBytes(CODE_LENGTH), (byte) => ALPHABET[byte & 31]).join("");
  const expiresAt = now + CODE_TTL_MS;
  codes.set(code, { userId, sessionId, expiresAt });
  return { code, expiresAt };
}

export function consumePairingCode(input: string) {
  const code = normalize(input);
  const entry = codes.get(code);
  codes.delete(code);
  return entry && entry.expiresAt > Date.now() ? entry : null;
}
