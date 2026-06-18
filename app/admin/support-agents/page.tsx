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

export default function AdminSupportAgentsPage() {
  const agents = useQuery(api.adminSupportAgents.listSupportAgents, {});
  const addSupportAgent = useMutation(api.adminSupportAgents.addSupportAgent);
  const setSupportAgentActive = useMutation(api.adminSupportAgents.setSupportAgentActive);
  const removeSupportAgent = useMutation(api.adminSupportAgents.removeSupportAgent);

  const [email, setEmail] = useState("");
  const [isAdding, setIsAdding] = useState(false);

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
              <TableHead>Online</TableHead>
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
                  {agent.isOnlineNow ? (
                    <Badge variant="secondary">Online</Badge>
                  ) : (
                    <Badge variant="outline">Offline</Badge>
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
                <TableCell colSpan={5} className="text-center text-sm text-slate-500 py-8">
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
