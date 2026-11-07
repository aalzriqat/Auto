import { describe, expect, test } from "vitest";
import { renderNotification } from "./render";

describe("SCRUM-929 supplier alert direction", () => {
  test("all obligation families have directional EN and AR due and overdue copy", () => {
    for (const kind of ["PAYABLE", "RECEIVABLE", "RECOVERY"]) {
    for (const overdue of [false, true]) {
      const type = overdue ? "accounting.supplierObligationOverdue" : "accounting.supplierObligationDue";
      const data = { kind, supplier: "Bloom", amount: "200.000", currency: "JOD", dueDate: "2026-11-07", daysOverdue: 7 };
      const en = renderNotification("en", type, data).message;
      const ar = renderNotification("ar", type, data).message;
      expect(en).toBe(`${kind === "PAYABLE" ? "You owe supplier Bloom" : "Supplier Bloom owes you"} 200.000 JOD, ${overdue ? "due 2026-11-07 and 7 days overdue" : "due 2026-11-07"}.`);
      expect(ar).toBe(`${kind === "PAYABLE" ? "عليك للمورّد Bloom" : "المورّد Bloom مدين لك بـ"} 200.000 JOD، ${overdue ? "استحق بتاريخ 2026-11-07 ومتأخر 7 أيام" : "يستحق بتاريخ 2026-11-07"}.`);
      for (const locale of ["en", "ar"] as const) {
        const withheld = renderNotification(locale, type, { kind, currency: "JOD", dueDate: "2026-11-07", daysOverdue: 7 }).message;
        expect(withheld).not.toMatch(/Bloom|200|\{|undefined/);
        expect(withheld).toContain(locale === "en" ? (kind === "PAYABLE" ? "You owe a supplier" : "A supplier owes you") : (kind === "PAYABLE" ? "عليك لمورّد" : "مورّد مدين لك"));
      }
    }
    }
  });
  test("cost reader with unresolved supplier gets localized generic identity", () => {
    const data = { kind: "RECOVERY", amount: "200.000", currency: "JOD", dueDate: "2026-11-07" };
    expect(renderNotification("en", "accounting.supplierObligationDue", data).message).toBe("A supplier owes you 200.000 JOD, due 2026-11-07.");
    expect(renderNotification("ar", "accounting.supplierObligationDue", data).message).toBe("مورّد مدين لك بـ 200.000 JOD، يستحق بتاريخ 2026-11-07.");
  });
});
