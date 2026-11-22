import { describe, expect, test } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { auditConvexBackend } from "./tenantWriteGuard";

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
