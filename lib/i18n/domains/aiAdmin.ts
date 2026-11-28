import { defineBilingualMessages } from "../defineBilingualMessages";

/**
 * Super-admin AI drafts control (/admin/ai and the per-dealership switch on the
 * admin organization page, SCRUM-980). Every key is prefixed `AiAdmin` so none
 * can collide with the rule-based Smart Reply keys.
 */
const aiAdminMessages = defineBilingualMessages({
  // Page
  AiAdminTitle: ["AI drafts", "مسودات الذكاء الاصطناعي"],
  AiAdminDescription: [
    "Control AI-written reply drafts for every dealership. A draft changes nothing until a person accepts it.",
    "تحكّم في مسودات الردود التي يكتبها الذكاء الاصطناعي لجميع المعارض. لا يكون للمسودة أي أثر قبل أن يعتمدها أحد الموظفين.",
  ],
  AiAdminLoading: ["Loading…", "جارٍ التحميل…"],
  AiAdminCancel: ["Cancel", "إلغاء"],

  // Platform switch
  AiAdminMasterTitle: ["Platform switch", "المفتاح العام للمنصة"],
  AiAdminMasterLabel: ["AI drafts on the platform", "مسودات الذكاء الاصطناعي على مستوى المنصة"],
  AiAdminMasterHint: [
    "Turns AI drafts on or off for every dealership at once.",
    "يشغّل مسودات الذكاء الاصطناعي أو يوقفها لجميع المعارض دفعة واحدة.",
  ],
  AiAdminMasterTurnedOn: ["AI drafts are now on for the platform.", "أصبحت مسودات الذكاء الاصطناعي مفعّلة على المنصة."],
  AiAdminMasterTurnedOff: ["AI drafts are now off for the platform.", "أصبحت مسودات الذكاء الاصطناعي متوقفة على المنصة."],
  AiAdminConditionsTitle: [
    "A dealership gets AI drafts only when all three are true:",
    "لا تعمل مسودات الذكاء الاصطناعي في أي معرض إلا إذا تحققت الشروط الثلاثة معاً:",
  ],
  AiAdminConditionPlatform: ["The platform switch is on.", "المفتاح العام للمنصة مفعّل."],
  AiAdminConditionDealership: [
    "The dealership's own switch is on, on its organization page.",
    "مفتاح المعرض نفسه مفعّل من صفحة المعرض.",
  ],
  AiAdminConditionKey: ["An Anthropic API key is saved on this page.", "مفتاح Anthropic API محفوظ في هذه الصفحة."],

  // Provider key
  AiAdminKeyTitle: ["Anthropic API key", "مفتاح Anthropic API"],
  AiAdminKeyDescription: [
    "The key is stored encrypted and is never shown again. Only its last four characters are displayed.",
    "يُحفظ المفتاح مشفّراً ولا يُعرض مرة أخرى أبداً، ولا يظهر منه إلا آخر أربعة أحرف.",
  ],
  AiAdminKeyStatusSet: ["Saved", "محفوظ"],
  AiAdminKeyStatusNotSet: ["Not set", "لم يُضف بعد"],
  AiAdminKeyEndsIn: ["Ends in", "ينتهي بـ"],
  AiAdminKeySavedOn: ["Saved on", "تاريخ الحفظ"],
  AiAdminKeyInputLabel: ["Key", "المفتاح"],
  AiAdminKeyReplaceLabel: ["Replace with a new key", "استبداله بمفتاح جديد"],
  AiAdminKeyInputPlaceholder: [
    "Paste the key from the Anthropic console",
    "الصق المفتاح من لوحة تحكم Anthropic",
  ],
  AiAdminKeySave: ["Save key", "حفظ المفتاح"],
  AiAdminKeySaving: ["Saving…", "جارٍ الحفظ…"],
  AiAdminKeySaved: ["The key was saved.", "تم حفظ المفتاح."],
  AiAdminKeyRemove: ["Remove key", "إزالة المفتاح"],
  AiAdminKeyRemoving: ["Removing…", "جارٍ الإزالة…"],
  AiAdminKeyRemoved: ["The key was removed.", "تمت إزالة المفتاح."],
  AiAdminKeyRemoveTitle: ["Remove the Anthropic key?", "هل تريد إزالة مفتاح Anthropic؟"],
  AiAdminKeyRemoveBody: [
    "AI drafts stop for every dealership until a new key is saved. The removed key cannot be recovered.",
    "ستتوقف مسودات الذكاء الاصطناعي في جميع المعارض حتى يُحفظ مفتاح جديد، ولا يمكن استرجاع المفتاح بعد إزالته.",
  ],
  AiAdminEncryptionMissingTitle: ["Keys cannot be saved yet", "لا يمكن حفظ المفاتيح حالياً"],
  AiAdminEncryptionMissingBody: [
    "Encryption is not configured on the server. Ask whoever manages the deployment to configure it, then reload this page.",
    "لم يُضبط التشفير على الخادم بعد. اطلب من المسؤول عن الخادم ضبطه، ثم أعد تحميل هذه الصفحة.",
  ],
  ServerError_AI_KEY_FORMAT_INVALID: ["The API key format is not valid.", "صيغة المفتاح غير صحيحة."],
  ServerError_AI_KEY_ENCRYPTION_NOT_CONFIGURED: [
    "AI key encryption is not configured on this deployment.",
    "تشفير مفاتيح الذكاء الاصطناعي غير مضبوط على هذا الخادم.",
  ],
  ServerError_AI_KEY_SAVE_FAILED: [
    "The API key could not be saved. Please try again later.",
    "تعذّر حفظ المفتاح. حاول مرة أخرى لاحقاً.",
  ],

  // Connection test (one sentence per result code of aiAdmin.testProviderConnection)
  AiAdminTestConnection: ["Test connection", "اختبار الاتصال"],
  AiAdminTestingConnection: ["Testing…", "جارٍ الاختبار…"],
  AiAdminConnectionOk: ["Connected. The saved key works.", "تم الاتصال، والمفتاح المحفوظ يعمل."],
  AiAdminConnection_AUTH_FAILED: [
    "Anthropic rejected the saved key. Check it, or save a new one.",
    "رفضت Anthropic المفتاح المحفوظ. تحقّق منه أو احفظ مفتاحاً جديداً.",
  ],
  AiAdminConnection_MODEL_UNAVAILABLE: [
    "The key works, but the AI model is not available to this Anthropic account.",
    "المفتاح يعمل، لكن نموذج الذكاء الاصطناعي غير متاح لحساب Anthropic هذا.",
  ],
  AiAdminConnection_PROVIDER_UNREACHABLE: [
    "Anthropic could not be reached. Try again in a few minutes.",
    "تعذّر الوصول إلى Anthropic. حاول مرة أخرى بعد بضع دقائق.",
  ],
  AiAdminConnection_KEY_NOT_SET: ["No key is saved yet.", "لم يُحفظ أي مفتاح بعد."],
  AiAdminConnection_ENCRYPTION_NOT_CONFIGURED: [
    "The saved key could not be opened. Encryption on the server is missing or has changed.",
    "تعذّر فتح المفتاح المحفوظ، فإعداد التشفير على الخادم غير موجود أو تغيّر.",
  ],
  AiAdminConnection_EGRESS_SUNK: [
    "Outgoing AI connections are switched off on this deployment, so nothing was sent to Anthropic.",
    "اتصالات الذكاء الاصطناعي الخارجية متوقفة على هذا الخادم، لذا لم يُرسَل شيء إلى Anthropic.",
  ],
  AiAdminConnectionTestFailed: [
    "The connection test could not run. Please try again later.",
    "تعذّر إجراء اختبار الاتصال. حاول مرة أخرى لاحقاً.",
  ],

  ServerError_AI_DRAFT_NOT_ENABLED: [
    "AI drafts are not turned on for this dealership.",
    "المسودات الذكية غير مفعّلة لهذا المعرض.",
  ],
  ServerError_AI_DRAFT_NO_CONVERSATION: [
    "This customer has no private message conversation to reply to.",
    "لا توجد محادثة خاصة مع هذا العميل للرد عليها.",
  ],
  ServerError_AI_DRAFT_NOT_FOUND: ["This draft was not found.", "لم يتم العثور على هذه المسودة."],
  ServerError_AI_DRAFT_RATE_LIMITED: [
    "Too many draft requests. Please wait a moment and try again.",
    "عدد كبير من طلبات المسودات. يرجى الانتظار قليلاً ثم المحاولة مجدداً.",
  ],

  ServerError_AI_ASSISTANT_NOT_ENABLED: [
    "The assistant is not turned on for this dealership.",
    "المساعد غير مفعّل لهذا المعرض.",
  ],
  ServerError_AI_ASSISTANT_RATE_LIMITED: [
    "Too many assistant requests. Please wait a moment and try again.",
    "عدد كبير من طلبات المساعد. يرجى الانتظار قليلاً ثم المحاولة مجدداً.",
  ],

  // Enabled dealerships
  AiAdminOrgsTitle: ["Dealerships with AI drafts on", "المعارض المفعّلة لها مسودات الذكاء الاصطناعي"],
  AiAdminOrgsEmpty: ["No dealership has AI drafts on.", "لا يوجد معرض مفعّلة له مسودات الذكاء الاصطناعي."],
  AiAdminOrgsEmptyHint: [
    "Turn it on from a dealership's organization page.",
    "يمكن تفعيلها من صفحة المعرض.",
  ],
  AiAdminOrgsCapped: ["Showing the first {count}.", "يُعرض أول {count} معرض فقط."],

  // Per-dealership switch (admin organization page)
  AiAdminOrgSwitchLabel: ["AI drafts for this dealership", "مسودات الذكاء الاصطناعي لهذا المعرض"],
  AiAdminOrgSwitchHint: [
    "Works only while the platform switch is on and an Anthropic key is saved.",
    "لا تعمل إلا عند تفعيل المفتاح العام للمنصة ووجود مفتاح Anthropic محفوظ.",
  ],
  AiAdminOrgSwitchManage: ["Platform AI settings", "إعدادات الذكاء الاصطناعي للمنصة"],
  AiAdminOrgSwitchTurnedOn: ["AI drafts are now on for this dealership.", "أصبحت مسودات الذكاء الاصطناعي مفعّلة لهذا المعرض."],
  AiAdminOrgSwitchTurnedOff: ["AI drafts are now off for this dealership.", "أصبحت مسودات الذكاء الاصطناعي متوقفة لهذا المعرض."],
});

export const aiAdminEn = aiAdminMessages.en;
export const aiAdminAr = aiAdminMessages.ar;
