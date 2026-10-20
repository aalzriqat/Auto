import { describe, expect, it } from "vitest";
import {
  decideReplayEnvironment,
  deploymentNameOf,
  replayOrgRefusals,
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

describe("decideReplayEnvironment", () => {
  const preview = "https://happy-otter-123.convex.cloud";

  it.each(["clever-mockingbird-719", "kindly-hound-172", "focused-starfish-265"])("refuses production %s whatever else is set", (name) => {
    expect(decideReplayEnvironment(`https://${name}.convex.cloud`, undefined).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(`https://${name}.convex.cloud`, name).kind).toBe("REFUSED");
    expect(decideReplayEnvironment(preview, name).kind).toBe("REFUSED");
  });

  it("is NOT RUN, never a run, when no disposable deployment was named", () => {
    expect(decideReplayEnvironment(preview, undefined).kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(preview, "  ").kind).toBe("NOT_RUN");
    expect(decideReplayEnvironment(undefined, undefined).kind).toBe("NOT_RUN");
  });

  it("refuses when the URL is not the deployment that was named, or names no deployment", () => {
    expect(decideReplayEnvironment(preview, "other-fox-9").kind).toBe("REFUSED");
    expect(decideReplayEnvironment("http://localhost:3210", "happy-otter-123").kind).toBe("REFUSED");
    expect(decideReplayEnvironment(undefined, "happy-otter-123").kind).toBe("REFUSED");
  });

  it("runs only when the named disposable deployment is the one addressed", () => {
    expect(decideReplayEnvironment(preview, "happy-otter-123")).toEqual({ kind: "RUN", deployment: "happy-otter-123" });
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

  it("allows a freshly created organization", () => {
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
