// Role-template sync writes immediately and removes the QA approver's extra grants (SCRUM-799).
const COMMIT_WORDS =
  /delete|remove|cancel|void|revers|refund|forfeit|post|close|approve|reject|confirm|submit|save|send|sign ?out|log ?out|archive|pay|transfer|disburse|finali[sz]e|record|import|upload|invite|sync|update|حذف|إلغاء|تأكيد|حفظ|إرسال|خروج|اعتماد|رفض|ترحيل|دفع|تسجيل|مزامنة|تحديث/i;

export function isCommitActionName(name: string): boolean {
  return COMMIT_WORDS.test(name);
}
