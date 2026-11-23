/**
 * The enabled-dealerships card against the server's own `truncated` flag
 * (PR 878 Seat 1 LOW-2). Not a visual check.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { Id } from "@/convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
}));

import { EnabledOrgsCard, type EnabledOrg } from "./EnabledOrgsCard";

afterEach(cleanup);

const orgs = (count: number): EnabledOrg[] =>
  Array.from({ length: count }, (_, index) => ({ orgId: `org${index}` as Id<"organizations">, name: `Dealer ${index}` }));

describe("EnabledOrgsCard", () => {
  test("exactly 100 dealerships with truncated=false shows no cap note", () => {
    render(<EnabledOrgsCard orgs={orgs(100)} truncated={false} />);
    expect(screen.getAllByRole("link")).toHaveLength(100);
    expect(screen.queryByText("Showing the first 100.")).toBeNull();
  });

  test("truncated=true shows the cap note with the number listed", () => {
    render(<EnabledOrgsCard orgs={orgs(100)} truncated />);
    expect(screen.getByText("Showing the first 100.")).toBeTruthy();
  });

  test("no dealerships shows the empty state", () => {
    render(<EnabledOrgsCard orgs={[]} truncated={false} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText(dictionaries.en.AiAdminOrgsEmpty)).toBeTruthy();
  });
});
