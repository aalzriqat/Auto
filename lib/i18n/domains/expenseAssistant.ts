import { defineBilingualMessages } from "../defineBilingualMessages";

/**
 * The expense assistant (SCRUM-1039): staff describe an expense in one sentence
 * and the normal expense form opens pre-filled for them to check and save. Every
 * key is prefixed `ExpenseAssistant`. The two refusals the request door can send
 * (`ServerError_AI_ASSISTANT_*`) live with the other AI texts in `aiAdmin.ts`.
 * Arabic follows the expense screens' own terms (مصروف، الفئة، طريقة الدفع، حفظ).
 */
const expenseAssistantMessages = defineBilingualMessages({
  // Entry (top bar on desktop, menu drawer on phones) and panel
  ExpenseAssistantOpen: ["Expense assistant", "مساعد المصروفات"],
  ExpenseAssistantTitle: ["Expense assistant", "مساعد المصروفات"],
  ExpenseAssistantExplain: [
    "Describe the expense in one sentence. The expense form opens filled in, and you check it before anything is saved.",
    "اكتب المصروف بجملة واحدة، وسيُفتح نموذج المصروف معبّأً لتراجعه قبل أن يُحفظ أي شيء.",
  ],
  ExpenseAssistantMessageLabel: ["The expense, in your words", "المصروف بكلماتك"],
  ExpenseAssistantPlaceholder: [
    "e.g. Paid 35 JOD for fuel yesterday, cash",
    "مثال: دفعت 35 دينار بنزين أمس نقداً",
  ],
  ExpenseAssistantSubmit: ["Fill the form", "عبّئ النموذج"],
  ExpenseAssistantWorking: ["Reading your message…", "جارٍ قراءة رسالتك…"],

  // Outcomes that keep the typed text for editing and retrying
  ExpenseAssistantNotExpense: [
    "This does not read like an expense. Say what was paid, how much and when.",
    "هذه الرسالة لا تبدو مصروفاً. اذكر ما الذي دُفع وكم المبلغ ومتى.",
  ],
  ExpenseAssistantNotUnderstood: [
    "The assistant could not get the amount, category and date from this. Add the missing details and try again.",
    "لم يتمكن المساعد من استخراج المبلغ والفئة والتاريخ من هذه الرسالة. أضف التفاصيل الناقصة وحاول مرة أخرى.",
  ],
  ExpenseAssistantFailed: [
    "The assistant could not finish this time. Try again, or record the expense yourself.",
    "تعذّر على المساعد إكمال الطلب هذه المرة. حاول مرة أخرى أو سجّل المصروف بنفسك.",
  ],
  ExpenseAssistantRequestFailed: [
    "The message could not be sent. Try again.",
    "تعذّر إرسال الرسالة. حاول مرة أخرى.",
  ],
  ExpenseAssistantTooLong: [
    "Keep the description to 1,000 characters or fewer.",
    "يجب ألا يزيد الوصف على 1000 حرف.",
  ],

  // Notice at the top of the expense form opened from the assistant
  ExpenseAssistantNoticeTitle: [
    "Filled by the assistant — check every field before saving.",
    "عبّأ المساعد هذا النموذج — راجع كل حقل قبل الحفظ.",
  ],
  ExpenseAssistantNoticeCategory: [
    "The suggested category is not one this form offers, so Category was left at its default.",
    "الفئة المقترحة غير موجودة في هذا النموذج، لذلك بقيت الفئة على قيمتها الافتراضية.",
  ],
  ExpenseAssistantNoticePaymentMethod: [
    "The suggested payment method is not one this form offers, so Payment Method was left at its default.",
    "طريقة الدفع المقترحة غير موجودة في هذا النموذج، لذلك بقيت طريقة الدفع على قيمتها الافتراضية.",
  ],
});

export const expenseAssistantEn = expenseAssistantMessages.en;
export const expenseAssistantAr = expenseAssistantMessages.ar;
