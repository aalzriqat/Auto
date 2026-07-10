"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { Car, CheckCircle2, Handshake, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";

type ResponseKind = "HAVE_MATCH" | "HAVE_SIMILAR" | "CAN_SOURCE" | "NOT_AVAILABLE";

function ResponseForm({
  orgId,
  requestId,
  onSaved,
}: {
  orgId: Id<"organizations">;
  requestId: Id<"marketplaceRequests">;
  onSaved: () => void;
}) {
  const { t } = useLanguage();
  const respond = useMutation(api.marketplaceResponses.respond);
  const vehiclesPage = useQuery(api.vehicles.list, {
    orgId,
    status: "AVAILABLE",
    paginationOpts: { numItems: 100, cursor: null },
  });

  const [kind, setKind] = useState<ResponseKind>("HAVE_MATCH");
  const [vehicleId, setVehicleId] = useState<string>("");
  const [offerPriceJod, setOfferPriceJod] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    setSaving(true);
    try {
      await respond({
        orgId,
        requestId,
        kind,
        vehicleId: vehicleId ? (vehicleId as Id<"vehicles">) : undefined,
        offerPriceJod: offerPriceJod ? Number(offerPriceJod) : undefined,
        note: note.trim() || undefined,
      });
      toast.success(t("MarketplaceResponseSaved" as any));
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "An unexpected error occurred. Please try again later.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-3 mt-3">
      <div>
        <p className="text-sm font-medium mb-1">{t("MarketplaceResponseKindLabel" as any)}</p>
        <Select value={kind} onValueChange={(v) => setKind(v as ResponseKind)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="HAVE_MATCH">{t("MarketplaceKindHaveMatch" as any)}</SelectItem>
            <SelectItem value="HAVE_SIMILAR">{t("MarketplaceKindHaveSimilar" as any)}</SelectItem>
            <SelectItem value="CAN_SOURCE">{t("MarketplaceKindCanSource" as any)}</SelectItem>
            <SelectItem value="NOT_AVAILABLE">{t("MarketplaceKindNotAvailable" as any)}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {kind !== "NOT_AVAILABLE" && (
        <>
          <div>
            <p className="text-sm font-medium mb-1">{t("MarketplaceResponseVehicleLabel" as any)}</p>
            <Select value={vehicleId || "none"} onValueChange={(v) => setVehicleId(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("MarketplaceResponseVehicleNone" as any)}</SelectItem>
                {(vehiclesPage?.page ?? []).map((vehicle: any) => (
                  <SelectItem key={vehicle._id} value={vehicle._id}>
                    {vehicle.year} {vehicle.make} {vehicle.model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <p className="text-sm font-medium mb-1">{t("MarketplaceResponseOfferPriceLabel" as any)}</p>
            <Input
              type="number"
              min={0}
              value={offerPriceJod}
              onChange={(e) => setOfferPriceJod(e.target.value)}
            />
          </div>
        </>
      )}

      <div>
        <p className="text-sm font-medium mb-1">{t("MarketplaceResponseNoteLabel" as any)}</p>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      </div>

      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={handleSubmit} disabled={saving}>
          {t("MarketplaceResponseSubmit" as any)}
        </Button>
      </div>
    </div>
  );
}

export function MarketplaceRequestsClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const requests = useQuery(
    api.marketplaceResponses.listForOrg,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const [openRequestId, setOpenRequestId] = useState<string | null>(null);

  const intentLabel = (intent: string) =>
    intent === "HOT"
      ? t("MarketplaceIntentHot" as any)
      : intent === "WARM"
        ? t("MarketplaceIntentWarm" as any)
        : t("MarketplaceIntentCold" as any);

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Handshake className="h-5 w-5" />
            {t("MarketplaceRequestsTitle" as any)}
          </CardTitle>
          <CardDescription>{t("MarketplaceRequestsDesc" as any)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {requests?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("MarketplaceRequestsEmpty" as any)}</p>
          )}

          {(requests ?? []).map((request) => (
            <div key={request.requestId} className="rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{request.buyerFirstName}</span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        request.buyerIntent === "HOT" && "border-rose-600 text-rose-600",
                        request.buyerIntent === "WARM" && "border-amber-600 text-amber-600"
                      )}
                    >
                      {intentLabel(request.buyerIntent)}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1 flex-wrap">
                    <Car className="h-3.5 w-3.5 shrink-0" />
                    {[request.make, request.model].filter(Boolean).join(" ") || t("MarketplaceRequestAnyVehicle" as any)}
                    <span className="mx-1">·</span>
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    {request.buyerCity}
                    <span className="mx-1">·</span>
                    {request.paymentType}
                  </p>
                </div>

                {request.latestResponse ? (
                  <Badge variant="outline" className="gap-1 text-emerald-700 border-emerald-600">
                    <CheckCircle2 className="h-3 w-3" />
                    {t("MarketplaceAlreadyResponded" as any)}
                  </Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setOpenRequestId(openRequestId === request.requestId ? null : request.requestId)
                    }
                  >
                    {t("MarketplaceRespond" as any)}
                  </Button>
                )}
              </div>

              {openRequestId === request.requestId && activeOrgId && (
                <ResponseForm
                  orgId={activeOrgId}
                  requestId={request.requestId}
                  onSaved={() => setOpenRequestId(null)}
                />
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
