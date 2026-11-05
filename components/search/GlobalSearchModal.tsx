"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Car, FileText, Search, Target, User } from "lucide-react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { cn } from "@/lib/utils";
import { formatDealNumber, parseDealNumberQuery } from "@/convex/utils/dealNumberFormat";

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
  /** SCRUM-808: at most one deal, matched by its per-organization deal number. */
  deals?: Array<
    | { kind: "application"; id: Id<"financeApplications">; dealNumber: number }
    | { kind: "sale"; id: Id<"sales">; dealNumber: number }
  >;
};

/** A deal number may be one digit ("7"), so it searches below the two-character minimum. */
const isSearchable = (query: string) => query.length >= 2 || parseDealNumberQuery(query) !== null;

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
    !isSearchable(debouncedQuery) || !activeOrgId
      ? "skip"
      : { orgId: activeOrgId, query: debouncedQuery }
  );
  const deals = results?.deals ?? [];

  const hasResults = useMemo(() => {
    if (!results) return false;
    return (
      (results.deals?.length ?? 0) > 0 ||
      results.vehicles.length > 0 ||
      results.customers.length > 0 ||
      results.leads.length > 0
    );
  }, [results]);

  const isLoading = isSearchable(debouncedQuery) && results === undefined;

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
              {deals.length > 0 && (
                <SearchGroup title={t("DealNumberSearchResult")} icon={FileText}>
                  {deals.map((deal) => (
                    <ResultLink
                      key={deal.id}
                      href={
                        deal.kind === "application"
                          ? `/${activeOrgId}/applications/${deal.id}/deal`
                          : `/${activeOrgId}/sales/${deal.id}/deal`
                      }
                      title={formatDealNumber(deal.dealNumber) ?? ""}
                      titleDir="ltr"
                      subtitle={t(deal.kind === "application" ? "DealKindFinanced" : "DealKindCash")}
                      onClick={close}
                    />
                  ))}
                </SearchGroup>
              )}

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
  titleDir,
  subtitle,
  onClick,
}: {
  href: string;
  title: string;
  /** "ltr" for an identifier such as a deal number, which must not reorder inside Arabic text. */
  titleDir?: "ltr";
  subtitle?: string;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="block rounded-md px-3 py-2 text-sm transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
    >
      <div className="font-medium text-slate-900">
        <bdi dir={titleDir}>{title}</bdi>
      </div>
      {subtitle && <div className="mt-0.5 truncate text-xs text-slate-500">{subtitle}</div>}
    </Link>
  );
}
