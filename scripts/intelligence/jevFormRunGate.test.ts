import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { explorerDidNotRun } from "./jevFormRunGate";

describe("explorerDidNotRun (SCRUM-771: an opted-in explorer that cannot explore fails)", () => {
  it("fails on an attestation refusal", () => {
    expect(explorerDidNotRun({ refusal: "Form explorer runs against a local app only." })).toMatch(/attestation refused: Form explorer runs/);
  });

  it("fails when the app opened an organization other than the attested one", () => {
    expect(explorerDidNotRun({ openedOrgId: "org_b", attestedOrgId: "org_a" })).toMatch(/opened organization org_b, not the attested QA organization org_a/);
  });

  it("fails on zero attempts when the budget asked for some", () => {
    expect(explorerDidNotRun({ maxAttempts: 30, attempts: 0 })).toMatch(/no attempt was made/);
  });

  it("lets an attested run in the right org go on, and passes a run that attacked", () => {
    expect(explorerDidNotRun({})).toBeUndefined();
    expect(explorerDidNotRun({ openedOrgId: "org_a", attestedOrgId: "org_a" })).toBeUndefined();
    expect(explorerDidNotRun({ maxAttempts: 30, attempts: 1 })).toBeUndefined();
    expect(explorerDidNotRun({ maxAttempts: 0, attempts: 0 })).toBeUndefined();
  });

  // The gate only works if the spec routes every "did not explore" exit through it.
  it("the spec throws on every such exit instead of skipping or passing empty", () => {
    const spec = readFileSync(path.join(process.cwd(), "playwright", "scenarios", "jev-form-explorer.spec.ts"), "utf8");
    // The only skip left is the opt-in itself.
    expect(spec.match(/test\.skip\(/g)).toHaveLength(1);
    expect(spec).toContain('test.skip(process.env.JEV_FORM_EXPLORER !== "1"');
    expect(spec).toContain("explorerDidNotRun({ refusal: attestation.refusal })");
    expect(spec).toContain("explorerDidNotRun({ openedOrgId: orgId, attestedOrgId: attestation.orgId })");
    expect(spec).toContain("explorerDidNotRun({ maxAttempts: MAX_ATTEMPTS, attempts: records.length })");
    // Bounded at one 30-minute attempt so the GL library after it always gets its time.
    expect(spec).toContain("test.describe.configure({ timeout: 1_800_000, retries: 0 })");
  });
});
