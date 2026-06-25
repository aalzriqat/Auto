"use client";

import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";

export function ImpersonationBanner() {
  const { activeOrgId } = useOrg();
  const router = useRouter();
  const grant = useQuery(
    api.adminImpersonation.getMyActiveImpersonation,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const endImpersonation = useMutation(api.adminImpersonation.endImpersonation);

  if (!grant) return null;

  const time = new Date(grant.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  async function handleExit() {
    try {
      await endImpersonation({});
      toast.success("Impersonation ended");
      router.push("/admin/users");
    } catch (e: any) {
      toast.error(e);
    }
  }

  return (
    <div className="w-full bg-red-500/15 border-b border-red-500/30 px-4 py-2 flex items-center justify-center gap-3 text-center text-xs sm:text-sm text-red-700 dark:text-red-300 shrink-0">
      <span>
        Impersonating <strong>{grant.targetName}</strong> in <strong>{grant.orgName}</strong> as {grant.roleName} — expires {time}
      </span>
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={handleExit}>
        Exit impersonation
      </Button>
    </div>
  );
}
