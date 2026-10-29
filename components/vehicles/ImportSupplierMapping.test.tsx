/**
 * SCRUM-868 P2: the import dialog asks the dealer to map every supplier name in the file to a supplier in
 * the master. This pins what that section shows and what it reports; the picker itself is covered by
 * SupplierSelect.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const world = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      t: (key: string) => (dictionaries[world.locale] as Record<string, string>)[key] ?? key,
      language: world.locale,
      isRtl: world.locale === "ar",
    }),
  };
});
vi.mock("@/components/suppliers/SupplierSelect", () => ({
  SupplierSelect: ({
    dataTestId,
    valueLabel,
    invalid,
    onChange,
  }: {
    dataTestId?: string;
    valueLabel?: string;
    invalid?: boolean;
    onChange: (s: { id: string; displayName: string }) => void;
  }) => (
    <button type="button" data-testid={dataTestId} data-invalid={String(!!invalid)} onClick={() => onChange({ id: "sup_gulf", displayName: "Gulf Motors" })}>
      {valueLabel ?? "unset"}
    </button>
  ),
}));

import { ImportSupplierMapping } from "./ImportSupplierMapping";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { ImportSupplierNeed } from "@/lib/vehicles/importSupplierMapping";

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;

const needs: ImportSupplierNeed[] = [
  { key: "SOURCED:Gulf Motors", role: "SOURCED", name: "Gulf Motors", rowCount: 3 },
  { key: "CREDITOR:Credit Co", role: "CREDITOR", name: "Credit Co", rowCount: 1 },
];

beforeEach(() => {
  world.locale = "en";
});
afterEach(cleanup);

const render_ = (mapped = {}, onMap = vi.fn()) => {
  render(<ImportSupplierMapping orgId={"org_1" as never} needs={needs} mapped={mapped} onMap={onMap} />);
  return onMap;
};

describe("ImportSupplierMapping", () => {
  test("renders nothing when the file names no supplier", () => {
    const { container } = render(<ImportSupplierMapping orgId={"org_1" as never} needs={[]} mapped={{}} onMap={() => undefined} />);
    expect(container.innerHTML).toBe("");
  });

  test("one row per distinct name, with its role and row count, and the count still to map", () => {
    render_();
    expect(screen.getByText(en.ImportSupplierRoleSourced, { exact: false })).toBeTruthy();
    expect(screen.getByText(en.ImportSupplierRoleCreditor, { exact: false })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("2");
    expect(screen.getByTestId("import-supplier-SOURCED:Gulf Motors").getAttribute("data-invalid")).toBe("true");
  });

  test("choosing a supplier reports the entry key with the picked supplier", () => {
    const onMap = render_();
    fireEvent.click(screen.getByTestId("import-supplier-CREDITOR:Credit Co"));
    expect(onMap).toHaveBeenCalledWith("CREDITOR:Credit Co", { id: "sup_gulf", displayName: "Gulf Motors" });
  });

  test("once every name is mapped the blocking notice is gone and the rows show the chosen names", () => {
    render_({
      "SOURCED:Gulf Motors": { id: "sup_gulf", displayName: "Gulf Motors" },
      "CREDITOR:Credit Co": { id: "sup_credit", displayName: "Credit Supplier Co" },
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("import-supplier-CREDITOR:Credit Co").textContent).toBe("Credit Supplier Co");
  });

  test("the heading, hint and notice are Arabic in Arabic, and a name is isolated with bdi", () => {
    world.locale = "ar";
    render_();
    expect(screen.getByText(ar.ImportSupplierMappingHeading)).toBeTruthy();
    expect(screen.getByText(ar.ImportSupplierMappingHint)).toBeTruthy();
    expect(screen.getByText("Gulf Motors", { selector: "bdi" })).toBeTruthy();
  });
});
