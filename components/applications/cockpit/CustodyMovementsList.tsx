"use client";

import { usePaginatedQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * One custody record's movement log, read through `listCustodyMovements` a
 * page at a time — oldest first, each reversed row struck through. Mounted
 * only when the operator opens the log, so the deal read stays bounded and a
 * deal with a long log never pays for it up front.
 *
 * A page boundary is stated, never hidden: "load more" is offered while the
 * server says there is more, and nothing here claims the visible rows are the
 * whole history until the server has said so.
 */

const PAGE = 25;

const METHOD_KEY: Record<"CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD", string> = {
  CASH: "MethodCash",
  BANK_TRANSFER: "MethodBankTransfer",
  CHEQUE: "MethodCheque",
  CARD: "MethodCard",
};
const KIND_KEY: Record<"ISSUED" | "RETURNED" | "REIMBURSED" | "REVERSAL", string> = {
  ISSUED: "CustodyKindIssued",
  RETURNED: "CustodyKindReturned",
  REIMBURSED: "CustodyKindReimbursed",
  REVERSAL: "CustodyKindReversal",
};

export function CustodyMovementsList({
  orgId,
  custodyId,
  currency,
  money,
  formatDate,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  custodyId: Id<"financeDealCustody">;
  /** The custody record's denomination — every movement on it is counted in it. */
  currency: string;
  money: (minor: number, currency: string) => string;
  formatDate: (ms: number) => string;
  t: (key: string) => string;
}>) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.financeDealCosts.listCustodyMovements,
    { orgId, custodyId },
    { initialNumItems: PAGE }
  );

  if (status === "LoadingFirstPage") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {t("Loading")}
      </p>
    );
  }
  return (
    <div className="space-y-1" data-testid="custody-movements">
      {results.length === 0 && <p className="text-xs text-muted-foreground">{t("CustodyNoMovements")}</p>}
      <ul className="divide-y divide-border text-sm">
        {results.map((entry) => (
          <li key={entry._id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5">
            <span className={`min-w-0 ${entry.reversed ? "line-through text-muted-foreground" : ""}`}>
              {t(KIND_KEY[entry.kind])}
              {entry.method && <span className="text-muted-foreground"> · {t(METHOD_KEY[entry.method])}</span>}
              {entry.reference && (
                <span className="text-muted-foreground">
                  {" · "}
                  <bdi dir="ltr">{entry.reference}</bdi>
                </span>
              )}
              <span className="text-muted-foreground">
                {" · "}
                <bdi dir="ltr">{formatDate(entry.occurredAt)}</bdi>
                {entry.recordedByName && (
                  <>
                    {" · "}
                    <bdi>{entry.recordedByName}</bdi>
                  </>
                )}
              </span>
              {entry.reversed && (
                <Badge variant="outline" className="ms-1.5">
                  {t("CustodyReversed")}
                </Badge>
              )}
            </span>
            <bdi dir="ltr" className={`shrink-0 tabular-nums ${entry.reversed ? "line-through text-muted-foreground" : ""}`}>
              {money(entry.amountMinor, currency)}
            </bdi>
          </li>
        ))}
      </ul>
      {status === "CanLoadMore" && (
        <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => loadMore(PAGE)}>
          {t("LoadMore")}
        </Button>
      )}
      {status === "LoadingMore" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {t("Loading")}
        </p>
      )}
    </div>
  );
}
