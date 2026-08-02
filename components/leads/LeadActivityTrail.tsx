"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Bot, PlusCircle, ArrowRightLeft, UserCheck, UserMinus, Pencil, Trash2, RotateCcw, MessageSquare, Loader2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { translatePipelineStageLabel } from "@/lib/i18n/defaultLabels";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/lib/errors";

interface LeadActivityTrailProps {
  orgId: Id<"organizations">;
  leadId: Id<"leads">;
  /** Hidden for a deleted lead, whose trail is history rather than a working log. */
  canAddUpdates?: boolean;
}

/** Mirrors MAX_NOTE_LENGTH in convex/utils/leadActivity.ts. */
const MAX_NOTE_LENGTH = 2000;

type TrailAction =
  | "CREATED"
  | "STAGE_CHANGED"
  | "ASSIGNED"
  | "UNASSIGNED"
  | "UPDATED"
  | "DELETED"
  | "RESTORED"
  | "NOTE";

const ACTION_ICONS: Record<TrailAction, typeof PlusCircle> = {
  CREATED: PlusCircle,
  STAGE_CHANGED: ArrowRightLeft,
  ASSIGNED: UserCheck,
  UNASSIGNED: UserMinus,
  UPDATED: Pencil,
  DELETED: Trash2,
  RESTORED: RotateCcw,
  NOTE: MessageSquare,
};

const ACTION_LABEL_KEYS: Record<TrailAction, string> = {
  CREATED: "ActivityCreated",
  STAGE_CHANGED: "ActivityStageChanged",
  ASSIGNED: "ActivityAssigned",
  UNASSIGNED: "ActivityUnassigned",
  UPDATED: "ActivityUpdated",
  DELETED: "ActivityDeleted",
  RESTORED: "ActivityRestored",
  NOTE: "ActivityNote",
};

const FIELD_LABEL_KEYS: Record<string, string> = {
  stage: "ActivityFieldStage",
  assignedUserId: "ActivityFieldAssignedUserId",
  customerId: "ActivityFieldCustomerId",
  vehicleId: "ActivityFieldVehicleId",
  source: "ActivityFieldSource",
  notes: "ActivityFieldNotes",
};

/**
 * Read-only audit trail for one lead. There is no mutation behind this panel —
 * rows are written server-side by convex/utils/leadActivity.ts and can't be
 * authored, edited or removed from the client.
 */
export function LeadActivityTrail({ orgId, leadId, canAddUpdates = true }: LeadActivityTrailProps) {
  const { t, locale, isRtl } = useLanguage();

  const activities = useQuery(api.leadActivities.listForLead, { orgId, leadId });
  const addNote = useMutation(api.leads.addNote);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAddNote = async () => {
    const note = draft.trim();
    if (!note || saving) return;
    setSaving(true);
    try {
      await addNote({ orgId, leadId, note });
      setDraft("");
      toast.success(t("UpdateAdded" as any) || "Update added");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const formatTimestamp = (ts: number) =>
    new Date(ts).toLocaleString(locale === "ar" ? "ar" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  // Stage is stored as a raw key ("NEGOTIATION"); every other field was already
  // rendered to a display string when the row was written.
  const renderValue = (field: string | undefined, value: string | undefined) => {
    if (!value) return t("ActivityEmptyValue" as any) || "(none)";
    return field === "stage" ? translatePipelineStageLabel(value, locale) : value;
  };

  const composer = canAddUpdates ? (
    <div className="space-y-2 mb-4">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MAX_NOTE_LENGTH))}
        placeholder={
          t("AddUpdatePlaceholder" as any) ||
          "Log an update — what you did and what happens next"
        }
        rows={2}
        className="resize-none"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          {t("UpdatesArePermanent" as any) || "Updates are permanent and can't be edited."}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={handleAddNote}
          disabled={saving || !draft.trim()}
        >
          {saving && <Loader2 className="h-3.5 w-3.5 me-1 animate-spin" />}
          {t("AddUpdate" as any) || "Add update"}
        </Button>
      </div>
    </div>
  ) : null;

  if (activities === undefined) {
    return (
      <div>
        {composer}
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div>
        {composer}
        <p className="text-sm text-muted-foreground py-1">
          {t("NoActivityYet" as any) || "No activity recorded yet."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {composer}
      <ol className="space-y-3">
      {(activities ?? []).map((activity) => {
        const action = activity.action as TrailAction;
        const Icon = ACTION_ICONS[action] ?? Pencil;
        const fieldKey = activity.field ? FIELD_LABEL_KEYS[activity.field] : undefined;
        const fieldLabel = fieldKey ? t(fieldKey as any) || activity.field : activity.field;

        // A value pair only reads as a transition when there was a previous
        // value; a first-time set (or a creation row) shows just the new one.
        const showTransition = Boolean(activity.fromValue) && action !== "CREATED";

        return (
          <li key={activity._id} className="flex gap-3">
            <div
              className={cn(
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                activity.isSystemActor
                  ? "bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-300"
                  : "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-300"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-medium">
                  {t(ACTION_LABEL_KEYS[action] as any) || action}
                </span>
                {action !== "CREATED" && action !== "DELETED" && action !== "RESTORED" && fieldLabel && (
                  <span className="text-muted-foreground"> · {fieldLabel}</span>
                )}
              </p>

              {(activity.toValue || activity.fromValue) && (
                <p className="text-sm text-foreground/80 break-words">
                  {showTransition && (
                    <>
                      <span className="line-through opacity-60">
                        {renderValue(activity.field, activity.fromValue)}
                      </span>{" "}
                      <span aria-hidden="true">{isRtl ? "←" : "→"}</span>{" "}
                    </>
                  )}
                  <span className="font-medium">
                    {renderValue(activity.field, activity.toValue)}
                  </span>
                </p>
              )}

              {activity.note && (
                <p
                  className={cn(
                    "break-words whitespace-pre-wrap mt-0.5",
                    // On a NOTE row the note is the point, not a footnote.
                    action === "NOTE"
                      ? "text-sm text-foreground"
                      : "text-xs text-muted-foreground"
                  )}
                >
                  {activity.note}
                </p>
              )}

              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1 flex-wrap">
                {activity.isSystemActor && <Bot className="h-3 w-3 shrink-0" />}
                <span>{activity.actorName}</span>
                <span aria-hidden="true">·</span>
                <span>{formatTimestamp(activity.createdAt)}</span>
              </p>
            </div>
          </li>
        );
      })}
      </ol>
    </div>
  );
}
