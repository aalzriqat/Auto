import { describe, expect, test } from "vitest";
import { accountingRehearsalPathGate } from "./accountingRehearsalPathGate.mjs";

describe("SCRUM-883 trusted PR backend inputs", () => {
  test.each([
    "convex/sales.ts", "lib/money.ts", "packages/shared/src/money.ts",
    "packages/shared/package.json", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
    "convex.json", "tsconfig.json", "scripts/accountingCleanupRehearsal.mjs",
    "scripts/accountingPreviewRehearsal.mjs", "scripts/e2ePreviewBootstrap.mjs",
    "scripts/intelligence/stageCandidateBackend.mjs", "regression/scenarios/money/case.json",
    ".github/workflows/accounting-rehearsal.yml", ".github/workflows/trusted-accounting-rehearsal.yml",
    "new-unknown-folder/file.ts", "scripts/new-helper.mjs",
  ])("runs for backend or unknown input %s", path => {
    expect(accountingRehearsalPathGate({ paths: [path], complete: true }).run).toBe(true);
  });

  test.each([
    { paths: ["app/page.tsx", "public/logo.svg"] }, { paths: ["components/Deal.tsx"] },
    { paths: ["docs/release.md", "README.md"] }, { paths: ["scripts/contractSkew/reader.ts"] },
  ])("does not apply for a complete frontend/docs/contract-skew diff %j", ({ paths }) => {
    expect(accountingRehearsalPathGate({ paths, complete: true })).toEqual({
      run: false, reason: "NOT_APPLICABLE: no backend input changed",
    });
  });

  test.each([
    { paths: [], complete: true }, { paths: ["app/page.tsx"], complete: false },
    { paths: undefined, complete: true }, { paths: ["components/A.tsx", "convex/sales.ts"], complete: true },
    { paths: ["components/../convex/sales.ts"], complete: true },
    { paths: ["docs\\file.md"], complete: true }, { paths: [""], complete: true },
  ])("runs when the list is empty, incomplete, ambiguous or mixed: %j", evidence => {
    expect(accountingRehearsalPathGate(evidence).run).toBe(true);
  });
});
