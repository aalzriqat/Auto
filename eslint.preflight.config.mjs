// SCRUM-1011: the local `pnpm preflight` sonar-lint step. NOT the CI lint gate: `pnpm lint` keeps using eslint.config.mjs.
//
// This is the main config plus a hand-picked set of eslint-plugin-sonarjs rules that map to the SonarCloud rules which have
// failed our required quality gate (the table, with the S-numbers, is scripts/preflight/sonarRules.mjs). It does not enable
// `sonarjs.configs.recommended`: that set is ~200 rules and would bury the few that matter. ESLint is not Sonar: a clean pass
// here does not prove the Sonar gate passes (README, "Preflight").
//
//   error = Sonar type BUG or VULNERABILITY (these set the reliability / security rating): a finding fails preflight.
//   warn  = Sonar type CODE_SMELL: printed and counted, never fails preflight.
//
// Typed rules (the plugin README marks them as needing type information) need type-aware parsing:
//   - TypeScript files use `projectService` (the nearest tsconfig, as typed linting is documented);
//   - plain JavaScript is in no tsconfig `include` (the root one lists *.ts/*.tsx only), so it is parsed by the typescript-eslint
//     parser against tsconfig.preflight.json, which exists only for this config.
import { defineConfig } from "eslint/config";
import sonarjs from "eslint-plugin-sonarjs";
import base from "./eslint.config.mjs";
import { SONAR_RULES } from "./scripts/preflight/sonarRules.mjs";

// typescript-eslint's parser is a transitive dependency (pnpm does not hoist it), so take the instance eslint-config-next
// already registered for TypeScript instead of adding a direct dependency.
const tsParser = base.map((c) => c.languageOptions?.parser).find((p) => p?.meta?.name === "typescript-eslint/parser");
if (!tsParser) throw new Error("eslint.preflight.config.mjs: no typescript-eslint parser found in eslint.config.mjs");

const rules = Object.fromEntries(SONAR_RULES.map((r) => [`sonarjs/${r.rule}`, [r.level, ...(r.options ?? [])]]));

export default defineConfig([
  ...base,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    plugins: { sonarjs },
    rules,
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },
  {
    // test-utils/ is excluded from the root tsconfig; convex/tsconfig.json is the project that owns it. The project service
    // only finds a test-utils file when a root-included file imports it, so helpers used only by convex tests were reported
    // as "not found by the project service". Point the parser at the owning project instead (projectService must be off).
    files: ["test-utils/**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parserOptions: { projectService: false, project: ["./convex/tsconfig.json"], tsconfigRootDir: import.meta.dirname } },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { project: ["./tsconfig.preflight.json"], tsconfigRootDir: import.meta.dirname },
    },
  },
]);
