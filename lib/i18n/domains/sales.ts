import { refundApprovalQueueMessages, customerMoneyMountMessages } from "./sales/dealCustomerMoney";
import { dealCommissionMessages } from "./sales/dealCommissions";
import { quoteWizardQaMessages, quotationUnavailableMessages } from "./sales/quotationWizard";
import { settlementErrorMessages } from "./sales/settlementErrors";
import { dealUnwindMessages } from "./sales/dealUnwind";
import { dealStageMessages, dealDepositMessages } from "./sales/dealStages";
import { dealNavigationMessages } from "./sales/dealNavigation";
import { handoverCostStatusMessages, handoverCostMessages } from "./sales/handoverCosts";
import { dealShortfallMessages } from "./sales/dealShortfall";
import { dealStepMessages } from "./sales/dealSteps";
import { profitApprovalMessages } from "./sales/priceUplift";
import { dealSummaryMessages } from "./sales/dealSummary";
import { closingReadinessMessages } from "./sales/closingReadiness";
import { dealCustodyMessages } from "./sales/dealCustody";
import { dealWizardMessages } from "./sales/dealWizard";
import { salesRecordsEn, salesRecordsAr } from "./sales/salesRecords";
import { salesOperationsEn, salesOperationsAr } from "./sales/salesOperations";
import { financeApplicationsEn, financeApplicationsAr } from "./sales/financeApplications";
import { salesQuotationsEn, salesQuotationsAr } from "./sales/salesQuotations";
import { dealCockpitEn, dealCockpitAr } from "./sales/dealCockpit";
import { lenderDecisionEn, lenderDecisionAr, lenderEvidenceEn, lenderEvidenceAr } from "./sales/lenderDecision";
import { dealDeliveryEn, dealDeliveryAr } from "./sales/dealDelivery";

// Keep each locale's spread order to preserve dictionary precedence.
export const salesEn = {
  ...refundApprovalQueueMessages.en,
  ...dealCommissionMessages.en,
  ...customerMoneyMountMessages.en,
  ...quoteWizardQaMessages.en,
  ...quotationUnavailableMessages.en,
  ...settlementErrorMessages.en,
  ...dealUnwindMessages.en,
  ...dealStageMessages.en,
  ...dealNavigationMessages.en,
  ...handoverCostStatusMessages.en,
  ...dealShortfallMessages.en,
  ...handoverCostMessages.en,
  ...dealDepositMessages.en,
  ...dealStepMessages.en,
  ...profitApprovalMessages.en,
  ...dealSummaryMessages.en,
  ...closingReadinessMessages.en,
  ...dealCustodyMessages.en,
  ...dealWizardMessages.en,
  ...salesRecordsEn,
  ...salesOperationsEn,
  ...financeApplicationsEn,
  ...salesQuotationsEn,
  ...dealCockpitEn,
  ...lenderDecisionEn,
  ...dealDeliveryEn,
  ...lenderEvidenceEn,
};

export const salesAr = {
  ...refundApprovalQueueMessages.ar,
  ...dealCommissionMessages.ar,
  ...customerMoneyMountMessages.ar,
  ...quoteWizardQaMessages.ar,
  ...quotationUnavailableMessages.ar,
  ...settlementErrorMessages.ar,
  ...dealUnwindMessages.ar,
  ...dealStageMessages.ar,
  ...dealNavigationMessages.ar,
  ...handoverCostStatusMessages.ar,
  ...dealShortfallMessages.ar,
  ...handoverCostMessages.ar,
  ...dealDepositMessages.ar,
  ...dealStepMessages.ar,
  ...profitApprovalMessages.ar,
  ...dealSummaryMessages.ar,
  ...closingReadinessMessages.ar,
  ...dealCustodyMessages.ar,
  ...dealWizardMessages.ar,
  ...salesRecordsAr,
  ...salesOperationsAr,
  ...financeApplicationsAr,
  ...salesQuotationsAr,
  ...dealCockpitAr,
  ...lenderDecisionAr,
  ...dealDeliveryAr,
  ...lenderEvidenceAr,
};
