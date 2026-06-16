"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { MessageSquarePlus, Bug, Lightbulb, X, ChevronLeft } from "lucide-react";

type FeedbackType = "BUG" | "FEATURE";

export function FeedbackWidget() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const submit = useMutation(api.feedback.submit);

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FeedbackType | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reset = () => {
    setType(null);
    setTitle("");
    setDescription("");
    setIsSubmitting(false);
  };

  const handleClose = () => {
    setOpen(false);
    reset();
  };

  const handleSubmit = async () => {
    if (!activeOrgId) return;
    if (!title.trim()) {
      toast.error(t("FeedbackTitleRequired" as any));
      return;
    }
    setIsSubmitting(true);
    try {
      await submit({
        orgId: activeOrgId,
        type: type!,
        title: title.trim(),
        description: description.trim() || undefined,
        url: typeof window !== "undefined" ? window.location.pathname : undefined,
      });
      toast.success(t("FeedbackSuccess" as any));
      handleClose();
    } catch {
      toast.error(t("FeedbackError" as any));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 end-5 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-lg ring-1 ring-black/10 hover:bg-primary/90 transition-colors"
        aria-label={t("FeedbackWidgetTitle" as any)}
      >
        <MessageSquarePlus className="h-4 w-4" />
        <span className="hidden sm:inline">{t("FeedbackWidgetTitle" as any)}</span>
      </button>

      {/* Panel overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end p-4 sm:pe-6 sm:pb-20">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/20" onClick={handleClose} />

          {/* Panel */}
          <div className="relative w-full sm:w-96 bg-background rounded-xl border shadow-xl flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b">
              {type ? (
                <button
                  onClick={() => setType(null)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {t("Back" as any)}
                </button>
              ) : (
                <span className="text-sm font-semibold">{t("FeedbackWidgetTitle" as any)}</span>
              )}
              <button onClick={handleClose} className="rounded-md p-1 hover:bg-muted text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4 overflow-y-auto">
              {!type ? (
                // Type selection
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">{t("FeedbackWidgetDesc" as any)}</p>
                  <button
                    onClick={() => setType("BUG")}
                    className="w-full flex items-start gap-3 rounded-lg border p-4 text-start hover:bg-muted/50 transition-colors"
                  >
                    <Bug className="h-5 w-5 text-rose-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-sm">{t("FeedbackTypeBug" as any)}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Something isn't working as expected</p>
                    </div>
                  </button>
                  <button
                    onClick={() => setType("FEATURE")}
                    className="w-full flex items-start gap-3 rounded-lg border p-4 text-start hover:bg-muted/50 transition-colors"
                  >
                    <Lightbulb className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-sm">{t("FeedbackTypeFeature" as any)}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Suggest an improvement or new feature</p>
                    </div>
                  </button>
                </div>
              ) : (
                // Form
                <div className="space-y-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {type === "BUG"
                      ? <Bug className="h-4 w-4 text-rose-500" />
                      : <Lightbulb className="h-4 w-4 text-amber-500" />}
                    {type === "BUG" ? t("FeedbackTypeBug" as any) : t("FeedbackTypeFeature" as any)}
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t("FeedbackTitle" as any)}</label>
                    <Input
                      placeholder={t("FeedbackTitlePlaceholder" as any)}
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      autoFocus
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">{t("FeedbackDescription" as any)}</label>
                    <Textarea
                      placeholder={t("FeedbackDescPlaceholder" as any)}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={3}
                      className="resize-none"
                    />
                  </div>

                  <Button
                    onClick={handleSubmit}
                    disabled={isSubmitting || !title.trim()}
                    className="w-full"
                  >
                    {isSubmitting ? t("FeedbackSubmitting" as any) : t("FeedbackSubmit" as any)}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
