import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// ============================================================
// AES-256-GCM encryption for sensitive data (SEC-04)
// SSOT: encrypted ciphertext in DB, key from env var ENCRYPTION_KEY
// Backward compatible: plaintext values (no ':' separator) pass through
// ============================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

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

export function decrypt(ciphertext: string): string {
  // Backward compatibility: if not encrypted (no 'enc:' prefix), return as-is
  if (!ciphertext.startsWith('enc:')) return ciphertext;

  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 4) return ciphertext; // malformed, return as-is

  const [, ivHex, tagHex, encHex] = parts;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch {
    // Decryption failed (wrong key?) — return as-is to avoid crash
    return ciphertext;
  }
}
