"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Id } from "@/convex/_generated/dataModel";

export default function ApprovalsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { format } = useCurrency();

  const pendingApprovals = useQuery(api.approvals.listPendingApprovals, activeOrgId ? { orgId: activeOrgId } : "skip");
  const respondToApproval = useMutation(api.approvals.respondToApproval);

  const handleRespond = async (requestId: Id<"profitApprovalRequests">, status: "APPROVED" | "REJECTED") => {
    try {
      await respondToApproval({
        orgId: activeOrgId!,
        requestId,
        status,
      });
      toast.success(status === "APPROVED" ? t("ApprovalApprovedMsg") : t("ApprovalRejectedMsg"));
    } catch (error: any) {
      toast.error(error);
    }
  };

  if (!activeOrgId) return null;

  return (
    <div className="flex-1 space-y-6 p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">{t("Approvals")}</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {pendingApprovals === undefined ? (
          <div className="col-span-full flex justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : pendingApprovals.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center p-12 text-center border rounded-xl border-dashed bg-muted/20">
            <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-4 opacity-50" />
            <p className="text-lg font-medium text-slate-700">{t("NoPendingApprovals")}</p>
            <p className="text-sm text-slate-500">{t("AllCaughtUp")}</p>
          </div>
        ) : (
          pendingApprovals.map((request) => (
            <Card key={request._id} className="relative overflow-hidden flex flex-col">
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
                      <p className="text-lg font-bold text-slate-900">{format(request.requestedProfit)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500 font-medium">{t("MinimumAllowed")}</p>
                      <p className="text-sm font-semibold text-slate-600">{format(request.minimumProfit)}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 px-3 py-2 rounded-md border border-amber-100">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{t("ShortBy")} {format(request.minimumProfit - request.requestedProfit)}</span>
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
    </div>
  );
}
