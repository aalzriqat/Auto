import { describe, expect, it } from "vitest";
import { commonAr, commonEn } from "../../lib/i18n/domains/common";
import { isCommitActionName } from "../scenarios/jevExplorerActions";

describe("random-walk action safety", () => {
  it.each([
    commonEn.SyncRolePermissions,
    commonAr.SyncRolePermissions,
    "Update Role Permissions",
    "تحديث صلاحيات الأدوار",
  ])("refuses the immediate-write role action %s", (name) => {
    expect(isCommitActionName(name)).toBe(true);
  });

  it("keeps read-only navigation eligible", () => {
    expect(isCommitActionName("Open Reports")).toBe(false);
  });
});
