/**
 * SCRUM-51 — Claims may never be a second finance-company AR authority.
 *
 * `claims.add` used to open a canonical FINANCE_COMPANY receivable while no
 * `CLAIM_CREATED` accounting event existed, so the subledger carried AR the GL
 * had never debited. `claims.settle`/`claims.reject` then *credited*
 * `ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES`, discharging a balance that was never
 * originated. Finance Applications already own that receivable
 * (`applications.ts` → `ensureFinanceCompanyReceivable` + `ruleFinanceDisbursed`),
 * so Claims was a second model of one economic fact.
 *
 * The resolution (SCRUM-49: "Operations create the economic event. Accounting
 * consumes, controls, reconciles and reports it.") is that Claims originates
 * nothing and settles nothing. It is a read-only work queue over the
 * authoritative receivable.
 *
 * Settling *through* Claims is not a safe alternative either: `confirmDisbursement`
 * posts `hookFinanceCashReceived` before it computes `allocationMinor`, and skips
 * allocation when the receivable is already fully allocated instead of throwing.
 * A second settlement door would therefore double-credit the GL silently.
 *
 * This is a source-shape guard rather than a behavioural test because the
 * defect's return would take the form of a *new writer* being added back to the
 * module — there is no runtime call left to assert against once the writers are
 * gone. The self-tests below come first on purpose: a guard nobody has watched
 * fail is not a guard.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CONVEX_ROOT = path.resolve(__dirname);
const CLAIMS_MODULE = path.join(CONVEX_ROOT, "claims.ts");

/**
 * The claim-settlement hooks post `Dr Cash-or-Bank / Cr AR — Finance Companies`
 * and `Dr Claim Write-off / Cr AR — Finance Companies`. They are left in place
 * (their posting rules still serve `accountingMigration`'s legacy CLAIM_PAYMENT
 * replay and any historical event), but nothing may *call* them: a caller is
 * exactly how a second settlement door — and the one-sided credit — comes back,
 * and it need not live in claims.ts to do damage.
 */
const UNCALLABLE_HOOKS = ["hookClaimSettled", "hookClaimWrittenOff"];

/** Where those hooks are defined, and therefore allowed to appear. */
const HOOK_DEFINITION_MODULE = path.join(CONVEX_ROOT, "accounting", "workflowHooks.ts");

function convexSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_generated" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) convexSourceFiles(full, acc);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * Helpers that originate or discharge money. Any of them appearing in the
 * Claims module means Claims has become a money authority again.
 */
const FORBIDDEN_MONEY_HELPERS = [
  "ensureReceivableDocument",
  "createCanonicalPayment",
  "allocatePaymentToReceivable",
  "hookClaimSettled",
  "hookClaimWrittenOff",
  "postDomainEvent",
];

/** Tables Claims must never write, whoever the caller is. */
const FORBIDDEN_WRITE_TABLES = [
  "receivableDocuments",
  "canonicalPayments",
  "paymentAllocations",
  "accountingEvents",
  "journalEntries",
  "journalLines",
];

export interface ClaimsGuardViolation {
  kind: "mutation" | "money-helper" | "table-write" | "db-write" | "indirect-write";
  detail: string;
}

/**
 * Reports every way the given Claims source could originate or settle money.
 *
 * Comments are stripped first so that documenting the retired behaviour — as
 * this file's own header does — cannot trip the guard.
 */
export function findClaimsWriteCapabilities(source: string): ClaimsGuardViolation[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const violations: ClaimsGuardViolation[] = [];

  // A registration can be renamed on import — `import { mutation as writer }` —
  // so the local names that mean "mutation" are resolved first rather than
  // matching the bare word. Codex's review found this exact bypass.
  const registrationNames = new Set(["mutation", "internalMutation"]);
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  for (const imp of code.matchAll(importRe)) {
    for (const clause of imp[1].split(",")) {
      const aliased = /^\s*(\w+)\s+as\s+(\w+)\s*$/.exec(clause);
      if (aliased && registrationNames.has(aliased[1])) registrationNames.add(aliased[2]);
    }
  }

  const names = [...registrationNames].join("|");
  // Covers `export const x = <reg>(` and `export const x = <reg><any generics>(`.
  const mutationDecl = new RegExp(`export\\s+const\\s+(\\w+)\\s*=\\s*(${names})\\s*[<(]`, "g");
  for (const m of code.matchAll(mutationDecl)) {
    violations.push({ kind: "mutation", detail: `${m[1]} = ${m[2]}(...)` });
  }

  // Any database write at all, whatever it targets. `ctx.db.patch` on an id
  // needs no table name, so a table-name scan alone never sees it.
  for (const op of ["insert", "patch", "replace", "delete"]) {
    if (new RegExp(`\\.db\\s*\\.\\s*${op}\\s*\\(`).test(code)) {
      violations.push({ kind: "db-write", detail: `ctx.db.${op}(...)` });
    }
  }

  // Reaching a writer indirectly is still writing.
  for (const escape of ["runMutation", "scheduler"]) {
    if (new RegExp(`\\b${escape}\\b`).test(code)) {
      violations.push({ kind: "indirect-write", detail: escape });
    }
  }

  for (const helper of FORBIDDEN_MONEY_HELPERS) {
    if (new RegExp(`\\b${helper}\\b`).test(code)) {
      violations.push({ kind: "money-helper", detail: helper });
    }
  }

  for (const table of FORBIDDEN_WRITE_TABLES) {
    // ctx.db.insert("receivableDocuments", …) / ctx.db.patch on a doc id is not
    // table-named, so the insert form is what is detectable and what matters:
    // Claims creating the document is the defect.
    if (new RegExp(`\\.insert\\(\\s*["'\`]${table}["'\`]`).test(code)) {
      violations.push({ kind: "table-write", detail: `insert into ${table}` });
    }
  }

  return violations;
}

/**
 * True when the source raises a **receivable document** stamped with the Claims
 * source — the shape of the retired defect — as opposed to merely mentioning
 * that source string, which the accounting event legitimately does.
 *
 * Scans the argument object of each call that can create one, bounded to the
 * call's own braces so a later unrelated `sourceType` cannot be attributed to it.
 */
export function findClaimsSourcedReceivable(code: string): boolean {
  const callSites = /(ensureReceivableDocument\s*\(|\.insert\s*\(\s*["'`]receivableDocuments["'`])/g;

  for (const match of code.matchAll(callSites)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 0;
    let end = start;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    if (/sourceType\s*:\s*["'`]claims["'`]/.test(code.slice(start, end))) return true;
  }

  return false;
}

/** Verbatim shape of `claims.add` as it shipped pre-fix (the CRITICAL defect). */
const VULNERABLE = `
import { ensureReceivableDocument } from "./subledger";
import { hookClaimSettled } from "./accounting/workflowHooks";

export const add = mutation({
  args: { orgId: v.id("organizations"), claimAmountMinor: v.number() },
  handler: async (ctx, args) => {
    const claimId = await ctx.db.insert("claims", { orgId: args.orgId });
    const receivableDocumentId = await ensureReceivableDocument(ctx, {
      orgId: args.orgId,
      payerType: "FINANCE_COMPANY",
      sourceType: "claims",
      originalAmountMinor: args.claimAmountMinor,
    });
    await ctx.db.patch(claimId, { receivableDocumentId });
    return claimId;
  },
});
`;

/** The post-fix shape: a projection query and nothing else. */
const READ_ONLY = `
import { query } from "./_generated/server";

export const listFinanceCompanyReceivables = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db.query("receivableDocuments").collect();
  },
});
`;

describe("SCRUM-51 guard self-tests", () => {
  test("flags the pre-fix claims.add that originated a receivable", () => {
    const violations = findClaimsWriteCapabilities(VULNERABLE);
    expect(violations.map((v) => v.kind)).toContain("mutation");
    expect(violations.map((v) => v.detail)).toContain("ensureReceivableDocument");
    expect(violations.map((v) => v.detail)).toContain("hookClaimSettled");
  });

  test("clears a read-only projection module", () => {
    expect(findClaimsWriteCapabilities(READ_ONLY)).toEqual([]);
  });

  test("flags a mutation smuggled in under an aliased import", () => {
    const aliased = `
      import { mutation as writer } from "./functions";
      export const settle = writer({
        args: {},
        handler: async (ctx) => { await ctx.db.patch(id, { status: "PAID" }); },
      });
    `;
    const kinds = findClaimsWriteCapabilities(aliased).map((v) => v.kind);
    expect(kinds).toContain("mutation");
    expect(kinds).toContain("db-write");
  });

  test("flags a table-agnostic write and an indirect one", () => {
    expect(
      findClaimsWriteCapabilities(`const f = async (ctx) => ctx.db.patch(id, {});`)
        .map((v) => v.detail)
    ).toContain("ctx.db.patch(...)");

    expect(
      findClaimsWriteCapabilities(`const f = async (ctx) => ctx.runMutation(internal.x.y, {});`)
        .map((v) => v.detail)
    ).toContain("runMutation");

    expect(
      findClaimsWriteCapabilities(`const f = async (ctx) => ctx.scheduler.runAfter(0, internal.x.y, {});`)
        .map((v) => v.detail)
    ).toContain("scheduler");
  });

  test("tells a claims-sourced receivable apart from a claims-sourced event", () => {
    // The real pre-fix shape: the receivable itself is stamped.
    expect(
      findClaimsSourcedReceivable(`
        await ensureReceivableDocument(ctx, {
          payerType: "FINANCE_COMPANY",
          sourceType: "claims",
          sourceId: claimId.toString(),
        });
      `)
    ).toBe(true);

    // workflowHooks' postClaimEvent — legitimate, and must not be flagged.
    expect(
      findClaimsSourcedReceivable(`
        await postDomainEvent(ctx, {
          eventType,
          sourceType: "claims",
          sourceId: args.claimId.toString(),
        });
      `)
    ).toBe(false);

    // A receivable raised for a different source, with an unrelated claims
    // event later in the same file, must not be attributed to the call.
    expect(
      findClaimsSourcedReceivable(`
        await ensureReceivableDocument(ctx, { sourceType: "finance_application" });
        await postDomainEvent(ctx, { sourceType: "claims" });
      `)
    ).toBe(false);
  });

  test("does not trip on prose describing the retired behaviour", () => {
    const documented = `
      // Claims used to call ensureReceivableDocument here; it no longer does.
      /* hookClaimSettled is deliberately not imported. */
      ${READ_ONLY}
    `;
    expect(findClaimsWriteCapabilities(documented)).toEqual([]);
  });
});

describe("SCRUM-51 — convex/claims.ts originates and settles nothing", () => {
  test("exposes no mutation and touches no money helper or subledger table", () => {
    const source = fs.readFileSync(CLAIMS_MODULE, "utf8");
    const violations = findClaimsWriteCapabilities(source);

    expect(
      violations,
      `convex/claims.ts must stay a read-only projection over the authoritative\n` +
        `finance-company receivable. Found:\n` +
        violations.map((v) => `  - [${v.kind}] ${v.detail}`).join("\n")
    ).toEqual([]);
  });

  test("no module calls the claim settlement/write-off hooks", () => {
    const callers: string[] = [];

    for (const file of convexSourceFiles(CONVEX_ROOT)) {
      if (file === HOOK_DEFINITION_MODULE) continue;
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");

      for (const hook of UNCALLABLE_HOOKS) {
        if (new RegExp(`\\b${hook}\\b`).test(code)) {
          callers.push(`${path.relative(CONVEX_ROOT, file)} → ${hook}`);
        }
      }
    }

    expect(
      callers,
      `These hooks credit AR — Finance Companies. Nothing may call them: the\n` +
        `matching debit is originated by Finance Applications, and a second\n` +
        `settlement door double-credits the GL. Found:\n` +
        callers.map((c) => `  - ${c}`).join("\n")
    ).toEqual([]);
  });

  test("no module anywhere raises a claims-sourced receivable", () => {
    // The other half of the bypass: origination does not have to live in
    // claims.ts to recreate a second finance-company AR authority. What defines
    // the defect is a receivable stamped with the Claims source, wherever the
    // code sits.
    const originators: string[] = [];

    for (const file of convexSourceFiles(CONVEX_ROOT)) {
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");

      // Deliberately NOT a bare search for `sourceType: "claims"`. That string
      // also appears on the *accounting event* in workflowHooks' postClaimEvent,
      // which is legitimate — accountingMigration still replays legacy
      // CLAIM_PAYMENT rows as CLAIM_SETTLED and they are sourced to claims. The
      // defect is a claims-sourced RECEIVABLE, so only the two calls that can
      // create one are inspected.
      if (findClaimsSourcedReceivable(code)) {
        originators.push(path.relative(CONVEX_ROOT, file));
      }
    }

    expect(
      originators,
      `A receivable stamped sourceType:"claims" has no originating GL debit —\n` +
        `Finance Applications own finance-company AR. Found in:\n` +
        originators.map((f) => `  - ${f}`).join("\n")
    ).toEqual([]);
  });

  test("the scan actually reaches nested modules (guard self-test)", () => {
    const scanned = convexSourceFiles(CONVEX_ROOT).map((f) => path.relative(CONVEX_ROOT, f));
    // A non-recursive scan would miss accounting/, which is where the hooks live.
    expect(scanned).toContain(path.join("accounting", "workflowHooks.ts"));
    expect(scanned).toContain("applications.ts");
    expect(scanned.some((f) => /\.test\.ts$/.test(f))).toBe(false);
  });
});
