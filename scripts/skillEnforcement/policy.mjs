/**
 * Skill-enforcement policy: which paths are sensitive, which skills each step
 * needs. Shared by the Claude Code hook (skillGate.mjs) and the PR check
 * (checkPrSkillEvidence.mjs) so the two cannot drift. Skills rank below
 * AGENTS.md; this file only makes the table in .claude/skills/README.md
 * mechanical. It never replaces the two-seat review.
 */

/** Keywords in a `convex/utils/` file name that mark money, permission or tenancy code. */
const UTIL_KEYWORDS = [
  "money", "deposit", "sale", "commission", "cost", "financ", "invoice", "ledger", "payroll",
  "prepaid", "expense", "settlement", "supplier", "cheque", "customercredit", "fee", "vat",
  "bank", "cash", "dealunwind", "handover", "amort", "partner", "payment", "economics", "quote",
  "retained", "profit", "gross", "custody", "commit", "execution", "materialization",
  "closewarnings", "manualfinance", "orgreset", "vehicleownership", "permissions", "tenancy",
  "idempotency", "auditlog",
];

/** `convex/<name>.ts` files that hold money, permission, tenancy or schema logic. */
const ROOT_NAMES = new Set([
  "sales", "deposits", "deposit", "depositRequests", "depositRevenueImpact", "collections",
  "collectionReminderActions", "expenses", "payroll", "bankAccounts", "bankReconciliation",
  "bankBalanceBackfill", "cashDrawer", "financingEconomics", "customerFinanceCompanyPayments",
  "dealUnwind", "dealCommissions", "dealOverview", "dealWorkspace", "applications",
  "prepaidExpenses", "partnerEquity", "paymentIntents", "paymentVouchers", "retainedCreditRefunds",
  "subledger", "sourcingPayables", "fixedAssets", "chartOfAccounts", "transactions", "commitments",
  "vatReport", "reports", "orgFinancialReset", "orgResetPreflight", "quotes",
  "journalReportEligibility", "diagnosePrepaidLedgerIntegrity", "chequeLineageAudit",
  "financialAudit", "aggregates", "subscriptions", "vehicleEdits", "vehicles",
  "sourcedAgentImpact", "dashboardExpenseSummary", "dashboard", "crons", "http", "schema", "roles",
  "memberships", "users", "organizations", "orgSettings", "approvals", "adminAuth", "adminOrgs",
  "adminData", "adminUsers", "adminImpersonation",
]);
const ROOT_PREFIXES = ["accounting", "finance", "supplier", "migrate"];

const GATE_EXACT = new Set(["AGENTS.md", "regression/rulings.json"]);
const GATE_PREFIXES = [".github/", ".claude/", "scripts/skillEnforcement/", "scripts/intelligence/"];
const GATE_SCRIPTS = ["assertRelease", "checkReleaseAuthority", "verifyZeroState", "rolloutProduction"];

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

function stem(file) {
  return file.replace(/\.test\.ts$/, "").replace(/\.ts$/, "");
}

function isGate(p) {
  if (GATE_EXACT.has(p) || GATE_PREFIXES.some((x) => p.startsWith(x))) return true;
  return p.startsWith("scripts/") && GATE_SCRIPTS.some((x) => p.slice("scripts/".length).startsWith(x));
}

function isMoney(p) {
  if (!p.startsWith("convex/")) return false;
  const rest = p.slice("convex/".length);
  if (rest.startsWith("accounting/")) return true;
  if (rest.startsWith("utils/")) {
    const name = stem(rest.slice("utils/".length)).toLowerCase();
    return !name.includes("/") && UTIL_KEYWORDS.some((k) => name.includes(k));
  }
  if (rest.includes("/") || !rest.endsWith(".ts")) return false;
  const name = stem(rest);
  return ROOT_NAMES.has(name) || ROOT_PREFIXES.some((x) => name.startsWith(x));
}

export function classifyPaths(paths) {
  const out = { sensitive: [], gate: [], code: [] };
  for (const raw of paths) {
    const p = raw.replace(/^\.\//, "");
    if (!p) continue;
    if (isGate(p)) out.gate.push(p);
    if (isMoney(p)) out.sensitive.push(p);
    if (CODE_EXTENSIONS.some((e) => p.endsWith(e))) out.code.push(p);
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

const normSkill = (s) => String(s).replace(/^\/+/, "").split(":").pop();
const COMMAND_MARKER = /<command-name>\/?([^<\s]+)<\/command-name>/g;

function parseLine(line) {
  try {
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

function userTexts(msg) {
  if (typeof msg?.content === "string") return [msg.content];
  const blocks = Array.isArray(msg?.content) ? msg.content : [];
  return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text);
}

/**
 * Skills invoked in a Claude Code JSONL transcript. Two sources count, and only
 * these two:
 *  - an assistant `Skill` tool call whose tool_result came back without error
 *    (an unknown or failed skill is not an invocation);
 *  - a `<command-name>/skill</command-name>` marker in a user-role message that
 *    is not a tool result, which is how the harness records a typed /skill.
 * Assistant prose that merely contains the marker text counts for nothing.
 */
export function invokedSkills(transcriptText) {
  const calls = new Map(); // tool_use id -> skill
  const answered = new Set();
  const seen = new Set();
  for (const rec of transcriptText.split("\n").map(parseLine)) {
    const msg = rec?.message;
    const role = msg?.role ?? rec?.type;
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    if (role === "assistant") {
      for (const b of blocks) {
        if (b?.type === "tool_use" && b.name === "Skill" && b.input?.skill && b.id) {
          calls.set(b.id, normSkill(b.input.skill));
        }
      }
    } else if (role === "user") {
      for (const b of blocks) {
        if (b?.type === "tool_result" && b.tool_use_id && !b.is_error) answered.add(b.tool_use_id);
      }
      for (const t of userTexts(msg)) for (const m of t.matchAll(COMMAND_MARKER)) seen.add(normSkill(m[1]));
    }
  }
  for (const [id, skill] of calls) if (answered.has(id)) seen.add(skill);
  return seen;
}
