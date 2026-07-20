"use client";

import { ShieldAlert, Info } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { cn } from "@/lib/utils";

export interface AccessDeniedProps {
  /** Overrides the default "Access Not Allowed" heading. */
  title?: string;
  /** Overrides the default description line. */
  description?: string;
  /** Overrides the default "contact your manager or administrator" hint. Pass null to hide it. */
  hint?: string | null;
  /**
   * "page" fills the available height and centres the panel (route-level gating);
   * "card" renders inline within existing content.
   */
  variant?: "page" | "card";
  className?: string;
}

/**
 * A calm, branded "you don't have access" panel — used instead of a red error
 * whenever a whole page or section is gated by permissions. Access restrictions
 * are an expected state, not a failure, so this reads as an informational notice.
 * Bilingual (EN/AR + RTL) and theme-aware via the shared design tokens.
 */
export function AccessDenied({
  title,
  description,
  hint,
  variant = "page",
  className,
}: AccessDeniedProps) {
  const { t } = useLanguage();

  const resolvedTitle = title ?? t("AccessNotAllowedTitle");
  const resolvedDescription = description ?? t("AccessNotAllowedPageDescription");
  const resolvedHint = hint === null ? null : hint ?? t("AccessNotAllowedHint");

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full",
        variant === "page" ? "min-h-[60vh] items-center justify-center p-4" : "",
        className,
      )}
    >
      <div
        className={cn(
          "relative flex w-full max-w-2xl items-start gap-5 overflow-hidden rounded-2xl border bg-card p-6 shadow-sm sm:p-8",
          "border-border",
        )}
      >
        {/* Brand accent rail */}
        <span
          aria-hidden
          className="absolute inset-y-0 start-0 w-1 bg-primary/70"
        />

        {/* Shield-lock badge */}
        <div className="shrink-0">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-inset ring-primary/20">
            <ShieldAlert className="h-8 w-8 text-primary" aria-hidden />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            AutoFlow
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {resolvedTitle}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            {resolvedDescription}
          </p>

          {resolvedHint ? (
            <div className="mt-5 flex items-start gap-2 border-t border-border/60 pt-4">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p className="text-sm text-muted-foreground">{resolvedHint}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default AccessDenied;
