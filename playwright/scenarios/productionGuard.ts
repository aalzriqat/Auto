// The explorers' refusal to run against production, kept free of Playwright
// imports so a plain unit test can pin it.

// `clever-mockingbird-719` is the live production deployment. `kindly-hound-172`
// is the earlier one and stays refused.
export const PRODUCTION_DEPLOYMENTS: readonly string[] = ["clever-mockingbird-719", "kindly-hound-172"];

/** True when the configured Convex URL names a production deployment. */
export function namesProduction(convexUrl: string | undefined): boolean {
  return PRODUCTION_DEPLOYMENTS.some((name) => (convexUrl ?? "").includes(name));
}

/** True when any served deployment is production or is not the expected preview. */
export function servesOtherThan(served: readonly string[], expected: string): boolean {
  return served.some((d) => PRODUCTION_DEPLOYMENTS.includes(d) || d !== expected);
}
