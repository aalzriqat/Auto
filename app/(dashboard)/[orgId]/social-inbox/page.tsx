"use client";

import { useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { Car, MessageCircle } from "lucide-react";
import { SocialConversationDialog } from "@/components/leads/SocialConversationDialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

type EventRow = Doc<"instagramEvents"> & {
  vehicleSummary: string | null;
  leadStage: string | null;
  senderDisplayName: string;
};

export default function SocialInboxPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { results: events, status, loadMore } = usePaginatedQuery(
    api.instagramEngagement.listEvents,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 25 }
  );

  const [conversationLeadId, setConversationLeadId] = useState<Id<"leads"> | null>(null);

  const statusBadge = (event: EventRow) => {
    if (event.autoRepliedAt) return <Badge className="bg-emerald-50 text-emerald-700">{t("AutoReplied" as any)}</Badge>;
    if (event.manualRepliedAt) return <Badge className="bg-emerald-50 text-emerald-700">{t("Replied" as any)}</Badge>;
    return <Badge variant="secondary">{t("NeedsReply" as any)}</Badge>;
  };

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

        {/* Mobile card list */}
        <div className="flex flex-col gap-3 md:hidden">
          {!events || events.length === 0 ? (
            <p className="text-center py-12 text-muted-foreground">{t("NoSocialEvents" as any)}</p>
          ) : (
            (events as EventRow[]).map((event) => (
              <div
                key={event._id}
                className="rounded-xl border bg-card p-4 space-y-2 cursor-pointer active:bg-muted/30"
                onClick={() => event.leadId && setConversationLeadId(event.leadId)}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-sm truncate">{event.senderDisplayName}</p>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {event.kind === "dm" ? t("DM" as any) : t("Comment" as any)}
                  </Badge>
                </div>
                {event.vehicleSummary && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Car className="h-3 w-3 shrink-0" />{event.vehicleSummary}
                  </p>
                )}
                <p className="text-sm truncate">{event.text}</p>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(event._creationTime).toLocaleString()}
                  </span>
                  {statusBadge(event)}
                </div>
              </div>
            ))
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
                <TableHead>{t("Kind" as any)}</TableHead>
                <TableHead>{t("Vehicle" as any) || "Vehicle"}</TableHead>
                <TableHead>{t("Notes" as any) || "Text"}</TableHead>
                <TableHead>{t("Date" as any) || "Date"}</TableHead>
                <TableHead>{t("Stage" as any) || "Status"}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!events || events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                    {t("NoSocialEvents" as any)}
                  </TableCell>
                </TableRow>
              ) : (
                (events as EventRow[]).map((event) => (
                  <TableRow
                    key={event._id}
                    className="cursor-pointer group"
                    onClick={() => event.leadId && setConversationLeadId(event.leadId)}
                  >
                    <TableCell className="py-4 px-6 font-medium">
                      {event.senderDisplayName}
                    </TableCell>
                    <TableCell className="py-4 px-6">
                      <Badge variant="secondary">{event.kind === "dm" ? t("DM" as any) : t("Comment" as any)}</Badge>
                    </TableCell>
                    <TableCell className="py-4 px-6">
                      {event.vehicleSummary ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Car className="h-3.5 w-3.5" />{event.vehicleSummary}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50">-</span>
                      )}
                    </TableCell>
                    <TableCell className="py-4 px-6 max-w-[280px] truncate">{event.text}</TableCell>
                    <TableCell className="py-4 px-6 text-muted-foreground text-xs">
                      {new Date(event._creationTime).toLocaleString()}
                    </TableCell>
                    <TableCell className="py-4 px-6">{statusBadge(event)}</TableCell>
                  </TableRow>
                ))
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
          leadId={conversationLeadId}
          open={!!conversationLeadId}
          onOpenChange={(o) => !o && setConversationLeadId(null)}
        />
      </div>
    </RoleGuard>
  );
}
