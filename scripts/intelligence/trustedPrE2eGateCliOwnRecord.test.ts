// @vitest-environment node
import { describe, expect, it } from "vitest";
import { scenario } from "../../test-utils/trustedPrE2eGateCliScenario";

describe("SCRUM-990 admission publishes one gate record", () => {
  // SCRUM-990: initialize then final publication in ONE invocation, with the
  // commit listing still lagging, must leave exactly one record.
  it("updates its own initialize record when the commit listing lags", async () => {
    const { records, verdict, publications } = await scenario({
      mode: "initialize", files: ["app/page.tsx"], listingLag: 1,
    });
    expect(records).toHaveLength(1);
    expect(records[0].conclusion).toBe("failure");
    expect(verdict).toMatchObject({ conclusion: "failure", reason: "The secret-free PR preflight did not succeed." });
    expect(verdict).not.toHaveProperty("refusal");
    expect(publications.filter((body) => body.head_sha)).toHaveLength(1);
  });

  // Round 2: listing lag plus an unreadable own record must refuse, never POST a
  // second record. Waits the real 1 s + 2 s confirmation backoff.
  it("refuses with the fixed string and one record when its own record cannot be confirmed", async () => {
    const { records, verdict, publications } = await scenario({
      mode: "initialize", files: ["app/page.tsx"], listingLag: 100, ownReadFails: true,
    });
    expect(records).toHaveLength(1);
    expect(records[0].conclusion).toBe("failure");
    expect(publications.filter((body) => body.head_sha)).toHaveLength(1);
    expect(verdict).toEqual({
      conclusion: "failure",
      reason: "The gate record created by this run could not be confirmed; rerun the admission job.",
      refusal: true,
    });
  }, 20000);
});
