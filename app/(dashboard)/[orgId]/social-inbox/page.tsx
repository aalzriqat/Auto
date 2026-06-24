"use client";

import { useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Id } from "@/convex/_generated/dataModel";
import { Car, MessageCircle, ExternalLink } from "lucide-react";
import { SocialConversationDialog } from "@/components/leads/SocialConversationDialog";
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
  senderDisplayName: string;
  latestText: string | undefined;
  latestKind: "comment" | "dm";
  latestCreationTime: number;
  latestPostId: string | null;
  latestSenderHandle: string | null;
  vehicleSummary: string | null;
  vehicleCount: number;
  eventCount: number;
  needsReply: boolean;
  leadStage: string | null;
};

function buildRowPostUrl(row: ConversationRow): string | null {
  if (row.latestKind === "comment") {
    if (row.platform === "facebook" && row.latestPostId) {
      return `https://www.facebook.com/${row.latestPostId}`;
    }
    if (row.platform === "instagram" && row.latestSenderHandle) {
      return `https://www.instagram.com/${row.latestSenderHandle}/`;
    }
  }
  return null;
}

export default function SocialInboxPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { results: conversations, status, loadMore } = usePaginatedQuery(
    api.socialInbox.listConversations,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 25 }
  );

  const stats = useQuery(
    api.socialInbox.platformStats,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const [conversationCustomerId, setConversationCustomerId] = useState<Id<"customers"> | null>(null);

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

  return (
    <RoleGuard permissions={["view:leads"]}>
      <div className="space-y-6 flex flex-col h-full overflow-hidden">
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
                { platform: "instagram", label: "Instagram", color: "bg-pink-600", key: "ig" },
                { platform: "facebook", label: "Facebook", color: "bg-blue-600", key: "fb" },
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

        {/* Mobile card list */}
        <div className="flex flex-col gap-3 md:hidden">
          {!conversations || conversations.length === 0 ? (
            <p className="text-center py-12 text-muted-foreground">{t("NoSocialEvents" as any)}</p>
          ) : (
            (conversations as ConversationRow[]).map((conversation) => {
              const postUrl = buildRowPostUrl(conversation);
              return (
                <div
                  key={conversation.customerId}
                  className="rounded-xl border bg-card p-4 space-y-2 cursor-pointer active:bg-muted/30"
                  onClick={() => setConversationCustomerId(conversation.customerId)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-sm truncate flex items-center gap-1.5">
                      <PlatformIcon platform={conversation.platform} />
                      {conversation.senderDisplayName}
                      {postUrl && (
                        <a
                          href={postUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </p>
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {conversation.eventCount} {t("Messages" as any)}
                    </Badge>
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
                  <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                    {t("NoSocialEvents" as any)}
                  </TableCell>
                </TableRow>
              ) : (
                (conversations as ConversationRow[]).map((conversation) => {
                  const postUrl = buildRowPostUrl(conversation);
                  return (
                    <TableRow
                      key={conversation.customerId}
                      className="cursor-pointer group"
                      onClick={() => setConversationCustomerId(conversation.customerId)}
                    >
                      <TableCell className="py-4 px-6 font-medium">
                        <span className="flex items-center gap-1.5">
                          <PlatformIcon platform={conversation.platform} />
                          {conversation.senderDisplayName}
                          {postUrl && (
                            <a
                              href={postUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </span>
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
          customerId={conversationCustomerId}
          open={!!conversationCustomerId}
          onOpenChange={(o) => !o && setConversationCustomerId(null)}
        />
      </div>
    </RoleGuard>
  );
}
