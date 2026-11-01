"use client";

/**
 * The Suppliers list (SCRUM-887 slice A). Reads `listForManagement` (paginated, VIEW_FINANCE) and
 * `searchForManagement` (bounded). Write controls appear only for MANAGE_FINANCE; the server
 * refuses the writes regardless.
 *
 * States: loading (skeleton text), empty (nothing exists), no match (search or filter), load error
 * (boundary), and "can load more". Pagination uses Convex `usePaginatedQuery`
 * (https://docs.convex.dev/database/pagination).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Building2, Plus, Search } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePermissions } from "@/hooks/use-permissions";
import { interpolate } from "@/lib/i18n/interpolate";
import { SupplierCreateDialog } from "./SupplierCreateDialog";
import { loadErrorMessage, QueryErrorBoundary, supplierHref, SupplierStatusBadge, useTranslate } from "./shared";

type StatusFilter = "ACTIVE" | "INACTIVE" | "ALL";
const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;

interface ManagementRow {
  _id: Id<"suppliers">;
  displayName: string;
  legalName?: string;
  status: "ACTIVE" | "INACTIVE";
  taxId?: string;
  taxJurisdiction?: string;
  sharedLegalIdentityOf?: Id<"suppliers">;
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function SupplierRows({ orgId, rows }: Readonly<{ orgId: string; rows: ManagementRow[] }>) {
  const translate = useTranslate();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-start">{translate("SuppliersColName")}</TableHead>
          <TableHead className="hidden text-start md:table-cell">{translate("SuppliersColLegalName")}</TableHead>
          <TableHead className="hidden text-start sm:table-cell">{translate("SuppliersColTaxId")}</TableHead>
          <TableHead className="text-start">{translate("SuppliersColStatus")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row._id}>
            <TableCell className="text-start">
              <Link href={supplierHref(orgId, row._id)} className="font-medium text-primary hover:underline">
                <bdi>{row.displayName}</bdi>
              </Link>
              {row.legalName && (
                <div className="text-xs text-muted-foreground md:hidden">
                  <bdi>{row.legalName}</bdi>
                </div>
              )}
              {row.sharedLegalIdentityOf && (
                <div className="text-xs text-muted-foreground">{translate("SuppliersSharedIdentity")}</div>
              )}
            </TableCell>
            <TableCell className="hidden text-start md:table-cell">
              <bdi>{row.legalName ?? ""}</bdi>
            </TableCell>
            <TableCell className="hidden text-start sm:table-cell">
              <bdi dir="ltr">{row.taxId ? `${row.taxJurisdiction ? `${row.taxJurisdiction} · ` : ""}${row.taxId}` : ""}</bdi>
            </TableCell>
            <TableCell className="text-start">
              <SupplierStatusBadge status={row.status} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SupplierListBody({
  orgId,
  search,
  filter,
  canManage,
  onAdd,
}: Readonly<{ orgId: Id<"organizations">; search: string; filter: StatusFilter; canManage: boolean; onAdd: () => void }>) {
  const translate = useTranslate();
  const status = filter === "ALL" ? undefined : filter;
  const searching = search !== "";

  const paged = usePaginatedQuery(
    api.suppliers.listForManagement,
    searching ? "skip" : { orgId, ...(status ? { status } : {}) },
    { initialNumItems: PAGE_SIZE },
  );
  const found = useQuery(api.suppliers.searchForManagement, searching ? { orgId, query: search, ...(status ? { status } : {}) } : "skip");

  const loading = searching ? found === undefined : paged.status === "LoadingFirstPage";
  const rows: ManagementRow[] = (searching ? found?.rows : paged.results) ?? [];
  // The search is capped (no continuation across its four sources), so the screen says when the cap
  // hid matches instead of presenting a partial list as the whole answer.
  const truncated = searching && found?.truncated === true;

  if (loading) {
    return (
      <p role="status" className="py-8 text-center text-sm text-muted-foreground">
        {translate("SuppliersLoading")}
      </p>
    );
  }
  if (rows.length === 0) {
    if (searching || filter !== "ALL") {
      return <p className="py-8 text-center text-sm text-muted-foreground">{translate("SuppliersNoMatch")}</p>;
    }
    return (
      <EmptyState
        icon={Building2}
        title={translate("SuppliersEmptyTitle")}
        description={translate(canManage ? "SuppliersEmptyBody" : "SuppliersEmptyBodyReadOnly")}
        action={
          canManage ? (
            <Button onClick={onAdd}>
              <Plus aria-hidden="true" />
              {translate("SuppliersAdd")}
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      <SupplierRows orgId={orgId} rows={rows} />
      {truncated && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {interpolate(translate("SuppliersSearchTruncated"), { count: rows.length })}
        </p>
      )}
      {!searching && paged.status === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => paged.loadMore(PAGE_SIZE)}>
            {translate("SuppliersLoadMore")}
          </Button>
        </div>
      )}
      {!searching && paged.status === "LoadingMore" && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {translate("SuppliersLoading")}
        </p>
      )}
    </div>
  );
}

export function SupplierListScreen({ orgId }: Readonly<{ orgId: Id<"organizations"> }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const canManage = !isLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("ACTIVE");
  const [creating, setCreating] = useState(false);
  const search = useDebounced(text.trim(), SEARCH_DEBOUNCE_MS);

  const filters: Array<{ value: StatusFilter; label: string }> = [
    { value: "ACTIVE", label: translate("SuppliersFilterActive") },
    { value: "INACTIVE", label: translate("SuppliersFilterInactive") },
    { value: "ALL", label: translate("SuppliersFilterAll") },
  ];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{translate("Suppliers")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{translate("SuppliersSubtitle")}</p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            {translate("SuppliersAdd")}
          </Button>
        )}
      </header>
      {!isLoading && !canManage && (
        <p role="note" className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          {translate("SuppliersReadOnlyNote")}
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1 space-y-1.5">
          <Label htmlFor="suppliers-search">{translate("SuppliersSearchLabel")}</Label>
          <Search
            className="pointer-events-none absolute start-3 top-[2.1rem] h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="suppliers-search"
            type="search"
            className="ps-9"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={translate("SuppliersSearchPlaceholder")}
            aria-describedby="suppliers-search-hint"
            maxLength={200}
          />
          <p id="suppliers-search-hint" className="text-xs text-muted-foreground">
            {translate("SuppliersSearchHint")}
          </p>
        </div>
        <div role="group" aria-label={translate("SuppliersFilterLabel")} className="flex gap-1">
          {filters.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={filter === option.value ? "default" : "outline"}
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <QueryErrorBoundary
        key={`${filter}:${search}`}
        render={(error) => (
          <p role="alert" className="py-8 text-center text-sm text-destructive">
            {loadErrorMessage(error, translate)}
          </p>
        )}
      >
        <SupplierListBody orgId={orgId} search={search} filter={filter} canManage={canManage} onAdd={() => setCreating(true)} />
      </QueryErrorBoundary>
      {canManage && <SupplierCreateDialog orgId={orgId} open={creating} onOpenChange={setCreating} />}
    </div>
  );
}
