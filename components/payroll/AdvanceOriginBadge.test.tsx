/**
 * SCRUM-961: an employee advance created by moving it out of an opening prepaid schedule carries
 * `prepaidReclassificationId`; the payroll advances list labels it so nobody mistakes it for cash paid out.
 */
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { AdvanceOriginBadge } from "./AdvanceOriginBadge";

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

test.each(["en", "ar"] as const)("a reclassified advance is labelled in %s", (locale) => {
  state.locale = locale;
  render(<AdvanceOriginBadge prepaidReclassificationId="reclass-1" />);
  expect(screen.getByText(dictionaries[locale].AdvanceFromPrepaidReclass)).toBeTruthy();
});

test("an ordinary advance has no label", () => {
  const view = render(<AdvanceOriginBadge prepaidReclassificationId={undefined} />);
  expect(view.container.textContent).toBe("");
});
