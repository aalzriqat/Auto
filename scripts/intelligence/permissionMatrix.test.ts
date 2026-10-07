import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../../convex/utils/permissions";
import { extractGuards, fnId, type FnGuard, type Guard } from "./permissionMatrix";
import { INLINE_ALLOWLIST, MEMBER_ONLY_ALLOWLIST, NO_GUARD_ALLOWLIST, type AllowEntry } from "./permissionMatrixAllowlist";

const convexDir = join(__dirname, "..", "..", "convex");

function scan(): FnGuard[] {
  return readdirSync(convexDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_") && f !== "schema.ts")
    .sort((a, b) => a.localeCompare(b))
    .flatMap((f) => extractGuards(`convex/${f}`, readFileSync(join(convexDir, f), "utf8")));
}

describe("extractGuards", () => {
  it("classifies each guard shape", () => {
    const src = `
export const a = mutation({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_LEADS, PERMISSIONS.VIEW_LEADS]); } });
export const b = query({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId); } });
export const c = query({ handler: async (ctx, args) => { await requireSuperAdmin(ctx); } });
export const d = query({ handler: async (ctx) => { return []; } });
export const e = mutation({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId, NEEDS_FORWARD_PERMS); } });
export const f = mutation({ handler: async (ctx, args) => { await requireTenantAuth(ctx, args.orgId); if (!role.permissions.includes(PERMISSIONS.MANAGE_FINANCE)) throw 1; } });
`;
    expect(extractGuards("convex/x.ts", src).map((g) => [g.name, g.guard, g.permissions])).toEqual([
      ["a", "permission", ["EDIT_LEADS", "VIEW_LEADS"]],
      ["b", "member", []],
      ["c", "other", []],
      ["d", "none", []],
      ["e", "permission", ["$NEEDS_FORWARD_PERMS"]],
      ["f", "inline", []],
    ]);
  });
});

describe("permission matrix of the real convex/ directory (SCRUM-616)", () => {
  const all = scan();

  it("finds the exports (guards against the scanner going blind)", () => {
    expect(all.length).toBeGreaterThan(500);
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

  it("every export with no recognisable guard is listed on purpose", () => exact("none", NO_GUARD_ALLOWLIST));
  it("every member-only export (any active member passes) is listed on purpose", () => exact("member", MEMBER_ONLY_ALLOWLIST));
  it("every export that checks permissions inline is listed on purpose", () => exact("inline", INLINE_ALLOWLIST));

  it("no mutation that moves money is member-only or unguarded", () => {
    const money = /payment|refund|deposit|forward|settle|commission|ledger|journal|invoice|receipt|cheque|unwind|cost|price|payroll/i;
    const offenders = all.filter((g) => g.kind === "mutation" && (g.guard === "none" || g.guard === "member") && money.test(g.name));
    expect(offenders.map(fnId)).toEqual([]);
  });
});
