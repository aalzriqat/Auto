/** The quote wizard's input steps; the success screen after them is not one. */
export const QUOTE_WIZARD_STEP_COUNT = 3;

export type QuoteWizardStepCounter =
  | { kind: "STEP"; step: number; total: number }
  | { kind: "COMPLETE" };

/**
 * What the wizard header says about progress. The success screen is shown as
 * complete rather than as "Step 4 of 3" (SCRUM-628 F-10).
 */
export function quoteWizardStepCounter(currentStep: number): QuoteWizardStepCounter {
  if (currentStep > QUOTE_WIZARD_STEP_COUNT) return { kind: "COMPLETE" };
  return { kind: "STEP", step: currentStep, total: QUOTE_WIZARD_STEP_COUNT };
}
