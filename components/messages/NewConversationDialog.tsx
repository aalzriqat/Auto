"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Check, X } from "lucide-react";

interface Props {
  orgId: Id<"organizations">;
  open: boolean;
  mode: "dm" | "group";
  onClose: () => void;
  onConversationCreated: (id: Id<"dmConversations">) => void;
}

export function NewConversationDialog({
  orgId,
  open,
  mode,
  onClose,
  onConversationCreated,
}: Props) {
  const { t } = useLanguage();
  const members = useQuery(api.directMessages.getOrgMembers, { orgId });
  const getOrCreateDm = useMutation(api.directMessages.getOrCreateDm);
  const createGroup = useMutation(api.directMessages.createGroup);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Id<"users">[]>([]);
  const [groupName, setGroupName] = useState("");
  const [loading, setLoading] = useState(false);

  type OrgMember = { _id: Id<"users">; name?: string; email: string; imageUrl?: string; roleName?: string } | null;
  const filtered = (members ?? [] as OrgMember[]).filter((m: OrgMember) =>
    m && (m.name?.toLowerCase().includes(search.toLowerCase()) ||
      m.email.toLowerCase().includes(search.toLowerCase()))
  );

  function toggle(uid: Id<"users">) {
    if (mode === "dm") {
      setSelected([uid]);
    } else {
      setSelected((prev) =>
        prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
      );
    }
  }

  async function handleCreate() {
    if (selected.length === 0) return;
    setLoading(true);
    try {
      if (mode === "dm") {
        const id = await getOrCreateDm({ orgId, otherUserId: selected[0] });
        onConversationCreated(id);
      } else {
        if (!groupName.trim()) return;
        const id = await createGroup({ orgId, name: groupName.trim(), memberIds: selected });
        onConversationCreated(id);
      }
      setSelected([]);
      setGroupName("");
      setSearch("");
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "dm" ? t("MessagesNewConversationTitle") : t("MessagesNewGroupTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {mode === "group" && (
            <Input
              placeholder={t("MessagesGroupNamePlaceholder")}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
          )}

          {selected.length > 0 && mode === "group" && (
            <div className="flex flex-wrap gap-1">
              {selected.map((uid) => {
                const m = (members ?? [] as OrgMember[]).find((x: OrgMember) => x?._id === uid);
                return (
                  <Badge key={uid} variant="secondary" className="gap-1 pe-1">
                    {m?.name ?? "…"}
                    <button
                      onClick={() => toggle(uid)}
                      className="hover:text-red-500 transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          )}

          <Input
            placeholder={t("MessagesSearchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="max-h-60 overflow-y-auto space-y-1">
            {filtered.map((m: OrgMember) => {
              if (!m) return null;
              const isSelected = selected.includes(m._id);
              return (
                <button
                  key={m._id}
                  onClick={() => toggle(m._id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-start transition-colors",
                    isSelected
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-slate-50"
                  )}
                >
                  <Avatar className="h-8 w-8 shrink-0">
                    {m.imageUrl && <AvatarImage src={m.imageUrl} />}
                    <AvatarFallback className="text-xs bg-slate-200">
                      {(m.name ?? m.email).slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{m.name ?? m.email}</p>
                    {m.roleName && (
                      <p className="text-xs text-slate-400 truncate">{m.roleName}</p>
                    )}
                  </div>
                  {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              {t("MessagesCancel")}
            </Button>
            <Button
              className="flex-1"
              disabled={
                selected.length === 0 ||
                (mode === "group" && !groupName.trim()) ||
                loading
              }
              onClick={handleCreate}
            >
              {t("MessagesCreate")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
