/**
 * SCRUM-810: the pilot capability manifest.
 *
 * ONE place that ties each pilot switch to (a) the value the server reads, (b) the public
 * Convex doors it guards, (c) the EN/AR refusal copy and (d) the screens that call those doors.
 * `lib/pilotCapabilityManifest.test.ts` fails when any of those drift apart, and
 * `test-utils/pilotConfigParity.ts` fails a suite that claims pilot certification while a
 * switch has been mocked away from its shipped value.
 *
 * This file does not own any switch value. Every reader goes through the same export the server
 * reads (the constant, or the module's own `is...Disabled` function), so a screen that asks
 * `isPilotSwitchOn(...)` sees exactly what the mutation will do. Flipping a switch stays a
 * reviewed code change in its own leaf module plus its own certification.
 *
 * All modules imported here are leaf modules that the web client already bundles.
 */
import { PAYMENT_LINKS_PILOT_DISABLED } from "./pilotCapabilities";
import { MANUAL_JOURNALS_PILOT_DISABLED } from "../convex/utils/pilotSwitches";
import {
  assertFixedAssetLifecycleAllowed,
  isFixedAssetLifecycleDisabled,
} from "../convex/utils/fixedAssetLifecycleContainment";
import {
  PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED,
  PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE,
} from "../convex/utils/partnerDistributionContainment";
import {
  areSaleInvoiceReceiptDoorsDisabled,
  assertCustomerCreditPayoutAllowed,
  assertSaleInvoiceReceiptDoorsAllowed,
  isCustomerCreditPayoutDisabled,
} from "../convex/utils/customerCreditPayoutContainment";
import { DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED } from "../convex/utils/depositOtherContainment";
import {
  assertLegacyCollectionRefundAllowed,
  isLegacyCollectionRefundDisabled,
} from "../convex/utils/legacyCollectionRefundContainment";
import { assertClearedChequeReturnAllowed, isClearedChequeReturnDisabled } from "../convex/utils/postDeliveryDoorContainment";
import { assertSupplierSettlementDoorAllowed, isSupplierSettlementDoorDisabled } from "../convex/utils/supplierSettlementContainment";
import { assertRt11DoorAllowed, isRt11DoorDisabled } from "../convex/utils/rt11DoorContainment";
import {
  CASH_SALE_EXTRAS_PILOT_REFUSED,
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED,
  PAYMENT_LINKS_PILOT_DISABLED as PAYMENT_LINKS_VIA_SALE_DEBT,
} from "../convex/utils/saleDebtContainment";
import { DEAL_COMMISSION_LINES_PILOT_DISABLED } from "../convex/utils/dealCommissionLines";

/**
 * Every pilot switch, keyed by its constant (or door-map key) name. The value is the RAW switch
 * value: `true` on a `*_PILOT_DISABLED` switch means the door is shut; `true` on a
 * `*_PILOT_REQUIRED` or `*_PILOT_REFUSED` switch means the rule is enforced.
 */
export const PILOT_SWITCHES = {
  PAYMENT_LINKS_PILOT_DISABLED: () => PAYMENT_LINKS_PILOT_DISABLED as boolean,
  FIXED_ASSET_LIFECYCLE_PILOT_DISABLED: () => isFixedAssetLifecycleDisabled(),
  MANUAL_JOURNALS_PILOT_DISABLED: () => MANUAL_JOURNALS_PILOT_DISABLED as boolean,
  PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED: () => PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED as boolean,
  CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED: () => isCustomerCreditPayoutDisabled(),
  SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED: () => areSaleInvoiceReceiptDoorsDisabled(),
  DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED: () => DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED as boolean,
  LEGACY_COLLECTION_REFUND_PILOT_DISABLED: () => isLegacyCollectionRefundDisabled(),
  CLEARED_CHEQUE_RETURN_PILOT_DISABLED: () => isClearedChequeReturnDisabled(),
  SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED: () => isSupplierSettlementDoorDisabled("SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED"),
  SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED: () => isSupplierSettlementDoorDisabled("SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED"),
  SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED: () => isSupplierSettlementDoorDisabled("SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED"),
  CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED: () => isRt11DoorDisabled("CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED"),
  CUSTODY_WRITEOFF_PILOT_DISABLED: () => isRt11DoorDisabled("CUSTODY_WRITEOFF_PILOT_DISABLED"),
  CUSTODY_MIGRATION_PILOT_DISABLED: () => isRt11DoorDisabled("CUSTODY_MIGRATION_PILOT_DISABLED"),
  CUSTODY_REOPEN_PILOT_DISABLED: () => isRt11DoorDisabled("CUSTODY_REOPEN_PILOT_DISABLED"),
  MANUAL_FINANCE_APPROVAL_PILOT_DISABLED: () => isRt11DoorDisabled("MANUAL_FINANCE_APPROVAL_PILOT_DISABLED"),
  EXPECTED_PAYMENT_PAID_PILOT_DISABLED: () => isRt11DoorDisabled("EXPECTED_PAYMENT_PAID_PILOT_DISABLED"),
  SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED: () => isRt11DoorDisabled("SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED"),
  DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED: () => isRt11DoorDisabled("DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED"),
  VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED: () => isRt11DoorDisabled("VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED"),
  PAID_LANDED_COST_CHANGE_PILOT_DISABLED: () => isRt11DoorDisabled("PAID_LANDED_COST_CHANGE_PILOT_DISABLED"),
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: () => CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED as boolean,
  CASH_SALE_EXTRAS_PILOT_REFUSED: () => CASH_SALE_EXTRAS_PILOT_REFUSED as boolean,
  DEAL_COMMISSION_LINES_PILOT_DISABLED: () => DEAL_COMMISSION_LINES_PILOT_DISABLED as boolean,
} as const satisfies Record<string, () => boolean>;

export type PilotSwitchKey = keyof typeof PILOT_SWITCHES;

/**
 * Other modules the SERVER imports a switch through. `convex/paymentIntents.ts` takes the
 * payment-link switch from `saleDebtContainment`, which re-exports it, so a mock of that module
 * changes what the mutation does while the reader above stays on the declaring module.
 * `test-utils/pilotConfigParity.ts` compares every binding with the shipped value, and
 * `lib/pilotCapabilityManifest.test.ts` fails if a module re-exports a switch without being listed.
 */
export const PILOT_SERVER_BINDINGS: Readonly<
  Partial<Record<PilotSwitchKey, readonly { readonly module: string; readonly read: () => boolean }[]>>
> = {
  PAYMENT_LINKS_PILOT_DISABLED: [
    { module: "convex/utils/saleDebtContainment", read: () => PAYMENT_LINKS_VIA_SALE_DEBT as boolean },
  ],
};

/**
 * The guard each mutation actually calls, for every switch that has one. It throws while the
 * switch is on. The parity check calls it, so a mock that replaces only the guard is caught even
 * when the constant is untouched.
 */
export const PILOT_SERVER_GUARDS: Readonly<Partial<Record<PilotSwitchKey, () => void>>> = {
  FIXED_ASSET_LIFECYCLE_PILOT_DISABLED: () => assertFixedAssetLifecycleAllowed(),
  CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED: () => assertCustomerCreditPayoutAllowed(),
  SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED: () => assertSaleInvoiceReceiptDoorsAllowed(),
  LEGACY_COLLECTION_REFUND_PILOT_DISABLED: () => assertLegacyCollectionRefundAllowed(),
  CLEARED_CHEQUE_RETURN_PILOT_DISABLED: () => assertClearedChequeReturnAllowed(),
  SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED: () => assertSupplierSettlementDoorAllowed("SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED"),
  SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED: () => assertSupplierSettlementDoorAllowed("SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED"),
  SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED: () => assertSupplierSettlementDoorAllowed("SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED"),
  CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED: () => assertRt11DoorAllowed("CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED"),
  CUSTODY_WRITEOFF_PILOT_DISABLED: () => assertRt11DoorAllowed("CUSTODY_WRITEOFF_PILOT_DISABLED"),
  CUSTODY_MIGRATION_PILOT_DISABLED: () => assertRt11DoorAllowed("CUSTODY_MIGRATION_PILOT_DISABLED"),
  CUSTODY_REOPEN_PILOT_DISABLED: () => assertRt11DoorAllowed("CUSTODY_REOPEN_PILOT_DISABLED"),
  MANUAL_FINANCE_APPROVAL_PILOT_DISABLED: () => assertRt11DoorAllowed("MANUAL_FINANCE_APPROVAL_PILOT_DISABLED"),
  EXPECTED_PAYMENT_PAID_PILOT_DISABLED: () => assertRt11DoorAllowed("EXPECTED_PAYMENT_PAID_PILOT_DISABLED"),
  SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED: () => assertRt11DoorAllowed("SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED"),
  DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED: () => assertRt11DoorAllowed("DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED"),
  VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED: () => assertRt11DoorAllowed("VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED"),
  PAID_LANDED_COST_CHANGE_PILOT_DISABLED: () => assertRt11DoorAllowed("PAID_LANDED_COST_CHANGE_PILOT_DISABLED"),
};

/**
 * The one call a screen makes to decide whether to offer an action behind a switch.
 * `true` means the pilot switch is ON, so the server refuses the door.
 */
export function isPilotSwitchOn(key: PilotSwitchKey): boolean {
  return PILOT_SWITCHES[key]();
}

export interface PilotDoor {
  /** `<convex module>.<export>` of the public Convex function. */
  readonly name: string;
  /** Any one of these identifiers must appear in the door's source. */
  readonly guards: readonly string[];
  /**
   * `whole`: the door refuses every call while the switch is on, so no screen may offer it.
   * `conditional`: the door refuses only the ruled branch and is shared with enabled behaviour.
   */
  readonly scope: "whole" | "conditional";
}

export interface PilotUiCaller {
  /** A component under components/ or app/ that references `api.<door>`. */
  readonly file: string;
  readonly doors: readonly string[];
  /** Text that must stay in `gateFile` (default: `file`). The gate that hides or disables the action. */
  readonly gate: string;
  readonly gateFile?: string;
}

export interface PilotCapability {
  readonly id: string;
  readonly switches: readonly PilotSwitchKey[];
  /** `ServerError_*` keys that must exist in the EN and AR dictionaries. */
  readonly refusalKeys: readonly string[];
  /** Copy that lives beside the switch instead of in the dictionaries (partner distribution only). */
  readonly refusalCopy?: Readonly<{ en: string; ar: string }>;
  readonly doors: readonly PilotDoor[];
  readonly uiCallers?: readonly PilotUiCaller[];
}

const whole = (name: string, ...guards: string[]): PilotDoor => ({ name, guards, scope: "whole" });
const conditional = (name: string, ...guards: string[]): PilotDoor => ({ name, guards, scope: "conditional" });

const RT11_GUARDS = ["assertRt11DoorAllowed", "isRt11DoorDisabled"];
const SUPPLIER_GUARDS = ["assertSupplierSettlementDoorAllowed", "isSupplierSettlementDoorDisabled"];
const PAYOUT_GUARDS = ["assertCustomerCreditPayoutAllowed", "CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED"];
const RECEIPT_GUARDS = ["assertSaleInvoiceReceiptDoorsAllowed", "SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED"];

export const PILOT_CAPABILITIES: readonly PilotCapability[] = [
  {
    id: "PAYMENT_LINKS",
    switches: ["PAYMENT_LINKS_PILOT_DISABLED"],
    refusalKeys: ["ServerError_PAYMENT_LINKS_DISABLED"],
    doors: [
      whole("paymentIntents.create", "PAYMENT_LINKS_PILOT_DISABLED"),
      whole("paymentIntents.markSettled", "PAYMENT_LINKS_PILOT_DISABLED"),
    ],
    uiCallers: [
      {
        file: "components/accounting/collections/PaymentLinksPanel.tsx",
        doors: ["paymentIntents.create", "paymentIntents.markSettled"],
        gate: 'isPilotSwitchOn("PAYMENT_LINKS_PILOT_DISABLED")',
      },
    ],
  },
  {
    id: "FIXED_ASSET_LIFECYCLE",
    switches: ["FIXED_ASSET_LIFECYCLE_PILOT_DISABLED"],
    refusalKeys: ["ServerError_FIXED_ASSET_LIFECYCLE_DISABLED"],
    doors: [
      whole("fixedAssets.capitalize", "assertFixedAssetLifecycleAllowed"),
      whole("fixedAssets.update", "assertFixedAssetLifecycleAllowed"),
      whole("fixedAssets.remove", "assertFixedAssetLifecycleAllowed"),
      whole("fixedAssets.impair", "assertFixedAssetLifecycleAllowed"),
      whole("fixedAssets.dispose", "assertFixedAssetLifecycleAllowed"),
      whole("accountingMigration.backfillFixedAssetMinorUnits", "assertFixedAssetLifecycleAllowed"),
    ],
    uiCallers: [
      {
        file: "components/accounting/FixedAssetsTab.tsx",
        doors: ["fixedAssets.capitalize", "fixedAssets.impair", "fixedAssets.dispose"],
        gate: 'isPilotSwitchOn("FIXED_ASSET_LIFECYCLE_PILOT_DISABLED")',
      },
    ],
  },
  {
    id: "MANUAL_JOURNALS",
    switches: ["MANUAL_JOURNALS_PILOT_DISABLED"],
    refusalKeys: ["ServerError_MANUAL_JOURNALS_DISABLED"],
    doors: [
      whole("financialAudit.createManualJournal", "assertManualJournalsEnabled"),
      whole("financialAudit.approveManualJournal", "assertManualJournalsEnabled"),
    ],
    uiCallers: [
      {
        file: "components/accounting/ManualJournalTab.tsx",
        doors: ["financialAudit.createManualJournal", "financialAudit.approveManualJournal"],
        gate: "MANUAL_JOURNALS_PILOT_DISABLED",
      },
    ],
  },
  {
    id: "PARTNER_PROFIT_DISTRIBUTION",
    switches: ["PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED"],
    refusalKeys: [],
    refusalCopy: PARTNER_PROFIT_DISTRIBUTION_UNAVAILABLE,
    doors: [conditional("partnerEquity.recordEquityMovement", "PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED")],
  },
  {
    id: "CUSTOMER_CREDIT_PAYOUT",
    switches: ["CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED"],
    refusalKeys: ["ServerError_CUSTOMER_CREDIT_PAYOUT_DISABLED"],
    doors: [
      whole("retainedCreditRefunds.executeRetainedCreditRefund", ...PAYOUT_GUARDS),
      conditional("dealUnwind.finishDealUnwind", ...PAYOUT_GUARDS),
      conditional("sales.update", ...PAYOUT_GUARDS),
    ],
    uiCallers: [
      {
        file: "components/accounting/RetainedCreditRefundsSection.tsx",
        doors: ["retainedCreditRefunds.executeRetainedCreditRefund"],
        gate: "payoutAvailable",
      },
    ],
  },
  {
    id: "SALE_INVOICE_RECEIPT_DOORS",
    switches: ["SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED"],
    refusalKeys: ["ServerError_SALE_INVOICE_RECEIPT_DOORS_DISABLED"],
    doors: [
      whole("collections.registerSaleInvoiceCheque", ...RECEIPT_GUARDS),
      whole("collections.reserveSaleInvoiceReceipt", ...RECEIPT_GUARDS),
      whole("collections.activateSaleInvoiceReceipt", ...RECEIPT_GUARDS),
      conditional("collections.recordPayment", ...RECEIPT_GUARDS),
    ],
    uiCallers: [
      {
        file: "components/applications/cockpit/DealInvoiceReceiptsPanel.tsx",
        doors: [
          "collections.registerSaleInvoiceCheque",
          "collections.reserveSaleInvoiceReceipt",
          "collections.activateSaleInvoiceReceipt",
        ],
        gate: "saleInvoiceDoorsAvailable",
      },
    ],
  },
  {
    id: "DEPOSIT_OTHER_TREATMENT",
    switches: ["DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED"],
    refusalKeys: ["ServerError_DEPOSIT_OTHER_TREATMENT_DISABLED"],
    doors: [
      conditional("deposits.resolveReleasedAllocation", "DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED"),
      conditional("sales.create", "DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED"),
      conditional("sales.completeFromQuote", "DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED"),
    ],
  },
  {
    id: "LEGACY_COLLECTION_REFUND",
    switches: ["LEGACY_COLLECTION_REFUND_PILOT_DISABLED"],
    refusalKeys: ["ServerError_LEGACY_COLLECTION_REFUND_PILOT_DISABLED"],
    doors: [
      conditional("collections.requestApproval", "assertLegacyCollectionRefund"),
      conditional("collections.respondToApproval", "assertLegacyCollectionRefund"),
      conditional("subledger.recordPayment", "assertLegacyCollectionRefund"),
    ],
  },
  {
    id: "CLEARED_CHEQUE_RETURN",
    switches: ["CLEARED_CHEQUE_RETURN_PILOT_DISABLED"],
    refusalKeys: ["ServerError_CLEARED_CHEQUE_RETURN_PILOT_DISABLED"],
    doors: [conditional("collections.returnClearedCheque", "assertClearedChequeReturnAllowed")],
  },
  {
    id: "SUPPLIER_SETTLEMENT_REVERSALS",
    switches: [
      "SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED",
      "SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED",
      "SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED",
    ],
    refusalKeys: [
      "ServerError_SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED",
      "ServerError_SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED",
      "ServerError_SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED",
    ],
    doors: [
      // The supplier cost-recovery receipt reversal is not listed: scripts/supplierSettlementCensus.test.ts
      // forbids any app, component, lib or mobile source from naming that door, and this file is under lib/.
      conditional("vehicles.correctAcquisitionCost", ...SUPPLIER_GUARDS),
      conditional("expenses.reverseExpense", ...SUPPLIER_GUARDS),
    ],
  },
  {
    id: "RT11_DOORS",
    switches: [
      "CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED",
      "CUSTODY_WRITEOFF_PILOT_DISABLED",
      "CUSTODY_MIGRATION_PILOT_DISABLED",
      "CUSTODY_REOPEN_PILOT_DISABLED",
      "MANUAL_FINANCE_APPROVAL_PILOT_DISABLED",
      "EXPECTED_PAYMENT_PAID_PILOT_DISABLED",
      "SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED",
      "DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED",
      "VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED",
      "PAID_LANDED_COST_CHANGE_PILOT_DISABLED",
    ],
    refusalKeys: [
      "ServerError_CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED",
      "ServerError_CUSTODY_WRITEOFF_PILOT_DISABLED",
      "ServerError_CUSTODY_MIGRATION_PILOT_DISABLED",
      "ServerError_CUSTODY_REOPEN_PILOT_DISABLED",
      "ServerError_MANUAL_FINANCE_APPROVAL_PILOT_DISABLED",
      "ServerError_EXPECTED_PAYMENT_PAID_PILOT_DISABLED",
      "ServerError_SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED",
      "ServerError_DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED",
      "ServerError_VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED",
      "ServerError_PAID_LANDED_COST_CHANGE_PILOT_DISABLED",
    ],
    doors: [
      whole("financeDealCosts.migrateLegacyCustodyToLedger", ...RT11_GUARDS),
      whole("financeDealCosts.reopenDealCustody", ...RT11_GUARDS),
      whole("financingEconomics.recordManualFinanceApproval", ...RT11_GUARDS),
      whole("applications.amendSupplierDisbursementAdvice", ...RT11_GUARDS),
      conditional("financeDealCosts.recordCustodyMovement", ...RT11_GUARDS),
      conditional("applications.correctExpectedPayment", ...RT11_GUARDS),
      conditional("sales.markCommissionPaid", ...RT11_GUARDS),
      conditional("vehicles.update", ...RT11_GUARDS),
      conditional("vehicles.upsertLandedCosts", ...RT11_GUARDS),
    ],
    uiCallers: [
      {
        file: "components/applications/cockpit/DealCockpit.tsx",
        doors: ["applications.amendSupplierDisbursementAdvice"],
        gate: 'isRt11DoorDisabled("SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED")',
      },
      {
        file: "components/applications/cockpit/DealCockpit.tsx",
        doors: ["financeDealCosts.reopenDealCustody"],
        gate: 'isRt11DoorDisabled("CUSTODY_REOPEN_PILOT_DISABLED")',
        gateFile: "components/applications/cockpit/DealCustodyPanel.tsx",
      },
    ],
  },
  {
    id: "CASH_SALE_PAY_FIRST",
    switches: ["CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED", "CASH_SALE_EXTRAS_PILOT_REFUSED"],
    refusalKeys: [
      "ServerError_CASH_SALE_BALANCE_UNPAID_REFUSED",
      "ServerError_CASH_SALE_TAX_FEES_WARRANTY_REFUSED",
      "ServerError_UNLINKED_RECEIPT_OPEN_SALE_INVOICE_REFUSED",
    ],
    doors: [],
  },
  {
    // Enabled for the pilot (the switch is `false`): listed so a future flip is a reviewed, visible change.
    id: "DEAL_COMMISSION_LINES",
    switches: ["DEAL_COMMISSION_LINES_PILOT_DISABLED"],
    refusalKeys: ["ServerError_DEAL_COMMISSION_LINES_DISABLED"],
    doors: [],
  },
];
