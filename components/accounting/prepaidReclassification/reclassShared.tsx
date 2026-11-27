"use client";

import type { ReactNode } from "react";
import { usePaginatedQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { usePrepaidReclassAccess } from "@/hooks/usePrepaidReclassAccess";
import { serverErrorMessageKey } from "@/lib/errors";
import { scaleForCurrency } from "../AccountingTabShared";

/**
 * SCRUM-961 shared pieces for the opening-prepaid-to-employee-advances screens. Every figure shown comes from the
 * backend; the only arithmetic here is the display conversion of an integer minor amount, the same one the prepaid tab
 * uses for its own columns.
 */
export type ReclassStatus = FunctionReturnType<typeof api.openingPrepaidReclassification.prepaidReclassificationStatus>;
export type PendingReclass = NonNullable<ReclassStatus["pending"]>;
export type ApprovedReclass = NonNullable<ReclassStatus["approved"]>;
export type ReclassPreview = FunctionReturnType<typeof api.openingPrepaidReclassification.previewPrepaidReclassification>;
export type ReclassFiguresOk = Extract<ReclassPreview, { ok: true }>;

/** The parts of a prepaid schedule row these screens read. */
export type ReclassSchedule = {
  _id: Id<"prepaidExpenseSchedules">;
  currency: string;
  title: string;
  monthsRemaining: number;
};

export type Translate = (key: string) => string;

/** The translated `ServerError_<code>` text, or the generic refusal when the code has no entry. */
export function reclassCodeMessage(code: string | null | undefined, t: Translate): string {
  if (code) {
    const key = serverErrorMessageKey(code);
    const text = t(key);
    if (text && text !== key) return text;
  }
  return t(serverErrorMessageKey("PREPAID_RECLASS_UNAVAILABLE"));
}

/** Formats an integer minor amount in the schedule's own currency at its full scale (JOD: 3 decimals). */
export function useMinorFormatter(currency: string): (minor: number) => string {
  const formatCurrency = useCurrencyFormatterInCurrency();
  const scale = scaleForCurrency(currency);
  return (minor) => formatCurrency(minor / 10 ** scale, currency, scale);
}

export type MemberOption = { userId: string; userName: string };

/**
 * Active team members for picking and naming beneficiaries. `memberships.list` needs `view:users`, so it is only
 * asked when the user holds it; without it the list is unavailable rather than a failed query.
 */
export function useReclassMembers(orgId: Id<"organizations">): {
  members: MemberOption[];
  loading: boolean;
  allowed: boolean;
  myUserId: string | null;
} {
  const { canListMembers: allowed, myUserId } = usePrepaidReclassAccess();
  const { results, status } = usePaginatedQuery(api.memberships.list, allowed ? { orgId } : "skip", { initialNumItems: 100 });
  const members = (results ?? []).map((member) => ({ userId: String(member?.userId ?? ""), userName: member?.userName || "" }));
  return { members, loading: allowed && status === "LoadingFirstPage", allowed, myUserId };
}

/** A date the way the General Ledger shows one: the user's locale (ar-JO / en-US). */
export function useReclassDate(): (ms: number) => string {
  const { locale } = useLanguage();
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";
  return (ms) => new Date(ms).toLocaleDateString(localeCode);
}

/** One label/value pair of a figures list; the value is isolated so a number keeps its direction inside RTL text. */
export function Figure({ label, value }: Readonly<{ label: ReactNode; value: ReactNode }>) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end font-medium tabular-nums"><bdi>{value}</bdi></dd>
    </>
  );
}

/**
 * The backend's figures for a change, as `Figure` rows inside a `<dl>`: expense given back, new schedule total, new
 * recognised amount, months left and the monthly amount (and the final month when it differs). Nothing is computed.
 */
export function ReclassFigureRows({ figures, format }: Readonly<{ figures: ReclassFiguresOk; format: (minor: number) => string }>) {
  const { t } = useLanguage();
  return (
    <>
      <Figure label={t("PrepaidReclassTrueUp")} value={format(figures.trueUpMinor)} />
      <Figure label={t("PrepaidReclassNewTotal")} value={format(figures.newTotalMinor)} />
      <Figure label={t("PrepaidReclassNewRecognized")} value={format(figures.newRecognizedMinor)} />
      <Figure label={t("PrepaidReclassMonthsLeft")} value={figures.remainingMonths} />
      <Figure label={t("PrepaidReclassMonthly")} value={format(figures.regularMonthlyMinor)} />
      {figures.finalMonthlyMinor !== figures.regularMonthlyMinor && (
        <Figure label={t("PrepaidReclassFinalMonthly")} value={format(figures.finalMonthlyMinor)} />
      )}
    </>
  );
}
