"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { MessageCircle, CheckCircle2, Ban, Car } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildWhatsAppDeepLink } from "@/lib/whatsappDeepLink";

type RequestStatus = "OPEN" | "MATCHED" | "FULFILLED" | "EXPIRED" | "SPAM";

const STATUS_TABS: { label: string; value: RequestStatus | undefined }[] = [
  { label: "All", value: undefined },
  { label: "Open", value: "OPEN" },
  { label: "Matched", value: "MATCHED" },
  { label: "Fulfilled", value: "FULFILLED" },
  { label: "Spam", value: "SPAM" },
];

function buildDealerMessage(request: {
  buyerFirstName: string;
  buyerCity: string;
  make?: string;
  model?: string;
  paymentType: string;
  buyerIntent: string;
}) {
  const vehicle = [request.make, request.model].filter(Boolean).join(" ") || "a vehicle";
  return `AutoFlow: buyer ${request.buyerFirstName} in ${request.buyerCity} is looking for ${vehicle} (${request.paymentType}, ${request.buyerIntent} intent). Reply here if you have a match.`;
}

export default function AdminMarketplacePage() {
  const [statusFilter, setStatusFilter] = useState<RequestStatus | undefined>(undefined);
  const requests = useQuery(api.adminMarketplace.listRequests, { status: statusFilter });
  const markMatchNotified = useMutation(api.adminMarketplace.markMatchNotified);
  const markSpam = useMutation(api.adminMarketplace.markSpam);

  async function handleSend(matchId: Id<"marketplaceRequestMatches">, phone: string, message: string) {
    window.open(buildWhatsAppDeepLink(phone, message), "_blank", "noopener,noreferrer");
    try {
      await markMatchNotified({ matchId });
    } catch {
      toast.error("Opened WhatsApp, but failed to record the notification timestamp.");
    }
  }

  async function handleMarkSpam(requestId: Id<"marketplaceRequests">) {
    try {
      await markSpam({ requestId });
      toast.success("Marked as spam.");
    } catch {
      toast.error("Failed to mark as spam.");
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100">Marketplace Requests</h1>
        <p className="text-sm text-slate-400 mt-1">
          Buyer car requests and their matched dealers. Send via WhatsApp per master plan §0.5 — manual, no Meta API dependency.
        </p>
      </div>

      <div className="flex gap-2">
        {STATUS_TABS.map((tab) => (
          <Button
            key={tab.label}
            size="sm"
            variant={statusFilter === tab.value ? "default" : "outline"}
            onClick={() => setStatusFilter(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="space-y-4">
        {requests === undefined && <p className="text-sm text-slate-400">Loading...</p>}
        {requests?.length === 0 && <p className="text-sm text-slate-400">No requests.</p>}

        {(requests ?? []).map((request) => (
          <Card key={request._id} className="p-4 bg-slate-900 border-slate-800 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-100">{request.buyerFirstName}</span>
                  <span className="text-sm text-slate-400">{request.buyerPhone}</span>
                  <Badge variant="outline" className="text-[10px] border-slate-600 text-slate-300">
                    {request.status}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      request.buyerIntent === "HOT" && "border-rose-600 text-rose-400",
                      request.buyerIntent === "WARM" && "border-amber-600 text-amber-400",
                      request.buyerIntent === "COLD" && "border-slate-600 text-slate-400"
                    )}
                  >
                    {request.buyerIntent}
                  </Badge>
                </div>
                <p className="text-sm text-slate-400 mt-1 flex items-center gap-1">
                  <Car className="h-3.5 w-3.5" />
                  {[request.make, request.model].filter(Boolean).join(" ") || "Any vehicle"} · {request.buyerCity} ·{" "}
                  {request.paymentType} · {request.buyerTimeframe}
                </p>
              </div>
              {request.status !== "SPAM" && (
                <Button size="sm" variant="ghost" onClick={() => handleMarkSpam(request._id)}>
                  <Ban className="h-3.5 w-3.5 me-1" />
                  Mark spam
                </Button>
              )}
            </div>

            {request.matches.length > 0 && (
              <div className="border-t border-slate-800 pt-3 space-y-2">
                {request.matches.map((match) => (
                  <div key={match.matchId} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-slate-200">{match.dealerName}</span>
                    {match.notifiedAt ? (
                      <span className="flex items-center gap-1 text-emerald-400 text-xs">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Sent
                      </span>
                    ) : match.whatsappNumber ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSend(match.matchId, match.whatsappNumber!, buildDealerMessage(request))}
                      >
                        <MessageCircle className="h-3.5 w-3.5 me-1" />
                        Send via WhatsApp
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-500">No WhatsApp number on file</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
