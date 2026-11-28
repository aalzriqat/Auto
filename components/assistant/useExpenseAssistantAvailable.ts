"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * `PERMISSIONS.CREATE_EXPENSES` (convex/utils/permissions.ts), spelled out because
 * components may not import convex/utils. The button test pins the two together;
 * the server's own check on getAvailability is the authority either way.
 */
export const CREATE_EXPENSES_PERMISSION = "create:expenses";

/**
 * Whether this member may use the expense assistant (SCRUM-1039): they can
 * create expenses AND their dealership has the assistant switched on.
 *
 * The availability query refuses members without `create:expenses`, so it is
 * not subscribed for them at all. `false` while either answer is loading, so the
 * entry never flashes in and out.
 */
export function useExpenseAssistantAvailable(
  orgId: Id<"organizations"> | null | undefined,
  permissions: readonly string[],
): boolean {
  const canCreate = permissions.includes(CREATE_EXPENSES_PERMISSION);
  const availability = useQuery(
    api.aiAssistant.getAvailability,
    orgId && canCreate ? { orgId } : "skip",
  );
  return canCreate && availability?.enabled === true;
}
