"use client";

import { createContext, useContext, useEffect, useState, useRef, ReactNode } from "react";
import { useQuery, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

interface OrgContextType {
  activeOrgId: Id<"organizations"> | null;
  setActiveOrgId: (id: Id<"organizations"> | null) => void;
  isLoading: boolean;
}

const OrgContext = createContext<OrgContextType | undefined>(undefined);

// How long to wait after receiving an empty org list before showing the
// onboarding screen. This gives the Clerk webhook time to sync a newly
// created user into the Convex `users` table so that listMine can return
// their memberships on the next reactive update.
const WEBHOOK_SYNC_WAIT_MS = 4000;

export function OrgProvider({ children }: { children: ReactNode }) {
  const [activeOrgId, setActiveOrgId] = useState<Id<"organizations"> | null>(null);
  const { isAuthenticated } = useConvexAuth();

  // Fetch user's organizations
  const orgs = useQuery(api.organizations.listMine, isAuthenticated ? undefined : "skip");

  // stabilized: true means we've waited long enough and can trust an empty list
  const [stabilized, setStabilized] = useState(false);
  const stabilizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (orgs === undefined) {
      // Still loading from Convex — reset stabilization
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStabilized(false);
      if (stabilizeTimerRef.current) {
        clearTimeout(stabilizeTimerRef.current);
        stabilizeTimerRef.current = null;
      }
      return;
    }

    if (orgs.length > 0) {
      // We have orgs — immediately stable, cancel any pending timer
      setStabilized(true);
      if (stabilizeTimerRef.current) {
        clearTimeout(stabilizeTimerRef.current);
        stabilizeTimerRef.current = null;
      }
      return;
    }

    // orgs is defined but empty — could be a webhook race condition.
    // Start a timer; if orgs are still empty when it fires, we show onboarding.
    if (!stabilizeTimerRef.current) {
      stabilizeTimerRef.current = setTimeout(() => {
        setStabilized(true);
        stabilizeTimerRef.current = null;
      }, WEBHOOK_SYNC_WAIT_MS);
    }

    return () => {
      if (stabilizeTimerRef.current) {
        clearTimeout(stabilizeTimerRef.current);
      }
    };
  }, [orgs]);

  useEffect(() => {
    // Auto-select the first org if none is selected and orgs are available
    if (orgs && orgs.length > 0 && !activeOrgId) {
      // Check localStorage first
      const stored = localStorage.getItem("autoflow_active_org");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored && orgs.some((o: any) => o._id === stored)) {
        setActiveOrgId(stored as Id<"organizations">);
      } else {
        const firstOrgId = orgs[0]?._id;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (firstOrgId) {
          setActiveOrgId(firstOrgId);
        }
      }
    }
  }, [orgs, activeOrgId]);

  useEffect(() => {
    // Persist to localStorage when it changes
    if (activeOrgId) {
      localStorage.setItem("autoflow_active_org", activeOrgId);
    }
  }, [activeOrgId]);

  // Loading = Convex query is in flight OR we haven't yet stabilized on an empty result
  const isLoading = orgs === undefined || (orgs.length === 0 && !stabilized);

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
