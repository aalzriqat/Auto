"use client";

import Image from "next/image";
import Link from "next/link";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { NavSections, PlanCard } from "@/components/layout/NavSections";

export function Sidebar() {
  const { activeOrgId } = useOrg();

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];
  const isOwner = myMembership?.isSystemOwnerRole === true;
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const canSeeApprovals = permissions.includes("approve:requests");
  const pendingCount = useQuery(
    api.approvals.countPending,
    activeOrgId && canSeeApprovals ? { orgId: activeOrgId } : "skip"
  );

  return (
    <aside className="hidden md:flex flex-col w-64 border-e border-slate-200/50 bg-white shadow-sm shrink-0">
      {/* 64px, the same height as the top bar, so the two borders line up. */}
      <div className="flex h-16 items-center justify-center px-6 border-b border-slate-200/50 shrink-0">
        <Link href={`/${activeOrgId}/dashboard`} className="flex items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {logoUrl ? (
            <img src={logoUrl} alt="Organization Logo" className="h-10 w-auto max-w-[160px] object-contain" />
          ) : (
            <Image src="/logo.png" alt="AutoFlow Logo" width={180} height={80} className="h-10 w-auto max-w-[160px] object-contain" priority />
          )}
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pt-3 pb-4">
        <NavSections
          permissions={permissions}
          isOwner={isOwner}
          density="desktop"
          badges={{ Approvals: pendingCount }}
        />
      </div>

      <div className="shrink-0 border-t border-slate-200/50 p-3 empty:hidden">
        <PlanCard permissions={permissions} isOwner={isOwner} density="desktop" />
      </div>
    </aside>
  );
}
