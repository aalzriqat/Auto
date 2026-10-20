/**
 * Skill-enforcement policy: which paths are sensitive, which skills each step
 * needs. Shared by the Claude Code hook (skillGate.mjs) and the PR check
 * (checkPrSkillEvidence.mjs) so the two cannot drift. Skills rank below
 * AGENTS.md; this file only makes the table in .claude/skills/README.md
 * mechanical. It never replaces the two-seat review.
 */

const MONEY_UTILS =
  /^convex\/utils\/[^/]*(money|deposit|sale|commission|cost|financ|invoice|ledger|payroll|prepaid|expense|settlement|supplier|cheque|fcCheque|customerCredit|fee|vat|bank|cash|dealUnwind|handover|amort|partner|payment|economics|quote|retained|profit|gross|custody|commit|execution|materialization|closeWarnings|manualFinance|orgReset|vehicleOwnership|permissions|tenancy|idempotency|financialGuards|auditLog)[^/]*$/i;

const MONEY_ROOT =
  /^convex\/(accounting[^/]*|sales|deposits?|depositRequests|depositRevenueImpact|collections|collectionReminderActions|expenses|payroll|bankAccounts|bankReconciliation|bankBalanceBackfill|cashDrawer|finance[^/]*|financingEconomics|customerFinanceCompanyPayments|dealUnwind|dealCommissions|dealOverview|dealWorkspace|applications|prepaidExpenses|partnerEquity|paymentIntents|paymentVouchers|retainedCreditRefunds|subledger|supplier[^/]*|sourcingPayables|fixedAssets|chartOfAccounts|transactions|commitments|vatReport|reports|orgFinancialReset|orgResetPreflight|quotes|journalReportEligibility|diagnosePrepaidLedgerIntegrity|chequeLineageAudit|financialAudit|migrate[^/]*|aggregates|subscriptions|vehicleEdits|vehicles|sourcedAgentImpact|dashboardExpenseSummary|dashboard|crons|http|schema|roles|memberships|users|organizations|orgSettings|approvals|admin(Auth|Orgs|Data|Users|Impersonation))(\.test)?\.ts$/;

/** Gate and production-safeguard files: AGENTS.md says these need both seats. */
const GATE = [
  /^AGENTS\.md$/,
  /^\.github\//,
  /^\.claude\//,
  /^scripts\/skillEnforcement\//,
  /^scripts\/(assertRelease|checkReleaseAuthority|verifyZeroState|rolloutProduction)[^/]*$/,
  /^scripts\/intelligence\//,
  /^regression\/rulings\.json$/,
];

const MONEY = [
  MONEY_UTILS,
  MONEY_ROOT,
  /^convex\/accounting\//,
];

const CODE = /\.(ts|tsx|js|mjs|cjs)$/;

export function classifyPaths(paths) {
  const out = { sensitive: [], gate: [], code: [] };
  for (const raw of paths) {
    const p = raw.replace(/^\.\//, "");
    if (!p) continue;
    if (GATE.some((r) => r.test(p))) out.gate.push(p);
    if (MONEY.some((r) => r.test(p))) out.sensitive.push(p);
    if (CODE.test(p)) out.code.push(p);
  }
  return out;
}

/** Skills a step needs given what it touches. Returns [{skill, why}]. */
export function requiredSkills(step, classes) {
  const need = new Map();
  const add = (skill, why) => need.has(skill) || need.set(skill, why);
  const sensitive = classes.sensitive.length > 0;
  const gate = classes.gate.length > 0;
  if (step === "commit" || step === "push") {
    if (sensitive) {
      add("tdd", "money/permission code changed: a failing-first test is required");
      add("blast-radius", "money/permission code changed");
    }
    if (gate) add("blast-radius", "gate or production-safeguard file changed");
  }
  if (step === "pr") {
    add("technical-writing", "PR body is a document");
    add("unslop", "PR body is prose");
    if (sensitive || gate) {
      add("two-axis-review", "run before requesting review seats");
      add("engineering-principles", "money/gate change: verify before declaring done");
    }
  }
  return [...need].map(([skill, why]) => ({ skill, why }));
}

/** Parse a Claude Code JSONL transcript and return the set of skills invoked. */
export function invokedSkills(transcriptText) {
  const seen = new Set();
  const norm = (s) => String(s).replace(/^\/+/, "").split(":").pop();
  for (const line of transcriptText.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use" && block.name === "Skill" && block.input?.skill) {
          seen.add(norm(block.input.skill));
        }
        // user typed /skill-name: harness records <command-name>
        if (block?.type === "text" && typeof block.text === "string") {
          for (const m of block.text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) {
            seen.add(norm(m[1]));
          }
        }
      }
    } else if (typeof content === "string") {
      for (const m of content.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) {
        seen.add(norm(m[1]));
      }
    }
  }
  return seen;
}
