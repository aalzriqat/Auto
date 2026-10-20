import { describe, expect, it } from "vitest";
import {
  decideReplayEnvironment,
  deploymentNameOf,
  replayOrgRefusals,
  REPLAY_MAX_ORG_AGE_MS,
  type ReplayAttestation,
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

describe("decideReplayEnvironment (allow-list on the backend's own attestation)", () => {
  const url = "https://happy-otter-123.convex.cloud";
  const good: ReplayAttestation = {
    attested: true,
    reasons: [],
    deploymentName: "happy-otter-123",
    markerDeploymentName: "happy-otter-123",
    orgAgeMs: 60_000,
  };
  const with_ = (over: Partial<ReplayAttestation>): ReplayAttestation => ({ ...good, ...over });

  it("runs only on a positive attestation whose URL, backend and marker name one deployment", () => {
    expect(decideReplayEnvironment(url, good, true)).toEqual({ kind: "RUN", deployment: "happy-otter-123" });
  });

  it("is NOT RUN, never a run, when the marker or attestation is missing or unreadable", () => {
    expect(decideReplayEnvironment(url, null, true).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, undefined, true).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ attested: false, reasons: ["NO_MARKER"] }), true).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ attested: false, reasons: ["CLASS_NOT_PREVIEW"] }), true)).toMatchObject({
      kind: "NOT_RUN",
      reason: expect.stringContaining("CLASS_NOT_PREVIEW"),
    });
  });

  it("is NOT RUN unless the lane declares the org dedicated, even with a positive attestation", () => {
    expect(decideReplayEnvironment(url, good, false).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, good).kind).toBe("NOT_RUN");
  });

  it("still refuses production when the dedicated-org flag is absent", () => {
    expect(decideReplayEnvironment("https://clever-mockingbird-719.convex.cloud", good, false).kind).toBe("REFUSED");
  });

  it("does not trust an operator-supplied name: an attestation of false stays NOT RUN whatever the URL says", () => {
    expect(decideReplayEnvironment(url, with_({ attested: false, reasons: [] }), true).kind).toBe("NOT_RUN");
  });

  it.each(["clever-mockingbird-719", "kindly-hound-172", "focused-starfish-265"])(
    "refuses production %s even when the backend attests (a marker on a prod-named deployment)",
    (name) => {
      const prodUrl = `https://${name}.convex.cloud`;
      expect(decideReplayEnvironment(prodUrl, with_({ deploymentName: name, markerDeploymentName: name }), true).kind).toBe("REFUSED");
      expect(decideReplayEnvironment(prodUrl, null, true).kind).toBe("REFUSED");
      expect(decideReplayEnvironment(prodUrl, with_({ attested: false, reasons: ["NO_MARKER"] }), true).kind).toBe("REFUSED");
      // A preview URL whose backend or marker names production is refused too.
      expect(decideReplayEnvironment(url, with_({ deploymentName: name }), true).kind).toBe("REFUSED");
      expect(decideReplayEnvironment(url, with_({ markerDeploymentName: name }), true).kind).toBe("REFUSED");
    }
  );

  it("refuses when the URL, the backend and the marker do not name one deployment", () => {
    expect(decideReplayEnvironment(url, with_({ deploymentName: "other-fox-9" }), true).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(url, with_({ markerDeploymentName: "other-fox-9" }), true).kind).toBe("REFUSED");
    expect(decideReplayEnvironment("https://other-fox-9.convex.cloud", good, true).kind).toBe("REFUSED");
  });

  it("refuses an attested deployment that does not name itself everywhere", () => {
    expect(decideReplayEnvironment(url, with_({ deploymentName: null }), true).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(url, with_({ markerDeploymentName: null }), true).kind).toBe("REFUSED");
    expect(decideReplayEnvironment("http://localhost:3210", good, true).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(undefined, good, true).kind).toBe("REFUSED");
  });

  it("is NOT RUN when the organization was not created by the seed recently", () => {
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: REPLAY_MAX_ORG_AGE_MS + 1 }), true).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: null }), true).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: -1 }), true).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(url, with_({ orgAgeMs: REPLAY_MAX_ORG_AGE_MS }), true).kind).toBe("RUN");
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
