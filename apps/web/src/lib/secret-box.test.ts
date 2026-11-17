import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, parseEncryptionKey, sealSecret } from "./secret-box";

const key = randomBytes(32);
const token = "access-sandbox-00000000-0000-0000-0000-000000000000";

describe("secret box", () => {
  it("opens what it sealed", () => {
    const sealed = sealSecret(token, key);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(token);
    expect(openSecret(sealed, key)).toBe(token);
  });

  it("uses a fresh IV each time", () => {
    expect(sealSecret(token, key)).not.toBe(sealSecret(token, key));
  });

  it("refuses a changed value", () => {
    const sealed = sealSecret(token, key);
    const bytes = Buffer.from(sealed.slice(3), "base64url");
    bytes[20] = bytes[20]! ^ 1;
    expect(() => openSecret(`v1.${bytes.toString("base64url")}`, key)).toThrow(/could not be opened/);
    expect(() => openSecret(sealed.slice(0, -4), key)).toThrow();
    expect(() => openSecret(`v2.${sealed.slice(3)}`, key)).toThrow(/not a sealed secret/);
  });

  it("refuses the wrong key, without saying the value", () => {
    const sealed = sealSecret(token, key);
    let message = "";
    try {
      openSecret(sealed, randomBytes(32));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/wrong key/);
    expect(message).not.toContain(token);
  });

  it("takes only a 32-byte base64 key", () => {
    expect(parseEncryptionKey(key.toString("base64"))?.equals(key)).toBe(true);
    expect(parseEncryptionKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(parseEncryptionKey("")).toBeNull();
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey("not base64!")).toBeNull();
  });
});
