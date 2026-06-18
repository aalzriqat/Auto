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

function formatDuration(sinceMs: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - sinceMs) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function PresenceBadge({ presence }: { presence: "ONLINE" | "BREAK" | "OFFLINE" }) {
  if (presence === "ONLINE") return <Badge variant="secondary" className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30">Online</Badge>;
  if (presence === "BREAK") return <Badge variant="secondary" className="bg-amber-500/20 text-amber-300 border-amber-500/30">On break</Badge>;
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
      toast.error(e?.data?.message ?? e?.message ?? "Failed to add support agent");
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(agentId: Id<"supportAgents">) {
    try {
      await removeSupportAgent({ agentId });
      toast.success("Support agent removed");
    } catch (e: any) {
      toast.error(e?.data?.message ?? e?.message ?? "Failed to remove support agent");
    }
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-slate-100 mb-1">Support Agents</h1>
      <p className="text-sm text-slate-500 mb-4">
        People who can handle the live chat queue at <code>/support</code>. They must have signed in to AutoFlow at least once before they can be added.
      </p>

      <Card className="p-4 mb-4 flex items-end gap-3">
        <div className="flex-1">
          <label className="text-xs text-slate-500 mb-1 block">Add by email</label>
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

      <Card className="overflow-hidden">
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
            {agents?.map((agent) => (
              <TableRow key={agent._id}>
                <TableCell className="font-medium">{agent.email}</TableCell>
                <TableCell>{agent.name ?? "—"}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <PresenceBadge presence={agent.presence as "ONLINE" | "BREAK" | "OFFLINE"} />
                    {agent.pendingBreak && (
                      <span className="text-[10px] text-amber-400">break pending</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {agent.activeChatCount > 0 ? (
                    <span className="text-sm text-slate-300">
                      {agent.activeChatCount} {agent.activeChatCount === 1 ? "chat" : "chats"}
                      {agent.activeChatSince && (
                        <span className="text-slate-500"> · {formatDuration(agent.activeChatSince)}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-sm text-slate-500">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {agent.isActive ? <Badge variant="secondary">Active</Badge> : <Badge variant="destructive">Inactive</Badge>}
                </TableCell>
                <TableCell className="text-end space-x-2">
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
                <TableCell colSpan={6} className="text-center text-sm text-slate-500 py-8">
                  No support agents yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
