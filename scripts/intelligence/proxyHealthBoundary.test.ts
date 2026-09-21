import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("public health proxy boundary", () => {
  const source = readFileSync(path.resolve(process.cwd(), "proxy.ts"), "utf8");

  it("keeps /api/health public and outside Clerk proxy matching", () => {
    expect(source).toContain('"/api/health"');
    expect(source).toContain("api/health(?:/|$)");
    expect(source).toContain("api(?!/health(?:/|$))");
  });

  it("does not introduce a test-mode or credential bypass for protected routes", () => {
    expect(source).not.toContain("AUTOFLOW_SECURITY_PLACEHOLDER_MODE");
    expect(source).not.toContain("CI_SECURITY_BYPASS");
    expect(source).toContain("await auth.protect()");
  });
});
