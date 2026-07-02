"use client";

import { createContext, useContext, useEffect, ReactNode } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

interface OrgContextType {
  activeOrgId: Id<"organizations"> | null;
  setActiveOrgId: (id: Id<"organizations">) => void;
  isLoading: boolean;
}

const OrgContext = createContext<OrgContextType | undefined>(undefined);

// Active org lives in the URL (the [orgId] segment), not in client storage.
// Every navigation re-derives it, and every Convex query re-validates it
// server-side via requireTenantAuth — so there's no separate persisted
// client state that can go stale (e.g. after a user is removed from an org).
export function OrgProvider({ children }: { children: ReactNode }) {
  const params = useParams<{ orgId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();

  const urlOrgId = (params?.orgId ?? null) as Id<"organizations"> | null;

  const orgs = useQuery(api.organizations.listMine, isAuthenticated ? undefined : "skip");

  const isMember = orgs?.some((o: any) => o._id === urlOrgId) ?? false;

  useEffect(() => {
    if (!orgs) return; // still loading — don't redirect yet
    if (!urlOrgId || !isMember) {
      // The URL references an org the user doesn't belong to (stale link,
      // removed membership, foreign id). Bounce to the entry point, which
      // will pick a valid org or show onboarding.
      router.replace("/dashboard");
    }
  }, [orgs, urlOrgId, isMember, router]);

  function setActiveOrgId(id: Id<"organizations">) {
    // Swap the leading orgId path segment, preserving the rest of the path.
    const rest = pathname.split("/").slice(2).join("/");
    router.push(`/${id}${rest ? `/${rest}` : ""}`);
  }

  const isLoading = orgs === undefined;
  // Do not expose activeOrgId until membership is confirmed. The parent
  // dashboard layout keeps listMine subscribed so the cache is warm and
  // isLoading is false before child components mount on normal navigation.
  // Guarding here prevents Convex queries from firing with an unvalidated
  // URL org ID, which would produce invalid-ID errors on stale/foreign links.
  const activeOrgId = (!isLoading && isMember) ? urlOrgId : null;

  return (
    <OrgContext.Provider
      value={{
        activeOrgId,
        setActiveOrgId,
        isLoading,
      }}
    >
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg() {
  const context = useContext(OrgContext);
  if (context === undefined) {
    throw new Error("useOrg must be used within an OrgProvider");
  }
  return context;
}
