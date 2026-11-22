import { defineBilingualMessages } from "../../defineBilingualMessages";

const dealDeliveryMessages = defineBilingualMessages({
  RegisterHandoverAction: ["Register vehicle handover", "تسجيل تسليم المركبة"],
  HandoverNeedsPermission: [
    "Sales or a Manager registers the vehicle handover.",
    "يسجّل موظف المبيعات أو المدير تسليم المركبة.",
  ],
  ConfirmHandoverTitle: ["Register the vehicle handover", "تسجيل تسليم المركبة"],
  ConfirmHandoverDesc: [
    "The vehicle goes out to the customer. This is recorded as a fact, and it closes the deal's figures.",
    "تخرج المركبة إلى العميل. يُسجَّل ذلك كواقعة، ويُغلق أرقام الصفقة.",
  ],
  /**
   * The one-way door, stated BEFORE it closes.
   *
   * `reopenApproval` refuses once the vehicle has gone out, so from this point
   * a wrong approved amount can only be undone by cancelling the application.
   * The dialog shows the amount and the split so the verification it asks for
   * can actually be done here, rather than from memory.
   */
  HandoverSealsApprovedAmount: [
    "After the vehicle is handed over, the recorded approved amount can no longer be corrected through the normal correction flow.",
    "بعد تسليم المركبة لا يعود بالإمكان تصحيح المبلغ المعتمد المسجَّل عبر مسار التصحيح المعتاد.",
  ],
  /**
   * The anomaly the SERVER already judged, restated at the one-way door.
   *
   * Named rather than only coloured: colour is not a message on its own, and
   * an operator about to seal a figure permanently should be told in words.
   */
  /**
   * Names no particular document, because the rule does not require one.
   *
   * `isApprovalFarFromEvidence` compares the approved amount against whichever
   * of the quotation and the appraisal are actually on file, and returns true
   * from the quotation alone. The earlier wording said "the quotation and
   * appraisal on this deal", which asserts an appraisal exists — to an operator
   * standing at the one-way door, on a deal that may only have a quotation.
   */
  HandoverAmountLooksUnusual: [
    "This approved amount is unlike the other figures recorded on this deal. AutoFlow flagged it when it was recorded.",
    "هذا المبلغ المعتمد يختلف عن باقي الأرقام المسجَّلة على هذه الصفقة، وقد نبّه أوتوفلو إليه عند تسجيله.",
  ],
  HandoverVerifyBeforeContinuing: [
    "Check the approved amount and the funding split above before continuing.",
    "تحقّق من المبلغ المعتمد وتقسيم التمويل أعلاه قبل المتابعة.",
  ],
  EconomicsCurrencyUnusable: [
    "This deal's figures cannot be shown safely.",
    "لا يمكن عرض أرقام هذه الصفقة بشكل موثوق.",
  ],
  EconomicsCurrencyUnusableHint: [
    "AutoFlow cannot confirm which currency this deal's economics are recorded in, so showing the amounts could be wrong by a factor of ten. Record the deal's economics again in a supported currency to restore them.",
    "لا يستطيع أوتوفلو تأكيد العملة المسجَّلة بها اقتصاديات هذه الصفقة، وعرض المبالغ قد يكون خاطئًا بعشرة أضعاف. أعد تسجيل اقتصاديات الصفقة بعملة مدعومة لاستعادتها.",
  ],
  HandoverCurrencyUnverified: [
    "AutoFlow cannot confirm which currency this deal's figures are recorded in, so it will not show them here. Record the deal's economics again before handing the vehicle over.",
    "لا يستطيع أوتوفلو تأكيد العملة المسجَّلة بها أرقام هذه الصفقة، ولذلك لن يعرضها هنا. أعد تسجيل اقتصاديات الصفقة قبل تسليم المركبة.",
  ],
  HandoverNotesLabel: ["Notes (optional)", "ملاحظات (اختياري)"],
  HandoverNotesPlaceholder: [
    "e.g. collected by the customer's brother, ID checked",
    "مثال: استلمها شقيق العميل، وتم التحقق من الهوية",
  ],
  ConfirmHandoverAction: ["Confirm handover", "تأكيد التسليم"],
  HandoverRegistered: ["Vehicle handover registered", "تم تسجيل تسليم المركبة"],
  RegisterExpectedPaymentAction: ["Register the expected payment", "تسجيل الدفعة المتوقعة"],
  ExpectedPaymentNeedsPermission: [
    "Sales or a Manager registers the expected payment.",
    "يسجّل موظف المبيعات أو المدير الدفعة المتوقعة.",
  ],
  FinalizeDealAction: ["Close the deal", "إغلاق الصفقة"],
  FinalizeNeedsPermission: ["A Manager or Accountant closes the deal.", "يغلق المدير أو المحاسب الصفقة."],
  FinalizeWaitsForReadiness: [
    "Closing readiness could not be checked right now, so the deal can't be closed yet. Try again shortly.",
    "تعذّر فحص جاهزية الإغلاق الآن، لذا لا يمكن إغلاق الصفقة بعد. حاول مجددًا بعد قليل.",
  ],
  FinalizeNeedsReadinessAccess: [
    "Your role can close deals but cannot view finance applications, so this deal's closing readiness can't be checked for you. Ask an administrator to add finance-application view access to your role.",
    "دورك يسمح بإغلاق الصفقات لكنه لا يسمح بعرض طلبات التمويل، لذا لا يمكن فحص جاهزية إغلاق هذه الصفقة لك. اطلب من المسؤول إضافة صلاحية عرض طلبات التمويل إلى دورك.",
  ],
  FinalizeNeedsClosingReadiness: [
    "The deal is not ready to close yet. Complete the items marked in the closing readiness list, then close it.",
    "الصفقة غير جاهزة للإغلاق بعد. أكمل البنود المؤشَّر عليها في قائمة جاهزية الإغلاق، ثم أغلقها.",
  ],
  /**
   * The prerequisite, named before it becomes a refusal.
   *
   * On a consigned car with an external financier the route decides opposite
   * balance sheets — a payable to the supplier for his whole entitlement, or a
   * claim on him for the margin — so `finalizeDeal` refuses until it is on the
   * record. It says where, because the control is still in the review dialog.
   */
  FinalizeNeedsSettlementRoute: [
    "This car belongs to the supplier and the deal is financed, so who the finance company pays has to be recorded before the deal can be closed. Choose it here, on this step.",
    "هذه المركبة تعود للمورد والصفقة ممولة، لذا يجب تسجيل الجهة التي تدفع لها شركة التمويل قبل إغلاق الصفقة. اختره هنا، في هذه الخطوة.",
  ],
  /**
   * Both blockers at once, and the pointer withheld on purpose.
   *
   * Recording the route (`setSupplierSettlementRoute`) needs
   * `manage:supplier_settlement`; closing (`finalizeDeal`) needs
   * `confirm:finance_disbursement`. Shown when the caller lacks the ROUTE
   * permission — the review dialog hides the selector from them, so sending
   * them there would be sending them to an empty screen.
   */
  FinalizeNeedsRouteAndPermission: [
    "This deal is waiting on who the finance company pays, and you do not have permission to record it. Someone who does chooses it here; an accountant then closes the deal.",
    "هذه الصفقة بانتظار تحديد الجهة التي تدفع لها شركة التمويل، ولا تملك صلاحية تسجيلها. يختارها هنا من يملك الصلاحية، ثم يُغلق المحاسب الصفقة.",
  ],
  ConfirmFinalizeTitle: ["Close the deal", "إغلاق الصفقة"],
  ConfirmFinalizeDesc: [
    "The handover and the expected payment are on file, so the deal can be closed.",
    "التسليم والدفعة المتوقعة مسجَّلان، ويمكن إغلاق الصفقة.",
  ],
  /**
   * What closing actually does, said before it is done.
   *
   * `finalizeDeal` is not a status change: it creates the sale, posts its
   * journals and moves the vehicle. There is no unwind — reversing it means
   * cancelling the sale — so the word "close" is not left to carry that alone.
   */
  FinalizeCreatesTheSale: [
    "Closing records the sale and posts it to the books. It cannot be undone; correcting it afterwards means cancelling the sale.",
    "الإغلاق يسجّل البيع ويقيّده في الدفاتر، ولا يمكن التراجع عنه؛ وتصحيحه بعد ذلك يعني إلغاء البيع.",
  ],
  /**
   * Deliberately NOT the same words as `FinalizeDealAction`.
   *
   * The opener and the confirmation would otherwise carry the same accessible
   * name, which makes "close the deal" ambiguous to anything selecting by role
   * and name — a screen reader announcing the dialog, and the E2E driving it.
   */
  ConfirmFinalizeAction: ["Confirm closing", "تأكيد الإغلاق"],
});

export const dealDeliveryEn = dealDeliveryMessages.en;

export const dealDeliveryAr = dealDeliveryMessages.ar;
