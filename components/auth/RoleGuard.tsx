"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function RoleGuard({
  children,
  permissions = [],
  ownerOnly = false,
}: {
  children: React.ReactNode;
  permissions?: string[];
  /** When true, only the OWNER role may pass — overrides `permissions`. */
  ownerOnly?: boolean;
}) {
  const { activeOrgId } = useOrg();
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(true);

  const membership = useQuery(
    api.memberships.getMyMembership,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  useEffect(() => {
    if (membership !== undefined && activeOrgId) {
      const hasAccess = ownerOnly
        ? membership.roleName === "OWNER"
        : permissions.every(p => membership.permissions.includes(p));
      if (!hasAccess) {
        router.replace("/"); // Redirect to dashboard if no permission
      } else {
        setIsChecking(false);
      }
    }
  }, [membership, activeOrgId, permissions, ownerOnly, router]);

  if (isChecking || membership === undefined || !activeOrgId) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return <>{children}</>;
}
