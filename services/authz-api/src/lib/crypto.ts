import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ============================================================
// AES-256-GCM encryption for sensitive data (SEC-04)
// SSOT: encrypted ciphertext in DB, key from env var ENCRYPTION_KEY
// Backward compatible: plaintext values (no 'enc:' prefix) pass through
// ============================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`Decryption failed: ${reason}. Check ENCRYPTION_KEY env var.`);
    this.name = 'DecryptionError';
  }
}

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    // Dev fallback — deterministic key for POC (NOT for production)
    return Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');
  }
  return Buffer.from(keyHex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: enc:iv:tag:ciphertext (all hex, 'enc:' prefix for detection)
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt ciphertext. Throws DecryptionError on failure instead of
 * silently returning the ciphertext (which would leak encrypted data
 * or cause misleading "auth failed" errors at the DB layer).
 *
 * Plaintext values (no 'enc:' prefix) pass through for backward compat.
 */
export function decrypt(ciphertext: string): string {
  // Backward compatibility: if not encrypted (no 'enc:' prefix), return as-is
  if (!ciphertext.startsWith('enc:')) return ciphertext;

  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 4) {
    throw new DecryptionError('malformed ciphertext (expected enc:iv:tag:data)');
  }

  const [, ivHex, tagHex, encHex] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch (err) {
    throw new DecryptionError('wrong key or corrupted ciphertext');
  }
}

/**
 * Startup self-check: encrypt + decrypt a test string to verify the key works.
 * Call once at server boot. Logs a clear warning if the roundtrip fails.
 */
export function verifyCryptoKey(): boolean {
  try {
    const testValue = `crypto-selfcheck-${Date.now()}`;
    const encrypted = encrypt(testValue);
    const decrypted = decrypt(encrypted);
    if (decrypted !== testValue) {
      console.error('[CRYPTO] Self-check FAILED: roundtrip mismatch. Encrypted data will be unrecoverable.');
      return false;
    }
    const keySource = (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length === 64) ? 'ENCRYPTION_KEY env' : 'dev fallback (NOT for production)';
    console.log(`[CRYPTO] Self-check passed — key source: ${keySource}`);
    return true;
  } catch (err) {
    console.error(`[CRYPTO] Self-check FAILED: ${err}. Data source connections will fail.`);
    return false;
  }
}
