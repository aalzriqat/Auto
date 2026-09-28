import { interpolate } from "@/lib/i18n/interpolate";

/** What `memberships.syncRolePermissionsToTemplate` returns; an older backend returns a bare count. */
export type SyncRolePermissionsResult = { changes: { name: string }[] } | number;

export function syncRolePermissionsMessage(
  result: SyncRolePermissionsResult,
  t: (key: string) => string
): string {
  // The old count covers every template-matched role, changed or not, and carries no names.
  if (typeof result === "number") return t("SyncRolePermissionsSynced");
  if (result.changes.length === 0) return t("SyncRolePermissionsNone");
  return interpolate(t("SyncRolePermissionsDone"), {
    count: result.changes.length,
    roles: result.changes.map((change) => change.name).join(", "),
  });
}
