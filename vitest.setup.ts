import { afterEach } from "vitest";

// vitest.config.ts does not enable `globals`, so @testing-library/react cannot
// register its automatic afterEach(cleanup) itself. Without it every render()
// stays mounted in document.body for the rest of the file, and a later test's
// screen queries can match an earlier test's leftover DOM (order-dependent
// failures that only show under --sequence.shuffle).
//
// Register it here once for every suite. The default environment is jsdom, so
// every file that renders (including the convex test files, which also load
// the library) gets the cleanup. Two guards keep the node-environment files
// (`// @vitest-environment node`) unaffected: it only acts when a DOM exists
// (they have no `document`), and the library is imported lazily so they never
// load react-dom.
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
