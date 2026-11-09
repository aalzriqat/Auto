"use client";

import Link from "next/link";
import { usePaginatedQuery, type PaginationStatus } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePermissions } from "@/hooks/use-permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { translateVehicleStatus } from "@/lib/i18n/statusLabels";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryErrorBoundary, useTranslate } from "./shared";

type Row = FunctionReturnType<typeof api.supplierRelationships.vehicles>["page"][number];
type PageView = { rows: Row[]; status: PaginationStatus; loadMore: (count: number) => void };
const PAGE_SIZE = 25;

function VehicleGroup({ title, rows, status, loadMore }: Readonly<PageView & { title: string }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const canOpen = !isLoading && hasPermission("view:vehicles");
  const loading = status === "LoadingFirstPage";
  const incomplete = !loading && status !== "Exhausted";
  return <section className="min-w-0 space-y-3 rounded-xl border p-4" aria-label={title}>
    <h3 className="font-semibold">{title}</h3>
    {loading && <output className="block text-sm text-muted-foreground">{translate("SuppliersRelationshipsLoading")}</output>}
    {!loading && rows.length === 0 && !incomplete && <p className="text-sm text-muted-foreground">{translate("SuppliersRelationshipsEmpty")}</p>}
    {!loading && <ul className="space-y-3">{(rows ?? []).map(row => <li key={row.vehicleId} className="min-w-0 space-y-1 border-b pb-3 last:border-0 last:pb-0">
      {canOpen && row.href ? <Link prefetch={false} href={row.href} className="break-words font-medium text-primary underline underline-offset-4"><bdi>{row.label}</bdi></Link> : <span className="break-words font-medium"><bdi>{row.label}</bdi></span>}
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="secondary">{translate(row.model === "SOURCED" ? "SuppliersRelationshipsSourced" : "SuppliersRelationshipsOwned")}</Badge>
        <Badge variant="outline">{translateVehicleStatus(row.status, translate)}</Badge>
      </div>
    </li>)}</ul>}
    {incomplete && <output className="block text-xs text-money-out">{translate("SuppliersRelationshipsIncomplete")}</output>}
    {status === "CanLoadMore" && <Button variant="outline" size="sm" onClick={() => loadMore(PAGE_SIZE)}>{translate("SuppliersRelationshipsMore")}</Button>}
    {status === "LoadingMore" && <output className="block text-sm">{translate("SuppliersRelationshipsLoading")}</output>}
  </section>;
}

export function SupplierRelationshipsView({ sourced, owned }: Readonly<{ sourced: PageView; owned: PageView }>) {
  const translate = useTranslate();
  const { locale } = useLanguage();
  return <Card dir={locale === "ar" ? "rtl" : "ltr"} className="min-w-0 shadow-sm">
    <CardHeader><h2 className="text-lg font-semibold">{translate("SuppliersRelationshipsTitle")}</h2>
      <p className="text-xs text-muted-foreground">{translate("SuppliersRelationshipsScope")}</p>
    </CardHeader>
    <CardContent className="grid min-w-0 gap-4 lg:grid-cols-2">
      <VehicleGroup title={translate("SuppliersRelationshipsSourcedTitle")} {...sourced} />
      <VehicleGroup title={translate("SuppliersRelationshipsOwnedTitle")} {...owned} />
    </CardContent>
  </Card>;
}

function RelationshipsBody({ orgId, supplierId }: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const { isLoading, hasPermission } = usePermissions();
  const allowed = !isLoading && hasPermission("view:finance");
  const sourced = usePaginatedQuery(api.supplierRelationships.vehicles, allowed ? { orgId, supplierId, kind: "SOURCED" } : "skip", { initialNumItems: PAGE_SIZE });
  const owned = usePaginatedQuery(api.supplierRelationships.vehicles, allowed ? { orgId, supplierId, kind: "OWNED" } : "skip", { initialNumItems: PAGE_SIZE });
  if (!allowed) return null;
  return <SupplierRelationshipsView sourced={{ rows: sourced.results ?? [], status: sourced.status, loadMore: sourced.loadMore }} owned={{ rows: owned.results ?? [], status: owned.status, loadMore: owned.loadMore }} />;
}

export function SupplierRelationshipsError() {
  const translate = useTranslate();
  return <p role="alert" className="py-4 text-sm text-destructive">{translate("SuppliersRelationshipsError")}</p>;
}

export function SupplierRelationshipsSection(props: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  return <QueryErrorBoundary key={`${props.orgId}:${props.supplierId}`} render={() => <SupplierRelationshipsError />}><RelationshipsBody {...props} /></QueryErrorBoundary>;
}
