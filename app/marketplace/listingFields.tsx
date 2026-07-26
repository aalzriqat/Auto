"use client";

import type { ReactNode } from "react";
import type { UseFormRegisterReturn } from "react-hook-form";

/**
 * Shared labeled-field primitives for the two marketplace listing forms
 * (/marketplace/sell and the inline editor on /marketplace/my-listings).
 * Both render the same field set over the same react-hook-form registrations,
 * so the markup lives here once rather than being repeated per field per page.
 *
 * `size` covers the only real difference between the two: the standalone sell
 * form uses full-size controls, the inline edit form a denser variant.
 */
export type FieldSize = "default" | "compact";

const INPUT_CLASS: Record<FieldSize, string> = {
  default: "w-full rounded-lg border border-slate-300 px-3 py-2",
  compact: "w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm",
};

const LABEL_CLASS: Record<FieldSize, string> = {
  default: "text-sm font-medium block mb-1",
  compact: "text-xs font-medium block mb-1",
};

function FieldShell({
  id,
  label,
  size,
  error,
  children,
}: {
  readonly id?: string;
  readonly label: string;
  readonly size: FieldSize;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS[size]}>
        {label}
      </label>
      {children}
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}

export function TextField({
  id,
  label,
  registration,
  size = "default",
  error,
  placeholder,
  type,
  min,
}: {
  readonly id?: string;
  readonly label: string;
  readonly registration: UseFormRegisterReturn;
  readonly size?: FieldSize;
  readonly error?: string;
  readonly placeholder?: string;
  readonly type?: "text" | "number";
  readonly min?: number;
}) {
  return (
    <FieldShell id={id} label={label} size={size} error={error}>
      <input
        id={id}
        type={type}
        min={min}
        placeholder={placeholder}
        className={INPUT_CLASS[size]}
        {...registration}
      />
    </FieldShell>
  );
}

export function SelectField({
  id,
  label,
  registration,
  options,
  size = "default",
  error,
}: {
  readonly id?: string;
  readonly label: string;
  readonly registration: UseFormRegisterReturn;
  /** `value` is submitted; `label` is shown (they match for plain code lists). */
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly size?: FieldSize;
  readonly error?: string;
}) {
  return (
    <FieldShell id={id} label={label} size={size} error={error}>
      <select id={id} className={`${INPUT_CLASS[size]} bg-white`} {...registration}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function TextAreaField({
  id,
  label,
  registration,
  rows = 3,
  size = "default",
  error,
  placeholder,
}: {
  readonly id?: string;
  readonly label: string;
  readonly registration: UseFormRegisterReturn;
  readonly rows?: number;
  readonly size?: FieldSize;
  readonly error?: string;
  readonly placeholder?: string;
}) {
  return (
    <FieldShell id={id} label={label} size={size} error={error}>
      <textarea
        id={id}
        rows={rows}
        placeholder={placeholder}
        className={INPUT_CLASS[size]}
        {...registration}
      />
    </FieldShell>
  );
}

/** Plain code lists (currencies, conditions) render the code as its own label. */
export function codeOptions(codes: readonly string[]): { value: string; label: string }[] {
  return codes.map((code) => ({ value: code, label: code }));
}
