"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AdminShell } from "@/components/admin/AdminShell";
import { Toaster } from "@/components/ui/sonner";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const isSuperAdmin = useQuery(api.adminAuth.isSuperAdmin, isAuthenticated ? {} : "skip");

  const isLoading = authLoading || (isAuthenticated && isSuperAdmin === undefined);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated || !isSuperAdmin) {
      router.replace("/dashboard");
    }
  }, [isLoading, isAuthenticated, isSuperAdmin, router]);

  if (isLoading || !isAuthenticated || !isSuperAdmin) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-muted/30">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Checking access…</p>
      </div>
    );
  }

  return (
    <>
      <AdminShell>{children}</AdminShell>
      <Toaster />
    </>
  );
}
