import { createPublicKey } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_JWKS_BYTES = 64 * 1024;
const TEST_PUBLISHABLE_PREFIX = "pk_test_";
const TEST_FRONTEND_API_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.clerk\.accounts\.dev$/;

/**
 * Derive the public Clerk Frontend API origin from a development-instance
 * publishable key. The browser swarm deliberately refuses pk_live_ here:
 * candidate code may observe an authenticated test session, so the identity
 * provider itself must be non-production.
 *
 * @param {string | undefined} publishableKey
 */
export function clerkTestFrontendApiOrigin(publishableKey) {
  if (!publishableKey?.startsWith(TEST_PUBLISHABLE_PREFIX)) {
    throw new Error(
      "Trusted browser swarm requires a Clerk pk_test_ publishable key.",
    );
  }

  const encoded = publishableKey.slice(TEST_PUBLISHABLE_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    throw new Error("Clerk test publishable key payload is malformed.");
  }

  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("Clerk test publishable key payload is not valid base64url.");
  }

  if (!decoded.endsWith("$")) {
    throw new Error("Clerk test publishable key payload is missing its host terminator.");
  }

  const hostname = decoded.slice(0, -1).toLowerCase();
  if (!TEST_FRONTEND_API_HOST.test(hostname)) {
    throw new Error(
      "Trusted browser swarm publishable key must resolve to *.clerk.accounts.dev.",
    );
  }

  return "https://" + hostname;
}

/**
 * Convert one unambiguous Clerk RSA signing JWK into the PEM format consumed
 * by CLERK_JWT_KEY. Multiple active signing keys fail closed rather than
 * silently choosing the wrong key during a rotation.
 *
 * @param {unknown} value
 */
export function clerkJwtPemFromJwks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Clerk JWKS payload must be an object.");
  }

  const keys = /** @type {{keys?: unknown}} */ (value).keys;
  if (!Array.isArray(keys)) {
    throw new TypeError("Clerk JWKS payload is missing keys.");
  }

  const signingKeys = keys.filter((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const key = /** @type {Record<string, unknown>} */ (entry);
    return (
      key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256") &&
      typeof key.n === "string" &&
      typeof key.e === "string"
    );
  });

  if (signingKeys.length !== 1) {
    throw new Error(
      "Trusted browser swarm requires exactly one Clerk RSA signing key.",
    );
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: /** @type {JsonWebKey} */ (signingKeys[0]),
      format: "jwk",
    });
  } catch {
    throw new Error("Clerk JWKS signing key could not be converted to a public key.");
  }

  if (publicKey.asymmetricKeyType !== "rsa") {
    throw new Error("Clerk JWKS signing key is not RSA.");
  }

  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

/**
 * @param {{
 *   publishableKey: string | undefined,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export async function fetchClerkTestJwtPem({
  publishableKey,
  fetchImpl = fetch,
}) {
  const origin = clerkTestFrontendApiOrigin(publishableKey);
  const response = await fetchImpl(origin + "/.well-known/jwks.json", {
    headers: { accept: "application/json" },
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(
      "Clerk JWKS request failed with HTTP " + String(response.status) + ".",
    );
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JWKS_BYTES) {
    throw new Error("Clerk JWKS response exceeds the trusted size limit.");
  }

  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_JWKS_BYTES) {
    throw new Error("Clerk JWKS response exceeds the trusted size limit.");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Clerk JWKS response is not valid JSON.");
  }

  return clerkJwtPemFromJwks(parsed);
}

/**
 * Resolve the test-instance public signing key and write only the PEM bytes to
 * stdout. The CLI accepts no output path: the trusted workflow owns temporary
 * file placement, so caller-controlled arguments cannot steer filesystem writes.
 *
 * @param {{
 *   publishableKey?: string,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export async function printClerkTestJwtPem({
  publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  fetchImpl = fetch,
} = {}) {
  const pem = await fetchClerkTestJwtPem({ publishableKey, fetchImpl });
  process.stdout.write(pem);
  return pem;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await printClerkTestJwtPem();
}
