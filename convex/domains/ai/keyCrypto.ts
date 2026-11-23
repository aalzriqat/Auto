/**
 * AES-256-GCM encryption of provider API keys with Web Crypto, which the
 * default Convex runtime provides (no Node builtin needed, so this runs in a
 * mutation-free action or a query alike).
 *
 * - Master key: env `AI_KEY_ENCRYPTION_KEY`, base64 of exactly 32 bytes.
 *   Missing or malformed fails closed: nothing is encrypted or stored.
 * - A fresh random 96-bit IV per encryption.
 * - The provider name is bound as additional authenticated data, so a
 *   ciphertext cannot be moved to another provider's row.
 *
 * Errors are fixed strings. They never carry the plaintext, key or ciphertext.
 */

import type { Infer } from "convex/values";
import type { aiProviderValidator } from "../../schema/ai.schema";

export type AiProvider = Infer<typeof aiProviderValidator>;
export const KEY_VERSION = 1;

const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

const NOT_CONFIGURED = "AI key encryption is not configured.";
const DECRYPT_FAILED = "The stored AI provider key could not be decrypted.";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function parseMasterKey(raw: string | undefined): Uint8Array<ArrayBuffer> | null {
  const trimmed = raw?.trim();
  if (!trimmed || !BASE64_SHAPE.test(trimmed)) return null;
  try {
    const bytes = base64ToBytes(trimmed);
    return bytes.length === MASTER_KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

export function isEncryptionConfigured(masterKey: string | undefined): boolean {
  return parseMasterKey(masterKey) !== null;
}

async function importMasterKey(raw: string | undefined, usage: "encrypt" | "decrypt"): Promise<CryptoKey | null> {
  const bytes = parseMasterKey(raw);
  if (!bytes) return null;
  return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [usage]);
}

function aad(provider: AiProvider): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(provider);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

export async function encryptProviderKey(args: {
  provider: AiProvider;
  plaintext: string;
  masterKey: string | undefined;
}): Promise<{ ciphertext: string; iv: string; keyVersion: number }> {
  const key = await importMasterKey(args.masterKey, "encrypt");
  if (!key) throw new Error(NOT_CONFIGURED);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)));
  const encoded = new TextEncoder().encode(args.plaintext);
  const data = new Uint8Array(new ArrayBuffer(encoded.length));
  data.set(encoded);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(args.provider), tagLength: 128 },
    key,
    data
  );
  return { ciphertext: bytesToBase64(new Uint8Array(sealed)), iv: bytesToBase64(iv), keyVersion: KEY_VERSION };
}

export async function decryptProviderKey(args: {
  provider: AiProvider;
  ciphertext: string;
  iv: string;
  keyVersion: number;
  masterKey: string | undefined;
}): Promise<string> {
  try {
    if (args.keyVersion !== KEY_VERSION) throw new Error("unsupported key version");
    const key = await importMasterKey(args.masterKey, "decrypt");
    if (!key) throw new Error("no master key");
    const iv = base64ToBytes(args.iv);
    if (iv.length !== IV_BYTES) throw new Error("bad iv");
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad(args.provider), tagLength: 128 },
      key,
      base64ToBytes(args.ciphertext)
    );
    return new TextDecoder().decode(opened);
  } catch {
    // Collapse every cause (tamper, wrong provider, wrong master key, bad
    // encoding) into one fixed message.
    throw new Error(DECRYPT_FAILED);
  }
}
