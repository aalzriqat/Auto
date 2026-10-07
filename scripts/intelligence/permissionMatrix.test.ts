import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../../convex/utils/permissions";
import ts from "typescript";
import { BUILDERS, extractGuards, fnId, type FnGuard, type Guard } from "./permissionMatrix";
import { AUTHED_ONLY_ALLOWLIST, INLINE_ALLOWLIST, MEMBER_ONLY_ALLOWLIST, NO_GUARD_ALLOWLIST, type AllowEntry } from "./permissionMatrixAllowlist";

const convexDir = join(__dirname, "..", "..", "convex");

const sources = () =>
  readdirSync(convexDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_") && f !== "schema.ts")
    .sort((a, b) => a.localeCompare(b))
    .map((f) => ({ file: `convex/${f}`, text: readFileSync(join(convexDir, f), "utf8") }));

const scan = (): FnGuard[] => sources().flatMap((s) => extractGuards(s.file, s.text));

describe("extractGuards", () => {
  const classes = (src: string) => extractGuards("convex/x.ts", src).map((g) => [g.name, g.kind, g.guard, g.permissions]);

  it("classifies each guard shape", () => {
    expect(
      classes(`
export const a = mutation({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS, PERMISSIONS.VIEW_LEADS]); } });
export const b = query({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId); } });
export const c = query({ handler: async (ctx, args) => { await requireSuperAdmin(ctx); } });
export const d = query({ handler: async (ctx) => { return []; } });
export const e = mutation({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId, NEEDS_FORWARD_PERMS); } });
export const f = mutation({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId); if (!role.permissions.includes(PERMISSIONS.MANAGE_FINANCE)) throw 1; } });
export const g = mutation({ handler: async (ctx) => { await requireAuth(ctx); } });
export const h = action({ handler: async (ctx) => { await ctx.runMutation(internal.x.y, {}); } });
export const i =
  mutation({ handler: async () => {} });
export const j = socialBulkMutation({ handler: async () => {} });
export const k = mutation({ handler: async (ctx, a) => { await requireOwner(ctx, a.orgId); } });
export const l = mutation({ handler: async (ctx, a) => { await requireTenantAuth(ctx, a.orgId, [...AUTH_LIST]); } });
`),
    ).toEqual([
      ["a", "mutation", "permission", ["EDIT_LEADS", "VIEW_LEADS"]],
      ["b", "query", "member", []],
      ["c", "query", "platform", []],
      ["d", "query", "none", []],
      ["e", "mutation", "permission", ["$NEEDS_FORWARD_PERMS"]],
      ["f", "mutation", "inline", []],
      ["g", "mutation", "authed", []],
      ["h", "action", "none", []],
      ["i", "mutation", "none", []],
      ["j", "mutation", "none", []],
      ["k", "mutation", "owner", []],
      ["l", "mutation", "permission", ["$AUTH_LIST"]],
    ]);
  });

  it("a guarded neighbour, internal function or trailing helper never lends its guard (PR #512 F1)", () => {
    expect(
      classes(`
export const open = mutation({ handler: async () => {} });
export const hidden = internalMutation({ handler: async (ctx, a) => { await requireTenantAuth(ctx, a.orgId, [PERMISSIONS.MANAGE_USERS]); } });
export const last = query({ handler: async () => [] });
async function helper(ctx, a) { await requireSuperAdmin(ctx); await requireTenantAuth(ctx, a.orgId, [PERMISSIONS.MANAGE_USERS]); }
`),
    ).toEqual([
      ["open", "mutation", "none", []],
      ["last", "query", "none", []],
    ]);
  });

  it("validation helpers and comments are not guards (PR #512 F2)", () => {
    expect(
      classes(`
export const a = mutation({ handler: async (ctx, args) => { assertFiniteNumber(args.n); await requireFeature(ctx, args.orgId, "x"); await requireOwnedRow(ctx, args.orgId, "t", args.id); } });
// requireTenantAuth(ctx, orgId, [PERMISSIONS.EDIT_LEADS])
export const b = mutation({ handler: async () => { /* requireSuperAdmin(ctx); PERMISSIONS.MANAGE_USERS */ } });
`),
    ).toEqual([
      ["a", "mutation", "none", []],
      ["b", "mutation", "none", []],
    ]);
  });
});

describe("permission matrix of the real convex/ directory (SCRUM-616)", () => {
  const all = scan();

  it("sees every export a plain text search sees (the scanner cannot go blind)", () => {
    const names = Object.keys(BUILDERS).join("|");
    const broad = sources().reduce((n, s) => n + [...s.text.matchAll(new RegExp(`^export const \\w+\\s*=\\s*(${names})\\(`, "gm"))].length, 0);
    expect(all.length).toBe(broad);
    expect(all.length).toBeGreaterThan(600);
  });

  it("convex/functions.ts exports no public builder the scanner does not know (PR #512 NEW-1)", () => {
    const text = readFileSync(join(convexDir, "functions.ts"), "utf8");
    const sf = ts.createSourceFile("functions.ts", text, ts.ScriptTarget.Latest, true);
    const exported = sf.statements.flatMap((s) =>
      ts.isVariableStatement(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ? s.declarationList.declarations.map((d) => d.name.getText(sf))
        : [],
    );
    expect(exported.length).toBeGreaterThan(2);
    // `internal*` builders register private functions; every other exported builder is public.
    expect(exported.filter((n) => !n.startsWith("internal") && !(n in BUILDERS))).toEqual([]);
  });

  it("the scanner sees the socialBulkMutation export setConversationVehicle", () => {
    expect(all.find((g) => fnId(g) === "convex/socialInbox.ts:setConversationVehicle")?.guard).toBe("permission");
  });

  it("every PERMISSIONS key a guard names exists in the catalogue", () => {
    const known = new Set(Object.keys(PERMISSIONS));
    const unknown = all.flatMap((g) => g.permissions.filter((p) => !p.startsWith("$") && !known.has(p)).map((p) => `${fnId(g)} -> ${p}`));
    expect(unknown).toEqual([]);
  });

  const exact = (guard: Guard, list: AllowEntry[]) => {
    const found = all.filter((g) => g.guard === guard).map(fnId).sort((a, b) => a.localeCompare(b));
    expect(found).toEqual(list.map((e) => e.id).sort((a, b) => a.localeCompare(b)));
    for (const e of list) expect(e.reason.trim().length, e.id).toBeGreaterThan(10);
  };

  it("every export with no recognised guard is listed on purpose", () => exact("none", NO_GUARD_ALLOWLIST));
  it("every member-only export (any active member passes) is listed on purpose", () => exact("member", MEMBER_ONLY_ALLOWLIST));
  it("every export that reads PERMISSIONS inline is listed on purpose", () => exact("inline", INLINE_ALLOWLIST));
  it("every export open to any signed-in user of any org is listed on purpose", () => exact("authed", AUTHED_ONLY_ALLOWLIST));

  it("every mutation in a money file carries a permission, platform or owner guard, apart from the retired stubs", () => {
    const moneyFile =
      /^convex\/(accounting\w*|ledger\w*|glPosting|financeCompanyForward|financingEconomics|dealUnwind|deposits?\w*|payments?\w*|collections?\w*|payroll\w*|commissions?\w*|cashDrawer|expenses|transactions|settlement\w*|refunds?\w*|invoices?\w*|receipts?\w*|applications|sales|quotes|financeDealCosts|prepaidExpenses|bankReconciliation|bankAccounts|chartOfAccounts|fixedAssets|partnerEquity|claims|supplierCostRecoveries|sourcingPayables|supplierReceivables|finance)\.ts$/;
    const money = all.filter((g) => g.kind === "mutation" && moneyFile.test(g.file));
    expect(money.length).toBeGreaterThan(20);
    const stubs = new Set([
      "convex/transactions.ts:add",
      "convex/transactions.ts:update",
      "convex/transactions.ts:remove",
      "convex/accountingMigration.ts:migrateUnpostedTransactions",
      // Checks REGISTER_EXPECTED_PAYMENT / MANAGE_FINANCE inline after auth (applications.ts:4160-4168).
      "convex/applications.ts:registerExpectedPayment",
    ]);
    const offenders = money.filter((g) => !["permission", "platform", "owner"].includes(g.guard) && !stubs.has(fnId(g)));
    expect(offenders.map((g) => `${fnId(g)} (${g.guard})`)).toEqual([]);
  });
});
