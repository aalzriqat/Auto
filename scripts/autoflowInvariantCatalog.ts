import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type InvariantSeverity = "CRITICAL" | "HIGH";
export type InvariantState =
  | "DOCUMENTED"
  | "PARTIAL"
  | "ENFORCED"
  | "RETIRED"
  | "SUPERSEDED";
export type EvidenceMechanism =
  | "EXECUTION"
  | "STRUCTURAL"
  | "PREVIEW"
  | "MANUAL_POLICY"
  | "PRODUCTION_MONITOR";
export type ProofObligation =
  | "POSITIVE"
  | "NEGATIVE"
  | "BOUNDARY"
  | "REPLAY"
  | "PROPERTY"
  | "STATE_TRANSITION"
  | "CONCURRENCY"
  | "FAULT_INJECTION"
  | "REVERSAL"
  | "TENANCY"
  | "AUTHORIZATION"
  | "MUTATION"
  | "HISTORICAL_REGRESSION"
  | "RECONCILIATION"
  | "E2E"
  | "PRODUCTION_MONITOR";
export type ObligationStatus = "REQUIRED" | "NOT_APPLICABLE" | "DEFERRED";
export type EconomicImpact = "NONE" | "INDIRECT" | "DIRECT";
export type ConcurrencyApplicability =
  | "REQUIRED"
  | "PLATFORM_SERIALIZED_PROVEN"
  | "NOT_APPLICABLE"
  | "UNKNOWN";
export type ReversalApplicability =
  | "REQUIRED"
  | "IRREVERSIBLE_BY_DESIGN"
  | "NOT_APPLICABLE";

export interface ProofRequirement {
  obligation: ProofObligation;
  status: ObligationStatus;
  acceptedEvidence?: readonly EvidenceMechanism[];
  reason?: string;
  tracking?: string;
}

export interface InvariantProof {
  path: string;
  mechanism: EvidenceMechanism;
  obligations: readonly ProofObligation[];
  note: string;
  marker?: string;
  negativeControl?: boolean;
}

export interface InvariantAssuranceProfile {
  economicImpact: EconomicImpact;
  concurrency: ConcurrencyApplicability;
  reversal: ReversalApplicability;
  tenantSensitive: boolean;
  authorizationSensitive: boolean;
  externalInputSensitive: boolean;
  webhookSensitive: boolean;
  scheduledWorkSensitive: boolean;
}

export interface InvariantRetirement {
  reason: string;
  tracking: string;
  supersededBy?: readonly string[];
}

export interface InvariantDefinition {
  id: string;
  title: string;
  severity: InvariantSeverity;
  state: InvariantState;
  statement: string;
  sourceAreas: readonly string[];
  symbols?: readonly string[];
  profile: InvariantAssuranceProfile;
  requirements: readonly ProofRequirement[];
  proofs: readonly InvariantProof[];
  tracking?: string;
  retirement?: InvariantRetirement;
  evidenceBoundary: string;
}

const SCRUM_342 = "SCRUM-342";
const RUNTIME_EVIDENCE: readonly EvidenceMechanism[] = ["EXECUTION", "PREVIEW"];
const ANY_EXECUTABLE_EVIDENCE: readonly EvidenceMechanism[] = [
  "EXECUTION",
  "STRUCTURAL",
  "PREVIEW",
  "PRODUCTION_MONITOR",
];

const required = (
  obligation: ProofObligation,
  acceptedEvidence: readonly EvidenceMechanism[] = RUNTIME_EVIDENCE
): ProofRequirement => ({ obligation, status: "REQUIRED", acceptedEvidence });

const deferred = (obligation: ProofObligation, reason: string): ProofRequirement => ({
  obligation,
  status: "DEFERRED",
  reason,
  tracking: SCRUM_342,
});

const notApplicable = (obligation: ProofObligation, reason: string): ProofRequirement => ({
  obligation,
  status: "NOT_APPLICABLE",
  reason,
});

const execution = (
  pathName: string,
  obligations: readonly ProofObligation[],
  note: string
): InvariantProof => ({
  path: pathName,
  mechanism: "EXECUTION",
  obligations,
  note,
});

const structural = (
  pathName: string,
  obligations: readonly ProofObligation[],
  note: string
): InvariantProof => ({
  path: pathName,
  mechanism: "STRUCTURAL",
  obligations,
  note,
  negativeControl: true,
});

const preview = (
  pathName: string,
  obligations: readonly ProofObligation[],
  note: string
): InvariantProof => ({
  path: pathName,
  mechanism: "PREVIEW",
  obligations,
  note,
});

const profile = (
  overrides: Partial<InvariantAssuranceProfile> = {}
): InvariantAssuranceProfile => ({
  economicImpact: "NONE",
  concurrency: "NOT_APPLICABLE",
  reversal: "NOT_APPLICABLE",
  tenantSensitive: false,
  authorizationSensitive: false,
  externalInputSensitive: false,
  webhookSensitive: false,
  scheduledWorkSensitive: false,
  ...overrides,
});

export const AUTOFLOW_INVARIANTS: readonly InvariantDefinition[] = [
  {
    id: "TEN-1",
    title: "Tenant isolation",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "A tenant-scoped operation must not read, write, mutate, or link a resource that belongs to another organization.",
    sourceAreas: ["convex/**", "test-utils/**"],
    profile: profile({ tenantSensitive: true }),
    requirements: [
      required("NEGATIVE"),
      required("TENANCY"),
      required("MUTATION", ["STRUCTURAL", "EXECUTION"]),
      deferred(
        "BOUNDARY",
        "A source-complete boundary matrix for every tenant-bearing relationship is not yet encoded."
      ),
    ],
    proofs: [
      structural(
        "scripts/tenantWriteGuard.test.ts",
        ["MUTATION"],
        "Repository census for caller-addressed tenant writes, with analyzer self-tests and coverage ratchets."
      ),
      execution(
        "convex/saleCompletionTenancyGuards.test.ts",
        ["NEGATIVE", "TENANCY"],
        "Execution proof for canonical sale-completion relationships and cross-organization resource refusal."
      ),
    ],
    tracking: SCRUM_342,
    evidenceBoundary:
      "The write census and sale-completion execution tests are strong evidence for their covered shapes, but they are not yet a source-complete proof of every read path, helper-mediated relation, and future tenant-bearing table.",
  },
  {
    id: "AUTH-1",
    title: "Authorization and segregation of duties",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Sensitive economic lifecycle actions must be authorized server-side, and transitions requiring separation of duties must reject the prohibited same-actor case.",
    sourceAreas: ["convex/**"],
    profile: profile({ authorizationSensitive: true }),
    requirements: [
      required("NEGATIVE"),
      required("AUTHORIZATION"),
      deferred(
        "MUTATION",
        "The repository does not yet mutation-prove every sensitive command's authorization guard."
      ),
    ],
    proofs: [
      execution(
        "convex/commitmentFinalization.test.ts",
        ["NEGATIVE", "AUTHORIZATION"],
        "Exercises actor separation and lifecycle authorization around commitment finalization and reversals."
      ),
      execution(
        "convex/sales.test.ts",
        ["NEGATIVE", "AUTHORIZATION"],
        "Exercises sale cancellation permissions and different-actor enforcement."
      ),
    ],
    tracking: SCRUM_342,
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
    profile: profile({ economicImpact: "INDIRECT" }),
    requirements: [
      required("REPLAY"),
      required("MUTATION", ["STRUCTURAL", "EXECUTION"]),
      notApplicable(
        "CONCURRENCY",
        "This invariant classifies commands; runtime contention semantics are owned by CONC-1."
      ),
      notApplicable(
        "REVERSAL",
        "This invariant is about replay-safety classification, not lifecycle reversal semantics."
      ),
      notApplicable(
        "RECONCILIATION",
        "This invariant does not assert a subledger or GL balance."
      ),
    ],
    proofs: [
      structural(
        "scripts/economicCommandCensus.test.ts",
        ["MUTATION"],
        "Source-complete command-to-money-sink census with pinned analyzer blind spots and a classification ratchet."
      ),
      execution(
        "convex/idempotencyEconomicCommands.test.ts",
        ["REPLAY"],
        "Execution checks for one-intent/one-economic-effect and fingerprint completeness on identity-guarded commands."
      ),
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
    profile: profile({ economicImpact: "INDIRECT" }),
    requirements: [
      required("REPLAY"),
      required("NEGATIVE"),
      required("MUTATION", ["STRUCTURAL", "EXECUTION"]),
      notApplicable(
        "CONCURRENCY",
        "The invariant concerns client retry identity lifetime; runtime command contention is owned by CONC-1."
      ),
      notApplicable(
        "REVERSAL",
        "Client identity lifetime does not define lifecycle reversal semantics."
      ),
      notApplicable(
        "RECONCILIATION",
        "Client identity lifetime does not itself assert ledger or subledger parity."
      ),
    ],
    proofs: [
      structural(
        "scripts/clientIdentityLifetime.test.ts",
        ["NEGATIVE", "MUTATION"],
        "Enumerates client callers, detects per-attempt identity minting, volatile fingerprint inputs, and pinned past analyzer faults."
      ),
      execution(
        "hooks/useCommandIdentity.test.tsx",
        ["REPLAY", "NEGATIVE"],
        "Execution proof for retained command identity behavior and removal of the unsafe per-attempt renew API."
      ),
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
      "Every posted economic event must produce zero or one semantically correct balanced journal entry; balancing alone is insufficient if wrong accounts or amounts offset each other.",
    sourceAreas: ["convex/accounting/**", "convex/accounting*.ts", "convex/utils/saleCompletion.ts"],
    profile: profile({
      economicImpact: "DIRECT",
      concurrency: "UNKNOWN",
    }),
    requirements: [
      required("POSITIVE"),
      required("NEGATIVE"),
      required("REPLAY"),
      deferred(
        "PROPERTY",
        "A generative posting oracle covering arbitrary valid and invalid journals is not yet present."
      ),
      deferred(
        "CONCURRENCY",
        "Real-runtime contention coverage is not source-complete for all posting families."
      ),
      notApplicable(
        "REVERSAL",
        "Canonical reversal correctness is tracked separately by ACC-2."
      ),
      deferred(
        "RECONCILIATION",
        "A source-complete event-type to subledger/GL reconciliation matrix is not yet present."
      ),
    ],
    proofs: [
      execution(
        "convex/accounting/ownedSaleTaxPosting.test.ts",
        ["POSITIVE", "NEGATIVE"],
        "Asserts per-account owned-sale amounts in addition to debit/credit balance."
      ),
      execution(
        "convex/accounting/consignedSalePosting.test.ts",
        ["POSITIVE", "NEGATIVE"],
        "Asserts agent-basis consigned sale posting semantics and refusal where policy is undefined."
      ),
      execution(
        "convex/dealCustodyAccounting.test.ts",
        ["POSITIVE", "NEGATIVE"],
        "Exercises a large custody posting and reversal matrix with accounting controls."
      ),
      execution(
        "convex/accountingPhase2.test.ts",
        ["NEGATIVE", "REPLAY"],
        "Proves invalid journals are refused and duplicate posting identities do not double-post."
      ),
    ],
    tracking: SCRUM_342,
    evidenceBoundary:
      "High-value posting families are deeply tested, but the repository does not yet have a source-complete semantic oracle, generative property layer, real-contention matrix, and reconciliation proof for every posting rule.",
  },
  {
    id: "ACC-2",
    title: "Immutable posted history and canonical reversal",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Posted financial history must not be rewritten as a correction; corrections must preserve the original and use the canonical linked reversal or replacement path.",
    sourceAreas: ["convex/accounting/**", "convex/**"],
    profile: profile({
      economicImpact: "DIRECT",
      concurrency: "UNKNOWN",
      reversal: "REQUIRED",
      tenantSensitive: true,
      authorizationSensitive: true,
    }),
    requirements: [
      required("REVERSAL"),
      required("NEGATIVE"),
      required("TENANCY"),
      required("REPLAY"),
      deferred(
        "CONCURRENCY",
        "Real concurrent double-reversal and stale-writer coverage is not yet source-complete."
      ),
      deferred(
        "RECONCILIATION",
        "Reversal-to-control-account reconciliation is not yet cataloged for every financial family."
      ),
    ],
    proofs: [
      execution(
        "convex/accountingGenericReversalAuthority.test.ts",
        ["REVERSAL", "NEGATIVE", "TENANCY"],
        "Execution proof around generic reversal authority and cross-tenant reversal safety."
      ),
      execution(
        "convex/dealCustodyAccounting.test.ts",
        ["REVERSAL", "NEGATIVE"],
        "Exercises canonical journal reversals across custody movement types."
      ),
      execution(
        "convex/accountingPhase2.test.ts",
        ["REVERSAL", "REPLAY"],
        "Proves inverse journal behavior and repeated reversal idempotency in the accounting engine."
      ),
    ],
    tracking: SCRUM_342,
    evidenceBoundary:
      "The referenced domains prove their reversal model. A repository-wide census of every posted mutable financial surface, correction writer, contention case, and reconciliation consequence is still required.",
  },
  {
    id: "ACC-3",
    title: "Accounting date and period authority",
    severity: "CRITICAL",
    state: "ENFORCED",
    statement:
      "Manual journals must post using the declared accounting date, and ordinary posting into a closed accounting period must be rejected.",
    sourceAreas: ["convex/financialAudit.ts", "convex/accountingPeriods.ts", "components/accounting/**"],
    profile: profile({ economicImpact: "INDIRECT" }),
    requirements: [
      required("POSITIVE"),
      required("NEGATIVE"),
      required("BOUNDARY"),
    ],
    proofs: [
      execution(
        "convex/manualJournalAccountingDate.test.ts",
        ["POSITIVE", "BOUNDARY"],
        "Proves declared accountingDate propagation, validation, and period behavior for manual journals."
      ),
      execution(
        "convex/accountingPhase2.test.ts",
        ["NEGATIVE", "BOUNDARY"],
        "Proves closed-period posting refusal in the accounting engine."
      ),
    ],
    evidenceBoundary:
      "This exact manual-journal and ordinary-posting period contract is executed. Specialized reopen, migration, and opening-balance policies have separate rules and are not implied by this invariant.",
  },
  {
    id: "CONS-1",
    title: "Consignment ownership and economics",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "A SOURCED or consigned vehicle remains agent-basis rather than dealership-owned inventory, and its sale economics must preserve supplier settlement and dealership margin without inventing ownership or tax treatment.",
    sourceAreas: ["convex/utils/vehicleOwnership.ts", "convex/utils/financingEconomics.ts", "convex/accounting/**"],
    profile: profile({
      economicImpact: "DIRECT",
      concurrency: "NOT_APPLICABLE",
      reversal: "REQUIRED",
    }),
    requirements: [
      required("POSITIVE"),
      required("NEGATIVE"),
      notApplicable(
        "REPLAY",
        "The canonical ownership/economics helpers are deterministic calculations rather than replayable commands."
      ),
      notApplicable(
        "CONCURRENCY",
        "This invariant covers canonical ownership/economic semantics; command contention is cataloged separately."
      ),
      deferred(
        "REVERSAL",
        "Consigned sale cancellation and supplier-settlement inverse paths are not yet one source-complete proof."
      ),
      deferred(
        "RECONCILIATION",
        "Generative supplier receivable and GL reconciliation is not yet attached to this invariant."
      ),
    ],
    proofs: [
      execution(
        "convex/consignedOwnership.test.ts",
        ["POSITIVE", "NEGATIVE"],
        "Proves STOCK versus SOURCED legal and commercial ownership classification."
      ),
      execution(
        "convex/consignmentEconomics.test.ts",
        ["POSITIVE", "NEGATIVE"],
        "Proves margin, settlement, missing-basis and legacy-state consignment economics."
      ),
      execution(
        "convex/accounting/consignedSalePosting.test.ts",
        ["POSITIVE", "NEGATIVE"],
        "Proves agent-basis journal semantics and fail-closed handling of undefined tax policy."
      ),
    ],
    tracking: SCRUM_342,
    evidenceBoundary:
      "Canonical ownership, economics and posting helpers are covered. Full reversal and supplier-subledger to GL reconciliation obligations remain explicit gaps rather than being hidden behind an ENFORCED label.",
  },
  {
    id: "LIFE-1",
    title: "Lifecycle reversal completeness",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Cancellation, void, return, reopen, or reversal of an economic lifecycle must unwind effects owned by that lifecycle without erasing independent surviving obligations.",
    sourceAreas: ["convex/sales.ts", "convex/collections.ts", "convex/financeDealCosts.ts", "convex/commitments.ts"],
    profile: profile({
      economicImpact: "DIRECT",
      concurrency: "UNKNOWN",
      reversal: "REQUIRED",
    }),
    requirements: [
      required("STATE_TRANSITION"),
      required("REVERSAL"),
      required("NEGATIVE"),
      deferred("REPLAY", "Replay behavior is not yet cataloged for every lifecycle inverse path."),
      deferred(
        "CONCURRENCY",
        "Ordering truth tables exist for important paths, but real contention proof is not source-complete."
      ),
      deferred(
        "FAULT_INJECTION",
        "Failure-boundary coverage is strong in selected workflows but not yet matrix-complete."
      ),
      deferred(
        "RECONCILIATION",
        "Every lifecycle inverse is not yet generatively reconciled across all dependent ledgers."
      ),
    ],
    proofs: [
      execution(
        "convex/cashDealCockpit.test.ts",
        ["STATE_TRANSITION", "REVERSAL", "NEGATIVE"],
        "Contains adversarial counterexamples for surviving supplier obligations and deal-cockpit lifecycle economics."
      ),
      execution(
        "convex/chequeReturnLifecycle.test.ts",
        ["STATE_TRANSITION", "REVERSAL", "NEGATIVE"],
        "Exercises return and reversal behavior through cheque lifecycle transitions."
      ),
      execution(
        "convex/dealCustodyAccounting.test.ts",
        ["STATE_TRANSITION", "REVERSAL", "NEGATIVE"],
        "Exercises custody issue, return, reimburse, write-off, reopen and inverse transitions."
      ),
    ],
    tracking: SCRUM_342,
    evidenceBoundary:
      "Several critical lifecycle families have strong inverse-transition tests, but there is not yet one enumerated model proving every economic transition, retry/interleaving, fault boundary, and dependent subledger or GL consequence.",
  },
  {
    id: "PERF-1",
    title: "Completeness under scale",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "An authoritative financial value, safety decision, or reconciliation result must not silently infer completeness from a bounded, truncated, or first-page-only read.",
    sourceAreas: ["convex/**", "scripts/accountingRehearsalCases.mjs", "components/accounting/**"],
    profile: profile({ scheduledWorkSensitive: true }),
    requirements: [
      required("BOUNDARY", ANY_EXECUTABLE_EVIDENCE),
      required("NEGATIVE"),
      deferred(
        "MUTATION",
        "A repository-wide analyzer proving every authoritative read distinguishes bounded probes from complete totals is not yet present."
      ),
    ],
    proofs: [
      execution(
        "scripts/accountingRehearsalCases.test.ts",
        ["NEGATIVE", "BOUNDARY"],
        "Attacks rehearsal logic and pagination assumptions before its output is trusted."
      ),
      execution(
        "convex/accountingPhase18.test.ts",
        ["BOUNDARY"],
        "Exercises ledger and report snapshot and delta boundaries at scale-sensitive accounting surfaces."
      ),
      preview(
        ".github/workflows/accounting-rehearsal.yml",
        ["BOUNDARY"],
        "Runs accounting rehearsal against an actual preview backend rather than treating the in-memory harness as platform-limit evidence."
      ),
    ],
    tracking: SCRUM_342,
    evidenceBoundary:
      "Accounting rehearsal covers selected authoritative paths and real preview behavior. A repository-wide source census for all authoritative complete reads remains missing.",
  },
  {
    id: "CONC-1",
    title: "Runtime concurrency and atomicity",
    severity: "CRITICAL",
    state: "PARTIAL",
    statement:
      "Critical economic commands that can race must preserve one economic effect and their state-machine invariants under real Convex contention, not merely under serialized convex-test execution.",
    sourceAreas: ["convex/**", "scripts/accountingRehearsalCases.mjs", ".github/workflows/accounting-rehearsal.yml"],
    profile: profile({
      economicImpact: "DIRECT",
      concurrency: "REQUIRED",
      scheduledWorkSensitive: true,
    }),
    requirements: [
      required("REPLAY"),
      required("STATE_TRANSITION"),
      required("CONCURRENCY", ["PREVIEW"]),
      deferred(
        "FAULT_INJECTION",
        "Fault injection exists for selected workers but is not yet complete for every command classified as concurrency-sensitive."
      ),
      notApplicable(
        "REVERSAL",
        "This invariant is about collision semantics; lifecycle-specific reversal correctness is tracked separately."
      ),
      deferred(
        "RECONCILIATION",
        "Post-contention reconciliation is not yet systematically asserted for every economic command family."
      ),
    ],
    proofs: [
      execution(
        "convex/idempotencyEconomicCommands.test.ts",
        ["REPLAY", "STATE_TRANSITION"],
        "Proves retry and state-machine logic in the serialized test harness."
      ),
      execution(
        "scripts/accountingRehearsalCases.test.ts",
        ["STATE_TRANSITION"],
        "Proves the rehearsal instrument detects broken modeled concurrency cases."
      ),
      preview(
        ".github/workflows/accounting-rehearsal.yml",
        ["CONCURRENCY", "REPLAY"],
        "Provides real preview-backend evidence for the contention cases included in the rehearsal."
      ),
    ],
    tracking: SCRUM_342,
    evidenceBoundary:
      "The repository explicitly documents that convex-test serializes and cannot authorize OCC claims. Preview rehearsal covers only enumerated cases, so whole-system contention and post-contention reconciliation remain partial.",
  },
  {
    id: "UI-1",
    title: "One UI action, one backend authority",
    severity: "HIGH",
    state: "ENFORCED",
    statement:
      "The Unified Deal and transitional Review surfaces must call the same canonical backend commands for migrated actions; no duplicate deal mutation namespace or V2 economic path may be introduced.",
    sourceAreas: ["components/applications/**", "scripts/reviewActionParity.test.ts"],
    profile: profile({ economicImpact: "INDIRECT" }),
    requirements: [
      required("POSITIVE"),
      required("NEGATIVE", ["STRUCTURAL", "EXECUTION"]),
      required("MUTATION", ["STRUCTURAL", "EXECUTION"]),
    ],
    proofs: [
      structural(
        "scripts/reviewActionParity.test.ts",
        ["NEGATIVE", "MUTATION"],
        "Reads real source, freezes required commands, rejects duplicate mutation namespaces, and includes a removal negative control."
      ),
      execution(
        "components/applications/cockpit/DealCockpitReviewParity.test.tsx",
        ["POSITIVE", "NEGATIVE"],
        "UI-level parity checks for the Deal cockpit and Review migration behavior."
      ),
    ],
    evidenceBoundary:
      "The migrated Review and Deal action set is protected. This does not claim every screen in AutoFlow is free of duplicate domain authority.",
  },
] as const;

export const STRUCTURAL_NEGATIVE_CONTROL_PATTERN =
  /NEGATIVE CONTROL|FAULT(?:\s+\d+)?|self-tests?|guard nobody has watched fail|mutation control/i;

export function structuralProofHasNegativeControlSource(source: string): boolean {
  return STRUCTURAL_NEGATIVE_CONTROL_PATTERN.test(source);
}

export function isActiveInvariant(invariant: InvariantDefinition): boolean {
  return invariant.state !== "RETIRED" && invariant.state !== "SUPERSEDED";
}

function hasValidTracking(value: string | undefined): boolean {
  return /^SCRUM-\d+$/.test(value ?? "");
}

function requirementMap(invariant: InvariantDefinition): Map<ProofObligation, ProofRequirement> {
  return new Map(invariant.requirements.map((item) => [item.obligation, item]));
}

function proofCanSatisfy(requirement: ProofRequirement, proof: InvariantProof): boolean {
  if (!proof.obligations.includes(requirement.obligation)) {
    return false;
  }
  const accepted = requirement.acceptedEvidence ?? RUNTIME_EVIDENCE;
  return accepted.includes(proof.mechanism);
}

export function validateInvariantCatalog(
  repoRoot: string,
  catalog: readonly InvariantDefinition[] = AUTOFLOW_INVARIANTS
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const active = catalog.filter(isActiveInvariant);

  if (active.length === 0) {
    errors.push("Invariant catalog has no active invariants");
  }

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
    if (invariant.evidenceBoundary.trim().length < 30) {
      errors.push(invariant.id + " has no meaningful evidence boundary");
    }

    if (invariant.state === "RETIRED" || invariant.state === "SUPERSEDED") {
      if (
        !invariant.retirement ||
        invariant.retirement.reason.trim().length < 20 ||
        !hasValidTracking(invariant.retirement.tracking)
      ) {
        errors.push(invariant.id + " retirement metadata is incomplete");
      }
      if (
        invariant.state === "SUPERSEDED" &&
        (!invariant.retirement?.supersededBy || invariant.retirement.supersededBy.length === 0)
      ) {
        errors.push(invariant.id + " is SUPERSEDED without replacement invariant IDs");
      }
      continue;
    }

    if (invariant.state !== "DOCUMENTED" && invariant.proofs.length === 0) {
      errors.push(invariant.id + " has no proof evidence");
    }
    if (invariant.state === "PARTIAL" && !hasValidTracking(invariant.tracking)) {
      errors.push(invariant.id + " is PARTIAL without a SCRUM tracking issue");
    }

    const requirements = requirementMap(invariant);
    if (requirements.size !== invariant.requirements.length) {
      errors.push(invariant.id + " has duplicate proof obligations");
    }

    for (const requirement of invariant.requirements) {
      if (requirement.status === "NOT_APPLICABLE" && (requirement.reason?.trim().length ?? 0) < 20) {
        errors.push(
          invariant.id + " marks " + requirement.obligation + " NOT_APPLICABLE without a meaningful rationale"
        );
      }
      if (requirement.status === "DEFERRED") {
        if ((requirement.reason?.trim().length ?? 0) < 20) {
          errors.push(
            invariant.id + " defers " + requirement.obligation + " without a meaningful rationale"
          );
        }
        if (!hasValidTracking(requirement.tracking)) {
          errors.push(
            invariant.id + " defers " + requirement.obligation + " without a SCRUM tracking issue"
          );
        }
        if (invariant.state === "ENFORCED") {
          errors.push(
            invariant.id + " is ENFORCED while " + requirement.obligation + " is still DEFERRED"
          );
        }
      }
      if (requirement.status === "REQUIRED") {
        if (!requirement.acceptedEvidence || requirement.acceptedEvidence.length === 0) {
          errors.push(
            invariant.id + " required proof " + requirement.obligation + " has no accepted evidence mechanism"
          );
        } else if (!invariant.proofs.some((proof) => proofCanSatisfy(requirement, proof))) {
          errors.push(
            invariant.id + " is missing required proof obligation " + requirement.obligation
          );
        }
      }
    }

    if (
      invariant.state === "PARTIAL" &&
      !invariant.requirements.some((requirement) => requirement.status === "DEFERRED")
    ) {
      errors.push(invariant.id + " is PARTIAL but declares no deferred proof obligation");
    }

    if (
      invariant.profile.tenantSensitive &&
      requirements.get("TENANCY")?.status !== "REQUIRED"
    ) {
      errors.push(invariant.id + " is tenant-sensitive without required TENANCY proof");
    }
    if (
      invariant.profile.authorizationSensitive &&
      requirements.get("AUTHORIZATION")?.status !== "REQUIRED"
    ) {
      errors.push(invariant.id + " is authorization-sensitive without required AUTHORIZATION proof");
    }

    if (invariant.profile.economicImpact === "DIRECT") {
      for (const obligation of ["REPLAY", "CONCURRENCY", "REVERSAL", "RECONCILIATION"] as const) {
        if (!requirements.has(obligation)) {
          errors.push(
            invariant.id + " has DIRECT economic impact without explicit " + obligation + " assessment"
          );
        }
      }
    }

    if (
      invariant.state === "ENFORCED" &&
      invariant.profile.concurrency === "UNKNOWN"
    ) {
      errors.push(invariant.id + " is ENFORCED with UNKNOWN concurrency applicability");
    }

    for (const proof of invariant.proofs) {
      if (path.isAbsolute(proof.path) || proof.path.split(/[\\/]/).includes("..")) {
        errors.push(invariant.id + " proof path must be repository-relative: " + proof.path);
        continue;
      }
      if (proof.obligations.length === 0) {
        errors.push(invariant.id + " proof declares no proof obligations: " + proof.path);
      }

      for (const obligation of proof.obligations) {
        const requirement = requirements.get(obligation);
        if (!requirement) {
          errors.push(
            invariant.id + " proof references undeclared obligation " + obligation + ": " + proof.path
          );
        } else if (requirement.status === "NOT_APPLICABLE") {
          errors.push(
            invariant.id + " provides evidence for NOT_APPLICABLE obligation " + obligation + ": " + proof.path
          );
        }
      }

      const absolute = path.resolve(repoRoot, proof.path);
      if (!existsSync(absolute)) {
        errors.push(invariant.id + " proof file does not exist: " + proof.path);
        continue;
      }

      if (proof.note.trim().length < 20) {
        errors.push(invariant.id + " proof has no meaningful note: " + proof.path);
      }

      const source = proof.mechanism === "STRUCTURAL" || proof.marker
        ? readFileSync(absolute, "utf8")
        : undefined;

      if (proof.marker && !source?.includes(proof.marker)) {
        errors.push(
          invariant.id + " proof marker is missing from " + proof.path + ": " + proof.marker
        );
      }

      if (proof.mechanism === "STRUCTURAL") {
        if (proof.negativeControl !== true) {
          errors.push(
            invariant.id + " structural proof is not declared negative-controlled: " + proof.path
          );
        } else if (!source || !structuralProofHasNegativeControlSource(source)) {
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
