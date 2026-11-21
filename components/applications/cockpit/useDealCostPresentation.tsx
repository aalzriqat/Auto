import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandIdentity } from "@/hooks/useCommandIdentity";
import { formatMinorAmount } from "@/lib/moneyDisplay";
import { CustodyMovementsList } from "./CustodyMovementsList";
import type { DealCustodyActions, DealCustodyWiring } from "./DealCustodyPanel";
import {
  FEE_TYPE_LABEL,
  type HandoverCostsData,
  type HandoverCostSource,
} from "./HandoverCostsPanel";
import { renderMoment } from "./dealCockpitDate";
import type { ClosingReadinessRead } from "./useClosingReadiness";
import { useDealCustodyActions } from "./useDealCustodyActions";
import { useHandoverCostActions } from "./useHandoverCostActions";
import { safeScaleForCurrency } from "./useDealMoneyPresentation";

export function useDealCostPresentation({
  orgId,
  applicationId,
  app,
  deal,
  dealCosts,
  permissionsLoading,
  canViewDealCosts,
  canCreateApplication,
  canConfirmFinanceDisbursement,
  economicsCurrencyCode,
  orgCurrencyCode,
  currencyMarker,
  closingReadiness,
  unwindBars,
  commandId,
  locale,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  dealCosts:
    | FunctionReturnType<typeof api.financeDealCosts.listDealCosts>
    | undefined;
  permissionsLoading: boolean;
  canViewDealCosts: boolean;
  canCreateApplication: boolean;
  canConfirmFinanceDisbursement: boolean;
  economicsCurrencyCode: string;
  orgCurrencyCode: string;
  currencyMarker: (currency: string) => string;
  closingReadiness: ClosingReadinessRead["readiness"];
  unwindBars: boolean;
  commandId: CommandIdentity;
  locale: string;
  t: (key: string) => string;
}>) {
  // `listCustodyCandidates`. Mounted on EXACTLY the predicate that offers the
  // custody commands below (`custodyCommandsOffered`), so the plan and issue
  // dialogs can never render with a picker whose read was skipped
  // (consolidated round, item 5); skipped for everyone else, so the cockpit
  // never mounts a query its caller cannot pass. Custody is a fact of a
  // FINANCE APPLICATION — the record is keyed on one — and this container
  // is the financed cockpit, so `deal` here is always the financed kind.
  const custodyCommandsOffered =
    canConfirmFinanceDisbursement && deal !== undefined && deal !== null;
  const custodyCandidates = useQuery(
    api.financeDealCosts.listCustodyCandidates,
    custodyCommandsOffered ? { orgId } : "skip",
  );

  const custodyCommands = useDealCustodyActions({
    orgId,
    applicationId,
    commandId,
    t,
  });
  const handoverCostActions = useHandoverCostActions({
    orgId,
    applicationId,
    commandId,
    t,
  });

  const custodyMoney = (minor: number, currency: string) =>
    `${formatMinorAmount(minor, Math.pow(10, safeScaleForCurrency(currency, 2)))} ${
      currency === orgCurrencyCode ? currencyMarker(currency) : currency
    }`;
  /**
   * رسوم ومصاريف تسليم السيارة — RECORD / ADD / EDIT / REMOVE on the canonical
   * `financeDealCosts` commands (c19384). Two are economic and take a retained
   * identity: `recordTemplateFeeActual` keyed on (deal, template position) and
   * `recordDealFee` keyed on the add form's own intent. EDIT and REMOVE are
   * idempotent by construction (a set and a void) and the server takes no
   * identity for them.
   */
  // SCRUM-54: banks a bank-method handover payment may name, in the deal's cost currency.
  const directPaymentBankOptions = useQuery(
    api.financeDealCosts.listDirectPaymentBankOptions,
    app && deal && canConfirmFinanceDisbursement
      ? { orgId, currency: dealCosts?.currency ?? economicsCurrencyCode }
      : "skip",
  );
  const custodyBankOptions = useQuery(
    api.financeDealCosts.listCustodyBankOptions,
    app && deal && canConfirmFinanceDisbursement
      ? { orgId, currency: dealCosts?.currency ?? economicsCurrencyCode }
      : "skip",
  );
  const handoverCosts =
    app && deal
      ? {
          // Undefined is "loading" until the permission has resolved AND, for a
          // caller who holds it, the query has answered; only a resolved caller
          // WITHOUT the permission is told the rows are not theirs to read.
          loading:
            permissionsLoading || (canViewDealCosts && dealCosts === undefined),
          costs: dealCosts
            ? ({
                lines: dealCosts.fees.map((fee) => ({
                  _id: fee._id,
                  feeType: fee.feeType,
                  description: fee.description,
                  estimatedAmountMinor: fee.estimatedAmountMinor,
                  actualAmountMinor: fee.actualAmountMinor,
                  paidBy: fee.paidBy,
                  paidTo: fee.paidTo,
                  currency: fee.currency,
                  status: fee.status,
                  paidAt: fee.paidAt,
                  receiptReference: fee.receiptReference,
                  // SCRUM-834: what a reconcile form pins besides the amount.
                  actualEvidenceRevision: fee.actualEvidenceRevision,
                  // SCRUM-443: who paid it and whether it is on the books —
                  // the server's verdict (the closing check's own module),
                  // passed through, never re-derived here.
                  handoverPayment: fee.handoverPayment,
                  directPaymentEligible: fee.directPaymentEligible,
                  directPayment: fee.directPayment
                    ? {
                        method: fee.directPayment.method,
                        amountMinor: fee.directPayment.amountMinor,
                        paidAt: fee.directPayment.paidAt,
                        reference: fee.directPayment.reference,
                      }
                    : undefined,
                })),
                // Null over mixed rows, with the reason beside it — served as
                // such, never turned into a zero or a cast here.
                summary: dealCosts.summary,
                summaryUnavailable: dealCosts.summaryUnavailable,
                // The finance company's frozen policy, derived server-side from
                // the deal's own rule snapshot. Passed through as served: the
                // expected figures, the totals and the comparison are the
                // server's, and nothing is summed or matched here.
                expected: dealCosts.expected
                  ? {
                      source: dealCosts.expected.source,
                      currency: dealCosts.expected.currency,
                      rows: dealCosts.expected.rows.map((row) => ({
                        templateIndex: row.templateIndex,
                        feeType: row.feeType,
                        description: row.description,
                        expectedAmountMinor: row.expectedAmountMinor,
                        expectedAmountReason: row.expectedAmountReason,
                        duplicateIdentity: row.duplicateIdentity,
                        actual: row.actual
                          ? {
                              feeId: row.actual.feeId,
                              actualAmountMinor: row.actual.actualAmountMinor,
                              currency: row.actual.currency,
                              status: row.actual.status,
                            }
                          : null,
                      })),
                      expectedTotalMinor: dealCosts.expected.expectedTotalMinor,
                      expectedTotalReason:
                        dealCosts.expected.expectedTotalReason,
                      actualTotalMinor: dealCosts.expected.actualTotalMinor,
                      differenceMinor: dealCosts.expected.differenceMinor,
                      unplannedLineIds: dealCosts.expected.unplannedLineIds,
                      // The honest "not configured" state — reported, never applied.
                      adoption: dealCosts.expected.adoption,
                    }
                  : null,
                // SCRUM-690: the finance company's execution fee as one
                // position — the server's verdict, passed through.
                executionFee: dealCosts.executionFee
                  ? {
                      expectedMinor: dealCosts.executionFee.expectedMinor,
                      boundFeeId: dealCosts.executionFee.boundFeeId,
                      unrecorded: dealCosts.executionFee.unrecorded,
                      withheld: dealCosts.executionFee.withheld,
                      eligibleFeeIds: dealCosts.executionFee.eligibleFeeIds,
                    }
                  : null,
              } satisfies HandoverCostsData)
            : undefined,
          // The currency a new line is recorded in, as the SERVER resolves it
          // for its own writers (pin, else the org's verified currency, which
          // the first cost fixes — SCRUM-319). Not derived client-side.
          denomination: { code: dealCosts?.currency ?? economicsCurrencyCode },
          scaleOf: (cur: string) => safeScaleForCurrency(cur, 2),
          money: custodyMoney,
          // Frozen once the sale is recognized (`economicsFrozen`): the server
          // refuses every posting-bearing edit, so none is offered, and the
          // panel says why at its head.
          canManage:
            canCreateApplication &&
            !(dealCosts?.economicsFrozen?.frozen ?? app.status === "CLOSED"),
          dealClosed:
            dealCosts?.economicsFrozen?.frozen ?? app.status === "CLOSED",
          // Where a new handover cost's cash comes from — always an employee's
          // custody (owner ruling 2026-09-28, SCRUM-439). A record counts
          // when it is open, on the ledger and in the deal's currency. It is
          // CHARGED directly only where `recordDealFee` would accept its
          // `custodyId` from this caller: custody authority, a ledger that
          // can take the posting, and a record held by somebody else (the
          // holder never charges their own). The candidate read is what names
          // the operator, so an authorised caller waits for it rather than
          // being handed the unlinked path by a loading flicker.
          costSource: ((): HandoverCostSource => {
            const open = (dealCosts?.custody ?? []).filter(
              (record) =>
                record.status === "OPEN" &&
                !record.legacy &&
                record.currency === dealCosts?.currency,
            );
            if (open.length === 0) return { kind: "NONE" };
            if (!custodyCommandsOffered) return { kind: "PENDING" };
            if (custodyCandidates === undefined) return { kind: "LOADING" };
            // The caller, named by the read itself: the member list is capped,
            // so the operator may be past it. A backend that predates
            // `actorId` answers through the list; with neither, the caller is
            // unknown and no record is offered — the server refuses a holder
            // charging their own custody, so a guess would be a dead end.
            const actorId =
              custodyCandidates.actorId ??
              custodyCandidates.candidates.find((member) => member.isActor)
                ?.userId;
            const payers =
              dealCosts?.custodyAccounting?.ready === true &&
              actorId !== undefined
                ? open
                    .filter((record) => record.userId !== actorId)
                    .map((record) => ({
                      custodyId: record._id,
                      holderName: record.userName || t("CustodyHandlerNone"),
                    }))
                : [];
            return payers.length > 0
              ? { kind: "CHARGE", payers }
              : { kind: "PENDING" };
          })(),
          ...handoverCostActions,
          // SCRUM-443: the dealership's own payment of a handover cost. Only a
          // caller who may confirm a finance disbursement is offered it (R1);
          // the server refuses anyone else regardless.
          canRecordDirectPayment: canConfirmFinanceDisbursement,
          directPaymentBankOptions,
          // The reconcile mutation checks the same permission (confirm:finance_disbursement).
          canReconcile: canConfirmFinanceDisbursement,
          // The lines the server's own closing check names as waiting on the
          // ledger: passed through, so a recorded-but-queued payment is never
          // shown as paid. Only a blocked check names any.
          // Undefined while readiness is loading or unavailable: nothing then
          // says a recorded payment is on the books.
          handoverCostsCheck: closingReadiness?.checks.find(
            (c) => c.key === "HANDOVER_COSTS_PAID",
          )?.status,
          // The same discipline for a custody-paid line (SCRUM-443 v6): the row
          // says a posting was made; only this check says it is on the books.
          custodyLedgerCheck: closingReadiness?.checks.find(
            (c) => c.key === "CUSTODY_ON_LEDGER",
          )?.status,
          // A stopped (cancelled or rejected) deal: labels follow app.status, so
          // its direct payments read as recorded, never as settled, and none is
          // offered. cancelApplication can leave finalizedSaleId set, so a
          // stopped deal may also be finalized; dealClosed still governs edit
          // notes there. Taken from the app record, not from a separately
          // fetched eligibility flag (SCRUM-443).
          dealStopped:
            app.status === "CANCELLED" || app.status === "REJECTED"
              ? app.status
              : null,
          postingHoldFeeIds: ((): string[] => {
            const check = closingReadiness?.checks.find(
              (c) => c.key === "HANDOVER_COSTS_PAID",
            );
            return check?.status === "BLOCKED" ? (check.feeIds ?? []) : [];
          })(),
        }
      : undefined;

  /**
   * عهدة الموظف — read AND acted on from this screen. The summary comes off
   * the bounded `listDealCosts` read; each record's movement log is a separate
   * paginated query, mounted only when the operator opens it. The commands
   * post through the custody clearing account and are offered only to a
   * caller holding CONFIRM_FINANCE_DISBURSEMENT; the server's readiness
   * verdict travels with the read so a dead button says why.
   *
   * Identity discipline, same as the handover costs: an issuance, a movement
   * and a closure each mint one command identity per dialog ATTEMPT — the
   * dialog's `intentId`, never the figures (R8) — and retire it on success,
   * on the server's own refusal, or when the operator abandons the dialog. A
   * lost response keeps it so the operator's retry replays rather than pays
   * twice; and because the figures are not in the key, a corrected figure on
   * that retry is refused by the server's fingerprint instead of becoming a
   * second payment, while a dialog opened again later for the same figures
   * is a new command rather than a silent replay of the first.
   */
  const custodyActions: DealCustodyActions | undefined =
    app && custodyCommandsOffered
      ? {
          members: custodyCandidates?.candidates,
          bankOptions: custodyBankOptions,
          eligibleFees: (dealCosts?.fees ?? [])
            .filter(
              (fee) =>
                fee.custodyEligible &&
                fee.custodyId === undefined &&
                fee.actualAmountMinor !== undefined &&
                fee.actualAmountMinor > 0,
            )
            .map((fee) => ({
              _id: fee._id,
              label:
                fee.description?.trim() ||
                t(FEE_TYPE_LABEL[fee.feeType] ?? fee.feeType),
              actualAmountMinor: fee.actualAmountMinor as number,
              currency: fee.currency,
            })),
          scaleOf: (cur: string) => safeScaleForCurrency(cur, 3),
          ...custodyCommands,
        }
      : undefined;
  const custody: DealCustodyWiring | undefined =
    app && deal
      ? {
          loading:
            permissionsLoading || (canViewDealCosts && dealCosts === undefined),
          records: dealCosts?.custody,
          truncated: dealCosts?.custodyTruncated ?? false,
          currency: dealCosts?.currency ?? economicsCurrencyCode,
          expectedTotalMinor: dealCosts?.expected?.expectedTotalMinor ?? null,
          accounting: dealCosts?.custodyAccounting,
          plannedCustody: dealCosts?.plannedCustody ?? null,
          plannedCustodyWithheld: dealCosts?.plannedCustodyWithheld ?? false,
          recommended: dealCosts?.recommendedCustody ?? null,
          openPeriodToday: dealCosts?.custodyPostsNow,
          reopenLocked: unwindBars,
          finalized:
            (dealCosts?.economicsFrozen?.frozen ?? false) ||
            app.status === "CLOSED",
          dealStopped:
            // The issuing commands' own predicate, when the read has it;
            // the local status check stays as the fallback while it loads.
            dealCosts?.acceptsNewCustodyCash?.accepts === false ||
            (dealCosts?.economicsFrozen?.frozen ?? false) ||
            app.status === "CLOSED" ||
            app.status === "CANCELLED" ||
            app.status === "REJECTED",
          actions: custodyActions,
          renderMovements: (custodyId, onReverse) => {
            const record = dealCosts?.custody.find(
              (row) => row._id === custodyId,
            );
            return (
              <CustodyMovementsList
                orgId={orgId}
                custodyId={custodyId}
                currency={
                  record?.currency ??
                  dealCosts?.currency ??
                  economicsCurrencyCode
                }
                money={custodyMoney}
                formatDate={(ms: number) =>
                  renderMoment(ms, "d MMM yyyy", locale)
                }
                t={t}
                onReverse={onReverse}
              />
            );
          },
        }
      : undefined;

  return { handoverCosts, custody, custodyMoney };
}
