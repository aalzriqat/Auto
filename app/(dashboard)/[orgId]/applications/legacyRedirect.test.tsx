import { describe, expect, test, vi } from "vitest";

/**
 * Review-removal navigation regression (SCRUM-215): every link and
 * notification that still lands on the legacy list keeps working — it
 * forwards to the Deals list for the same org, and the deal deep link under
 * this segment is a separate route left untouched.
 */
const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

import ApplicationsPage from "./page";

describe("/{orgId}/applications forwards to /{orgId}/deals", () => {
  test("the org segment is preserved", async () => {
    await ApplicationsPage({ params: Promise.resolve({ orgId: "org_42" }) });
    expect(redirect).toHaveBeenCalledWith("/org_42/deals");
  });
});
