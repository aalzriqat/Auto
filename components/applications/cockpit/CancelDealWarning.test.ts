/**
 * SCRUM-969 / SCRUM-1034 -- what the "Cancel deal" warnings may say about a cash deal.
 * Moved out of SaleDealCockpitCancel.test.tsx (which needs the Convex and permission harness);
 * the wording needs only the dictionaries.
 */
import { describe, expect, test } from "vitest";
import { dictionaries } from "@/lib/i18n/dictionaries";

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;

describe("warning wording (SCRUM-969, SCRUM-1034)", () => {
  // A BLACKLIST, not a proof of truth: it only stops the words of effects the server's cancel does
  // not have. restoreVehicleFromSale puts a not-yet-arrived SOURCED car back to SOURCING, not stock;
  // a draft's cancel branch touches no deposit or vehicle hold; the dialog never refunds anyone.
  test.each([["en", en], ["ar", ar]] as const)("%s: neither text uses a word for an inventory, refund or reinstated-deposit effect", (_locale, dict) => {
    for (const text of [dict.CancelDealDraftWarning, dict.CancelDealCompletedWarning]) {
      expect(text).not.toMatch(/inventory|stock|refund|reinstat|المخزون|استرداد|ردّ|إرجاع|إعادة المركبة/i);
    }
    expect(dict.CancelDealDraftWarning).not.toMatch(/reverse|عكس/);
  });

  // Each clause is pinned as a whole sentence-part, so a false statement of the same topic fails it.
  // Server facts (convex/utils/saleCancellation.ts): the trade-in is touched only when the sale's
  // trade-in value is above zero (:253); a reversed deposit lands in RELEASED_AWAITING_DECISION and
  // does not go back to the customer (:484-489); a claim on the supplier is cancelled and refuses
  // after a receipt (:379-381, supplierReceivables.ts:618-619).
  test("the completed warning, in English, states each effect with the condition the server applies", () => {
    const text = en.CancelDealCompletedWarning;
    expect(text).toContain("reverses any deposit applied to it; that money is held until someone decides what happens to it, and is not returned to the customer automatically.");
    expect(text).toContain("If the sale credited a trade-in value, that trade-in vehicle has its purchase cost cleared and, if it was available for sale, moves to inspection.");
    expect(text).toContain("Supplier payables on the sale, any claim on the supplier for a consigned car settled direct to the supplier, and any warranty or GAP deferrals are cancelled.");
    expect(text).toContain("a supplier payment was already made or received,");
    expect(text).not.toContain("A trade-in vehicle taken on the sale has its purchase cost cleared");
  });

  test("the completed warning, in Arabic, states the same effects with the same conditions", () => {
    const text = ar.CancelDealCompletedWarning;
    expect(text).toContain("وعكس أي عربون طُبّق عليه؛ ويبقى هذا المبلغ معلّقًا بانتظار قرار بشأنه، ولا يُعاد إلى العميل تلقائيًا.");
    expect(text).toContain("وإذا احتُسبت قيمة استبدال في البيع، تُمسح تكلفة شراء مركبة الاستبدال، وإن كانت متاحة للبيع فإنها تنتقل إلى الفحص.");
    expect(text).toContain("وتُلغى مستحقات المورد على الصفقة، وأي مطالبة للمعرض على المورد عن مركبة برسم البيع تُسوّى مباشرة مع المورد، وأي تأجيلات خاصة بالضمان أو GAP.");
    expect(text).toContain("أو سُدِّدت دفعة للمورد أو سُجّل استلام مقابل المطالبة على المورد");
    expect(text).not.toContain("المستلمة في هذه الصفقة");
  });
  test("Arabic uses the app's own word for a reservation deposit (عربون), in both warnings", () => {
    for (const text of [ar.CancelDealDraftWarning, ar.CancelDealCompletedWarning]) {
      expect(text).toContain("عربون");
      expect(text).not.toMatch(/مبلغ مقدّم|دفعة مقدمة/);
    }
  });
});
