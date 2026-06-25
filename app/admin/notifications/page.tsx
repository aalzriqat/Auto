"use client";

import { useState } from "react";
import { usePaginatedQuery, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
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
      <h1 className="text-xl font-semibold text-slate-100">Notifications</h1>

      <Card className="p-6 bg-slate-900 border-slate-800 space-y-4">
        <h2 className="text-sm font-semibold text-slate-200">Send an announcement</h2>

        <div className="grid grid-cols-2 gap-4 max-w-xl">
          <div className="space-y-1.5">
            <Label className="text-slate-300">Audience</Label>
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
              <Label className="text-slate-300">Organization</Label>
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

        <div className="space-y-1.5 max-w-xl">
          <Label className="text-slate-300">Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scheduled maintenance tonight" />
        </div>

        <div className="space-y-1.5 max-w-xl">
          <Label className="text-slate-300">Message</Label>
          <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="AutoFlow will be briefly unavailable at 2am UTC for scheduled maintenance." />
        </div>

        <div className="space-y-1.5 max-w-xl">
          <Label className="text-slate-300">Link (optional)</Label>
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="/dashboard" />
        </div>

        <Button onClick={handleSend} disabled={sending}>
          {sending ? "Sending..." : "Send broadcast"}
        </Button>
      </Card>

      <Card className="p-6 bg-slate-900 border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 mb-4">History</h2>
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
                <TableCell className="text-slate-400 text-xs">{new Date(b.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-slate-200">{b.title}</TableCell>
                <TableCell className="text-slate-400 text-xs">{b.orgId ? "Single org" : "All organizations"}</TableCell>
                <TableCell className="text-slate-400 text-xs">{b.recipientCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {status === "CanLoadMore" && (
          <div className="text-center mt-4">
            <Button variant="outline" size="sm" onClick={() => loadMore(25)}>Load more</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
