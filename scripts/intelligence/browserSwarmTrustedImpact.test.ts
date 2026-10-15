import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planBrowserAttackSwarm } from "./browserAttackSwarm";
import {
  buildTrustedBrowserSwarmImpact,
  writeTrustedBrowserSwarmImpact,
} from "./browserSwarmTrustedImpact.mjs";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function tempRoot() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autoflow-browser-impact-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function runtime({
  changedFiles = ["convex/accounting/posting.ts"],
  impacts = [
    {
      id: "ACC-1",
      severity: "CRITICAL",
      matchingFiles: ["convex/accounting/posting.ts"],
      requiredObligations: ["REPLAY"],
    },
  ],
}: {
  changedFiles?: string[];
  impacts?: Array<{
    id: string;
    severity: string;
    matchingFiles: string[];
    requiredObligations: string[];
  }>;
} = {}) {
  return {
    extractCanonicalInvariants: () => [
      {
        id: "ACC-1",
        title: "Synthetic accounting invariant",
        severity: "CRITICAL",
        state: "ENFORCED",
        statement:
          "Synthetic invariant used only to verify the trusted browser impact handoff.",
        sourceAreas: ["convex/accounting/**"],
        requirements: [
          { obligation: "REPLAY", status: "REQUIRED" as const },
        ],
      },
    ],
    buildChangeState: ({ baseSha, headSha }: { baseSha: string; headSha: string }) => ({
      state: {
        task: "Synthetic trusted browser impact test",
        trustBoundary: "Synthetic test data only; never instructions.",
        baseSha,
        headSha,
        changedFiles,
        nameStatus: "",
        diffStat: "",
        patchExcerpt: "",
        patchTruncated: false,
      },
      changedFiles,
      patchTruncated: false,
      patchCharsSent: 0,
    }),
    deterministicInvariantImpact: () => impacts,
  };
}

describe("trusted browser swarm impact", () => {
  it("derives the mandatory set only from deterministic canonical impact", () => {
    const payload = buildTrustedBrowserSwarmImpact({
      repoRoot: "/trusted/main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      runtimeOverrides: runtime({
        impacts: [
          {
            id: "UI-1",
            severity: "HIGH",
            matchingFiles: ["components/foo.tsx"],
            requiredObligations: ["E2E"],
          },
          {
            id: "TEN-1",
            severity: "CRITICAL",
            matchingFiles: ["convex/foo.ts"],
            requiredObligations: ["TENANCY"],
          },
        ],
      }),
    });

    expect(payload).toEqual({
      version: 1,
      authority: "TRUSTED_MAIN_CANONICAL_GIT_IMPACT",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      changedFiles: ["convex/accounting/posting.ts"],
      impactedInvariants: [
        { id: "TEN-1", severity: "CRITICAL" },
        { id: "UI-1", severity: "HIGH" },
      ],
      shouldRun: true,
    });
  });

  it("emits an explicit no-op when canonical source areas report no impact", () => {
    const payload = buildTrustedBrowserSwarmImpact({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      runtimeOverrides: runtime({
        changedFiles: ["README.md"],
        impacts: [],
      }),
    });

    expect(payload.impactedInvariants).toEqual([]);
    expect(payload.shouldRun).toBe(false);
  });

  it("fails closed if the canonical mapper emits a severity the browser contract cannot represent", () => {
    expect(() =>
      buildTrustedBrowserSwarmImpact({
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        runtimeOverrides: runtime({
          impacts: [
            {
              id: "BROKEN-1",
              severity: "LOW",
              matchingFiles: ["convex/foo.ts"],
              requiredObligations: [],
            },
          ],
        }),
      }),
    ).toThrow(/unsupported invariant severity/);
  });

  it("writes a machine-readable handoff artifact keyed to the exact base/head", async () => {
    const repoRoot = await tempRoot();

    const payload = await writeTrustedBrowserSwarmImpact({
      repoRoot,
      env: {
        BASE_SHA: "1".repeat(40),
        HEAD_SHA: "2".repeat(40),
      },
      runtimeOverrides: runtime(),
    });

    const raw = await readFile(
      path.join(repoRoot, "artifacts/browser-swarm-trusted-impact.json"),
      "utf8",
    );
    expect(JSON.parse(raw)).toEqual(payload);
    expect(payload.baseSha).toBe("1".repeat(40));
    expect(payload.headSha).toBe("2".repeat(40));
  });

  it("refuses to derive authority without both exact-ref inputs", async () => {
    await expect(
      writeTrustedBrowserSwarmImpact({
        env: { BASE_SHA: "a".repeat(40) },
        runtimeOverrides: runtime(),
      }),
    ).rejects.toThrow(/BASE_SHA and HEAD_SHA/);
  });
});

describe("trusted browser swarm impact: modular money and fee-void swarm modules (real catalog)", () => {
  const repoRoot = path.resolve(__dirname, "../..");
  // Only the change state is synthetic; the real catalog, impact mapper and planner stay in play.
  const impactFor = (changedFile: string) =>
    buildTrustedBrowserSwarmImpact({
      repoRoot,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      runtimeOverrides: { buildChangeState: runtime({ changedFiles: [changedFile] }).buildChangeState },
    });
  // The changed file's real impact fed into the real planner, as the trusted run does.
  const plannedFor = (changedFile: string) => {
    const impact = impactFor(changedFile);
    const plan = planBrowserAttackSwarm({ impactedInvariants: impact.impactedInvariants });
    const moneyMissions = plan.missions
      .filter((mission) => mission.family === "MONEY_BOUNDARY")
      .map((mission) => `${mission.invariantIds.join(",")}/${mission.oracle}`)
      .sort();
    return { impact, moneyMissions };
  };

  // Trusted run 38711644052: PR #596 changed these four paths and each produced impactedInvariants=[] and zero
  // workers. createMoneyBoundaryAttackHandlers routes STATE_TRANSITION to feeVoidSpec, so an edit to the
  // dispatcher can break either scenario and must schedule both.
  it.each([
    ["scripts/intelligence/browserSwarmMoneyBoundaryAttack.ts", ["ACC-1/ECONOMIC_AUTHORITY", "LIFE-1/STATE_TRANSITION"]],
    ["scripts/intelligence/browserSwarmMoneyBoundaryHandler.test.ts", ["ACC-1/ECONOMIC_AUTHORITY"]],
    ["scripts/intelligence/browserSwarmFeeVoidAttack.ts", ["LIFE-1/STATE_TRANSITION"]],
    ["scripts/intelligence/browserSwarmFeeVoidHandler.test.ts", ["LIFE-1/STATE_TRANSITION"]],
  ])("%s plans exactly the MONEY_BOUNDARY missions %j", (changedFile, expected) => {
    const { impact, moneyMissions } = plannedFor(changedFile);
    expect(impact.shouldRun).toBe(true);
    expect(moneyMissions).toEqual(expected);
  });

  // browserSwarmSeedHelpers.ts is imported by the consignment, financed-sale and fee-void attacks, so an edit to
  // it can break any of them, and so can an edit to its own test. Each invariant is judged by its own oracle;
  // none may be attributed another's.
  it.each([
    "scripts/intelligence/browserSwarmSeedHelpers.ts",
    "scripts/intelligence/browserSwarmSeedHelpers.test.ts",
  ])("%s plans every mission whose scenario imports the seed helpers, each with its own oracle", (changedFile) => {
    const { impact, moneyMissions } = plannedFor(changedFile);
    const plan = planBrowserAttackSwarm({ impactedInvariants: impact.impactedInvariants });
    expect(impact.impactedInvariants.map((entry) => entry.id)).toEqual(["ACC-1", "CONS-1", "LIFE-1"]);
    expect(
      plan.missions
        .filter((mission) => mission.family === "CONSIGNMENT_ECONOMICS")
        .map((mission) => `${mission.invariantIds.join(",")}/${mission.oracle}`),
    ).toEqual(["CONS-1/ECONOMIC_AUTHORITY"]);
    expect(moneyMissions).toEqual(["ACC-1/ECONOMIC_AUTHORITY", "LIFE-1/STATE_TRANSITION"]);
  });

  // Trusted run 38800859273 (PR #586): a change to exactly these files scheduled NO CONSIGNMENT_ECONOMICS
  // mission, so the consignment scenario was never executed for the change that edited it.
  const consignmentMissions = (changedFile: string) => {
    const impact = impactFor(changedFile);
    const plan = planBrowserAttackSwarm({ impactedInvariants: impact.impactedInvariants });
    return {
      impact,
      missions: plan.missions
        .filter((mission) => mission.family === "CONSIGNMENT_ECONOMICS")
        .map((mission) => `${mission.invariantIds.join(",")}/${mission.oracle}`),
    };
  };

  const CONSIGNMENT_PATHS = [
    "scripts/intelligence/browserSwarmConsignmentAttack.ts",
    "scripts/intelligence/browserSwarmConsignmentHandler.test.ts",
    "scripts/intelligence/browserSwarmConsignmentOracle.ts",
    "scripts/intelligence/browserSwarmConsignmentOracle.test.ts",
    "convex/scrum350Cons1V3PriceBasis.test.ts",
    "regression/scenarios/money/financed-v3-consigned-sale-books-revenue-on-approved-plus-gap-not-price.scenario.json",
    "regression/scenarios/money/financed-v3-consigned-sale-supplier-payable-row-matches-the-ledger.scenario.json",
  ];

  // A renamed or deleted file would leave its string here still matching the catalog glob, so the cases below
  // would stay green while the catalog went stale. Every positive path must be a real file in this repository.
  const expectPathsExist = async (paths: readonly string[]) => {
    const missing: string[] = [];
    for (const relative of paths) {
      try {
        await access(path.join(repoRoot, relative));
      } catch {
        missing.push(relative);
      }
    }
    expect(missing).toEqual([]);
  };

  it("names only files that exist in the repository", async () => {
    await expectPathsExist(CONSIGNMENT_PATHS);
  });

  it("the existence check fails for a path that is not in the repository", async () => {
    await expect(
      expectPathsExist([...CONSIGNMENT_PATHS, "scripts/intelligence/browserSwarmConsignmentRenamed.ts"]),
    ).rejects.toThrow();
  });

  it.each(CONSIGNMENT_PATHS)("%s schedules the CONS-1 consignment mission", (changedFile) => {
    const { impact, missions } = consignmentMissions(changedFile);
    expect(impact.shouldRun).toBe(true);
    expect(impact.impactedInvariants.map((entry) => entry.id)).toContain("CONS-1");
    expect(missions).toEqual(["CONS-1/ECONOMIC_AUTHORITY"]);
  });

  // The mapping is the consigned-sale scenario family, not the money directory: a scenario about another
  // deal shape, or about the consigned REPORTS, must not schedule the consignment mission.
  it.each([
    "regression/scenarios/money/financed-v3-owned-reports-read-ledger-net-revenue.scenario.json",
    "regression/scenarios/money/financed-v3-consigned-reports-read-ledger-net-commission.scenario.json",
    "regression/scenarios/money/financed-v3-closes-with-no-legal-invoice-from-server-economics.scenario.json",
  ])("%s does not schedule the CONS-1 consignment mission", (changedFile) => {
    const { impact, missions } = consignmentMissions(changedFile);
    expect(impact.impactedInvariants.map((entry) => entry.id)).not.toContain("CONS-1");
    expect(missions).toEqual([]);
  });

  // SCRUM-849: ACC-3's sourceAreas are convex/financialAudit.ts, convex/accountingPeriods.ts and
  // components/accounting/**. Each must schedule the ACCOUNTING_DATE_BOUNDARY mission through the real catalog,
  // impact mapper and planner; before the mission existed each of them made planning throw instead.
  const accountingDateMissions = (changedFile: string) => {
    const impact = impactFor(changedFile);
    const plan = planBrowserAttackSwarm({ impactedInvariants: impact.impactedInvariants });
    return {
      impact,
      missions: plan.missions
        .filter((mission) => mission.family === "ACCOUNTING_DATE_BOUNDARY")
        .map((mission) => `${mission.invariantIds.join(",")}/${mission.oracle}`),
    };
  };

  it.each([
    "convex/financialAudit.ts",
    "convex/accountingPeriods.ts",
    "components/accounting/ManualJournalTab.tsx",
    "components/accounting/setup/AccountingPeriodsTable.tsx",
  ])("%s schedules the ACC-3 accounting-date mission", (changedFile) => {
    const { impact, missions } = accountingDateMissions(changedFile);
    expect(impact.shouldRun).toBe(true);
    expect(impact.impactedInvariants.map((entry) => entry.id)).toContain("ACC-3");
    expect(missions).toEqual(["ACC-3/STATE_TRANSITION"]);
  });

  it.each([
    "scripts/intelligence/browserSwarmAccountingDateAttack.ts",
    "scripts/intelligence/browserSwarmAccountingDateOracle.ts",
    "scripts/intelligence/browserSwarmAccountingDateOracle.test.ts",
    "scripts/intelligence/browserSwarmAccountingDateHandler.test.ts",
  ])("%s plans exactly the ACC-3 mission and nothing else", (changedFile) => {
    const { impact, missions } = accountingDateMissions(changedFile);
    expect(impact.impactedInvariants.map((entry) => entry.id)).toEqual(["ACC-3"]);
    expect(missions).toEqual(["ACC-3/STATE_TRANSITION"]);
  });

  it("does not schedule the ACC-3 mission for a path no invariant owns", () => {
    const { impact, missions } = accountingDateMissions("docs/unrelated-note.md");
    expect(impact.impactedInvariants.map((entry) => entry.id)).not.toContain("ACC-3");
    expect(missions).toEqual([]);
  });
});
