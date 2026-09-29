"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle2, XCircle, AlertCircle, Search } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useTableControls } from "@/hooks/useTableControls";
import { getErrorMessage } from "@/lib/errors";
import { PendingDepositRequestsQueue } from "@/components/deposits/DepositRequests";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";

type ApprovalRequest = Doc<"profitApprovalRequests"> & {
  salespersonName: string;
  vehicleMakeModel: string;
  vehicleVin: string;
  salePrice?: number;
  listPrice?: number;
};

export default function ApprovalsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { format, code: orgCurrency } = useCurrency();
  // A request's amounts are in the currency it was raised in, which the org's
  // currency lock does not freeze (profitApprovalRequests is not a lock row).
  // Label them in that currency rather than restyling them as today's.
  const formatIn = (amount: number, currency: string | undefined) =>
    currency && currency !== orgCurrency ? `${amount.toLocaleString()} ${currency}` : format(amount);

  // This page serves two queues to two different roles (SCRUM-444): profit
  // approvals (`approve:requests`) and deposit requests
  // (`confirm:finance_disbursement`, which accountants hold and approvers may
  // not). A refused query throws into render, so each is asked only of someone
  // the server will answer — an accountant otherwise saw an error page instead
  // of the queue they came for.
  const { hasPermission } = usePermissions();
  const canApprove = hasPermission(PERMISSIONS.APPROVE_REQUESTS);
  const pendingApprovals = useQuery(
    api.approvals.listPendingApprovals,
    activeOrgId && canApprove ? { orgId: activeOrgId } : "skip"
  );
  const respondToApproval = useMutation(api.approvals.respondToApproval);

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    rows: filteredApprovals,
  } = useTableControls({
    data: pendingApprovals as ApprovalRequest[] | undefined,
    searchFields: (r) => [r.salespersonName, r.vehicleMakeModel, r.vehicleVin],
  });

  const handleRespond = async (requestId: Id<"profitApprovalRequests">, status: "APPROVED" | "REJECTED") => {
    try {
      await respondToApproval({
        orgId: activeOrgId!,
        requestId,
        status,
      });
      toast.success(status === "APPROVED" ? t("ApprovalApprovedMsg") : t("ApprovalRejectedMsg"));
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  if (!activeOrgId) return null;

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">{t("Approvals")}</h2>
      </div>

      {/* SCRUM-444: deposits a salesperson has asked to record. Nothing is held
          until one is confirmed here. */}
      <PendingDepositRequestsQueue orgId={activeOrgId} />

      {canApprove && pendingApprovals && pendingApprovals.length > 0 && (
        <div className="flex items-center w-full max-w-sm space-x-2 relative">
          <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
          <Input
            placeholder={t("Search" as any)}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9"
          />
        </div>
      )}

      {canApprove ? (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredApprovals === undefined ? (
          <div className="col-span-full flex justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : filteredApprovals.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center p-12 text-center border rounded-xl border-dashed bg-muted/20">
            <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-4 opacity-50" />
            <p className="text-lg font-medium text-slate-700">{t("NoPendingApprovals")}</p>
            <p className="text-sm text-slate-500">{t("AllCaughtUp")}</p>
          </div>
        ) : (
          filteredApprovals.map((request: ApprovalRequest) => (
            <Card
              key={request._id}
              data-testid="approval-card"
              className="relative overflow-hidden flex flex-col"
            >
              <div className="absolute top-0 left-0 w-1 h-full bg-yellow-500" />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-lg flex items-center gap-2">
                      {request.salespersonName}
                    </CardTitle>
                    <CardDescription className="mt-1 flex items-center gap-1.5">
                      {request.vehicleMakeModel}
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20">
                    {t("Pending")}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col justify-between">
                <div className="space-y-4 mb-6">
                  <div className="grid grid-cols-2 gap-4 rounded-lg bg-slate-50 p-3 border border-slate-100">
                    <div>
                      <p className="text-xs text-slate-500 font-medium">{t("RequestedProfit")}</p>
                      <p className="text-lg font-bold text-slate-900">{formatIn(request.requestedProfit, request.currency)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 font-medium">{t("MinimumAllowed")}</p>
                      <p className="text-sm font-semibold text-slate-600">{formatIn(request.minimumProfit, request.currency)}</p>
                    </div>
                    {/* SCRUM-260: approving authorizes exactly this price
                        against exactly this list price, so both are shown. */}
                    {request.salePrice !== undefined && request.listPrice !== undefined ? (
                      <>
                        <div>
                          <p className="text-xs text-slate-500 font-medium">{t("ApprovalSalePrice" as any)}</p>
                          <p className="text-sm font-semibold text-slate-900 tabular-nums">
                            {formatIn(request.salePrice, request.currency)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 font-medium">{t("ApprovalListPrice" as any)}</p>
                          <p className="text-sm font-semibold text-slate-600 tabular-nums">
                            {formatIn(request.listPrice, request.currency)}
                          </p>
                        </div>
                      </>
                    ) : null}
                  </div>

                  <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 px-3 py-2 rounded-md border border-amber-100">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{t("ShortBy")} {formatIn(request.minimumProfit - request.requestedProfit, request.currency)}</span>
                  </div>
                </div>

                <div className="flex gap-2 w-full pt-4 border-t">
                  <Button
                    variant="outline"
                    className="flex-1 bg-red-50 hover:bg-red-100 hover:text-red-600 border-red-200 text-red-600"
                    onClick={() => handleRespond(request._id, "REJECTED")}
                  >
                    <XCircle className="w-4 h-4 me-2" />
                    {t("Reject")}
                  </Button>
                  <Button
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => handleRespond(request._id, "APPROVED")}
                  >
                    <CheckCircle2 className="w-4 h-4 me-2" />
                    {t("Approve")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
      ) : null}
    </div>
  );
}
