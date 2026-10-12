import { defineBilingualMessages } from "../defineBilingualMessages";

/**
 * Super-admin Support Inbox (/admin/support, SCRUM-825). Every key is prefixed
 * `SupportInbox` so none can collide with the unrelated Social Inbox keys.
 */
const supportInboxMessages = defineBilingualMessages({
  // Chrome
  SupportInboxTitle: ["Support Inbox", "صندوق الدعم"],
  SupportInboxFilterPlaceholder: ["Filter loaded conversations", "تصفية المحادثات المحمّلة"],
  SupportInboxMailboxes: ["Mailboxes", "صناديق البريد"],
  SupportInboxMailboxSupport: ["Support", "الدعم"],
  SupportInboxMailboxInfo: ["Info", "المعلومات"],
  SupportInboxMailboxBilling: ["Billing", "الفوترة"],

  // List
  SupportInboxListLabel: ["Conversations", "المحادثات"],
  SupportInboxCategories: ["Conversation type", "نوع المحادثة"],
  SupportInboxCatPeople: ["Customers", "العملاء"],
  SupportInboxCatAutomated: ["Automated", "رسائل آلية"],
  SupportInboxStatusFilter: ["Status", "الحالة"],
  SupportInboxStatusOpen: ["Open", "مفتوحة"],
  SupportInboxStatusClosed: ["Closed", "مغلقة"],
  SupportInboxStatusAll: ["All", "الكل"],
  SupportInboxFlagNeedsReply: ["Needs reply", "بانتظار الرد"],
  SupportInboxFlagClosed: ["Closed", "مغلقة"],
  SupportInboxLoadMore: ["Load older conversations", "تحميل محادثات أقدم"],
  SupportInboxLoading: ["Loading…", "جارٍ التحميل…"],
  SupportInboxEmpty: ["No conversations here.", "لا توجد محادثات هنا."],
  SupportInboxEmptyFiltered: [
    "No loaded conversations match. Older ones may need “Load older conversations”.",
    "لا توجد محادثات محمّلة مطابقة. قد تحتاج المحادثات الأقدم إلى «تحميل محادثات أقدم».",
  ],

  // Reading pane
  SupportInboxSelectPrompt: ["Select a conversation to read it", "اختر محادثة لقراءتها"],
  SupportInboxBack: ["Back", "رجوع"],
  SupportInboxCloseConversation: ["Close conversation", "إغلاق المحادثة"],
  SupportInboxReopen: ["Reopen", "إعادة فتح"],
  SupportInboxMarkAutomated: ["Mark automated", "تعليم كآلية"],
  SupportInboxNotAutomated: ["Not automated", "ليست آلية"],
  SupportInboxPosition: ["{current} of {total}", "{current} من {total}"],
  SupportInboxPrevious: ["Previous conversation", "المحادثة السابقة"],
  SupportInboxNext: ["Next conversation", "المحادثة التالية"],
  SupportInboxMessageCountOne: ["1 message", "رسالة واحدة"],
  SupportInboxMessageCount: ["{count} messages", "{count} رسائل"],

  // Messages
  SupportInboxAutoAck: ["Automated acknowledgement", "إشعار استلام تلقائي"],
  SupportInboxYou: ["You", "أنت"],
  SupportInboxTo: ["to", "إلى"],
  SupportInboxExpandMessage: ["Show message", "عرض الرسالة"],
  SupportInboxNoContent: ["(No content)", "(لا يوجد محتوى)"],
  SupportInboxEmailContent: ["Email content", "محتوى البريد"],
  SupportInboxImagesHidden: [
    "Remote images are blocked to protect privacy.",
    "تم حظر الصور الخارجية لحماية الخصوصية.",
  ],
  SupportInboxUnsafeEmail: [
    "This message could not be displayed safely. Use Plain text.",
    "تعذّر عرض هذه الرسالة بأمان. استخدم النص العادي.",
  ],
  SupportInboxViewPlain: ["Plain text", "نص عادي"],
  SupportInboxViewFormatted: ["Formatted", "منسّق"],

  // Composer
  SupportInboxReply: ["Reply", "رد"],
  SupportInboxComposerFrom: ["From", "من"],
  SupportInboxComposerTo: ["To", "إلى"],
  SupportInboxComposerSubject: ["Subject", "الموضوع"],
  SupportInboxComposerPlaceholder: ["Write your reply…", "اكتب ردّك…"],
  SupportInboxSend: ["Send", "إرسال"],
  SupportInboxSending: ["Sending…", "جارٍ الإرسال…"],
  SupportInboxSendAndClose: ["Send & close", "إرسال وإغلاق"],
  SupportInboxDiscard: ["Discard", "تجاهل"],
  SupportInboxSendHint: ["Ctrl/⌘+Enter to send", "Ctrl/⌘+Enter للإرسال"],
  SupportInboxNoReplyNotice: [
    "This sender is a no-reply address. Replies would bounce, so replying is turned off.",
    "هذا المرسل عنوان لا يستقبل الردود (no-reply). الرد سيرتد، لذلك تم تعطيله.",
  ],

  // Keyboard hints
  SupportInboxKeyNavigate: ["Next / previous", "التالي / السابق"],
  SupportInboxKeyReply: ["Reply", "رد"],
  SupportInboxKeyClose: ["Close or reopen", "إغلاق أو إعادة فتح"],
  SupportInboxKeyFilter: ["Filter", "تصفية"],

  // Toasts
  SupportInboxReplySent: ["Reply sent.", "تم إرسال الرد."],
  SupportInboxReplySentClosed: ["Reply sent and conversation closed.", "تم إرسال الرد وإغلاق المحادثة."],
  SupportInboxReplySentNewerInbound: [
    "Reply sent. A new message arrived, so the conversation was kept open.",
    "تم إرسال الرد. وصلت رسالة جديدة، لذلك بقيت المحادثة مفتوحة.",
  ],
  SupportInboxReplyFailed: ["Could not send the reply. Please try again.", "تعذّر إرسال الرد. حاول مرة أخرى."],
  SupportInboxStatusFailed: ["Could not update the conversation.", "تعذّر تحديث المحادثة."],
  SupportInboxCategoryFailed: ["Could not update the category.", "تعذّر تحديث التصنيف."],
});

export const supportInboxEn = supportInboxMessages.en;
export const supportInboxAr = supportInboxMessages.ar;
