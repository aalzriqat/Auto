"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { LogOut, Menu, ShieldCheck } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AdminNavLinks, useActiveNavTitle } from "@/components/admin/adminNav";

function Brand() {
  return (
    <Link href="/admin" className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <ShieldCheck className="h-4.5 w-4.5" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-foreground">AutoFlow</span>
        <span className="text-[11px] font-medium text-muted-foreground">Super Admin</span>
      </span>
    </Link>
  );
}

function SignOutButton() {
  const router = useRouter();
  const { signOut } = useClerk();
  return (
    <button
      type="button"
      onClick={() => signOut(() => router.replace("/sign-in"))}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <LogOut className="h-4 w-4 shrink-0 text-muted-foreground/70" />
      Log out
    </button>
  );
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const title = useActiveNavTitle();

  return (
    <div className="flex min-h-screen w-full bg-muted/30">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-64 flex-col border-e border-border bg-sidebar lg:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-border px-5">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-5">
          <AdminNavLinks />
        </div>
        <div className="shrink-0 border-t border-border p-3">
          <SignOutButton />
          <p className="mt-2 px-3 text-[10px] leading-relaxed text-muted-foreground/70">
            Cross-tenant access — every action here is audit-logged.
          </p>
        </div>
      </aside>

      {/* Mobile drawer */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Admin navigation</SheetTitle>
          <div className="flex h-16 items-center border-b border-border px-5">
            <Brand />
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-5">
            <AdminNavLinks onNavigate={() => setOpen(false)} />
          </div>
          <div className="border-t border-border p-3">
            <SignOutButton />
          </div>
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col lg:ps-64">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            className="-ms-2 h-9 w-9"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        </header>

        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
