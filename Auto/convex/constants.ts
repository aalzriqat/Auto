export const LEAD_STAGES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "TEST_DRIVE",
  "NEGOTIATION",
  "RESERVED",
  "WON",
  "LOST",
] as const;

export type LeadStage = typeof LEAD_STAGES[number];
