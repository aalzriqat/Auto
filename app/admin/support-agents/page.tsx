"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useTicker } from "@/hooks/useTicker";
import { Headset } from "lucide-react";
import { PageHeader, TableScroll, EmptyState } from "@/components/admin/ui";

function formatDuration(sinceMs: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - sinceMs) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function PresenceBadge({ presence }: { presence: "ONLINE" | "BREAK" | "OFFLINE" }) {
  if (presence === "ONLINE")
    return (
      <Badge variant="secondary" className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
        Online
      </Badge>
    );
  if (presence === "BREAK")
    return (
      <Badge variant="secondary" className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300">
        On break
      </Badge>
    );
  return <Badge variant="outline">Offline</Badge>;
}

export default function AdminSupportAgentsPage() {
  const agents = useQuery(api.adminSupportAgents.listSupportAgents, {});
  const addSupportAgent = useMutation(api.adminSupportAgents.addSupportAgent);
  const setSupportAgentActive = useMutation(api.adminSupportAgents.setSupportAgentActive);
  const removeSupportAgent = useMutation(api.adminSupportAgents.removeSupportAgent);

  const [email, setEmail] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  useTicker(15_000);

  async function handleAdd() {
    if (!email.trim()) return;
    setIsAdding(true);
    try {
      await addSupportAgent({ email: email.trim() });
      toast.success("Support agent added");
      setEmail("");
    } catch (e: any) {
      toast.error(e);
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(agentId: Id<"supportAgents">) {
    try {
      await removeSupportAgent({ agentId });
      toast.success("Support agent removed");
    } catch (e: any) {
      toast.error(e);
    }
  }

  return (
    <div>
      <PageHeader
        title="Support Agents"
        description="People who can handle the live chat queue at /support. They must have signed in to AutoFlow at least once before they can be added."
      />

      <Card className="mb-4 flex flex-col items-stretch gap-3 p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted-foreground">Add by email</label>
          <Input
            placeholder="agent@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
        </div>
        <Button onClick={handleAdd} disabled={isAdding || !email.trim()}>
          {isAdding ? "Adding…" : "Add agent"}
        </Button>
      </Card>

      {/* Desktop table */}
      <TableScroll className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Presence</TableHead>
              <TableHead>Active chats</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-end">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {agents?.map((agent: (typeof agents)[number]) => (
              <TableRow key={agent._id}>
                <TableCell className="font-medium">{agent.email}</TableCell>
                <TableCell>{agent.name ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <PresenceBadge presence={agent.presence as "ONLINE" | "BREAK" | "OFFLINE"} />
                    {agent.pendingBreak && <span className="text-[10px] text-amber-600 dark:text-amber-400">break pending</span>}
                  </div>
                </TableCell>
                <TableCell>
                  {agent.activeChatCount > 0 ? (
                    <span className="text-sm text-foreground">
                      {agent.activeChatCount} {agent.activeChatCount === 1 ? "chat" : "chats"}
                      {agent.activeChatSince && (
                        <span className="text-muted-foreground"> · {formatDuration(agent.activeChatSince)}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {agent.isActive ? <Badge variant="secondary">Active</Badge> : <Badge variant="destructive">Inactive</Badge>}
                </TableCell>
                <TableCell className="space-x-2 text-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSupportAgentActive({ agentId: agent._id, isActive: !agent.isActive })}
                  >
                    {agent.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => handleRemove(agent._id)}>
                    Remove
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {agents?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  No support agents yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableScroll>

      {/* Mobile cards */}
      <div className="flex flex-col gap-3 md:hidden">
        {agents?.length === 0 && (
          <div className="rounded-xl border border-border bg-card">
            <EmptyState icon={Headset} title="No support agents yet." />
          </div>
        )}
        {agents?.map((agent: (typeof agents)[number]) => (
          <div key={agent._id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{agent.email}</p>
                {agent.name && <p className="truncate text-xs text-muted-foreground">{agent.name}</p>}
              </div>
              {agent.isActive ? <Badge variant="secondary">Active</Badge> : <Badge variant="destructive">Inactive</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PresenceBadge presence={agent.presence as "ONLINE" | "BREAK" | "OFFLINE"} />
              {agent.pendingBreak && <span className="text-[10px] text-amber-600 dark:text-amber-400">break pending</span>}
              {agent.activeChatCount > 0 && (
                <span className="text-xs text-muted-foreground">
                  {agent.activeChatCount} {agent.activeChatCount === 1 ? "chat" : "chats"}
                  {agent.activeChatSince && ` · ${formatDuration(agent.activeChatSince)}`}
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSupportAgentActive({ agentId: agent._id, isActive: !agent.isActive })}
              >
                {agent.isActive ? "Deactivate" : "Activate"}
              </Button>
              <Button size="sm" variant="destructive" onClick={() => handleRemove(agent._id)}>
                Remove
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
