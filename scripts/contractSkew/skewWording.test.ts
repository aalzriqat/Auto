import { describe, expect, test } from "vitest";
import { skewSummary } from "./skewWording.mjs";

/**
 * SCRUM-178 v2 F5-3. With `--spec` the spec's origin is not known to be
 * production, so the summary must not say so and must not tell anyone to deploy.
 */
const base = { specSource: "spec-dev.json, https://vibrant-cat-418.convex.cloud", proven: 1, unclassified: 2, basis: "b" };

describe("skewSummary", () => {
  test("a SUPPLIED spec file: target-neutral wording, no deploy instruction", () => {
    const text = skewSummary({ ...base, rung: "SUPPLIED_FILE" });
    expect(text).toMatch(/CONTRACT SKEW against the supplied spec \(spec-dev\.json, https:\/\/vibrant-cat-418\.convex\.cloud\)/);
    expect(text).not.toMatch(/PRODUCTION/);
    expect(text).not.toMatch(/Deploy the Convex backend/);
    expect(text).toContain("1 proven, 2 unclassified");
  });

  test("a spec FETCHED through the credential ladder keeps the production wording", () => {
    const text = skewSummary({ ...base, rung: "REPO_READ_KEY" });
    expect(text).toMatch(/^PRODUCTION SKEW — 1 proven, 2 unclassified\. Deploy the Convex backend at this commit\./);
  });
});
