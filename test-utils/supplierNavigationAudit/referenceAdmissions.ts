import { fixtureReferences } from "./fixtureReferences";
import { scenarioReferences } from "./scenarioReferences";
import { schemaAndCaseTypeReferences } from "./schemaAndCaseTypeReferences";
import { runnerApiReferences } from "./runnerApiReferences";

// These literal per-name admissions are reviewed with the runner pins.
// Keep them independent of the source being measured.
export const ADMITTED_RUNNER_REFERENCES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  ...fixtureReferences,
  ...scenarioReferences,
  ...schemaAndCaseTypeReferences,
  ...runnerApiReferences,
};
