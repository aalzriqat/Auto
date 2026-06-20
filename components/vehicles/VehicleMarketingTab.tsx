"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Camera, ExternalLink, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

interface VehicleMarketingTabProps {
  vehicleId: Id<"vehicles">;
}

export function VehicleMarketingTab({ vehicleId }: VehicleMarketingTabProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const vehicle = useQuery(api.vehicles.get, activeOrgId ? { orgId: activeOrgId, vehicleId } : "skip");
  const connection = useQuery(
    api.socialIntegrations.getConnectionStatus,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const history = useQuery(
    api.socialPostingData.listForVehicle,
    activeOrgId ? { orgId: activeOrgId, vehicleId } : "skip"
  );
  const requestPost = useMutation(api.socialPostingData.requestPost);

  const [selectedImageIds, setSelectedImageIds] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  const [isPosting, setIsPosting] = useState(false);

  // Default: all photos selected, caption pre-filled from vehicle details.
  useEffect(() => {
    if (!vehicle) return;
    setSelectedImageIds((vehicle.imageIds ?? []).map((id: string) => id.toString()));
    setCaption(
      `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""} — ${vehicle.sellingPrice.toLocaleString()} JOD\n${vehicle.mileage.toLocaleString()} km · ${vehicle.transmission} · ${vehicle.fuelType}\n\n#${vehicle.make.replace(/\s+/g, "")} #${vehicle.model.replace(/\s+/g, "")} #ForSale`
    );
  }, [vehicle?._id]);

  if (!vehicle) {
    return <div className="text-sm text-muted-foreground">{t("Loading" as any) || "Loading..."}</div>;
  }

  const imageIds: string[] = (vehicle.imageIds ?? []).map((id: string) => id.toString());
  const imageUrls: (string | null)[] = vehicle.imageUrls ?? [];

  const toggleImage = (id: string) => {
    setSelectedImageIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handlePost = async () => {
    if (!activeOrgId || selectedImageIds.length === 0) return;
    setIsPosting(true);
    try {
      await requestPost({
        orgId: activeOrgId,
        vehicleId,
        caption,
        imageStorageIds: selectedImageIds as Id<"_storage">[],
      });
      toast.success(t("InstagramPostQueued" as any) || "Queued — you'll be notified when it's posted.");
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setIsPosting(false);
    }
  };

  if (!connection?.instagramConnected) {
    return (
      <EmptyState
        icon={Camera}
        title={t("InstagramNotConnected" as any)}
        description={t("ConnectInstagramFromSettings" as any) || "Connect Instagram from Settings > Integrations to post vehicles."}
      />
    );
  }

  if (imageIds.length === 0) {
    return (
      <EmptyState
        icon={Camera}
        title={t("NoImagesToPost" as any) || "Add photos to this vehicle before posting to Instagram."}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm font-medium">{t("SelectPhotosToPost" as any) || "Select photos to post"}</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {imageIds.map((id, index) => {
            const url = imageUrls[index];
            const checked = selectedImageIds.includes(id);
            return (
              <label
                key={id}
                className="relative aspect-square rounded-md overflow-hidden border cursor-pointer group"
              >
                {url && <img src={url} alt="" className="object-cover w-full h-full" />}
                <div className="absolute top-1.5 left-1.5 bg-white/90 rounded p-0.5">
                  <Checkbox checked={checked} onCheckedChange={() => toggleImage(id)} />
                </div>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("InstagramCaption" as any) || "Caption"}</p>
        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={5}
          placeholder={t("InstagramCaptionPlaceholder" as any) || "Write a custom message..."}
        />
      </div>

      <Button onClick={handlePost} disabled={isPosting || selectedImageIds.length === 0}>
        {isPosting ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Camera className="h-4 w-4 me-2" />}
        {t("PostToInstagram" as any) || "Post to Instagram"}
      </Button>

      {history && history.length > 0 && (
        <div className="space-y-2 pt-4 border-t">
          <p className="text-sm font-medium">{t("PostHistory" as any) || "Post History"}</p>
          {history.map((post) => (
            <div key={post._id} className="flex items-center justify-between bg-muted/30 p-3 rounded-lg border text-sm">
              <div className="flex items-center gap-2">
                {post.status === "PUBLISHED" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                {post.status === "FAILED" && <XCircle className="h-4 w-4 text-destructive" />}
                {post.status === "PENDING" && <Clock className="h-4 w-4 text-amber-500" />}
                <div>
                  <Badge variant="secondary" className="text-xs">{post.status}</Badge>
                  {post.status === "FAILED" && post.errorMessage && (
                    <p className="text-xs text-destructive mt-1">{post.errorMessage}</p>
                  )}
                </div>
              </div>
              {post.externalPermalink && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => window.open(post.externalPermalink!, "_blank")}>
                  <ExternalLink className="h-3 w-3 me-1" /> {t("ViewOnInstagram" as any) || "View on Instagram"}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
