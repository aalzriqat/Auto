import { describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { fetchDeployedSpec } from "./fetchSpec.mjs";

/**
 * ⚠️ THE MISMATCH HAS TO BE PROVEN THROUGH A CREDENTIAL RUNG, NOT ONLY THROUGH
 * `--spec`. THE FILE PATH IS THE ONE THAT WAS ALREADY SAFE.
 *
 * `fetchDeployedSpec` refuses a wrong-deployment spec by throwing from
 * `finish()`. Every existing test proves that through the `specFile` branch —
 * and that branch sits OUTSIDE every `try`, so it always propagated. The
 * credential rungs called `finish()` INSIDE their `try`, so the same throw was
 * swallowed, recorded as "this rung failed", and the loop moved on. The run
 * then returned
 *
 *     unavailable: true
 *     reason: "no credential could read the production function spec"
 *
 * which is FALSE — the credential read a spec perfectly well, and it addressed
 * the WRONG BACKEND. The true cause survived only inside `tried[0]`, where
 * nothing reads it, while the headline sent a responder to investigate
 * credentials during exactly the incident this control exists to shorten.
 *
 * The existing tests could not see it because they never went through a rung.
 * These do: `execFileSync` is stubbed so the CLI "succeeds" and hands back a
 * parseable spec belonging to a different deployment.
 *
 * ⚠️ THIS LIVES IN ITS OWN FILE ON PURPOSE. `vi.mock` is hoisted and file-
 * scoped, so declaring it inside `fetchSpec.test.ts` would replace
 * `node:child_process` for every test in that file. Isolating it keeps the
 * rest of the suite running against the real module.
 */
vi.mock("node:child_process", () => {
  // A default export as well as the named one: other modules in this import
  // graph consume `node:child_process` as a default, and a mock that omits it
  // fails to load rather than failing an assertion.
  const execFileSync = vi.fn(() =>
    JSON.stringify({ url: "https://some-other-backend.convex.cloud", functions: [] })
  );
  return { execFileSync, default: { execFileSync } };
});

describe("a wrong deployment reached through a CREDENTIAL RUNG is a hard failure", () => {
  /** The rung the scheduled monitor actually uses. Value assembled, never a literal. */
  const withRungKey = (run: () => void) => {
    const saved = process.env.CONVEX_PROD_READ_KEY;
    process.env.CONVEX_PROD_READ_KEY = ["prod", ":", "kindly-hound-172", "|", "not-a-real-value-", "0000"].join("");
    try {
      run();
    } finally {
      if (saved) process.env.CONVEX_PROD_READ_KEY = saved;
      else delete process.env.CONVEX_PROD_READ_KEY;
    }
  };

  test("the stub really does make a rung succeed — otherwise the tests below prove nothing", () => {
    // Without this control every assertion here would also pass if no rung ran
    // at all: an absent credential and a wrong-deployment spec both end in "not
    // ok". Prove the CLI path is genuinely reached before relying on it.
    withRungKey(() => {
      let threw: unknown;
      try {
        fetchDeployedSpec({});
      } catch (error) {
        threw = error;
      }
      expect(threw, "no identity was requested, so a successful read must not throw").toBeUndefined();
      expect(vi.mocked(execFileSync), "the credential rung never invoked the CLI").toHaveBeenCalled();
    });
  });

  test("the identity mismatch PROPAGATES rather than being swallowed by the rung catch", () => {
    withRungKey(() => {
      expect(() => fetchDeployedSpec({ expectedDeployment: "kindly-hound-172" })).toThrow(
        /Refusing to report on a deployment nobody is served by/
      );
    });
  });

  test("and it is NEVER downgraded to a credential failure", () => {
    // ⚠️ THE ASSERTION THAT PINS THE DEFECT ITSELF. Before the fix this call
    // RETURNED rather than threw, carrying a reason that named the wrong
    // system. A test asserting only "it did not succeed" would have passed then
    // too — which is precisely how this survived every earlier round.
    withRungKey(() => {
      let returned: unknown;
      try {
        returned = fetchDeployedSpec({ expectedDeployment: "kindly-hound-172" });
      } catch {
        return; // throwing is the correct behaviour; there is nothing to inspect
      }
      expect(
        returned,
        "a wrong-deployment spec must never be reported as 'no credential could read the production function spec'"
      ).toBeUndefined();
    });
  });

  test("a MALFORMED expected deployment also propagates through a rung", () => {
    // The other throw inside `finish()`, swallowed by the same catch.
    withRungKey(() => {
      expect(() => fetchDeployedSpec({ expectedDeployment: "prod:kindly-hound-172" })).toThrow(
        /is not a deployment name/
      );
    });
  });

  test("a GENUINE command failure still falls through to UNAVAILABLE", () => {
    // The control that stops the fix over-correcting. Only the identity verdict
    // was meant to escape; a real CLI failure must remain a rung that did not
    // work, not an exception out of the whole control.
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("convex: command failed");
    });
    withRungKey(() => {
      const result = fetchDeployedSpec({ expectedDeployment: "kindly-hound-172" }) as {
        unavailable?: boolean;
        reason?: string;
      };
      expect(result.unavailable).toBe(true);
      expect(result.reason).toMatch(/no credential could read the production function spec/);
    });
  });
});
