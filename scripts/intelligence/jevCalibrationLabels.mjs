export const JEV_CALIBRATION_LABELS = Object.freeze({
  "pr285-add-vehicle-wizard": Object.freeze({
    control: "NEGATIVE_LOW_RISK",
    revealedAfter: "2026-09-06T06:35:05Z",
    findings: Object.freeze([]),
  }),
  "pr309-pricing-copy": Object.freeze({
    control: "NEGATIVE_LOW_RISK",
    revealedAfter: "2026-09-14T22:02:32Z",
    findings: Object.freeze([]),
  }),
  "pr319-pre-first-review": Object.freeze({
    revealedAfter: "2026-09-20T00:42:06Z",
    findings: Object.freeze([
      Object.freeze({
        id: "pr319-caller-contract-break",
        severity: "CRITICAL",
        summary: "Configured-finance quote validation broke existing web/mobile callers and fixtures.",
        acceptedInvariantIds: Object.freeze(["UI-1"]),
        acceptedRiskKeys: Object.freeze(["uiAuthority", "externalInput"]),
        acceptedRequirements: Object.freeze([
          "review:ui-backend-authority",
          "proof:BOUNDARY",
        ]),
      }),
      Object.freeze({
        id: "pr319-resumed-company-fee-guard",
        severity: "HIGH",
        summary: "A resumed draft could advance with a finance company whose execution fees were no longer configured.",
        acceptedInvariantIds: Object.freeze(["LIFE-1", "UI-1"]),
        acceptedRiskKeys: Object.freeze(["lifecycle", "uiAuthority"]),
        acceptedRequirements: Object.freeze([
          "proof:STATE_TRANSITION",
          "review:ui-backend-authority",
        ]),
      }),
      Object.freeze({
        id: "pr319-unconfigured-fee-financial-surface",
        severity: "HIGH",
        summary: "Financial/deal surfaces could consume an unconfigured execution-fee authority and render or calculate from incomplete state.",
        acceptedInvariantIds: Object.freeze(["ACC-1", "UI-1"]),
        acceptedRiskKeys: Object.freeze(["economic", "externalInput"]),
        acceptedRequirements: Object.freeze([
          "review:financial-authority",
          "proof:BOUNDARY",
        ]),
      }),
    ]),
  }),
  "pr321-pre-governance-review": Object.freeze({
    revealedAfter: "2026-09-20T22:02:53Z",
    findings: Object.freeze([
      Object.freeze({
        id: "pr321-workflow-scope-false-green",
        severity: "HIGH",
        summary: "Workflow evidence could be accepted when required markers existed in the wrong job or step.",
        acceptedInvariantIds: Object.freeze([]),
        acceptedRiskKeys: Object.freeze([]),
        acceptedRequirements: Object.freeze([
          "review:correctness-governance",
          "proof:jev-harness",
        ]),
      }),
      Object.freeze({
        id: "pr321-analyzer-presence-false-green",
        severity: "HIGH",
        summary: "Structural proof could pass from analyzer identifier presence without executing the analyzer and asserting its result.",
        acceptedInvariantIds: Object.freeze([]),
        acceptedRiskKeys: Object.freeze([]),
        acceptedRequirements: Object.freeze([
          "review:correctness-governance",
          "proof:jev-harness",
        ]),
      }),
    ]),
  }),
});

export function calibrationLabelById(id) {
  return JEV_CALIBRATION_LABELS[id];
}
