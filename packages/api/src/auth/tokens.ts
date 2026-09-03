import { createHash, randomBytes } from "node:crypto";

/** The cookie the dashboard carries. httpOnly, so page scripts can never
 * read it — an XSS bug cannot walk off with a login. */
export const SESSION_COOKIE = "ba_session";

/**
 * How long a login lasts without being used.
 *
 * "Log in once and don't log in again" is the requirement, so this is
 * deliberately long — and every authenticated request slides it forward
 * (see touchAuthSession), which means somebody using the dashboard weekly
 * is never signed out at all. An abandoned session still ages out.
 */
export const SESSION_TTL_DAYS = 90;

/** Reset links are the opposite: short, because an email sits in an inbox
 * indefinitely and a link that still works next month is a liability. */
export const RESET_TTL_MINUTES = 60;

/** 32 bytes of CSPRNG, base64url — long enough that guessing is hopeless
 * and safe to put in a URL or a Set-Cookie header unescaped. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What actually gets stored. A plain SHA-256 (not a slow KDF) is right
 * here: the token is already 256 bits of randomness, so there is no
 * dictionary to attack and nothing for key-stretching to buy — it only
 * needs to be one-way so a database leak is not a pile of live sessions.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function resetExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + RESET_TTL_MINUTES * 60 * 1000);
}
