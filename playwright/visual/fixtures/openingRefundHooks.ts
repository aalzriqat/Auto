import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

/** Synthetic Convex transport boundary. The dialogs, policy, language and controls are real. */
export function useQuery(reference: FunctionReference<"query">, args: unknown) {
  if (args === "skip") return undefined;
  const name = getFunctionName(reference);
  if (name === "bankAccounts:list") return [];
  if (name !== "openingRefundCustody:openingRefundReservation") throw new Error(`Unexpected query: ${name}`);
  const state = new URLSearchParams(location.search).get("state");
  if (state === "loading") return undefined;
  if (state === "unavailable") return null;
  return {
    reservationKey: "synthetic-reservation", method: state === "bank" ? "BANK_TRANSFER" : "CASH",
    canRecover: state === "custody", ...(state === "bank" ? { bankAccountName: "Synthetic bank" } : {}),
  };
}

export function useMutation(reference: FunctionReference<"mutation">) {
  return async (args: Record<string, unknown>) => {
    const response = await fetch("/mutation", {
      method: "POST", body: JSON.stringify({ name: getFunctionName(reference), args }),
    });
    if (!response.ok) throw new ConvexError({ code: "OPENING_REFUND_BANK_PILOT_DISABLED", message: "Synthetic server refusal" });
    return { reservationKey: "synthetic-reservation" };
  };
}
