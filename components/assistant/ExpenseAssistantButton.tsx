"use client";

import { Sparkles } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { openExpenseAssistant } from "./expenseAssistantStore";
import { useExpenseAssistantAvailable } from "./useExpenseAssistantAvailable";

interface ExpenseAssistantButtonProps {
  /** "bar": icon button in the desktop top bar. "drawer": text row in the phone menu drawer. */
  variant: "bar" | "drawer";
  /** The member's permissions, as the top bar already reads them. */
  permissions: readonly string[];
  /** Runs before the panel opens; the drawer uses it to close itself. */
  onOpen?: () => void;
  /** Where focus goes when the panel closes, for a trigger that will be gone by then. */
  returnFocusTo?: () => HTMLElement | null;
}

/**
 * Entry to the expense assistant (SCRUM-1039). Placed exactly like the feedback
 * entry: an icon in the top bar from `md` up, a row in the menu drawer on phones,
 * never a floating button (SCRUM-612). Renders nothing unless the member may
 * create expenses and the assistant is on for their dealership.
 */
export function ExpenseAssistantButton({ variant, permissions, onOpen, returnFocusTo }: ExpenseAssistantButtonProps) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const available = useExpenseAssistantAvailable(activeOrgId, permissions);
  if (!available) return null;

  const label = t("ExpenseAssistantOpen");
  const open = (trigger: HTMLElement) => {
    onOpen?.();
    openExpenseAssistant(returnFocusTo ? returnFocusTo() : trigger);
  };

  if (variant === "drawer") {
    return (
      <button
        type="button"
        onClick={(event) => open(event.currentTarget)}
        aria-haspopup="dialog"
        className="flex h-11 w-full items-center gap-3 px-3 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        <Sparkles className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
        <span className="flex-1 text-start">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={(event) => open(event.currentTarget)}
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      className="hidden md:inline-flex p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors"
    >
      <Sparkles className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
