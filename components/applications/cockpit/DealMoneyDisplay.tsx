import type { ReactNode } from "react";

/** A money run is Latin digits inside Arabic prose; `<bdi>` keeps it whole. */
export function Money({ children }: Readonly<{ children: ReactNode }>) {
  return <bdi className="tabular-nums">{children}</bdi>;
}

/**
 * One fact of the six-fact summary. `value` is already formatted; `null`
 * renders the unavailable state rather than a zero, because every figure here
 * is either on the server's record or it is not.
 */
export function MoneyFact({
  label,
  value,
  unavailableKey = "NotRecorded",
  note,
  action,
  t,
}: Readonly<{
  label: string;
  value: string | null;
  /** What a `null` value means here — "never recorded" by default. */
  unavailableKey?: string;
  note?: ReactNode;
  action?: ReactNode;
  t: (key: string) => string;
}>) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {value === null ? (
        <p className="text-sm text-muted-foreground">{t(unavailableKey)}</p>
      ) : (
        <p className="text-base font-semibold leading-snug">
          <Money>{value}</Money>
        </p>
      )}
      {note && <p className="min-w-0 break-words text-xs text-muted-foreground">{note}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
