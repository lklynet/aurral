import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import bcrypt from "bcrypt";

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const value = String(stored || "");
  if (value.startsWith("scrypt$")) {
    const parts = value.split("$");
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (!salt.length || !expected.length) return false;
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  if (value.startsWith("$2")) {
    return bcrypt.compareSync(password, value);
  }
  return false;
}

export function needsRehash(stored) {
  return String(stored || "").startsWith("$2");
}
