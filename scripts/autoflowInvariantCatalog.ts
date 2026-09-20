import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type InvariantSeverity = "CRITICAL" | "HIGH";
export type InvariantState = "ENFORCED" | "PARTIAL";
export type ProofKind = "EXECUTION" | "STRUCTURAL" | "PREVIEW";

export interface InvariantProof {
  path: string;
  kind: ProofKind;
  note: string;
  /**
   * Required for STRUCTURAL evidence. It means the referenced guard has a
   * deliberate fault / negative-control test proving that the guard can turn red.
   */
  negativeControl?: boolean;
}

export interface InvariantDefinition {
  id: string;
  title: string;
  severity: InvariantSeverity;
  state: InvariantState;
  statement: string;
  sourceAreas: readonly string[];
  proofs: readonly InvariantProof[];
  /**
   * Required while state is PARTIAL. The issue owns the gap between the exact
   * invariant statement and the evidence currently present in the repository.
   */
  tracking?: string;
  /**
   * What the evidence does and does not prove. This is intentionally mandatory:
   * green evidence with an unstated boundary is how narrow tests get misread as
   * whole-system proof.
   */
  evidenceBoundary: string;
}

/**
 * Canonical repository-level invariant catalog.
 *
 * IMPORTANT:
 * - ENFORCED applies to the exact statement below, not to every nearby concern.
 * - PARTIAL is not a failure badge. It is an explicit refusal to overclaim.
 * - This catalog references existing proofs; it does not replace them.
 */
export const AUTOFLOW_INVARIANTS: readonly InvariantDefinition[] = [
  {
    id: "TEN-1",
    title: "Tenant isolation",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "A tenant-scoped operation must not read, write, mutate, or link a resource that belongs to another organization.",
    sourceAreas: ["convex/**", "test-utils/**"],
    proofs: [
      {
        path: "scripts/tenantWriteGuard.test.ts",
        kind: "STRUCTURAL",
        negativeControl: true,
        note:
          "Repository census for caller-addressed tenant writes, with analyzer self-tests and coverage ratchets.",
      },
      {
        path: "convex/saleCompletionTenancyGuards.test.ts",
        kind: "EXECUTION",
        note:
          "Execution proof for canonical sale-completion relationships and cross-organization resource refusal.",
      },
    ],
    tracking: "SCRUM-342",
    evidenceBoundary:
      "The write census and sale-completion execution tests are strong evidence for their covered shapes, but they are not yet a source-complete proof of every read path, every helper-mediated relation, and every future tenant-bearing table.",
  },
  {
    id: "AUTH-1",
    title: "Authorization and segregation of duties",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Sensitive economic lifecycle actions must be authorized server-side, and transitions requiring separation of duties must reject the prohibited same-actor case.",
    sourceAreas: ["convex/**"],
    proofs: [
      {
        path: "convex/commitmentFinalization.test.ts",
        kind: "EXECUTION",
        note:
          "Exercises actor-separation and lifecycle authorization around commitment finalization and reversals.",
      },
      {
        path: "convex/sales.test.ts",
        kind: "EXECUTION",
        note:
          "Exercises sale cancellation permissions and different-actor enforcement.",
      },
    ],
    tracking: "SCRUM-342",
    evidenceBoundary:
      "These execution tests prove important economic actions, not a complete census proving that every sensitive command has the correct permission and actor-separation policy.",
  },
  {
    id: "ECON-1",
    title: "Economic command classification",
    severity: "CRITICAL",
    state: "ENFORCED",
    statement:
      "Every public mutation that can reach a money-bearing sink must have exactly one explicit replay-safety classification in the economic-command census.",
    sourceAreas: ["convex/**", "scripts/economicCommandCensus.ts"],
    proofs: [
      {
        path: "scripts/economicCommandCensus.test.ts",
        kind: "STRUCTURAL",
        negativeControl: true,
        note:
          "Source-complete command-to-money-sink census with pinned analyzer blind spots and a classification ratchet.",
      },
      {
        path: "convex/idempotencyEconomicCommands.test.ts",
        kind: "EXECUTION",
        note:
          "Execution checks for one-intent/one-economic-effect and fingerprint completeness on identity-guarded commands.",
      },
    ],
    evidenceBoundary:
      "This proves the exact census/classification contract and representative execution semantics. It does not mean every classification mechanism is automatically correct for every possible runtime interleaving.",
  },
  {
    id: "ECON-2",
    title: "Client command identity lifetime",
    severity: "CRITICAL",
    state: "ENFORCED",
    statement:
      "A client caller of an identity-guarded economic command must retain one command identity across retries and must not recompute fingerprinted inputs from volatile values.",
    sourceAreas: ["components/**", "app/**", "hooks/**", "apps/mobile/src/**", "playwright/**", "cypress/**"],
    proofs: [
      {
        path: "scripts/clientIdentityLifetime.test.ts",
        kind: "STRUCTURAL",
        negativeControl: true,
        note:
          "Enumerates client callers, detects per-attempt identity minting, volatile fingerprint inputs, and pinned past analyzer faults.",
      },
      {
        path: "hooks/useCommandIdentity.test.tsx",
        kind: "EXECUTION",
        note:
          "Execution proof for retained command identity behavior and removal of the unsafe per-attempt renew API.",
      },
    ],
    evidenceBoundary:
      "The structural census covers the repository client roots declared by the analyzer and explicitly enumerates server-only commands. It cannot prove behavior of an external caller that is not in this repository.",
  },
  {
    id: "ACC-1",
    title: "Balanced and semantically correct posting",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Every posted economic event must produce zero or one semantically correct balanced journal entry; balancing alone is insufficient if the wrong accounts or amounts offset each other.",
    sourceAreas: ["convex/accounting/**", "convex/accounting*.ts", "convex/utils/saleCompletion.ts"],
    proofs: [
      {
        path: "convex/accounting/ownedSaleTaxPosting.test.ts",
        kind: "EXECUTION",
        note:
          "Asserts per-account owned-sale amounts in addition to debit/credit balance.",
      },
      {
        path: "convex/accounting/consignedSalePosting.test.ts",
        kind: "EXECUTION",
        note:
          "Asserts agent-basis consigned sale posting semantics and refusal where policy is undefined.",
      },
      {
        path: "convex/dealCustodyAccounting.test.ts",
        kind: "EXECUTION",
        note:
          "Exercises a large custody posting/reversal matrix with accounting controls.",
      },
    ],
    tracking: "SCRUM-342",
    evidenceBoundary:
      "High-value posting families are deeply tested, but this catalog does not yet prove a source-complete event-type-to-semantic-oracle matrix for every posting rule.",
  },
  {
    id: "ACC-2",
    title: "Immutable posted history and canonical reversal",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Posted financial history must not be rewritten as a correction; corrections must preserve the original and use the canonical linked reversal/replacement path.",
    sourceAreas: ["convex/accounting/**", "convex/**"],
    proofs: [
      {
        path: "convex/accountingGenericReversalAuthority.test.ts",
        kind: "EXECUTION",
        note:
          "Execution proof around generic reversal authority and cross-tenant reversal safety.",
      },
      {
        path: "convex/dealCustodyAccounting.test.ts",
        kind: "EXECUTION",
        note:
          "Exercises canonical journal reversals across custody movement types.",
      },
    ],
    tracking: "SCRUM-342",
    evidenceBoundary:
      "The referenced domains prove their reversal model. A repository-wide census of every posted mutable financial surface and every correction writer is still required before the broader invariant can be called enforced.",
  },
  {
    id: "ACC-3",
    title: "Accounting date and period authority",
    severity: "CRITICAL",
    state: "ENFORCED",
    statement:
      "Manual journals must post using the declared accounting date, and ordinary posting into a closed accounting period must be rejected.",
    sourceAreas: ["convex/financialAudit.ts", "convex/accountingPeriods.ts", "components/accounting/**"],
    proofs: [
      {
        path: "convex/manualJournalAccountingDate.test.ts",
        kind: "EXECUTION",
        note:
          "Proves declared accountingDate propagation, validation, and period behavior for manual journals.",
      },
      {
        path: "convex/accountingPhase2.test.ts",
        kind: "EXECUTION",
        note:
          "Proves closed-period posting refusal in the accounting engine.",
      },
    ],
    evidenceBoundary:
      "This exact manual-journal/ordinary-posting period contract is executed. Specialized reopen, migration, and opening-balance policies have separate rules and are not implied by this invariant.",
  },
  {
    id: "CONS-1",
    title: "Consignment ownership and economics",
    severity: "CRITICAL",
    state: "ENFORCED",
    statement:
      "A SOURCED/consigned vehicle remains agent-basis rather than dealership-owned inventory, and its sale economics must preserve supplier settlement and dealership margin without inventing ownership or tax treatment.",
    sourceAreas: ["convex/utils/vehicleOwnership.ts", "convex/utils/financingEconomics.ts", "convex/accounting/**"],
    proofs: [
      {
        path: "convex/consignedOwnership.test.ts",
        kind: "EXECUTION",
        note:
          "Proves STOCK versus SOURCED legal/commercial ownership classification.",
      },
      {
        path: "convex/consignmentEconomics.test.ts",
        kind: "EXECUTION",
        note:
          "Proves margin, settlement, missing-basis and legacy-state consignment economics.",
      },
      {
        path: "convex/accounting/consignedSalePosting.test.ts",
        kind: "EXECUTION",
        note:
          "Proves agent-basis journal semantics and fail-closed handling of undefined tax policy.",
      },
    ],
    evidenceBoundary:
      "The canonical ownership/economics/posting helpers are covered. This does not claim that every UI projection is automatically consistent; projection parity remains a separate review concern.",
  },
  {
    id: "LIFE-1",
    title: "Lifecycle reversal completeness",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Cancellation, void, return, reopen, or reversal of an economic lifecycle must unwind the effects owned by that lifecycle without erasing independent surviving obligations.",
    sourceAreas: ["convex/sales.ts", "convex/collections.ts", "convex/financeDealCosts.ts", "convex/commitments.ts"],
    proofs: [
      {
        path: "convex/cashDealCockpit.test.ts",
        kind: "EXECUTION",
        note:
          "Contains adversarial counterexamples for surviving supplier obligations and deal-cockpit lifecycle economics.",
      },
      {
        path: "convex/chequeReturnLifecycle.test.ts",
        kind: "EXECUTION",
        note:
          "Exercises return/reversal behavior through cheque lifecycle transitions.",
      },
      {
        path: "convex/dealCustodyAccounting.test.ts",
        kind: "EXECUTION",
        note:
          "Exercises custody issue/return/reimburse/write-off/reopen inverse transitions.",
      },
    ],
    tracking: "SCRUM-342",
    evidenceBoundary:
      "Several critical lifecycle families have inverse-transition tests, but there is not yet one enumerated state-machine matrix proving every economic transition and every dependent subledger/GL/commitment effect.",
  },
  {
    id: "PERF-1",
    title: "Completeness under scale",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "An authoritative financial value, safety decision, or reconciliation result must not silently infer completeness from a bounded, truncated, or first-page-only read.",
    sourceAreas: ["convex/**", "scripts/accountingRehearsalCases.mjs", "components/accounting/**"],
    proofs: [
      {
        path: "scripts/accountingRehearsalCases.test.ts",
        kind: "EXECUTION",
        note:
          "Attacks rehearsal logic and pagination assumptions before its output is trusted.",
      },
      {
        path: "convex/accountingPhase18.test.ts",
        kind: "EXECUTION",
        note:
          "Exercises ledger/report snapshot and delta boundaries at scale-sensitive accounting surfaces.",
      },
      {
        path: ".github/workflows/accounting-rehearsal.yml",
        kind: "PREVIEW",
        note:
          "Runs accounting rehearsal against an actual preview backend rather than treating the in-memory harness as platform-limit evidence.",
      },
    ],
    tracking: "SCRUM-342",
    evidenceBoundary:
      "Accounting rehearsal covers selected authoritative paths and real preview behavior. There is not yet a repository-wide analyzer proving that every authoritative read distinguishes bounded safety probes from complete totals.",
  },
  {
    id: "CONC-1",
    title: "Runtime concurrency and atomicity",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Critical economic commands that can race must preserve one economic effect and their state-machine invariants under real Convex contention, not merely under serialized convex-test execution.",
    sourceAreas: ["convex/**", "scripts/accountingRehearsalCases.mjs", ".github/workflows/accounting-rehearsal.yml"],
    proofs: [
      {
        path: "convex/idempotencyEconomicCommands.test.ts",
        kind: "EXECUTION",
        note:
          "Proves retry/state-machine logic in the test harness.",
      },
      {
        path: "scripts/accountingRehearsalCases.test.ts",
        kind: "EXECUTION",
        note:
          "Proves the rehearsal instrument detects broken modeled concurrency cases.",
      },
      {
        path: ".github/workflows/accounting-rehearsal.yml",
        kind: "PREVIEW",
        note:
          "Provides real preview-backend evidence for the contention cases included in the rehearsal.",
      },
    ],
    tracking: "SCRUM-342",
    evidenceBoundary:
      "The repository explicitly documents that convex-test serializes and cannot authorize OCC claims. Preview rehearsal covers only its enumerated cases, so whole-system contention coverage remains partial.",
  },
  {
    id: "UI-1",
    title: "One UI action, one backend authority",
    severity: "HIGH",
    state: "ENFORCED",
    statement:
      "The Unified Deal and transitional Review surfaces must call the same canonical backend commands for migrated actions; no duplicate deal mutation namespace or V2 economic path may be introduced.",
    sourceAreas: ["components/applications/**", "scripts/reviewActionParity.test.ts"],
    proofs: [
      {
        path: "scripts/reviewActionParity.test.ts",
        kind: "STRUCTURAL",
        negativeControl: true,
        note:
          "Reads real source, freezes required commands, rejects duplicate mutation namespaces, and includes a removal negative control.",
      },
      {
        path: "components/applications/cockpit/DealCockpitReviewParity.test.tsx",
        kind: "EXECUTION",
        note:
          "UI-level parity checks for the Deal cockpit and Review migration behavior.",
      },
    ],
    evidenceBoundary:
      "The migrated Review/Deal action set is protected. This does not claim every screen in AutoFlow is free of duplicate domain authority.",
  },
] as const;

export const STRUCTURAL_NEGATIVE_CONTROL_PATTERN =
  /NEGATIVE CONTROL|FAULT(?:\s+\d+)?|self-tests?|guard nobody has watched fail|mutation control/i;

export function structuralProofHasNegativeControlSource(source: string): boolean {
  return STRUCTURAL_NEGATIVE_CONTROL_PATTERN.test(source);
}

export function validateInvariantCatalog(
  repoRoot: string,
  catalog: readonly InvariantDefinition[] = AUTOFLOW_INVARIANTS
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const invariant of catalog) {
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(invariant.id)) {
      errors.push("Invalid invariant id: " + invariant.id);
    }
    if (seen.has(invariant.id)) {
      errors.push("Duplicate invariant id: " + invariant.id);
    }
    seen.add(invariant.id);

    if (invariant.statement.trim().length < 20) {
      errors.push(invariant.id + " has no meaningful invariant statement");
    }
    if (invariant.sourceAreas.length === 0) {
      errors.push(invariant.id + " has no declared source areas");
    }
    if (invariant.proofs.length === 0) {
      errors.push(invariant.id + " has no proof evidence");
    }
    if (invariant.evidenceBoundary.trim().length < 30) {
      errors.push(invariant.id + " has no meaningful evidence boundary");
    }

    if (
      invariant.state === "PARTIAL" &&
      (invariant.tracking === undefined || !/^SCRUM-\d+$/.test(invariant.tracking))
    ) {
      errors.push(invariant.id + " is PARTIAL without a SCRUM tracking issue");
    }

    if (
      invariant.severity === "CRITICAL" &&
      invariant.state === "ENFORCED" &&
      !invariant.proofs.some((proof) => proof.kind === "EXECUTION" || proof.kind === "PREVIEW")
    ) {
      errors.push(
        invariant.id +
          " is CRITICAL+ENFORCED but relies only on structural/manual evidence; execution or preview evidence is required"
      );
    }

    for (const proof of invariant.proofs) {
      if (path.isAbsolute(proof.path) || proof.path.split(/[\\/]/).includes("..")) {
        errors.push(invariant.id + " proof path must be repository-relative: " + proof.path);
        continue;
      }

      const absolute = path.resolve(repoRoot, proof.path);
      if (!existsSync(absolute)) {
        errors.push(invariant.id + " proof file does not exist: " + proof.path);
        continue;
      }

      if (proof.note.trim().length < 20) {
        errors.push(invariant.id + " proof has no meaningful note: " + proof.path);
      }

      if (proof.kind === "STRUCTURAL") {
        if (proof.negativeControl !== true) {
          errors.push(
            invariant.id + " structural proof is not declared negative-controlled: " + proof.path
          );
          continue;
        }
        const source = readFileSync(absolute, "utf8");
        if (!structuralProofHasNegativeControlSource(source)) {
          errors.push(
            invariant.id +
              " structural proof declares a negative control but its source has no recognized fault/self-test marker: " +
              proof.path
          );
        }
      }
    }
  }

  return errors;
}
