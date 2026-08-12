"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A radio group built from buttons, with the keyboard behaviour a radio group
 * is required to have.
 *
 * This project carries no radix radio primitive, and the two finance dialogs
 * both need one that can show an amount and an explanation per option. Rolling
 * it by hand twice produced two groups that looked right and were not: every
 * option was tab-focusable and none responded to the arrow keys, so a keyboard
 * user tabbed through each option instead of arrowing within one control, and
 * the group had no single tab stop.
 *
 * What a radio group owes its user, and what this implements:
 *
 *  - ONE tab stop for the whole group — the selected option, or the first when
 *    nothing is selected yet (roving `tabIndex`);
 *  - arrow keys move the selection and the focus together, wrapping at the
 *    ends, which is how `role="radio"` is specified to behave;
 *  - Home/End jump to the first and last option.
 *
 * Rendered as one shared component rather than copied into both dialogs,
 * because the defect was that two hand-rolled copies drifted from the pattern
 * in the same way.
 */
export type RadioCardOption<Value extends string> = {
  value: Value;
  label: React.ReactNode;
  /** Optional supporting line, e.g. what a basis means or implies. */
  hint?: React.ReactNode;
};

export function RadioCardGroup<Value extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  idPrefix,
  layout = "stacked",
}: Readonly<{
  ariaLabel: string;
  value: Value;
  options: ReadonlyArray<RadioCardOption<Value>>;
  onChange: (value: Value) => void;
  /** Prefixes each option's DOM id, so tests and labels can address them. */
  idPrefix: string;
  layout?: "stacked" | "inline";
}>) {
  const move = (from: number, delta: number) => {
    if (options.length === 0) return;
    // Wrapping, per the radio-group pattern: the ends are not dead stops.
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    document.getElementById(`${idPrefix}-${options[next].value}`)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        move(index, 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        move(index, -1);
        break;
      case "Home":
        event.preventDefault();
        move(index, -index);
        break;
      case "End":
        event.preventDefault();
        move(index, options.length - 1 - index);
        break;
      default:
        break;
    }
  };

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={layout === "inline" ? "flex gap-2" : "space-y-2"}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            id={`${idPrefix}-${option.value}`}
            type="button"
            role="radio"
            aria-checked={selected}
            // The group is one tab stop; the arrows move within it.
            tabIndex={index === selectedIndex ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-start gap-2.5 rounded-md border p-3 text-start transition-colors",
              layout === "inline" ? "flex-1 items-center p-2.5 text-sm" : "w-full",
              selected ? "border-primary bg-primary/[0.06]" : "hover:bg-muted/60"
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                layout === "inline" ? "mt-0" : "",
                selected ? "border-primary bg-primary text-primary-foreground" : ""
              )}
              aria-hidden
            >
              {selected && <Check className="h-3 w-3" />}
            </span>
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm leading-snug">{option.label}</span>
              {option.hint && (
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
