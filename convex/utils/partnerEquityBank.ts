/** A contribution cheque is held; a draw cheque is issued against a bank. */
export function partnerEquityNeedsBank(
  type: "CONTRIBUTION" | "DRAW" | "PROFIT_DISTRIBUTION",
  method: string | undefined
): boolean {
  if (type === "PROFIT_DISTRIBUTION") return false;
  return method === "BANK_TRANSFER" || method === "CARD" ||
    (type === "DRAW" && method === "CHEQUE");
}
