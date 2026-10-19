/**
 * SCRUM-724 review (Codex R1 / Opus F2): the mounted refund queue must never show
 * raw server English. A coded refusal shows its EN/AR translation; anything else
 * (an uncoded ConvexError such as the idempotency in-flight refusal, a transport
 * failure, a code with no translation) shows the queue's own localized message.
 *
 * Real dictionaries; the expected texts are hand-written literals, independent of
 * the render.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  queryResults: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  toastError: vi.fn(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries[stubs.locale] as Record<string, string>)[key] ?? key,
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: stubs.toastError } }));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const value = stubs.queryResults.get(getFunctionName(reference));
      return typeof value === "function" ? (value as (a: unknown) => unknown)(args) : value;
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      if (!stubs.mutations.has(name)) stubs.mutations.set(name, vi.fn().mockResolvedValue(null));
      return stubs.mutations.get(name)!;
    },
  };
});

import { RetainedCreditRefundsSection } from "./RetainedCreditRefundsSection";

const FALLBACK = {
  en: "The refund action could not be completed. Reload the page to see its current status, then try again.",
  ar: "تعذّر إتمام إجراء ردّ الرصيد. أعد تحميل الصفحة لرؤية حالته الحالية، ثم حاول مجدداً.",
} as const;

const NOT_PENDING = {
  en: (dictionaries.en as Record<string, string>).ServerError_RETAINED_CREDIT_REFUND_NOT_PENDING,
  ar: (dictionaries.ar as Record<string, string>).ServerError_RETAINED_CREDIT_REFUND_NOT_PENDING,
};

const IN_FLIGHT = "This command is already being processed. Please retry shortly.";

const UNCODED: ReadonlyArray<[string, () => unknown]> = [
  ["uncoded ConvexError (idempotency in flight)", () => new ConvexError(IN_FLIGHT)],
  ["transport failure", () => new TypeError("Failed to fetch")],
  ["code with no translation", () => new ConvexError({ code: "FORBIDDEN", message: "Forbidden: missing permission" })],
];

const refundRow = (over: { status: "PENDING" | "APPROVED" }) => ({
  _id: "r1", orgId: "org1", amountMinor: 1200, currency: "JOD", customerName: "Layla Haddad",
  sourceChequeLabel: "Arab Bank #004512", originatingSaleStatus: "CANCELLED", requestedByMe: false, ...over,
});

type Action = "reject" | "cancel" | "execute";
const MUTATION: Record<Action, string> = {
  reject: "retainedCreditRefunds:respondToRetainedCreditRefund",
  cancel: "retainedCreditRefunds:cancelRetainedCreditRefund",
  execute: "retainedCreditRefunds:executeRetainedCreditRefund",
};

const t = (key: string) => (dictionaries[stubs.locale] as Record<string, string>)[key];

/** Renders the queue and performs one action whose mutation rejects with `failure`. */
async function perform(action: Action, failure: unknown) {
  stubs.queryResults.set("retainedCreditRefunds:listRetainedCreditRefundRequests",
    (args: { status?: string }) => [refundRow({ status: action === "reject" ? "PENDING" : "APPROVED" })]
      .filter((row) => row.status === args.status));
  stubs.mutations.set(MUTATION[action], vi.fn().mockRejectedValue(failure));
  render(<RetainedCreditRefundsSection orgId={"org1" as never} canApprove canManage
    payoutAvailable={action === "execute"} />);
  if (action === "reject") {
    fireEvent.click(screen.getByRole("button", { name: t("Reject") }));
  } else if (action === "cancel") {
    fireEvent.change(screen.getByLabelText(t("RetainedCreditCancelReason")), { target: { value: "kept" } });
    fireEvent.click(screen.getByRole("button", { name: t("RetainedCreditRefundCancel") }));
  } else {
    fireEvent.change(screen.getByLabelText(t("RetainedCreditPayoutReference")), { target: { value: "TRX-1" } });
    fireEvent.click(screen.getByRole("button", { name: t("RetainedCreditExecute") }));
  }
  await vi.waitFor(() => expect(stubs.toastError).toHaveBeenCalledTimes(1));
  return String(stubs.toastError.mock.calls[0][0]);
}

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.mutations.clear();
  stubs.toastError.mockReset();
  stubs.locale = "en";
});

describe("refund queue failures are always in the user's language", () => {
  for (const locale of ["en", "ar"] as const) {
    for (const action of ["reject", "cancel", "execute"] as const) {
      for (const [label, make] of UNCODED) {
        test(`${locale} · ${action} · ${label} -> the queue's localized message, never server English`, async () => {
          stubs.locale = locale;
          const shown = await perform(action, make());
          expect(shown).toBe(FALLBACK[locale]);
          expect(shown).not.toContain(IN_FLIGHT);
          expect(shown).not.toContain("Failed to fetch");
          expect(shown).not.toContain("Forbidden");
        });
      }

      test(`${locale} · ${action} · coded refusal keeps its own translation`, async () => {
        stubs.locale = locale;
        const shown = await perform(action, new ConvexError({
          code: "RETAINED_CREDIT_REFUND_NOT_PENDING", message: "This refund request is no longer pending.",
        }));
        expect(NOT_PENDING[locale]).toBeTruthy();
        expect(shown).toBe(NOT_PENDING[locale]);
      });
    }
  }
});
