"use client";

import { useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { usePaginatedQuery, useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Id } from "@/convex/_generated/dataModel";
import { Car, MessageCircle, ExternalLink, RefreshCw } from "lucide-react";
import { SocialConversationDialog, ConversationKey } from "@/components/leads/SocialConversationDialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

type ConversationRow = {
  customerId: Id<"customers">;
  leadId: Id<"leads"> | null;
  platform: "instagram" | "facebook";
  conversationKind: "comment" | "dm";
  conversationPostId: string | null;
  senderDisplayName: string;
  latestText: string | undefined;
  latestCreationTime: number;
  latestSenderHandle: string | null;
  vehicleSummary: string | null;
  vehicleCount: number;
  eventCount: number;
  needsReply: boolean;
  leadStage: string | null;
};

function buildRowLink(row: ConversationRow): { url: string; label: "post" | "inbox" } | null {
  if (row.conversationKind === "comment") {
    if (row.platform === "facebook" && row.conversationPostId) {
      return { url: `https://www.facebook.com/${row.conversationPostId}`, label: "post" };
    }
    if (row.platform === "instagram" && row.latestSenderHandle) {
      return { url: `https://www.instagram.com/${row.latestSenderHandle}/`, label: "post" };
    }
  }
  if (row.conversationKind === "dm") {
    if (row.platform === "instagram" && row.latestSenderHandle) {
      return { url: `https://ig.me/m/${row.latestSenderHandle}`, label: "inbox" };
    }
    if (row.platform === "facebook") {
      return { url: `https://www.facebook.com/messages/`, label: "inbox" };
    }
  }
  return null;
}

function rowToConversationKey(row: ConversationRow): ConversationKey {
  return {
    customerId: row.customerId,
    platform: row.platform,
    conversationKind: row.conversationKind,
    conversationPostId: row.conversationPostId,
  };
}

export default function SocialInboxPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission } = usePermissions();
  const isManager = hasPermission(PERMISSIONS.APPROVE_REQUESTS);

  // Filters
  const [filterPlatform, setFilterPlatform] = useState<"instagram" | "facebook" | undefined>(undefined);
  const [filterKind, setFilterKind] = useState<"comment" | "dm" | undefined>(undefined);
  const [filterHasVehicle, setFilterHasVehicle] = useState<boolean | undefined>(undefined);
  const [filterNeedsReply, setFilterNeedsReply] = useState<boolean | undefined>(undefined);

  const { results: conversations, status, loadMore } = usePaginatedQuery(
    api.socialInbox.listConversations,
    activeOrgId
      ? {
          orgId: activeOrgId,
          platform: filterPlatform,
          kind: filterKind,
          hasVehicle: filterHasVehicle,
          needsReply: filterNeedsReply,
        }
      : "skip",
    { initialNumItems: 25 }
  );

  const stats = useQuery(
    api.socialInbox.platformStats,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const [activeConversation, setActiveConversation] = useState<ConversationKey | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const resyncAction = useAction(api.socialInboxBackfill.resyncEvents);

  const handleResync = async () => {
    if (!activeOrgId || resyncing) return;
    setResyncing(true);
    try {
      await resyncAction({ orgId: activeOrgId });
      toast.success(t("ResyncSuccess" as any));
    } catch {
      toast.error("Resync failed");
    } finally {
      setResyncing(false);
    }
  };

  const statusBadge = (conversation: ConversationRow) =>
    conversation.needsReply ? (
      <Badge variant="secondary">{t("NeedsReply" as any)}</Badge>
    ) : (
      <Badge className="bg-emerald-50 text-emerald-700">{t("Replied" as any)}</Badge>
    );

  const vehicleLabel = (conversation: ConversationRow) => {
    if (!conversation.vehicleSummary) return null;
    const extra = conversation.vehicleCount - 1;
    return extra > 0 ? `${conversation.vehicleSummary} +${extra} ${t("MoreVehicles" as any)}` : conversation.vehicleSummary;
  };

  const PlatformIcon = ({ platform }: { platform: "instagram" | "facebook" }) => (
    <span
      className={`shrink-0 inline-flex items-center justify-center h-4 w-4 rounded-full text-[8px] font-bold text-white ${
        platform === "facebook" ? "bg-blue-600" : "bg-pink-600"
      }`}
    >
      {platform === "facebook" ? "f" : "ig"}
    </span>
  );

  const hasActiveFilters =
    filterPlatform !== undefined ||
    filterKind !== undefined ||
    filterHasVehicle !== undefined ||
    filterNeedsReply !== undefined;

  return (
    <RoleGuard permissions={["view:leads"]}>
      <div className="space-y-6 flex flex-col md:h-full md:overflow-hidden">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            {t("SocialInbox" as any)}
          </h1>
          <p className="text-sm text-muted-foreground">{t("SocialInboxDesc" as any)}</p>
        </div>

        {/* Platform analytics cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(
              [
                { platform: "instagram", label: "Instagram", color: "bg-pink-600" },
                { platform: "facebook", label: "Facebook", color: "bg-blue-600" },
              ] as const
            ).map(({ platform, label, color }) => {
              const d = stats[platform];
              return (
                <div
                  key={platform}
                  className="rounded-xl border bg-card p-4 space-y-2 col-span-1 md:col-span-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center justify-center h-5 w-5 rounded-full text-[9px] font-bold text-white shrink-0 ${color}`}
                    >
                      {platform === "facebook" ? "f" : "ig"}
                    </span>
                    <span className="font-semibold text-sm">{label}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <div className="text-center">
                      <p className="text-lg font-bold">{d.uniqueContacts}</p>
                      <p className="text-[10px] text-muted-foreground">{t("UniqueContacts" as any)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold">{d.comments}</p>
                      <p className="text-[10px] text-muted-foreground">{t("Comments" as any)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold">{d.dms}</p>
                      <p className="text-[10px] text-muted-foreground">{t("DirectMessages" as any)}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Platform */}
          <Select
            value={filterPlatform ?? "all"}
            onValueChange={(v) => setFilterPlatform(v === "all" ? undefined : (v as "instagram" | "facebook"))}
          >
            <SelectTrigger className="h-8 text-xs w-[130px]">
              <SelectValue placeholder={t("FilterPlatform" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("FilterPlatform" as any)}: {t("FilterAll" as any)}</SelectItem>
              <SelectItem value="instagram">Instagram</SelectItem>
              <SelectItem value="facebook">Facebook</SelectItem>
            </SelectContent>
          </Select>

          {/* Type */}
          <Select
            value={filterKind ?? "all"}
            onValueChange={(v) => setFilterKind(v === "all" ? undefined : (v as "comment" | "dm"))}
          >
            <SelectTrigger className="h-8 text-xs w-[130px]">
              <SelectValue placeholder={t("FilterType" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("FilterType" as any)}: {t("FilterAll" as any)}</SelectItem>
              <SelectItem value="comment">{t("Comments" as any)}</SelectItem>
              <SelectItem value="dm">{t("DirectMessages" as any)}</SelectItem>
            </SelectContent>
          </Select>

          {/* Vehicle */}
          <Select
            value={filterHasVehicle === undefined ? "all" : filterHasVehicle ? "yes" : "no"}
            onValueChange={(v) =>
              setFilterHasVehicle(v === "all" ? undefined : v === "yes")
            }
          >
            <SelectTrigger className="h-8 text-xs w-[130px]">
              <SelectValue placeholder={t("FilterVehicle" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("FilterVehicle" as any)}: {t("FilterAll" as any)}</SelectItem>
              <SelectItem value="yes">{t("FilterWithVehicle" as any)}</SelectItem>
              <SelectItem value="no">{t("FilterWithoutVehicle" as any)}</SelectItem>
            </SelectContent>
          </Select>

          {/* Status */}
          <Select
            value={filterNeedsReply === undefined ? "all" : filterNeedsReply ? "needs" : "replied"}
            onValueChange={(v) =>
              setFilterNeedsReply(v === "all" ? undefined : v === "needs")
            }
          >
            <SelectTrigger className="h-8 text-xs w-[130px]">
              <SelectValue placeholder={t("FilterStatus" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("FilterStatus" as any)}: {t("FilterAll" as any)}</SelectItem>
              <SelectItem value="needs">{t("NeedsReply" as any)}</SelectItem>
              <SelectItem value="replied">{t("Replied" as any)}</SelectItem>
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground"
              onClick={() => {
                setFilterPlatform(undefined);
                setFilterKind(undefined);
                setFilterHasVehicle(undefined);
                setFilterNeedsReply(undefined);
              }}
            >
              ✕ Clear
            </Button>
          )}

          {isManager && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs ms-auto"
              onClick={handleResync}
              disabled={resyncing}
            >
              <RefreshCw className={`h-3 w-3 me-1 ${resyncing ? "animate-spin" : ""}`} />
              {t("ResyncPostsDMs" as any)}
            </Button>
          )}
        </div>

        {/* Mobile card list */}
        <div className="flex flex-col gap-3 md:hidden">
          {!conversations || conversations.length === 0 ? (
            <p className="text-center py-12 text-muted-foreground">{t("NoSocialEvents" as any)}</p>
          ) : (
            (conversations as ConversationRow[]).map((conversation) => {
              const rowLink = buildRowLink(conversation);
              const ck = rowToConversationKey(conversation);
              return (
                <div
                  key={`${conversation.platform}:${conversation.customerId}:${conversation.conversationKind}:${conversation.conversationPostId ?? ""}`}
                  className="rounded-xl border bg-card p-4 space-y-2 cursor-pointer active:bg-muted/30"
                  onClick={() => setActiveConversation(ck)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-sm truncate flex items-center gap-1.5">
                      <PlatformIcon platform={conversation.platform} />
                      {conversation.senderDisplayName}
                    </p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {rowLink && (
                        <a
                          href={rowLink.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] text-primary border border-primary/30 rounded px-1.5 py-0.5 hover:bg-primary/10"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="h-2.5 w-2.5" />
                          {rowLink.label === "post" ? t("ViewPost" as any) : t("OpenInbox" as any)}
                        </a>
                      )}
                      <Badge variant="secondary" className="text-[10px]">
                        {conversation.eventCount} {t("Messages" as any)}
                      </Badge>
                    </div>
                  </div>
                  {vehicleLabel(conversation) && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Car className="h-3 w-3 shrink-0" />{vehicleLabel(conversation)}
                    </p>
                  )}
                  <p className="text-sm truncate">{conversation.latestText}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(conversation.latestCreationTime).toLocaleString()}
                    </span>
                    {statusBadge(conversation)}
                  </div>
                </div>
              );
            })
          )}
          {status === "CanLoadMore" && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={() => loadMore(25)}>{t("LoadMore" as any) || "Load More"}</Button>
            </div>
          )}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block flex-1 overflow-auto bg-card rounded-xl border-0 ring-1 ring-slate-100 dark:ring-zinc-800 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Sender" as any)}</TableHead>
                <TableHead className="w-[110px]">{t("LinkColumn" as any)}</TableHead>
                <TableHead>{t("Messages" as any)}</TableHead>
                <TableHead>{t("Vehicle" as any) || "Vehicle"}</TableHead>
                <TableHead>{t("Notes" as any) || "Text"}</TableHead>
                <TableHead>{t("Date" as any) || "Date"}</TableHead>
                <TableHead>{t("Stage" as any) || "Status"}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!conversations || conversations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    {t("NoSocialEvents" as any)}
                  </TableCell>
                </TableRow>
              ) : (
                (conversations as ConversationRow[]).map((conversation) => {
                  const rowLink = buildRowLink(conversation);
                  const ck = rowToConversationKey(conversation);
                  return (
                    <TableRow
                      key={`${conversation.platform}:${conversation.customerId}:${conversation.conversationKind}:${conversation.conversationPostId ?? ""}`}
                      className="cursor-pointer"
                      onClick={() => setActiveConversation(ck)}
                    >
                      <TableCell className="py-4 px-6 font-medium">
                        <span className="flex items-center gap-1.5">
                          <PlatformIcon platform={conversation.platform} />
                          {conversation.senderDisplayName}
                        </span>
                      </TableCell>
                      <TableCell className="py-4 px-6">
                        {rowLink ? (
                          <a
                            href={rowLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary border border-primary/30 rounded-md px-2 py-1 hover:bg-primary/10 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-3 w-3" />
                            {rowLink.label === "post" ? t("ViewPost" as any) : t("OpenInbox" as any)}
                          </a>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </TableCell>
                      <TableCell className="py-4 px-6">
                        <Badge variant="secondary">{conversation.eventCount} {t("Messages" as any)}</Badge>
                      </TableCell>
                      <TableCell className="py-4 px-6">
                        {vehicleLabel(conversation) ? (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Car className="h-3.5 w-3.5" />{vehicleLabel(conversation)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-4 px-6 max-w-[280px] truncate">{conversation.latestText}</TableCell>
                      <TableCell className="py-4 px-6 text-muted-foreground text-xs">
                        {new Date(conversation.latestCreationTime).toLocaleString()}
                      </TableCell>
                      <TableCell className="py-4 px-6">{statusBadge(conversation)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {status === "CanLoadMore" && (
            <div className="flex justify-center p-4">
              <Button variant="outline" onClick={() => loadMore(25)}>{t("LoadMore" as any) || "Load More"}</Button>
            </div>
          )}
        </div>

        <SocialConversationDialog
          conversationKey={activeConversation}
          open={!!activeConversation}
          onOpenChange={(o) => !o && setActiveConversation(null)}
        />
      </div>
    </RoleGuard>
  );
}
