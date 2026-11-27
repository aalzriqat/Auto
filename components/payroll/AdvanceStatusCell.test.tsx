/**
 * SCRUM-961: the status cell of the payroll advances list keeps the existing status badge and adds the
 * "from opening prepaid" badge for an advance moved out of an opening prepaid schedule.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { AdvanceStatusCell } from "./AdvanceStatusCell";

const state = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      locale: state.locale,
      t: (key: string) => (dictionaries as unknown as Record<string, Record<string, string>>)[state.locale][key] ?? key,
    }),
  };
});

beforeEach(() => {
  state.locale = "en";
});

const renderCell = (advance: { status: string; prepaidReclassificationId?: string | null }) =>
  render(<table><tbody><tr><AdvanceStatusCell advance={advance} /></tr></tbody></table>);

test.each(["en", "ar"] as const)("a reclassified outstanding advance shows its status and origin in %s", (locale) => {
  state.locale = locale;
  renderCell({ status: "OUTSTANDING", prepaidReclassificationId: "reclass-1" });
  const cell = screen.getByRole("cell");
  expect(cell.textContent).toContain(dictionaries[locale].AdvanceStatus_OUTSTANDING);
  expect(cell.textContent).toContain(dictionaries[locale].AdvanceFromPrepaidReclass);
});

test("an ordinary advance shows only its status, with the existing colours", () => {
  renderCell({ status: "OUTSTANDING" });
  const status = screen.getByText(dictionaries.en.AdvanceStatus_OUTSTANDING);
  expect(status.className).toContain("text-orange-600");
  expect(screen.queryByText(dictionaries.en.AdvanceFromPrepaidReclass)).toBeNull();
});

test("a settled advance keeps the green status badge", () => {
  renderCell({ status: "RECOVERED" });
  expect(screen.getByText(dictionaries.en.AdvanceStatus_RECOVERED).className).toContain("text-green-600");
});
