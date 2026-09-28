import { describe, expect, it } from "vitest";
import { syncRolePermissionsMessage } from "./syncRolePermissionsMessage";

const t = (key: string) =>
  ({
    SyncRolePermissionsDone: "Updated {count} role(s) to the latest permission templates: {roles}.",
    SyncRolePermissionsNone: "All standard roles already match the latest permission templates.",
    SyncRolePermissionsSynced: "Role permissions synced to the latest templates.",
  })[key] ?? key;

describe("syncRolePermissionsMessage", () => {
  it("names each changed role", () => {
    expect(
      syncRolePermissionsMessage({ changes: [{ name: "Manager" }, { name: "Sales" }] }, t)
    ).toBe("Updated 2 role(s) to the latest permission templates: Manager, Sales.");
  });

  it("says nothing changed when no role changed", () => {
    expect(syncRolePermissionsMessage({ changes: [] }, t)).toBe(
      "All standard roles already match the latest permission templates."
    );
  });

  // An older backend returns a bare count of every template-matched role, changed or not,
  // and no names: neither a count nor an empty role list may be shown.
  it.each([0, 3])("an older backend's bare count %i gives a message with no count or role list", (count) => {
    const message = syncRolePermissionsMessage(count, t);
    expect(message).toBe("Role permissions synced to the latest templates.");
    expect(message).not.toMatch(/:\s*\.$/);
  });
});
