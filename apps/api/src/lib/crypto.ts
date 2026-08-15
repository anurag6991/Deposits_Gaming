import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { encryptionKey } from '../config/env.js';

/**
 * Password hashing (Argon2id), secret encryption (AES-256-GCM), and token
 * digests (sha256).
 *
 * Three distinct jobs, deliberately not interchangeable:
 *   - Passwords are hashed. Nobody, including us, can read them back.
 *   - Proxy and test-account secrets are encrypted. They must be readable, since
 *     a publisher has to type them into a real site.
 *   - Refresh tokens are digested. We only ever need to compare, never recover.
 */

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** OWASP-recommended Argon2id parameters. */
const ARGON_OPTIONS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain, ARGON_OPTIONS);
  } catch {
    // A malformed stored hash must read as "wrong password", never as an error
    // that leaks which accounts have broken records.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reversible secrets
// ---------------------------------------------------------------------------

const IV_BYTES = 12; // GCM standard
const TAG_BYTES = 16;

/**
 * Encrypts a secret for storage. Layout: iv | authTag | ciphertext.
 *
 * GCM is authenticated, so tampering with a stored value causes decryption to
 * throw rather than silently returning corrupted plaintext.
 */
export function encryptSecret(plain: string): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  // A plain Uint8Array over its own ArrayBuffer: Node's Buffer may sit on a
  // pooled or shared buffer, which Prisma's Bytes type does not accept.
  return new Uint8Array(packed);
}

export function decryptSecret(stored: Buffer | Uint8Array | null | undefined): string | null {
  if (!stored || stored.length <= IV_BYTES + TAG_BYTES) return null;

  const buf = Buffer.from(stored);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** Refresh tokens are stored as digests so a database leak yields nothing usable. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison, for anything secret-adjacent. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
