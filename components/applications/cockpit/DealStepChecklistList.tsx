"use client";

import { ArrowRight, Check, Circle } from "lucide-react";
import type { ChecklistDestination, ChecklistItem } from "./dealStepChecklist";

/**
 * The sub-steps of a stage, drawn inside the step card (SCRUM-417 UX4, O2).
 *
 * Each item is done, current or pending, and never by colour alone: the three
 * have different shapes (a tick, an arrow, an empty ring), the current one says
 * "Next" in words, and every item carries its state as text for assistive
 * technology. Only the CURRENT item can be a control, and only when the cockpit
 * has somewhere to send it (`go` returns undefined otherwise, and the item is
 * then plain text -- never a button that does nothing).
 */
export function DealStepChecklist({
  items,
  go,
  t,
}: Readonly<{
  items: ReadonlyArray<ChecklistItem>;
  /** The handler for a destination, or undefined when this caller has none. */
  go: (destination: ChecklistDestination) => (() => void) | undefined;
  t: (key: string) => string;
}>) {
  return (
    <section aria-label={t("ChecklistHeading")} data-testid="deal-step-checklist">
      <ol className="space-y-1">
        {items.map((item) => {
          const handler = item.status === "current" && item.destination ? go(item.destination) : undefined;
          const stateKey =
            item.status === "done" ? "ChecklistDone" : item.status === "current" ? "ChecklistCurrent" : "ChecklistPending";
          const body = (
            <>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
                {item.status === "done" ? (
                  <Check className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
                ) : item.status === "current" ? (
                  <ArrowRight className="h-4 w-4 text-primary rtl:-scale-x-100" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </span>
              <span
                className={
                  item.status === "current"
                    ? "min-w-0 flex-1 font-medium text-foreground"
                    : "min-w-0 flex-1 text-muted-foreground"
                }
              >
                {t(item.labelKey)}
              </span>
              {/* The state in words: visible for the item to act on, spoken for the rest. */}
              <span
                className={
                  item.status === "current" ? "shrink-0 text-xs font-medium text-primary" : "sr-only"
                }
              >
                {t(stateKey)}
              </span>
            </>
          );
          return (
            <li key={item.id} data-testid={`deal-step-item-${item.id}`} data-status={item.status}>
              {handler ? (
                <button
                  type="button"
                  aria-current="step"
                  data-testid="deal-step-item-go"
                  onClick={handler}
                  className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-start text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {body}
                </button>
              ) : (
                <div
                  aria-current={item.status === "current" ? "step" : undefined}
                  className="flex min-h-8 items-center gap-2 px-1 text-sm"
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
