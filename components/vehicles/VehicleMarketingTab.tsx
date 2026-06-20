"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Camera,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Heart,
  MessageCircle,
  RefreshCw,
  EyeOff,
  Eye,
  Send,
} from "lucide-react";
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
            <PostHistoryItem key={post._id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}

type InstagramComment = {
  id: string;
  text: string;
  username?: string;
  timestamp?: string;
  hidden?: boolean;
};

function PostHistoryItem({ post }: { post: Doc<"socialPosts"> }) {
  const { t } = useLanguage();
  const refreshEngagement = useAction(api.socialEngagement.refreshEngagement);
  const listComments = useAction(api.socialEngagement.listComments);
  const replyToComment = useAction(api.socialEngagement.replyToComment);
  const setCommentHidden = useAction(api.socialEngagement.setCommentHidden);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [isLoadingComments, setIsLoadingComments] = useState(false);
  const [comments, setComments] = useState<InstagramComment[] | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyCommentId, setBusyCommentId] = useState<string | null>(null);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshEngagement({ socialPostId: post._id });
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleToggleComments = async () => {
    const next = !commentsOpen;
    setCommentsOpen(next);
    if (next && comments === null) {
      setIsLoadingComments(true);
      try {
        const result = await listComments({ socialPostId: post._id });
        setComments(result);
      } catch (error: any) {
        toast.error(error.message || t("SomethingWentWrong" as any));
        setCommentsOpen(false);
      } finally {
        setIsLoadingComments(false);
      }
    }
  };

  const handleReply = async (commentId: string) => {
    const message = (replyDrafts[commentId] ?? "").trim();
    if (!message) return;
    setBusyCommentId(commentId);
    try {
      await replyToComment({ socialPostId: post._id, commentId, message });
      setReplyDrafts((prev) => ({ ...prev, [commentId]: "" }));
      toast.success(t("ReplySent" as any) || "Reply sent.");
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setBusyCommentId(null);
    }
  };

  const handleToggleHidden = async (comment: InstagramComment) => {
    setBusyCommentId(comment.id);
    try {
      await setCommentHidden({ socialPostId: post._id, commentId: comment.id, hide: !comment.hidden });
      setComments((prev) =>
        prev ? prev.map((c) => (c.id === comment.id ? { ...c, hidden: !comment.hidden } : c)) : prev
      );
    } catch (error: any) {
      toast.error(error.message || t("SomethingWentWrong" as any));
    } finally {
      setBusyCommentId(null);
    }
  };

  return (
    <div className="bg-muted/30 p-3 rounded-lg border text-sm space-y-3">
      <div className="flex items-center justify-between gap-2">
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

      {post.status === "PUBLISHED" && post.externalPostId && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Heart className="h-3.5 w-3.5" /> {post.likeCount ?? "—"}
          </span>
          <button
            type="button"
            onClick={handleToggleComments}
            className="flex items-center gap-1 hover:text-foreground"
          >
            <MessageCircle className="h-3.5 w-3.5" /> {post.commentsCount ?? "—"}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-1 hover:text-foreground disabled:opacity-50"
          >
            {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t("Refresh" as any) || "Refresh"}
          </button>
        </div>
      )}

      {commentsOpen && (
        <div className="space-y-2 border-t pt-2">
          {isLoadingComments && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("Loading" as any) || "Loading..."}
            </div>
          )}
          {!isLoadingComments && comments && comments.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("NoComments" as any) || "No comments yet."}</p>
          )}
          {!isLoadingComments &&
            comments?.map((comment) => (
              <div key={comment.id} className="bg-background p-2 rounded border space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs">
                    <span className="font-semibold">{comment.username ?? "instagram_user"}</span>{" "}
                    <span className={comment.hidden ? "text-muted-foreground line-through" : ""}>{comment.text}</span>
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 shrink-0"
                    disabled={busyCommentId === comment.id}
                    onClick={() => handleToggleHidden(comment)}
                    title={comment.hidden ? (t("Unhide" as any) || "Unhide") : (t("Hide" as any) || "Hide")}
                  >
                    {comment.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={replyDrafts[comment.id] ?? ""}
                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [comment.id]: e.target.value }))}
                    placeholder={t("WriteAReply" as any) || "Write a reply..."}
                    className="flex-1 h-7 text-xs px-2 rounded border bg-background"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0 shrink-0"
                    disabled={busyCommentId === comment.id || !(replyDrafts[comment.id] ?? "").trim()}
                    onClick={() => handleReply(comment.id)}
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
