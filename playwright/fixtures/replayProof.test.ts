import { describe, expect, it } from "vitest";
import { replayProofFor } from "../../convex/e2eBootstrap";
import { replayProof } from "./replayProof";

const NONCE = "0123456789abcdef0123456789abcdef";

describe("replayProof (client) and replayProofFor (server) agree", () => {
  it.each([
    [NONCE, "org_abc123", "run-1"],
    ["fedcba9876543210fedcba9876543210", "k57x9y", "1234567890"],
    ["a".repeat(64), "o", "r"],
  ])("same proof for %#", (nonce, orgId, runId) => {
    expect(replayProof(nonce, orgId, runId)).toBe(replayProofFor(nonce, orgId, runId));
    expect(replayProof(nonce, orgId, runId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the organization, the run and the nonce, and does not contain the nonce", () => {
    const base = replayProof(NONCE, "org1", "run1");
    expect(replayProof(NONCE, "org2", "run1")).not.toBe(base);
    expect(replayProof(NONCE, "org1", "run2")).not.toBe(base);
    expect(replayProof("fedcba9876543210fedcba9876543210", "org1", "run1")).not.toBe(base);
    expect(base).not.toContain(NONCE);
  });
});
