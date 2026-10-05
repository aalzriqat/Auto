import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { RolePermissionsEditor } from "./RolePermissionsEditor";

/**
 * SCRUM-413 PR-B P4: the role editor carries the financed-deal authorities as
 * an independent group (manage:supplier_settlement, cancel:closed_deal), with
 * real EN and AR labels. EditRoleDialog.test.tsx mocks this editor, so the
 * group is exercised here against the real dictionaries.
 */

let locale: "en" | "ar" = "en";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) =>
      (dictionaries[locale] as Record<string, string>)[key] ??
      (dictionaries.en as Record<string, string>)[key] ??
      key,
  }),
}));

afterEach(() => {
  cleanup();
  locale = "en";
});

function openGroup(title: string) {
  fireEvent.click(screen.getByText(title));
}

describe("RolePermissionsEditor - financed deal authorities", () => {
  test("EN: both authorities render with their labels and toggle independently of any module", () => {
    const onChange = vi.fn();
    render(<RolePermissionsEditor selectedPermissions={[]} onChange={onChange} />);
    openGroup("Financed deal authorities");

    expect(screen.getByText("Record the supplier payment route")).toBeTruthy();
    expect(screen.getByText("Cancel a closed financed deal")).toBeTruthy();

    const route = document.getElementById("deal-manage:supplier_settlement") as HTMLElement;
    const cancel = document.getElementById("deal-cancel:closed_deal") as HTMLElement;
    expect(route.getAttribute("aria-checked")).toBe("false");
    expect(cancel.getAttribute("aria-checked")).toBe("false");

    // No base view is held, and the switch is still usable.
    fireEvent.click(cancel);
    expect(onChange).toHaveBeenCalledWith(["cancel:closed_deal"]);
  });

  test("EN: a held authority shows as on and can be switched off", () => {
    const onChange = vi.fn();
    render(
      <RolePermissionsEditor
        selectedPermissions={["manage:supplier_settlement", "view:sales"]}
        onChange={onChange}
      />
    );
    openGroup("Financed deal authorities");
    const route = document.getElementById("deal-manage:supplier_settlement") as HTMLElement;
    expect(route.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(route);
    expect(onChange).toHaveBeenCalledWith(["view:sales"]);
  });

  test("AR: the group, both labels and both hints come from the Arabic dictionary", () => {
    locale = "ar";
    render(<RolePermissionsEditor selectedPermissions={[]} onChange={() => {}} />);
    openGroup("صلاحيات الصفقات الممولة");

    for (const text of [
      "تسجيل مسار الدفع للمورّد",
      "إلغاء صفقة ممولة مغلقة",
      "تحديد الجهة التي تدفع لها شركة التمويل في الصفقة الممولة.",
      "عكس صفقة ممولة تم إغلاقها بالفعل.",
    ]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
  });
});
