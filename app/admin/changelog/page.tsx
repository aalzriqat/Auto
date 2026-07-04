"use client";

import { useState } from "react";
import { usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Pencil, Trash2 } from "lucide-react";

type ChangelogType = "FEATURE" | "FIX" | "IMPROVEMENT";

const EMPTY_FORM = {
  type: "FEATURE" as ChangelogType,
  titleEn: "",
  titleAr: "",
  descriptionEn: "",
  descriptionAr: "",
  notifyUsers: false,
};

const TYPE_BADGE: Record<ChangelogType, string> = {
  FEATURE: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  FIX: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  IMPROVEMENT: "bg-blue-500/15 text-blue-300 border-blue-500/30",
};

export default function AdminChangelogPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<Id<"changelogEntries"> | null>(null);
  const [saving, setSaving] = useState(false);

  const { results: entries, loadMore, status } = usePaginatedQuery(
    api.changelog.list,
    {},
    { initialNumItems: 50 }
  );
  const createEntry = useMutation(api.changelog.create);
  const updateEntry = useMutation(api.changelog.update);
  const removeEntry = useMutation(api.changelog.remove);

  function startEdit(entry: Doc<"changelogEntries">) {
    setEditingId(entry._id);
    setForm({
      type: entry.type,
      titleEn: entry.titleEn,
      titleAr: entry.titleAr,
      descriptionEn: entry.descriptionEn,
      descriptionAr: entry.descriptionAr,
      notifyUsers: false,
    });
  }

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSave() {
    if (!form.titleEn.trim() || !form.titleAr.trim() || !form.descriptionEn.trim() || !form.descriptionAr.trim()) {
      toast.error("Fill in both English and Arabic title/description.");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await updateEntry({
          entryId: editingId,
          type: form.type,
          titleEn: form.titleEn.trim(),
          titleAr: form.titleAr.trim(),
          descriptionEn: form.descriptionEn.trim(),
          descriptionAr: form.descriptionAr.trim(),
        });
        toast.success("Entry updated.");
      } else {
        await createEntry({
          type: form.type,
          titleEn: form.titleEn.trim(),
          titleAr: form.titleAr.trim(),
          descriptionEn: form.descriptionEn.trim(),
          descriptionAr: form.descriptionAr.trim(),
          notifyUsers: form.notifyUsers,
        });
        toast.success("Entry published.");
      }
      resetForm();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entryId: Id<"changelogEntries">) {
    if (!window.confirm("Delete this changelog entry? This cannot be undone.")) return;
    try {
      await removeEntry({ entryId });
      toast.success("Entry deleted.");
      if (editingId === entryId) resetForm();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Changelog</h1>
      <p className="text-sm text-slate-400 -mt-4">
        Published entries appear in the &ldquo;What&rsquo;s New&rdquo; panel for every organization.
      </p>

      <Card className="p-6 bg-slate-900 border-slate-800 space-y-4">
        <h2 className="text-sm font-semibold text-slate-200">
          {editingId ? "Edit entry" : "Publish a new entry"}
        </h2>

        <div className="space-y-1.5 max-w-xs">
          <Label className="text-slate-300">Type</Label>
          <Select value={form.type} onValueChange={(v) => setForm((f) => ({ ...f, type: v as ChangelogType }))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="FEATURE">Feature</SelectItem>
              <SelectItem value="FIX">Fix</SelectItem>
              <SelectItem value="IMPROVEMENT">Improvement</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-slate-300">Title (English)</Label>
            <Input value={form.titleEn} onChange={(e) => setForm((f) => ({ ...f, titleEn: e.target.value }))} placeholder="Two-person manual journal approval" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">Title (Arabic)</Label>
            <Input dir="rtl" value={form.titleAr} onChange={(e) => setForm((f) => ({ ...f, titleAr: e.target.value }))} placeholder="موافقة القيد اليدوي من شخصين" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-slate-300">Description (English)</Label>
            <Textarea rows={3} value={form.descriptionEn} onChange={(e) => setForm((f) => ({ ...f, descriptionEn: e.target.value }))} placeholder="Manual GL entries now require a second finance-authorized person to review and approve before they post." />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">Description (Arabic)</Label>
            <Textarea dir="rtl" rows={3} value={form.descriptionAr} onChange={(e) => setForm((f) => ({ ...f, descriptionAr: e.target.value }))} placeholder="القيود اليدوية في دفتر الأستاذ تتطلب الآن مراجعة والموافقة من شخص آخر مخول مالياً قبل ترحيلها." />
          </div>
        </div>

        {!editingId && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="notifyUsers"
              checked={form.notifyUsers}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, notifyUsers: checked === true }))}
            />
            <Label htmlFor="notifyUsers" className="text-slate-300 font-normal cursor-pointer">
              Also send an in-app notification to every organization
            </Label>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : editingId ? "Save changes" : "Publish entry"}
          </Button>
          {editingId && (
            <Button variant="outline" onClick={resetForm} disabled={saving}>
              Cancel
            </Button>
          )}
        </div>
      </Card>

      <Card className="p-6 bg-slate-900 border-slate-800">
        <h2 className="text-sm font-semibold text-slate-200 mb-4">Published entries</h2>
        <div className="space-y-3">
          {entries.length === 0 ? (
            <p className="text-sm text-slate-500">No entries yet.</p>
          ) : (
            entries.map((entry) => (
              <div key={entry._id} className="flex items-start justify-between gap-4 border-b border-slate-800 pb-3 last:border-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className={TYPE_BADGE[entry.type]}>{entry.type}</Badge>
                    <span className="text-xs text-slate-500">{new Date(entry.publishedAt).toLocaleString()}</span>
                  </div>
                  <p className="text-sm font-medium text-slate-200">{entry.titleEn}</p>
                  <p className="text-xs text-slate-400 truncate">{entry.descriptionEn}</p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon" onClick={() => startEdit(entry)}>
                    <Pencil className="w-4 h-4 text-slate-400" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(entry._id)}>
                    <Trash2 className="w-4 h-4 text-rose-400" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
        {status === "CanLoadMore" && (
          <div className="text-center mt-4">
            <Button variant="outline" size="sm" onClick={() => loadMore(50)}>Load more</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
