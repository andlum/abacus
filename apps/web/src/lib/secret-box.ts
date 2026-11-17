// Secrets the app must read back, such as a bank connection's Plaid access
// token. Unlike an API token, which is only ever compared and so is kept as
// a hash (api-tokens.ts), these are encrypted: AES-256-GCM with a key held
// outside the database (ABACUS_ENCRYPTION_KEY), a fresh 12-byte IV for each
// value. A leaked database without the key reveals nothing.
//
// Stored as "v1.<base64url of iv | ciphertext | tag>". The version says which
// key and scheme sealed it, so the key can be changed later by re-sealing.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// The key from its base64 text: exactly 32 bytes, or null.
export function parseEncryptionKey(text: string | null | undefined): Buffer | null {
  const value = (text ?? "").trim();
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value, "base64");
  return key.length === 32 ? key : null;
}

export function sealSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
}

// Throws when the value was changed, or sealed with another key. The error
// never includes the value.
export function openSecret(sealed: string, key: Buffer): string {
  const [version, data, ...rest] = sealed.split(".");
  if (version !== VERSION || !data || rest.length > 0) throw new Error("not a sealed secret");
  const bytes = Buffer.from(data, "base64url");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("not a sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("the secret could not be opened: wrong key, or it was changed");
  }
}
