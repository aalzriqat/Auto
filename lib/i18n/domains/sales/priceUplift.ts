import { defineBilingualMessages } from "../../defineBilingualMessages";

/**
 * SCRUM-260: the minimum-profit approval outside the quote wizard — the direct
 * sale dialog and the deal cockpit. An approval covers one exact price, so each
 * message names the price rather than a profit figure.
 */
export const profitApprovalMessages = defineBilingualMessages({
  ProfitApprovalRequiredTitle: ["Below the Minimum Price Uplift", "أقل من الحد الأدنى للزيادة فوق سعر القائمة"],
  ProfitApprovalRequiredBody: [
    "At this price the uplift over the list price is {margin}; this vehicle's Minimum Price Uplift is {minimum}. A manager must approve this exact price before the sale can be completed. This check does not prevent a loss-making sale.",
    "الزيادة عند هذا السعر فوق سعر القائمة هي {margin}، والحد الأدنى للزيادة فوق سعر القائمة لهذه المركبة {minimum}. يجب أن يعتمد مدير هذا السعر بعينه قبل إتمام البيع. هذا الفحص لا يمنع بيعاً بخسارة.",
  ],
  ProfitApprovalRequestAction: ["Request approval for this price", "طلب اعتماد هذا السعر"],
  ProfitApprovalRequesting: ["Requesting…", "جارٍ الإرسال…"],
  ProfitApprovalPending: ["Waiting for a manager to approve this price.", "بانتظار اعتماد مدير لهذا السعر."],
  ProfitApprovalRejected: [
    "A manager rejected this price. Change the price or request again.",
    "رفض المدير هذا السعر. عدّل السعر أو اطلب الاعتماد من جديد.",
  ],
  ProfitApprovalApproved: ["A manager approved this price.", "اعتمد المدير هذا السعر."],
  MinimumPriceUplift: ["Minimum Price Uplift", "الحد الأدنى للزيادة فوق سعر القائمة"],
  MinimumPriceUpliftHelp: ["The price uplift is the final sale price minus the vehicle's list price. A financed sale needs a manager's approval when its price uplift is less than this amount, including when the price is below the list price. It is not a loss check: it does not stop a sale below cost, and cash quotes are not covered. A minimum of 0 turns it off.", "الزيادة فوق سعر القائمة هي سعر البيع النهائي مطروحاً منه سعر قائمة المركبة. يحتاج البيع بالتمويل إلى موافقة المدير عندما تكون هذه الزيادة أقل من هذا المبلغ، بما في ذلك حين يكون السعر أقل من سعر القائمة. هذا ليس فحصاً للخسارة: لا يمنع بيعاً بأقل من التكلفة، ولا يشمل عروض الأسعار النقدية. الحد الأدنى 0 يعطّل الفحص."],
  ApprovalSalePrice: ["Sale price", "سعر البيع"],
  ApprovalListPrice: ["List price", "سعر القائمة"],
});
