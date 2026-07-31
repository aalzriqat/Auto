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
  globalIgnores(["convex/_generated", "scratch", "marketing/render-cover.js", "apps/**", "packages/**"]),
  // Every Convex mutation must be built from convex/functions.ts, whose ctx.db
  // fires the aggregate triggers. A mutation built from the raw generated
  // builder writes the row fine and silently skips the B-tree, so the counts
  // drift with nothing failing at the time of the bad write. A regex guard over
  // the source missed aliased imports (`mutation as define`), namespace imports
  // and single-quoted specifiers; the linter understands all three.
  {
    files: ["convex/**/*.ts"],
    ignores: ["convex/functions.ts", "convex/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // Patterns, not exact paths: "./_generated/server.js" resolves and
          // typechecks just as well as the extensionless form, and an exact
          // path match stays silent on it.
          patterns: [
            {
              group: ["**/_generated/server", "**/_generated/server.js"],
              importNames: ["mutation", "internalMutation"],
              message:
                "Import mutation/internalMutation from convex/functions.ts so aggregate triggers fire. See convex/aggregates.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      // `const { orgId: _, ...rest } = args` is how TypeScript expresses "every
      // field except this one". The discarded binding is required by the
      // language to say that — there is no way to write the omission without
      // naming what is omitted — so flagging it reports a false positive rather
      // than a defect. `ignoreRestSiblings` is the base ESLint rule's own
      // default; the TypeScript preset turns it off. Narrow by construction: it
      // exempts only bindings that sit alongside a rest property.
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
]);
