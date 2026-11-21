export const SCENARIO_RULING_ID = /^SCRUM-\d+#(?:c\d+|description)$/u;

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** @typedef {Pick<import("./scenarioRecord.ts").ScenarioRecord, "id" | "status">} ScenarioState */

/**
 * An active scenario can leave execution only via retirement. The caller
 * validates the retirement reason and ruling snapshot for its trust boundary.
 * @param {ReadonlyArray<ScenarioState>} base
 * @param {ReadonlyArray<ScenarioState>} head
 * @returns {import("./scenarioRecord.ts").LibraryProblem[]}
 */
export function validateTransitions(base, head) {
  const problems = [];
  const headById = new Map(head.filter(isObject).map(record => [record.id, record]));
  for (const before of base) {
    if (!isObject(before) || before.status !== "active") continue;
    const after = headById.get(before.id);
    if (after === undefined) {
      problems.push({ scenario: before.id, rule: "transition", message: "an active scenario was deleted; retire it with a reason and a ruling instead" });
    } else if (after.status !== "active" && after.status !== "retired") {
      problems.push({ scenario: before.id, rule: "transition", message: "an active scenario was demoted to candidate; only retirement (reason + ruling) may remove it from execution" });
    }
  }
  return problems;
}

/** @param {Pick<import("./scenarioRecord.ts").ScenarioRecord, "retiredReason" | "retiredByRuling">} record
 * @param {ReadonlyMap<string, unknown>} rulingById
 */
export function retirementProblems(record, rulingById) {
  const errors = [];
  if (typeof record.retiredReason !== "string" || !record.retiredReason.trim()) {
    errors.push("a retired scenario needs retiredReason (R4: never left red and ignored)");
  }
  const ruling = record.retiredByRuling;
  if (typeof ruling !== "string" || !SCENARIO_RULING_ID.test(ruling)) {
    errors.push("a retired scenario needs retiredByRuling");
  } else if (!rulingById.has(ruling)) {
    errors.push(`retiredByRuling ${ruling} is not in regression/rulings.json`);
  }
  return errors;
}
