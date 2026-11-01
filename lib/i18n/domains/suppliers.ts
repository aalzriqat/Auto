import { defineBilingualMessages } from "../defineBilingualMessages";

/**
 * Suppliers management screen (/suppliers, SCRUM-887). Screen keys are prefixed `Suppliers`; the
 * inline picker keeps its own `SupplierPicker*` keys in the vehicles domain.
 *
 * The `ServerError_*` entries below translate the refusal codes of convex/suppliers.ts that had no
 * entry (the other supplier codes live in common.ts). They sit here, not in common.ts, so this
 * slice does not touch a file the supplier-identity PR also edits.
 */
const suppliersMessages = defineBilingualMessages({
  // Navigation and page chrome
  Suppliers: ["Suppliers", "الموردون"],
  SuppliersSubtitle: [
    "The supplier master. Vehicles and supplier payables point to a supplier here, so a name is corrected once.",
    "سجل الموردين. تشير المركبات ومستحقات الموردين إلى مورّد من هذه القائمة، فيُصحَّح الاسم مرة واحدة.",
  ],
  SuppliersReadOnlyNote: [
    "You can view suppliers but not change them. Changes need the manage finance permission.",
    "يمكنك عرض الموردين دون تعديلهم. التعديل يتطلب صلاحية إدارة الشؤون المالية.",
  ],
  SuppliersGenericError: [
    "Something went wrong. Nothing was changed. Please try again.",
    "حدث خطأ ما. لم يتم تغيير أي شيء. يرجى المحاولة مرة أخرى.",
  ],
  SuppliersLoadError: [
    "Suppliers could not be loaded. Reload the page and try again.",
    "تعذّر تحميل الموردين. أعد تحميل الصفحة وحاول مرة أخرى.",
  ],
  SuppliersReload: ["Reload", "إعادة التحميل"],
  SuppliersLoading: ["Loading suppliers…", "جارٍ تحميل الموردين…"],

  // List
  SuppliersAdd: ["Add supplier", "إضافة مورّد"],
  SuppliersSearchLabel: ["Search suppliers", "البحث عن الموردين"],
  SuppliersSearchPlaceholder: ["Search by name, alias or tax id", "ابحث بالاسم أو الاسم المستعار أو الرقم الضريبي"],
  SuppliersSearchHint: [
    "An alias is found by its full text. Showing at most 25 matches.",
    "يُعثر على الاسم المستعار بنصه الكامل. تُعرض 25 نتيجة كحد أقصى.",
  ],
  SuppliersFilterLabel: ["Status", "الحالة"],
  SuppliersFilterActive: ["Active", "نشط"],
  SuppliersFilterInactive: ["Inactive", "غير نشط"],
  SuppliersFilterAll: ["All", "الكل"],
  SuppliersColName: ["Supplier", "المورّد"],
  SuppliersColLegalName: ["Legal name", "الاسم القانوني"],
  SuppliersColTaxId: ["Tax id", "الرقم الضريبي"],
  SuppliersColStatus: ["Status", "الحالة"],
  SuppliersStatusActive: ["Active", "نشط"],
  SuppliersStatusInactive: ["Inactive", "غير نشط"],
  SuppliersSharedIdentity: ["Shares a legal identity", "يشترك في هوية قانونية"],
  SuppliersEmptyTitle: ["No suppliers yet", "لا يوجد موردون بعد"],
  SuppliersEmptyBody: [
    "Add the first supplier. You can do it here without creating a vehicle.",
    "أضف أول مورّد. يمكنك ذلك من هنا دون إنشاء مركبة.",
  ],
  SuppliersEmptyBodyReadOnly: [
    "No suppliers have been added yet. A finance manager can add them.",
    "لم تتم إضافة أي مورّد بعد. يمكن لمدير الشؤون المالية إضافتهم.",
  ],
  SuppliersNoMatch: ["No supplier matches this search and filter.", "لا يوجد مورّد يطابق هذا البحث والتصفية."],
  SuppliersLoadMore: ["Load more", "تحميل المزيد"],
  SuppliersSearchTruncated: [
    "Showing the first {count} matches. More suppliers match. Refine your search.",
    "تُعرض أول {count} نتائج فقط. هناك مورّدون آخرون مطابقون، فحدّد البحث أكثر.",
  ],
  SuppliersOpen: ["Open {name}", "فتح {name}"],

  // Form fields (create and edit)
  SuppliersFieldDisplayName: ["Display name", "الاسم المعروض"],
  SuppliersFieldLegalName: ["Legal name (optional)", "الاسم القانوني (اختياري)"],
  SuppliersFieldPhone: ["Phone (optional)", "الهاتف (اختياري)"],
  SuppliersFieldEmail: ["Email (optional)", "البريد الإلكتروني (اختياري)"],
  SuppliersFieldAddress: ["Address (optional)", "العنوان (اختياري)"],
  SuppliersFieldTaxId: ["Tax id (optional)", "الرقم الضريبي (اختياري)"],
  SuppliersFieldTaxJurisdiction: ["Tax jurisdiction", "بلد الإصدار الضريبي"],
  SuppliersTaxJurisdictionHint: [
    "Two-letter country code that issued the tax id, for example JO. Needed when you enter a tax id.",
    "رمز الدولة المكوّن من حرفين التي أصدرت الرقم الضريبي، مثل JO. مطلوب عند إدخال رقم ضريبي.",
  ],
  SuppliersCancel: ["Cancel", "إلغاء"],

  // Create dialog
  SuppliersCreateTitle: ["Add supplier", "إضافة مورّد"],
  SuppliersCreateDescription: [
    "Add a supplier to the master. The name you enter is the name shown on vehicles and payables.",
    "أضف مورّداً إلى السجل. الاسم الذي تدخله هو الاسم الظاهر على المركبات والمستحقات.",
  ],
  SuppliersCreateSubmit: ["Add supplier", "إضافة المورّد"],
  SuppliersCreating: ["Adding supplier…", "جارٍ إضافة المورّد…"],
  SuppliersCreated: ["Supplier added.", "تمت إضافة المورّد."],

  // Duplicate-name candidates (create and edit)
  SuppliersDupTitle: ["Similar suppliers already exist", "يوجد موردون مشابهون بالفعل"],
  SuppliersDupHint: [
    "Open an existing supplier if this is the same one. Only confirm if this is a genuinely different supplier.",
    "افتح المورّد الموجود إن كان هو نفسه. أكّد فقط إذا كان هذا مورّداً مختلفاً فعلاً.",
  ],
  SuppliersDupOpenExisting: ["Open existing supplier", "فتح المورّد الموجود"],
  SuppliersDupConfirmDistinct: ["This is a different supplier", "هذا مورّد مختلف"],
  SuppliersDupReason_SAME_NAME: ["Same name", "الاسم نفسه"],
  SuppliersDupReason_ALIAS: ["Matches an alias", "يطابق اسماً مستعاراً"],
  SuppliersDupReason_CLOSE_NAME: ["Similar name", "اسم مشابه"],
  SuppliersDupReason_TAX_ID: ["Same tax id", "الرقم الضريبي نفسه"],
  SuppliersDupReason_UNKNOWN: ["Possible duplicate", "تكرار محتمل"],

  // Legal-identity conflict (create and edit)
  SuppliersLegalTitle: ["This tax id already belongs to a supplier", "هذا الرقم الضريبي يخص مورّداً موجوداً"],
  SuppliersLegalBody: [
    "A supplier with this tax id and jurisdiction already exists, and one legal entity is kept as one supplier. Open the existing supplier, or correct the tax id.",
    "يوجد مورّد بهذا الرقم الضريبي وبلد الإصدار، ويُحتفظ بكل كيان قانوني كمورّد واحد. افتح المورّد الموجود أو صحّح الرقم الضريبي.",
  ],
  SuppliersLegalOpenExisting: ["Open the existing supplier", "فتح المورّد الموجود"],
  SuppliersLegalShareIntro: [
    "If this is another branch or trading name of the same legal entity, you can record it as sharing that legal identity. It stays a separate supplier.",
    "إذا كان هذا فرعاً آخر أو اسماً تجارياً آخر للكيان القانوني نفسه، يمكنك تسجيله كمشارك في تلك الهوية القانونية. يبقى مورّداً مستقلاً.",
  ],
  SuppliersLegalShareReason: ["Why does it share the legal identity?", "لماذا يشترك في الهوية القانونية؟"],
  SuppliersLegalShareSubmit: ["Record as sharing the legal identity", "تسجيله كمشارك في الهوية القانونية"],
  SuppliersSharedOf: ["Shares the legal identity of", "يشترك في الهوية القانونية مع"],

  // Detail and edit
  SuppliersBack: ["All suppliers", "كل الموردين"],
  SuppliersDetailsTitle: ["Details", "التفاصيل"],
  SuppliersEditSubmit: ["Save changes", "حفظ التغييرات"],
  SuppliersSaving: ["Saving…", "جارٍ الحفظ…"],
  SuppliersUpdated: ["Supplier updated.", "تم تحديث المورّد."],
  SuppliersNameReason: ["Reason for changing the name", "سبب تغيير الاسم"],
  SuppliersNameReasonHint: [
    "The name is printed on records already created. A name change is audited and needs a reason.",
    "يظهر الاسم في سجلات أُنشئت سابقاً. تغيير الاسم يُدقَّق ويتطلب سبباً.",
  ],
  SuppliersNameReasonRequired: ["Enter a reason for the name change.", "أدخل سبب تغيير الاسم."],
  SuppliersDisplayNameRequired: ["Enter a display name.", "أدخل الاسم المعروض."],
  SuppliersVersionConflictTitle: ["This supplier was changed by someone else", "غيّر شخص آخر هذا المورّد"],
  SuppliersVersionConflictBody: [
    "Your edits were not saved. Reload the latest details, then make your change again.",
    "لم تُحفظ تعديلاتك. أعد تحميل أحدث التفاصيل ثم أعد إجراء التغيير.",
  ],
  SuppliersVersionConflictReload: ["Reload latest details", "إعادة تحميل أحدث التفاصيل"],
  SuppliersDeactivatedBanner: ["This supplier is inactive.", "هذا المورّد غير نشط."],
  SuppliersDeactivatedReason: ["Reason: {reason}", "السبب: {reason}"],
  SuppliersNotFound: ["Supplier not found.", "لم يتم العثور على المورّد."],

  // Aliases
  SuppliersAliasesTitle: ["Aliases", "الأسماء المستعارة"],
  SuppliersAliasesHint: [
    "Other names this supplier is known by. They are used to find the supplier and to spot duplicates. They never replace the display name.",
    "أسماء أخرى يُعرف بها المورّد. تُستخدم للعثور عليه وكشف التكرار، ولا تحل محل الاسم المعروض.",
  ],
  SuppliersAliasLabel: ["New alias", "اسم مستعار جديد"],
  SuppliersAliasAdd: ["Add alias", "إضافة اسم مستعار"],
  SuppliersAliasAdded: ["Alias added.", "تمت إضافة الاسم المستعار."],
  SuppliersAliasRetire: ["Retire", "إيقاف"],
  SuppliersAliasRetireLabel: ["Retire alias {alias}", "إيقاف الاسم المستعار {alias}"],
  SuppliersAliasRetired: ["Retired", "موقوف"],
  SuppliersAliasRetiredToast: ["Alias retired.", "تم إيقاف الاسم المستعار."],
  SuppliersAliasEmpty: ["No aliases.", "لا توجد أسماء مستعارة."],

  // Deactivate and reactivate
  SuppliersDeactivate: ["Deactivate", "إلغاء التنشيط"],
  SuppliersReactivate: ["Reactivate", "إعادة التنشيط"],
  SuppliersDeactivateTitle: ["Deactivate this supplier?", "إلغاء تنشيط هذا المورّد؟"],
  SuppliersDeactivateBody: [
    "An inactive supplier is not offered for new vehicles or new obligations. Everything already recorded against it stays as it is, and existing payables, receivables and recoveries can still be settled. A supplier is never deleted.",
    "لا يُعرض المورّد غير النشط للمركبات أو الالتزامات الجديدة. يبقى كل ما سُجّل عليه كما هو، ويمكن تسوية المستحقات والذمم والاستردادات القائمة. لا يُحذف المورّد أبداً.",
  ],
  SuppliersDeactivateReason: ["Reason for deactivating", "سبب إلغاء التنشيط"],
  SuppliersDeactivateReasonRequired: ["Enter a reason.", "أدخل السبب."],
  SuppliersDeactivateConfirm: ["Deactivate supplier", "إلغاء تنشيط المورّد"],
  SuppliersDeactivated: ["Supplier deactivated.", "تم إلغاء تنشيط المورّد."],
  SuppliersReactivateTitle: ["Reactivate this supplier?", "إعادة تنشيط هذا المورّد؟"],
  SuppliersReactivateBody: [
    "The supplier will be offered again for new vehicles and obligations.",
    "سيُعرض المورّد مجدداً للمركبات والالتزامات الجديدة.",
  ],
  SuppliersReactivateConfirm: ["Reactivate supplier", "إعادة تنشيط المورّد"],
  SuppliersReactivated: ["Supplier reactivated.", "تمت إعادة تنشيط المورّد."],
  SuppliersWorking: ["Working…", "جارٍ التنفيذ…"],

  // Server refusals of convex/suppliers.ts (codes not translated elsewhere)
  ServerError_REGISTRY_NOT_INITIALISED: [
    "The supplier register has not been set up for this organization yet. Nothing was changed. Contact support.",
    "لم يتم إعداد سجل الموردين لهذه المنشأة بعد. لم يتم تغيير أي شيء. تواصل مع الدعم.",
  ],
  ServerError_REGISTRY_CORRUPT: [
    "The supplier register needs repair. Nothing was changed. Contact support.",
    "سجل الموردين يحتاج إلى إصلاح. لم يتم تغيير أي شيء. تواصل مع الدعم.",
  ],
  ServerError_SUPPLIER_LEGAL_IDENTITY_EXISTS: [
    "A supplier with this tax id and jurisdiction already exists.",
    "يوجد مورّد بهذا الرقم الضريبي وبلد الإصدار.",
  ],
  ServerError_SUPPLIER_DUPLICATE_CANDIDATES: [
    "Similar suppliers exist. Confirm this is a different supplier, or use the existing one.",
    "يوجد موردون مشابهون. أكّد أن هذا مورّد مختلف أو استخدم المورّد الموجود.",
  ],
  ServerError_SUPPLIER_CANDIDATES_OVER_CAP: [
    "Too many similar suppliers to confirm at once. Make the name or tax id more specific.",
    "عدد الموردين المشابهين كبير جداً للتأكيد دفعة واحدة. اجعل الاسم أو الرقم الضريبي أكثر تحديداً.",
  ],
  ServerError_SUPPLIER_SHARED_IDENTITY_MISMATCH: [
    "A shared legal identity needs another supplier with the same tax id and jurisdiction, and that supplier must not itself share another's identity.",
    "الهوية القانونية المشتركة تتطلب مورّداً آخر بالرقم الضريبي وبلد الإصدار نفسيهما، على ألا يشترك هو نفسه في هوية مورّد آخر.",
  ],
  ServerError_SUPPLIER_SHARED_IDENTITY_IN_USE: [
    "Other suppliers share this supplier's legal identity, so its tax id cannot change.",
    "يشترك موردون آخرون في الهوية القانونية لهذا المورّد، لذلك لا يمكن تغيير رقمه الضريبي.",
  ],
  ServerError_SUPPLIER_REASON_REQUIRED: ["A reason is required.", "السبب مطلوب."],
  ServerError_SUPPLIER_VERSION_CONFLICT: [
    "This supplier was changed by someone else. Reload it and try again.",
    "غيّر شخص آخر هذا المورّد. أعد تحميله وحاول مرة أخرى.",
  ],
  ServerError_SUPPLIER_IDEMPOTENCY_CONFLICT: [
    "This request was already used for a different supplier. Close the form and start again.",
    "سبق استخدام هذا الطلب لمورّد مختلف. أغلق النموذج وابدأ من جديد.",
  ],
  ServerError_SUPPLIER_ALREADY_INACTIVE: ["This supplier is already inactive.", "هذا المورّد غير نشط بالفعل."],
  ServerError_SUPPLIER_ALREADY_ACTIVE: ["This supplier is already active.", "هذا المورّد نشط بالفعل."],
  ServerError_SUPPLIER_INVALID_INPUT: [
    "Check the entered details. A tax jurisdiction must be a two-letter country code and needs a tax id, and text fields have length limits.",
    "تحقق من البيانات المدخلة. يجب أن يكون بلد الإصدار الضريبي رمز دولة من حرفين ويتطلب رقماً ضريبياً، وللحقول النصية حدود طول.",
  ],
  ServerError_SUPPLIER_IDENTITY_UNRESOLVED: [
    "This record has no linked supplier yet. Link it to a supplier first.",
    "هذا السجل غير مرتبط بمورّد بعد. اربطه بمورّد أولاً.",
  ],
  ServerError_SUPPLIER_NO_CHANGE: ["There is nothing to change.", "لا يوجد ما يُغيَّر."],
  ServerError_SUPPLIER_ALIAS_EXISTS: ["This supplier already has that alias.", "لدى هذا المورّد هذا الاسم المستعار بالفعل."],
  ServerError_SUPPLIER_ALIAS_LIMIT: [
    "This supplier has reached the maximum number of aliases.",
    "بلغ هذا المورّد الحد الأقصى لعدد الأسماء المستعارة.",
  ],
  ServerError_SUPPLIER_ALIAS_ALREADY_RETIRED: ["This alias is already retired.", "هذا الاسم المستعار موقوف بالفعل."],
});

export const suppliersEn = suppliersMessages.en;
export const suppliersAr = suppliersMessages.ar;
