"use client";

import { useState } from "react";
import { usePaginatedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { PageHeader, SectionCard } from "@/components/admin/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { History, Pencil, Trash2 } from "lucide-react";

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
  FEATURE: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30",
  FIX: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
  IMPROVEMENT: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30",
};

export default function AdminChangelogPage() {
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<Id<"changelogEntries"> | null>(null);
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const { results: entries, loadMore, status } = usePaginatedQuery(
    api.changelog.list,
    {},
    { initialNumItems: 50 }
  );
  const createEntry = useMutation(api.changelog.create);
  const updateEntry = useMutation(api.changelog.update);
  const removeEntry = useMutation(api.changelog.remove);
  const seedHistoricalEntries = useMutation(api.changelog.seedHistoricalEntries);

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

  async function handleBackfillHistory() {
    if (!window.confirm("Backfill missing historical What's New entries? Existing entries will not be duplicated.")) return;
    setBackfilling(true);
    try {
      const result = await seedHistoricalEntries({});
      if (result.inserted > 0) {
        toast.success(`Backfilled ${result.inserted} historical entries.`);
      } else {
        toast.success(`History is already complete. Checked ${result.total} entries.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBackfilling(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Changelog"
        description={"Published entries appear in the “What’s New” panel for every organization."}
        actions={
          <Button variant="outline" onClick={handleBackfillHistory} disabled={backfilling}>
            <History className="mr-2 h-4 w-4" />
            {backfilling ? "Backfilling..." : "Backfill history"}
          </Button>
        }
      />

      <SectionCard title={editingId ? "Edit entry" : "Publish a new entry"}>
        <div className="space-y-4">
          <div className="max-w-xs space-y-1.5">
            <Label>Type</Label>
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Title (English)</Label>
              <Input value={form.titleEn} onChange={(e) => setForm((f) => ({ ...f, titleEn: e.target.value }))} placeholder="Two-person manual journal approval" />
            </div>
            <div className="space-y-1.5">
              <Label>Title (Arabic)</Label>
              <Input dir="rtl" value={form.titleAr} onChange={(e) => setForm((f) => ({ ...f, titleAr: e.target.value }))} placeholder="موافقة القيد اليدوي من شخصين" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Description (English)</Label>
              <Textarea rows={3} value={form.descriptionEn} onChange={(e) => setForm((f) => ({ ...f, descriptionEn: e.target.value }))} placeholder="Manual GL entries now require a second finance-authorized person to review and approve before they post." />
            </div>
            <div className="space-y-1.5">
              <Label>Description (Arabic)</Label>
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
              <Label htmlFor="notifyUsers" className="cursor-pointer font-normal">
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
        </div>
      </SectionCard>

      <SectionCard title="Published entries" bodyClassName="p-0">
        <div className="divide-y divide-border">
          {entries.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">No entries yet.</p>
          ) : (
            entries.map((entry) => (
              <div key={entry._id} className="flex items-start justify-between gap-4 px-4 py-3.5 sm:px-5">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={TYPE_BADGE[entry.type]}>{entry.type}</Badge>
                    <span className="text-xs text-muted-foreground">{new Date(entry.publishedAt).toLocaleString()}</span>
                  </div>
                  <p className="text-sm font-medium text-foreground">{entry.titleEn}</p>
                  <p className="truncate text-xs text-muted-foreground">{entry.descriptionEn}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" onClick={() => startEdit(entry)} aria-label="Edit entry">
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(entry._id)} aria-label="Delete entry">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
        {status === "CanLoadMore" && (
          <div className="border-t border-border px-4 py-3 text-center sm:px-5">
            <Button variant="outline" size="sm" onClick={() => loadMore(50)}>Load more</Button>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
