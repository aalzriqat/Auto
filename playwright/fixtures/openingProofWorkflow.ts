type WorkflowEnvironment = Pick<NodeJS.ProcessEnv,
  "GITHUB_ACTIONS" | "CI" | "GITHUB_WORKFLOW" | "GITHUB_EVENT_NAME">;

const TRUSTED_WORKFLOWS: ReadonlyArray<{ workflow: string; events: readonly string[] }> = [
  { workflow: "Deal Scenarios E2E (Playwright, GL-checked)", events: ["schedule", "workflow_dispatch"] },
  { workflow: "Trusted Browser Attack Swarm", events: ["workflow_run"] },
];

export function isOpeningProofWorkflow(env: WorkflowEnvironment): boolean {
  return env.GITHUB_ACTIONS === "true" && env.CI === "true" &&
    TRUSTED_WORKFLOWS.some(({ workflow, events }) =>
      env.GITHUB_WORKFLOW === workflow && events.includes(env.GITHUB_EVENT_NAME ?? ""));
}
