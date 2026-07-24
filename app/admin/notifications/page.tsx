"use client";

import { useState } from "react";
import { usePaginatedQuery, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { PageHeader, SectionCard, TableScroll } from "@/components/admin/ui";

export default function AdminNotificationsPage() {
  const [audience, setAudience] = useState<"all_orgs" | "one_org">("all_orgs");
  const [orgId, setOrgId] = useState<Id<"organizations"> | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [sending, setSending] = useState(false);

  const { results: orgs } = usePaginatedQuery(api.adminOrgs.listOrgs, {}, { initialNumItems: 200 });
  const { results: history, loadMore, status } = usePaginatedQuery(
    api.adminBroadcasts.list,
    {},
    { initialNumItems: 25 }
  );
  const createBroadcast = useMutation(api.adminBroadcasts.create);

  async function handleSend() {
    if (!title.trim() || !message.trim()) {
      toast.error("Title and message are required.");
      return;
    }
    if (audience === "one_org" && !orgId) {
      toast.error("Pick an organization.");
      return;
    }

    setSending(true);
    try {
      await createBroadcast({
        audience,
        orgId: audience === "one_org" ? orgId : undefined,
        title: title.trim(),
        message: message.trim(),
        link: link.trim() || undefined,
      });
      toast.success("Broadcast sent.");
      setTitle("");
      setMessage("");
      setLink("");
    } catch (e: any) {
      toast.error(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="Broadcast announcements to organizations." />

      <SectionCard title="Send an announcement">
        <div className="space-y-4">
          <div className="grid max-w-xl grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Audience</Label>
              <Select value={audience} onValueChange={(v) => setAudience(v as "all_orgs" | "one_org")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all_orgs">All organizations</SelectItem>
                  <SelectItem value="one_org">One organization</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {audience === "one_org" && (
              <div className="space-y-1.5">
                <Label>Organization</Label>
                <Select value={orgId} onValueChange={(v) => setOrgId(v as Id<"organizations">)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an org" />
                  </SelectTrigger>
                  <SelectContent>
                    {orgs.map((org) => (
                      <SelectItem key={org._id} value={org._id}>
                        {org.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="max-w-xl space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scheduled maintenance tonight" />
          </div>

          <div className="max-w-xl space-y-1.5">
            <Label>Message</Label>
            <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="AutoFlow will be briefly unavailable at 2am UTC for scheduled maintenance." />
          </div>

          <div className="max-w-xl space-y-1.5">
            <Label>Link (optional)</Label>
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="/dashboard" />
          </div>

          <Button onClick={handleSend} disabled={sending}>
            {sending ? "Sending..." : "Send broadcast"}
          </Button>
        </div>
      </SectionCard>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">History</h2>

        {/* Desktop table */}
        <TableScroll className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sent</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead>Recipients</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((b) => (
                <TableRow key={b._id}>
                  <TableCell className="text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="text-foreground">{b.title}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{b.orgId ? "Single org" : "All organizations"}</TableCell>
                  <TableCell className="text-xs tabular-nums text-muted-foreground">{b.recipientCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>

        {/* Mobile cards */}
        <div className="flex flex-col gap-3 md:hidden">
          {history.map((b) => (
            <div key={b._id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <p className="text-sm font-medium text-foreground">{b.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString()}</p>
              <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                <span>{b.orgId ? "Single org" : "All organizations"}</span>
                <span>·</span>
                <span>{b.recipientCount} recipients</span>
              </div>
            </div>
          ))}
        </div>

        {status === "CanLoadMore" && (
          <div className="mt-4 text-center">
            <Button variant="outline" size="sm" onClick={() => loadMore(25)}>Load more</Button>
          </div>
        )}
      </div>
    </div>
  );
}
