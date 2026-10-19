import { describe, expect, it } from "vitest";
import {
  PRODUCTION_DEPLOYMENTS,
  namesProduction,
  servesOtherThan,
} from "../playwright/scenarios/productionGuard";

// Both explorers (jev-explorer, formExplorer) refuse through these two
// functions. Dropping either production name must fail here.
describe("explorer production guard", () => {
  it("lists exactly the live and the earlier production deployment", () => {
    expect([...PRODUCTION_DEPLOYMENTS]).toEqual(["clever-mockingbird-719", "kindly-hound-172"]);
  });

  it.each(["clever-mockingbird-719", "kindly-hound-172"])("refuses a configured URL naming %s", (name) => {
    expect(namesProduction(`https://${name}.convex.cloud`)).toBe(true);
  });

  it("accepts a preview URL and an unset URL", () => {
    expect(namesProduction("https://happy-otter-123.convex.cloud")).toBe(false);
    expect(namesProduction(undefined)).toBe(false);
  });

  it.each(["clever-mockingbird-719", "kindly-hound-172"])("refuses a served app on %s even if it is the expected name", (name) => {
    expect(servesOtherThan([name], name)).toBe(true);
  });

  it("refuses any served deployment other than the expected preview, and accepts only the preview", () => {
    expect(servesOtherThan(["happy-otter-123", "other-fox-9"], "happy-otter-123")).toBe(true);
    expect(servesOtherThan(["happy-otter-123"], "happy-otter-123")).toBe(false);
  });
});
