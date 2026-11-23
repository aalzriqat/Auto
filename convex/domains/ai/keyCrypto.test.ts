// @vitest-environment node
import { describe, expect, test } from "vitest";
import { decryptProviderKey, encryptProviderKey, isEncryptionConfigured } from "./keyCrypto";

const MASTER = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const OTHER_MASTER = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const SECRET = "sk-ant-test-FAKE-0000000000000000";

function flipFirstByte(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  bytes[0] = bytes[0]! ^ 0xff;
  return btoa(String.fromCharCode(...bytes));
}

describe("T3 AES-256-GCM provider key encryption", () => {
  test("round trip returns the original key", async () => {
    const stored = await encryptProviderKey({ provider: "anthropic", plaintext: SECRET, masterKey: MASTER });
    expect(stored.ciphertext).not.toContain(SECRET);
    expect(stored.keyVersion).toBe(1);
    expect(await decryptProviderKey({ provider: "anthropic", masterKey: MASTER, ...stored })).toBe(SECRET);
  });

  test("two saves of the same key differ in IV and ciphertext", async () => {
    const a = await encryptProviderKey({ provider: "anthropic", plaintext: SECRET, masterKey: MASTER });
    const b = await encryptProviderKey({ provider: "anthropic", plaintext: SECRET, masterKey: MASTER });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(atob(a.iv)).toHaveLength(12); // guardrail-4-fixture: AES-GCM IV is 96 bits by specification
  });

  test("tampered ciphertext, tampered IV, wrong provider and wrong master key all throw cleanly", async () => {
    const s = await encryptProviderKey({ provider: "anthropic", plaintext: SECRET, masterKey: MASTER });
    const base = { provider: "anthropic" as const, masterKey: MASTER, ...s };
    await expect(decryptProviderKey({ ...base, ciphertext: flipFirstByte(s.ciphertext) })).rejects.toThrow(
      "could not be decrypted"
    );
    await expect(decryptProviderKey({ ...base, iv: flipFirstByte(s.iv) })).rejects.toThrow("could not be decrypted");
    await expect(decryptProviderKey({ ...base, provider: "openai" })).rejects.toThrow("could not be decrypted");
    await expect(decryptProviderKey({ ...base, masterKey: OTHER_MASTER })).rejects.toThrow("could not be decrypted");
    await expect(decryptProviderKey({ ...base, keyVersion: 2 })).rejects.toThrow("could not be decrypted");
  });

  test("missing or malformed master key fails closed", async () => {
    for (const bad of [undefined, "", "not base64!!", btoa("short")]) {
      expect(isEncryptionConfigured(bad)).toBe(false);
      await expect(encryptProviderKey({ provider: "anthropic", plaintext: SECRET, masterKey: bad })).rejects.toThrow(
        "not configured"
      );
    }
    expect(isEncryptionConfigured(MASTER)).toBe(true);
  });
});
