"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Car, Search, Target, User } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { cn } from "@/lib/utils";

type GlobalSearchModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type GlobalSearchResults = {
  vehicles: Array<{
    id: Id<"vehicles">;
    make: string;
    model: string;
    vin: string;
    year: number;
    status: string;
  }>;
  customers: Array<{
    id: Id<"customers">;
    firstName: string;
    lastName: string;
    phone?: string;
    email?: string;
  }>;
  leads: Array<{
    id: Id<"leads">;
    stage: string;
    customerId: Id<"customers">;
    customerName: string;
  }>;
};

const globalSearchQuery = (api as unknown as {
  search: {
    globalSearch: FunctionReference<
      "query",
      "public",
      { orgId: Id<"organizations">; query: string },
      GlobalSearchResults
    >;
  };
}).search.globalSearch;

export default function GlobalSearchModal({ open, onOpenChange }: GlobalSearchModalProps) {
  const { activeOrgId } = useOrg();
  const { t, isRtl } = useLanguage();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  const results = useQuery(
    globalSearchQuery,
    debouncedQuery.length < 2 || !activeOrgId
      ? "skip"
      : { orgId: activeOrgId, query: debouncedQuery }
  );

  const hasResults = useMemo(() => {
    if (!results) return false;
    return results.vehicles.length > 0 || results.customers.length > 0 || results.leads.length > 0;
  }, [results]);

  const isLoading = debouncedQuery.length >= 2 && results === undefined;

  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-100 px-5 py-4 text-start">
          <DialogTitle>{t("GlobalSearch" as any)}</DialogTitle>
        </DialogHeader>

        <div className="relative border-b border-slate-100">
          <Search className="absolute start-5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("SearchPlaceholder" as any)}
            className={cn(
              "h-12 w-full bg-white ps-12 pe-5 text-sm outline-none placeholder:text-slate-400",
              isRtl && "text-right"
            )}
          />
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-3">
          {isLoading && (
            <div className="px-3 py-8 text-center text-sm text-slate-500">{t("SearchLoading" as any)}</div>
          )}

          {!isLoading && results && !hasResults && (
            <div className="px-3 py-8 text-center text-sm text-slate-500">{t("SearchNoResults" as any)}</div>
          )}

          {!isLoading && results && hasResults && (
            <div className="space-y-4">
              {results.vehicles.length > 0 && (
                <SearchGroup title={t("SearchVehicles" as any)} icon={Car}>
                  {results.vehicles.map((vehicle) => (
                    <ResultLink
                      key={vehicle.id}
                      href={`/${activeOrgId}/vehicles/`}
                      title={`${vehicle.make} ${vehicle.model}`}
                      subtitle={`${vehicle.year} · ${vehicle.vin} · ${vehicle.status}`}
                      onClick={close}
                    />
                  ))}
                </SearchGroup>
              )}

              {results.customers.length > 0 && (
                <SearchGroup title={t("SearchCustomers" as any)} icon={User}>
                  {results.customers.map((customer) => (
                    <ResultLink
                      key={customer.id}
                      href={`/${activeOrgId}/customers/`}
                      title={`${customer.firstName} ${customer.lastName}`}
                      subtitle={[customer.phone, customer.email].filter(Boolean).join(" · ")}
                      onClick={close}
                    />
                  ))}
                </SearchGroup>
              )}

              {results.leads.length > 0 && (
                <SearchGroup title={t("SearchLeads" as any)} icon={Target}>
                  {results.leads.map((lead) => (
                    <ResultLink
                      key={lead.id}
                      href={`/${activeOrgId}/leads`}
                      title={lead.customerName}
                      subtitle={lead.stage}
                      onClick={close}
                    />
                  ))}
                </SearchGroup>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SearchGroup({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Car;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 px-2 text-xs font-semibold uppercase text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span>{title}</span>
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function ResultLink({
  href,
  title,
  subtitle,
  onClick,
}: {
  href: string;
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="block rounded-md px-3 py-2 text-sm transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
    >
      <div className="font-medium text-slate-900">{title}</div>
      {subtitle && <div className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</div>}
    </Link>
  );
}
