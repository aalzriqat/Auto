/**
 * The eslint-plugin-sonarjs rules the local `sonar-lint` preflight step enforces, with the SonarCloud rule each one mirrors (SCRUM-1011).
 * Pure data, so both eslint.preflight.config.mjs and preflight.mjs read it without loading ESLint or the plugin.
 *
 * level "error": the Sonar rule's type is BUG or VULNERABILITY (reliability / security rating); a finding FAILS preflight.
 * level "warn":  CODE_SMELL; printed and counted, never fails preflight.
 * Types from the SonarJS rule metadata (rules/javascript/S<n>.json): S2871 BUG, S3403 BUG, S4036 VULNERABILITY, S5852 VULNERABILITY,
 * S8786 CODE_SMELL; the rest are code smells.
 *
 * @typedef {{ rule: string, sonar: string, level: "error" | "warn", typed: boolean, options?: unknown[] }} SonarRule
 * @type {SonarRule[]}
 */
export const SONAR_RULES = [
  { rule: "no-alphabetical-sort", sonar: "S2871", level: "error", typed: true },
  { rule: "different-types-comparison", sonar: "S3403", level: "error", typed: true },
  { rule: "no-os-command-from-path", sonar: "S4036", level: "error", typed: false },
  { rule: "slow-regex", sonar: "S5852", level: "error", typed: true },
  { rule: "cognitive-complexity", sonar: "S3776", level: "warn", typed: false, options: [15] },
  { rule: "no-nested-conditional", sonar: "S3358", level: "warn", typed: false },
  { rule: "no-nested-template-literals", sonar: "S4624", level: "warn", typed: false },
  { rule: "prefer-read-only-props", sonar: "S6759", level: "warn", typed: true },
  { rule: "no-unused-vars", sonar: "S1481", level: "warn", typed: false },
  { rule: "no-dead-store", sonar: "S1854", level: "warn", typed: false },
  { rule: "no-misleading-array-reverse", sonar: "S4043", level: "warn", typed: true },
  { rule: "prefer-regexp-exec", sonar: "S6594", level: "warn", typed: true },
  { rule: "super-linear-regex", sonar: "S8786", level: "warn", typed: false },
];

/** `sonarjs/<rule>` -> its Sonar S-number, or undefined for a rule that is not one of ours. */
export function sonarNumberOf(ruleId) {
  return SONAR_RULES.find((r) => `sonarjs/${r.rule}` === ruleId)?.sonar;
}
