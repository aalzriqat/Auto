import { describe, expect, test } from "vitest";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { auditConvexBackend, findUnguardedTenantWrites } from "./tenantWriteGuard";

describe("delegated tenant writes", () => {
  test.each([true, false])("checks caller-ID writes in the imported handler with ownership proof %s", (owned) => {
    const directory = mkdtempSync(path.join(tmpdir(), "autoflow-tenant-delegation-"));
    try {
      writeFileSync(path.join(directory, "entry.ts"), [
        'import { updateDocument as update } from "./implementation";',
        "export const rename = mutation({",
        '  args: { orgId: v.id("organizations"), documentId: v.id("documents") },',
        "  handler: (ctx, args) => update(ctx, args),",
        "});",
      ].join("\n"));
      writeFileSync(path.join(directory, "implementation.ts"), [
        "export async function updateDocument(ctx: MutationCtx, args: UpdateArgs) {",
        ...(owned ? ['  await requireOwnedRow(ctx, args.orgId, "documents", args.documentId);'] : []),
        '  await ctx.db.patch(args.documentId, { title: "Updated" });',
        "}",
      ].join("\n"));

      expect(auditConvexBackend(directory)).toEqual(owned ? [] : [{
        file: "entry.ts",
        functionName: "rename",
        kind: "mutation",
        writes: ["patch(args.documentId)"],
      }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Accounting Periods tenant-write visibility", () => {
  const file = "accountingPeriods.ts";
  const source = readFileSync(path.resolve(__dirname, "../convex", file), "utf8");
  const proof = "if (!period || period.orgId !== args.orgId)";

  test.each(["open", "close", "lock", "reopen"])("detects missing ownership proof in %s", (name) => {
    const declaration = `\nexport const ${name} = mutation({`;
    const start = source.indexOf(declaration);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\nexport const ", start + declaration.length);
    const registeredMutation = source.slice(start, end === -1 ? undefined : end);
    expect(registeredMutation).toContain(proof);
    const withoutProof = registeredMutation.replace(proof, "if (!period)");
    expect(findUnguardedTenantWrites(withoutProof, file)).toEqual([{
      file,
      functionName: name,
      kind: "mutation",
      writes: ["patch(args.periodId)"],
    }]);
    expect(findUnguardedTenantWrites(registeredMutation, file)).toEqual([]);
  });
});
