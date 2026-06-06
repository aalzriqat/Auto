"use client";

import { TopNav } from "@/components/layout/TopNav";
import { OrgProvider, useOrg } from "@/components/providers/OrgProvider";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";

function Onboarding() {
  const { setActiveOrgId } = useOrg();
  const [name, setName] = useState("");
  const createOrg = useMutation(api.organizations.create);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const newId = await createOrg({ name: name.trim() });
      setActiveOrgId(newId);
      toast.success("Welcome to your new dealership!");
    } catch (err: any) {
      toast.error(err.message || "Something went wrong");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-muted/50 p-4">
      <div className="max-w-md w-full bg-background p-8 rounded-xl border shadow-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Welcome to AutoFlow</h1>
          <p className="text-muted-foreground text-sm">
            Let's get started by creating your first dealership organization.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2 text-start">
            <label htmlFor="orgName" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              Dealership Name
            </label>
            <Input
              id="orgName"
              placeholder="e.g. Acme Motors"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" disabled={!name.trim()}>
            Create Organization
          </Button>
        </form>
      </div>
    </div>
  );
}

function DashboardWrapper({ children }: { children: React.ReactNode }) {
  const { activeOrgId, isLoading } = useOrg();

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  if (!activeOrgId) {
    return <Onboarding />;
  }

  return (
    <div className="flex min-h-screen flex-col w-full bg-slate-50 dark:bg-zinc-950/40">
      <TopNav />
      <main className="flex-1 overflow-auto p-4 md:p-6 lg:p-8">
        {children}
      </main>
      <Toaster />
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <OrgProvider>
      <DashboardWrapper>{children}</DashboardWrapper>
    </OrgProvider>
  );
}
