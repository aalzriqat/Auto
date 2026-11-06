import { describe, expect, it } from "vitest";
import { isOpeningProofWorkflow } from "./openingProofWorkflow";

const deal = "Deal Scenarios E2E (Playwright, GL-checked)";
const swarm = "Trusted Browser Attack Swarm";
const library = "Regression library (nightly and release)";
const trustedRunner = { GITHUB_ACTIONS: "true", CI: "true" };

describe("opening proof workflow admission (SCRUM-923)", () => {
  it.each([
    [deal, "schedule"],
    [deal, "workflow_dispatch"],
    [swarm, "workflow_run"],
    [library, "schedule"],
    [library, "workflow_dispatch"],
    [library, "repository_dispatch"],
  ])("admits %s on %s", (workflow, event) => {
    expect(isOpeningProofWorkflow({ ...trustedRunner,
      GITHUB_WORKFLOW: workflow, GITHUB_EVENT_NAME: event })).toBe(true);
  });

  it.each([
    [deal, "pull_request"], [deal, "pull_request_target"],
    [swarm, "pull_request"], [swarm, "pull_request_target"],
    [library, "pull_request"], [library, "pull_request_target"],
    [deal, "repository_dispatch"], [swarm, "schedule"], [library, "workflow_run"],
    ["Unknown workflow", "schedule"],
  ])("refuses %s on %s", (workflow, event) => {
    expect(isOpeningProofWorkflow({ ...trustedRunner,
      GITHUB_WORKFLOW: workflow, GITHUB_EVENT_NAME: event })).toBe(false);
  });

  it.each([
    { GITHUB_ACTIONS: undefined }, { GITHUB_ACTIONS: "false" },
    { CI: undefined }, { CI: "false" },
    { GITHUB_WORKFLOW: undefined }, { GITHUB_EVENT_NAME: undefined },
  ])("refuses missing or false runner identity: %j", overrides => {
    expect(isOpeningProofWorkflow({ ...trustedRunner,
      GITHUB_WORKFLOW: deal, GITHUB_EVENT_NAME: "schedule", ...overrides })).toBe(false);
  });
});
