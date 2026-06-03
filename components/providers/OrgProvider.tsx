"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

interface OrgContextType {
  activeOrgId: Id<"organizations"> | null;
  setActiveOrgId: (id: Id<"organizations"> | null) => void;
  isLoading: boolean;
}

const OrgContext = createContext<OrgContextType | undefined>(undefined);

export function OrgProvider({ children }: { children: ReactNode }) {
  const [activeOrgId, setActiveOrgId] = useState<Id<"organizations"> | null>(null);

  // Fetch user's organizations
  const orgs = useQuery(api.organizations.listMine);

  useEffect(() => {
    // Auto-select the first org if none is selected and orgs are available
    if (orgs && orgs.length > 0 && !activeOrgId) {
      // Check localStorage first
      const stored = localStorage.getItem("autoflow_active_org");
      if (stored && orgs.some((o: any) => o._id === stored)) {
        setActiveOrgId(stored as Id<"organizations">);
      } else {
        setActiveOrgId(orgs[0]._id);
      }
    }
  }, [orgs, activeOrgId]);

  useEffect(() => {
    // Persist to localStorage when it changes
    if (activeOrgId) {
      localStorage.setItem("autoflow_active_org", activeOrgId);
    }
  }, [activeOrgId]);

  return (
    <OrgContext.Provider
      value={{
        activeOrgId,
        setActiveOrgId,
        isLoading: orgs === undefined,
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
