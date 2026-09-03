import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt rather than bcrypt/argon2 because it is in Node's standard library
// — no native module to compile, nothing extra to install in the image, and
// it is a memory-hard KDF, which is the property that actually matters
// against offline cracking.
//
// N=2^15 with r=8 costs roughly 32 MB and ~100 ms per hash here: slow
// enough to make guessing expensive, fast enough that a login does not feel
// laggy. maxmem must be raised explicitly or Node refuses these parameters.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 96 * 1024 * 1024;

/**
 * "scrypt$N$r$p$salt$hash", all base64url.
 *
 * The parameters travel with the hash so they can be raised later without
 * invalidating every existing password — an old hash still verifies under
 * the values it was created with.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/**
 * Constant-time verification. Returns false rather than throwing on a
 * malformed stored value — a corrupt row must fail the login, not crash the
 * endpoint (and not reveal, by crashing, that the account exists).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split("$");
    if (scheme !== "scrypt") return false;

    const salt = Buffer.from(saltB64, "base64url");
    const expected = Buffer.from(hashB64, "base64url");
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** The rules the signup form and the reset form both enforce, in one place
 * so they cannot drift into disagreeing about what is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 200) return "Password must be at most 200 characters.";
  if (!/[a-zA-Z]/.test(password)) return "Password must contain at least one letter.";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number.";
  return null;
}
