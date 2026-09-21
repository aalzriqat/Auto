import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  clerkJwtPemFromJwks,
  clerkTestFrontendApiOrigin,
  fetchClerkTestJwtPem,
} from "./clerkPublicJwtKey.mjs";

function publishableKey(hostname = "steady-hound-42.clerk.accounts.dev"): string {
  return "pk_test_" + Buffer.from(hostname + "$", "utf8").toString("base64url");
}

function rsaJwk(): JsonWebKey {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return publicKey.export({ format: "jwk" });
}

describe("trusted Clerk public JWT key resolver", () => {
  it("derives only a Clerk development Frontend API origin", () => {
    expect(clerkTestFrontendApiOrigin(publishableKey())).toBe(
      "https://steady-hound-42.clerk.accounts.dev",
    );
  });

  it("refuses live Clerk publishable keys", () => {
    const encoded = Buffer.from(
      "clerk.example.com$",
      "utf8",
    ).toString("base64url");
    expect(() => clerkTestFrontendApiOrigin("pk_live_" + encoded)).toThrow(
      /pk_test_/,
    );
  });

  it("refuses a test-looking key that decodes to an arbitrary host", () => {
    expect(() =>
      clerkTestFrontendApiOrigin(
        "pk_test_" +
          Buffer.from("attacker.example$", "utf8").toString("base64url"),
      ),
    ).toThrow(/clerk\.accounts\.dev/);
  });

  it("converts exactly one RSA signing JWK to PEM", () => {
    const jwk = { ...rsaJwk(), use: "sig", alg: "RS256" };
    const pem = clerkJwtPemFromJwks({ keys: [jwk] });

    expect(pem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(pem).toContain("-----END PUBLIC KEY-----");
  });

  it("fails closed when Clerk exposes multiple eligible signing keys", () => {
    const first = { ...rsaJwk(), use: "sig", alg: "RS256" };
    const second = { ...rsaJwk(), use: "sig", alg: "RS256" };

    expect(() => clerkJwtPemFromJwks({ keys: [first, second] })).toThrow(
      /exactly one/,
    );
  });

  it("fetches only the derived Clerk JWKS endpoint and returns PEM", async () => {
    const jwk = { ...rsaJwk(), use: "sig", alg: "RS256" };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const pem = await fetchClerkTestJwtPem({
      publishableKey: publishableKey(),
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://steady-hound-42.clerk.accounts.dev/.well-known/jwks.json",
    );
    expect(pem).toContain("-----BEGIN PUBLIC KEY-----");
  });
});
