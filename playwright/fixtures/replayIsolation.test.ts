import { describe, expect, it } from "vitest";
import {
  decideReplayEnvironment,
  deploymentNameOf,
  replayLaneAction,
  replayOrgRefusals,
  REPLAY_MAX_ORG_AGE_MS,
  REPLAY_NONCE_MIN_LENGTH,
  type ReplayAttestation,
  type ReplayLane,
  type ReplayOrgFacts,
} from "./replayIsolation";

describe("deploymentNameOf", () => {
  it("reads the name of a Convex cloud or site URL", () => {
    expect(deploymentNameOf("https://happy-otter-123.convex.cloud")).toBe("happy-otter-123");
    expect(deploymentNameOf("https://happy-otter-123.convex.site/x")).toBe("happy-otter-123");
  });
  it("returns null for anything else", () => {
    expect(deploymentNameOf(undefined)).toBeNull();
    expect(deploymentNameOf("http://happy-otter-123.convex.cloud")).toBeNull();
    expect(deploymentNameOf("https://evil.example.com/happy-otter-123.convex.cloud")).toBeNull();
  });
});

describe("decideReplayEnvironment (allow-list on the backend's attestation bound to this run's nonce)", () => {
  const url = "https://happy-otter-123.convex.cloud";
  const NONCE = "0123456789abcdef0123456789abcdef";
  const lane: ReplayLane = { dedicatedOrg: true, nonce: NONCE };
  const good: ReplayAttestation = {
    attested: true,
    reasons: [],
    deploymentName: "happy-otter-123",
    markerDeploymentName: "happy-otter-123",
    orgAgeMs: 60_000,
  };
  const with_ = (over: Partial<ReplayAttestation>): ReplayAttestation => ({ ...good, ...over });

  it("runs only on a positive attestation, this run's nonce, a dedicated org and one deployment name everywhere", () => {
    expect(decideReplayEnvironment(url, good, lane)).toEqual({ kind: "RUN", deployment: "happy-otter-123" });
  });

  it("is NOT RUN for the promoted-preview scenario: class and marker attest, but the lane holds no nonce", () => {
    // The backend says attested (class preview + marker + seed org) because those survive promotion.
    for (const nonce of [undefined, "", "short", "x".repeat(REPLAY_NONCE_MIN_LENGTH - 1)]) {
      const verdict = decideReplayEnvironment(url, good, { dedicatedOrg: true, nonce });
      expect(verdict.kind).toBe("NOT_RUN");
      expect(JSON.stringify(verdict)).not.toContain(NONCE);
    }
    expect(decideReplayEnvironment(url, good, { dedicatedOrg: true, nonce: "x".repeat(REPLAY_NONCE_MIN_LENGTH) }).kind).toBe("RUN");
  });

  it("is NOT RUN when the backend refuses the nonce (wrong, expired, not set), whatever the lane holds", () => {
    for (const reason of ["NONCE_MISMATCH", "EXPIRED", "NONCE_NOT_SET", "RUN_ID_MISMATCH"]) {
      expect(decideReplayEnvironment(url, with_({ attested: false, reasons: [reason] }), lane)).toMatchObject({
        kind: "NOT_RUN",
        reason: expect.stringContaining(reason),
      });
    }
  });

  it("is NOT RUN, never a run, when the marker or attestation is missing or unreadable", () => {
    expect(decideReplayEnvironment(url, null, lane).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, undefined, lane).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ attested: false, reasons: ["NO_MARKER"] }), lane).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ attested: false, reasons: ["CLASS_NOT_PREVIEW"] }), lane)).toMatchObject({
      kind: "NOT_RUN",
      reason: expect.stringContaining("CLASS_NOT_PREVIEW"),
    });
  });

  it("does not trust an operator-supplied name: attested false stays NOT RUN whatever the URL says", () => {
    expect(decideReplayEnvironment(url, with_({ attested: false, reasons: [] }), lane).kind).toBe("NOT_RUN");
  });

  it("is NOT RUN unless the lane declares the org dedicated, even with a positive attestation and nonce", () => {
    expect(decideReplayEnvironment(url, good, { nonce: NONCE }).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, good, { dedicatedOrg: false, nonce: NONCE }).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, good).kind).toBe("NOT_RUN");
  });

  it.each(["clever-mockingbird-719", "kindly-hound-172", "focused-starfish-265"])(
    "refuses production %s even when the backend attests and the lane holds a nonce",
    (name) => {
      const prodUrl = `https://${name}.convex.cloud`;
      const attested = with_({ deploymentName: name, markerDeploymentName: name });
      expect(decideReplayEnvironment(prodUrl, attested, lane).kind).toBe("REFUSED");
      expect(decideReplayEnvironment(prodUrl, null, lane).kind).toBe("REFUSED");
      expect(decideReplayEnvironment(prodUrl, with_({ attested: false, reasons: ["NO_MARKER"] }), lane).kind).toBe("REFUSED");
      expect(decideReplayEnvironment(prodUrl, attested, {}).kind).toBe("REFUSED");
      // A preview URL whose backend or marker names production is refused too.
      expect(decideReplayEnvironment(url, with_({ deploymentName: name }), lane).kind).toBe("REFUSED");
      expect(decideReplayEnvironment(url, with_({ markerDeploymentName: name }), lane).kind).toBe("REFUSED");
    }
  );

  it("refuses when the URL, the backend and the marker do not name one deployment", () => {
    expect(decideReplayEnvironment(url, with_({ deploymentName: "other-fox-9" }), lane).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(url, with_({ markerDeploymentName: "other-fox-9" }), lane).kind).toBe("REFUSED");
    expect(decideReplayEnvironment("https://other-fox-9.convex.cloud", good, lane).kind).toBe("REFUSED");
  });

  it("refuses an attested deployment that does not name itself everywhere", () => {
    expect(decideReplayEnvironment(url, with_({ deploymentName: null }), lane).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(url, with_({ markerDeploymentName: null }), lane).kind).toBe("REFUSED");
    expect(decideReplayEnvironment("http://localhost:3210", good, lane).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(undefined, good, lane).kind).toBe("REFUSED");
  });

  it("is NOT RUN when the organization was not created by the seed recently", () => {
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: REPLAY_MAX_ORG_AGE_MS + 1 }), lane).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: null }), lane).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: -1 }), lane).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: REPLAY_MAX_ORG_AGE_MS }), lane).kind).toBe("RUN");
  });
});

describe("replayLaneAction", () => {
  it("runs on RUN, fails on REFUSED, and skips a NOT RUN unless the lane requires the replay", () => {
    expect(replayLaneAction({ kind: "RUN", deployment: "d" }, false)).toEqual({ action: "RUN" });
    expect(replayLaneAction({ kind: "RUN", deployment: "d" }, true)).toEqual({ action: "RUN" });
    expect(replayLaneAction({ kind: "REFUSED", reason: "r" }, false).action).toBe("FAIL");
    expect(replayLaneAction({ kind: "REFUSED", reason: "r" }, true).action).toBe("FAIL");
    expect(replayLaneAction({ kind: "NOT_RUN", reason: "r" }, false).action).toBe("SKIP");
    expect(replayLaneAction({ kind: "NOT_RUN", reason: "r" }, true)).toMatchObject({
      action: "FAIL",
      reason: expect.stringContaining("requires it"),
    });
  });
});

describe("replayOrgRefusals", () => {
  const fresh: ReplayOrgFacts = {
    currency: "JOD",
    periodCount: 0,
    journalCount: 0,
    openingBalancePosted: false,
    pendingOpeningDraft: false,
    canPostDirectly: true,
    usableAccountCount: 2,
  };

  it("allows an organization with nothing the mutation would refuse", () => {
    expect(replayOrgRefusals(fresh)).toEqual([]);
  });

  it.each([
    ["a period", { periodCount: 1 }],
    ["a posted or reversed journal in any status", { journalCount: 1 }],
    ["a posted opening balance", { openingBalancePosted: true }],
    ["a pending opening draft", { pendingOpeningDraft: true }],
    ["a seat that cannot post directly", { canPostDirectly: false }],
    ["fewer than two usable accounts", { usableAccountCount: 1 }],
    ["an unsupported currency", { currency: "XYZ" }],
    ["a non-canonical currency", { currency: "jod" }],
    ["an empty currency", { currency: "" }],
  ] as const)("refuses %s", (_name, over) => {
    expect(replayOrgRefusals({ ...fresh, ...over })).toHaveLength(1);
  });

  it("reports every reason at once", () => {
    expect(replayOrgRefusals({ ...fresh, periodCount: 2, journalCount: 3, currency: "XYZ" })).toHaveLength(3);
  });
});
