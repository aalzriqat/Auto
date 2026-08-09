/**
 * `import.meta.glob` is Vite's, and vitest runs on Vite — but the app is built
 * by Next, whose tsconfig knows nothing about it.
 *
 * It went unnoticed until a component test needed it: `convex/` and
 * `test-utils/` are excluded from the tsconfig program, so every Convex test
 * that calls it was outside type-checking. A `.test.tsx` under `components/`
 * is not, and it drags `test-utils/convexTest.ts` in with it.
 *
 * Declared here rather than by adding `vite/client` to `compilerOptions.types`,
 * which would also pull in Vite's asset and env module declarations and change
 * how imports resolve for the whole app.
 */
interface ImportMeta {
  readonly glob: (
    pattern: string,
    options?: Record<string, unknown>
  ) => Record<string, () => Promise<unknown>>;
}
