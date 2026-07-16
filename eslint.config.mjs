import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import convexPlugin from "@convex-dev/eslint-plugin";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  ...convexPlugin.configs.recommended,
  // apps/** and packages/** carry their own toolchains (Expo/React Native);
  // the root Next.js lint setup misfires on their patterns, same reason they
  // are excluded from the root vitest run.
  globalIgnores(["convex/_generated", "scratch", "marketing/render-cover.js", "testsprite_tests/get_token.js", "apps/**", "packages/**"]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
]);
