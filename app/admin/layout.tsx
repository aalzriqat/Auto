"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
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
      <div className="flex h-screen items-center justify-center bg-slate-950 flex-col gap-4">
        <div className="w-10 h-10 rounded-full border-4 border-amber-500 border-t-transparent animate-spin" />
        <p className="text-sm text-slate-400">Checking access...</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-950">
      <AdminSidebar />
      <main className="flex-1 overflow-y-auto p-6 lg:p-8">{children}</main>
      <Toaster />
    </div>
  );
}
