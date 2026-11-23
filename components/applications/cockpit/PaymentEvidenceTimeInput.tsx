import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatLocalized, msToLocalDateTimeInput } from "@/lib/dateLocale";

export type EvidenceTime = { local: string; occurrence?: number };

function localOccurrences(value: string): number[] {
  const seconds = value.replace(/\.000$/, "");
  const local = seconds.length === 16 ? `${seconds}:00` : seconds;
  const first = Date.parse(local);
  if (!Number.isSafeInteger(first) || msToLocalDateTimeInput(first) !== local) return [];
  const minute = 60_000;
  const day = 24 * 60 * minute;
  const offset = new Date(first).getTimezoneOffset();
  const neighbors = [first - day, first + day].map((instant) => new Date(instant).getTimezoneOffset());
  return [...new Set([first, ...neighbors.map((neighbor) => first + (neighbor - offset) * minute)])]
    .filter((instant) => msToLocalDateTimeInput(instant) === local).sort((a, b) => a - b);
}

export function evidenceTimeInMs(time: EvidenceTime): number {
  const occurrences = localOccurrences(time.local);
  if (occurrences.length === 1) return occurrences[0];
  return occurrences.find((instant) => instant === time.occurrence) ?? NaN;
}

export function evidenceTimeFromMs(ms: number): EvidenceTime {
  return { local: msToLocalDateTimeInput(ms), occurrence: Math.floor(ms / 1000) * 1000 };
}

export function usePaymentEvidenceClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function PaymentEvidenceTimeInput({ id, value, onChange, invalid, errorText, t }: {
  id: string;
  value: EvidenceTime;
  onChange: (value: EvidenceTime) => void;
  invalid: boolean;
  errorText: string;
  t: (key: string) => string;
}) {
  const occurrences = localOccurrences(value.local);
  const chooseOffset = occurrences.length > 1;
  const missingOffset = chooseOffset && !occurrences.some((instant) => instant === value.occurrence);
  const errorId = `${id}-error`;
  return <>
    <Input id={id} type="datetime-local" step="1" dir="ltr" required value={value.local}
      aria-invalid={invalid && !missingOffset} aria-describedby={invalid && !missingOffset ? errorId : undefined}
      onChange={(event) => onChange({ local: event.target.value })} />
    {chooseOffset && <>
      <Label htmlFor={`${id}-offset`}>{t("PaymentEvidenceTimeOffset")}</Label>
      <select id={`${id}-offset`} dir="ltr" required value={value.occurrence ?? ""} aria-invalid={missingOffset}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-ring"
        onChange={(event) => onChange({ ...value, occurrence: event.target.value ? Number(event.target.value) : undefined })}>
        <option value="">{t("PaymentEvidenceChooseOffset")}</option>
        {occurrences.map((instant) => <option key={instant} value={instant}>UTC{formatLocalized(instant, "xxx", undefined)}</option>)}
      </select>
    </>}
    {invalid && !missingOffset && <p id={errorId} role="alert" className="text-sm text-destructive">{errorText}</p>}
  </>;
}
