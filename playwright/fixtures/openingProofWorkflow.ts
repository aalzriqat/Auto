const TRUSTED_WORKFLOWS: ReadonlyArray<{ workflow: string; events: readonly string[] }> = [
  { workflow: "Deal Scenarios E2E (Playwright, GL-checked)", events: ["schedule", "workflow_dispatch"] },
  { workflow: "Trusted Browser Attack Swarm", events: ["workflow_run"] },
  { workflow: "Regression library (nightly and release)", events: ["schedule", "workflow_dispatch", "repository_dispatch"] },
];

export function isOpeningProofWorkflow(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.GITHUB_ACTIONS === "true" && env.CI === "true" &&
    TRUSTED_WORKFLOWS.some(({ workflow, events }) =>
      env.GITHUB_WORKFLOW === workflow && events.includes(env.GITHUB_EVENT_NAME ?? ""));
}
