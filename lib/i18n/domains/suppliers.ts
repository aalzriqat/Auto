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
  SuppliersStmtAttnPayableTitle: ["Payables needing attention (A/P)", "مستحقات للمورد تحتاج إلى متابعة (A/P)"],
  SuppliersStmtAttnReceivableTitle: ["Receivables needing attention (A/R)", "مستحقات على المورد تحتاج إلى متابعة (A/R)"],
  SuppliersStmtAttnTitle: ["Needs attention", "يحتاج إلى متابعة"],
  SuppliersStmtAttnNone: ["No reminder-eligible or held obligations in this family.", "لا توجد التزامات مؤهلة للتذكير أو موقوفة في هذه الفئة."],
  SuppliersStmtAttnStepT3: ["Due within 3 days", "مستحق خلال 3 أيام"],
  SuppliersStmtAttnStepDue: ["Due-date reminder reached", "حان تذكير تاريخ الاستحقاق"],
  SuppliersStmtAttnStepOverdue7: ["7-day overdue reminder reached", "حان تذكير التأخر 7 أيام"],
  SuppliersStmtAttnStepWeekly: ["Overdue, weekly reminder", "متأخر، تذكير أسبوعي"],
  SuppliersStmtAttnHeldDisputed: ["Held: under dispute, reminders paused", "موقوف: قيد النزاع، التذكيرات معلّقة"],
  SuppliersStmtAttnHeldNoDue: ["Held: no due date, no reminder", "موقوف: لا يوجد تاريخ استحقاق، لا تذكير"],
  SuppliersStmtAttnEligibility: ["Reminder eligibility, not delivery confirmation. Amounts owed to and from this supplier stay separate.", "أهلية التذكير وليست تأكيدًا لإرساله. تبقى المبالغ المستحقة للمورد والمستحقة عليه منفصلة."],
  SuppliersStmtAttnIncomplete: ["Incomplete view: this page is only part of the records. Full counts and totals are unavailable.", "عرض غير مكتمل: هذه الصفحة جزء من السجلات فقط. الأعداد والإجماليات الكاملة غير متاحة."],
  SuppliersStmtAttnBudget: ["Incomplete: the read budget was reached. Figures are unavailable and the page has not advanced. Try again later.", "غير مكتمل: تم بلوغ حد القراءة. الأرقام غير متاحة ولم تتقدم الصفحة. حاول لاحقًا."],
  SuppliersStmtAttnSplit: ["Incomplete: this page needs a smaller read range. Figures are unavailable and the page has not advanced.", "غير مكتمل: تحتاج هذه الصفحة إلى نطاق قراءة أصغر. الأرقام غير متاحة ولم تتقدم الصفحة."],
  SuppliersStmtAttnUnlinked: ["This organisation has unlinked supplier records in this family, including history. They are excluded from this supplier account.", "توجد في هذه المنشأة سجلات موردين غير مرتبطة في هذه الفئة، بما فيها السجلات السابقة. وهي مستبعدة من حساب هذا المورد."],
  SuppliersStmtAttnUnlinkedIncomplete: ["Unlinked-record check incomplete. Their presence and count are unavailable.", "فحص السجلات غير المرتبطة غير مكتمل. وجودها وعددها غير متاحين."],
  SuppliersStmtAttnRestricted: ["Supplier attention is unavailable without finance and cost access.", "متابعة المورد غير متاحة دون صلاحية المالية والاطلاع على التكلفة."],
  SuppliersStmtAttnRecord: ["Record", "السجل"],
  SuppliersStmtAttnNext: ["Next records", "السجلات التالية"],
  SuppliersStmtAttnPrevious: ["Previous records", "السجلات السابقة"],
  ServerError_SUPPLIER_ATTENTION_UNAVAILABLE: ["Supplier attention could not be loaded. Please try again.", "تعذّر تحميل متابعة المورد. يُرجى المحاولة مرة أخرى."],
  SuppliersRowAP: ["A/P to supplier", "ذمم دائنة للمورّد"],
  SuppliersRowAR: ["A/R from supplier", "ذمم مدينة على المورّد"],
  SuppliersRowPayee: ["Payee", "المستفيد"],
  SuppliersRowPayer: ["Payer", "الدافع"],
  SuppliersRowCreated: ["Recorded", "تاريخ التسجيل"],
  SuppliersRowUnknownTime: ["Date unavailable", "التاريخ غير متاح"],
  SuppliersRowUnknownParty: ["Supplier snapshot unavailable", "بيانات المورّد المحفوظة غير متاحة"],
  SuppliersRowSourceUnavailable: ["Source record unavailable", "المستند المصدر غير متاح"],
  SuppliersRowSourceVEHICLE: ["Vehicle", "المركبة"],
  SuppliersRowSourceSALE: ["Sale", "البيع"],
  SuppliersRowSourceAPPLICATION: ["Deal", "الصفقة"],
  SuppliersRowSourceEXPENSE: ["Expense", "المصروف"],
  SuppliersRowSourceOPENING: ["Opening balance", "الرصيد الافتتاحي"],
  SuppliersRelationshipsTitle: ["Relationships", "السجلات المرتبطة"],
  SuppliersRelationshipsSourcedTitle: ["Consignment vehicles", "مركبات الأمانة"],
  SuppliersRelationshipsOwnedTitle: ["Owned vehicles bought on account", "المركبات المملوكة المشتراة على الحساب"],
  SuppliersRelationshipsSourced: ["Consignment", "أمانة"],
  SuppliersRelationshipsOwned: ["Owned · on account", "مملوكة · على الحساب"],
  SuppliersRelationshipsScope: ["Linked by supplier id only. Older records without a supplier link are excluded; their count is unavailable here.", "الربط بمعرّف المورّد فقط. تُستبعد السجلات القديمة غير المرتبطة بمورّد؛ عددها غير متاح هنا."],
  SuppliersRelationshipsLoading: ["Loading linked vehicles…", "جارٍ تحميل المركبات المرتبطة…"],
  SuppliersRelationshipsEmpty: ["No linked vehicles in this category.", "لا توجد مركبات مرتبطة في هذه الفئة."],
  SuppliersRelationshipsIncomplete: ["Incomplete list. More linked records may exist; no total is shown.", "القائمة غير مكتملة. قد توجد سجلات مرتبطة أخرى؛ لا يُعرض إجمالي."],
  SuppliersRelationshipsMore: ["Load more", "تحميل المزيد"],
  SuppliersRelationshipsError: ["Linked records could not be loaded. Please try again.", "تعذّر تحميل السجلات المرتبطة. يرجى المحاولة مجدداً."],
  ServerError_SUPPLIER_NAVIGATION_UNAVAILABLE: ["Supplier records could not be loaded. Please try again.", "تعذّر تحميل سجلات المورّد. يرجى المحاولة مجدداً."],
  ServerError_SUPPLIER_STATEMENT_INVALID_TIME: ["Refresh the statement to use the current date and time.", "حدّث كشف الحساب لاستخدام التاريخ والوقت الحاليين."],
  // Navigation and page chrome
  Suppliers: ["Suppliers", "الموردون"],
  SuppliersBalances: ["Balances", "الأرصدة"],
  SuppliersBalancesSubtitle: ["What you owe each supplier and what each supplier owes you, by currency.", "ما عليك لكل مورّد وما يدين به كل مورّد لك، حسب العملة."],
  SuppliersBalancesYouOwe: ["You owe", "عليك للمورّد"],
  SuppliersBalancesOwesYou: ["Owes you", "المورّد مدين لك"],
  SuppliersBalancesNet: ["Net (informational)", "الصافي (للمعلومات فقط)"],
  SuppliersBalancesNetYouOwe: ["− You owe the supplier", "− عليك للمورّد"],
  SuppliersBalancesNetOwesYou: ["+ Supplier owes you", "+ المورّد مدين لك"],
  SuppliersBalancesNetZero: ["No net difference", "لا فرق في الصافي"],
  SuppliersBalancesNetNote: ["Net is informational only. Payables and receivables are never automatically offset.", "الصافي للمعلومات فقط. لا تتم مقاصة المستحقات والذمم تلقائياً."],
  SuppliersBalancesOverdue: ["Overdue", "المتأخر"],
  SuppliersBalancesOldest: ["Oldest due date", "أقدم تاريخ استحقاق"],
  SuppliersBalancesCurrency: ["Currency", "العملة"],
  SuppliersBalancesDisputed: ["Disputed (included above)", "المتنازع عليه (مشمول أعلاه)"],
  SuppliersBalancesEmpty: ["No suppliers to report.", "لا يوجد موردون لعرض أرصدتهم."],
  SuppliersBalancesZero: ["No outstanding obligations", "لا توجد التزامات قائمة"],
  SuppliersBalancesPartial: ["Partial report. Only this supplier page is shown. Incomplete supplier totals are unavailable.", "تقرير جزئي. تظهر صفحة الموردين هذه فقط. إجماليات الموردين غير المكتملة غير متاحة."],
  SuppliersBalancesWithheld: ["Supplier balances require finance and cost-price access.", "أرصدة الموردين تتطلب صلاحية عرض الشؤون المالية وأسعار التكلفة."],
  SuppliersBalancesScope: ["Linked obligations only, as in each supplier statement. Unlinked legacy obligations and unallocated openings are excluded. Current balances, aged at the displayed date.", "الالتزامات المرتبطة فقط كما في كشف كل مورّد. تُستثنى الالتزامات القديمة غير المرتبطة والأرصدة الافتتاحية غير المخصصة. أرصدة حالية بأعمار محسوبة في التاريخ المعروض."],
  SuppliersBalancesAsOf: ["Aging date (Amman)", "تاريخ احتساب العمر (عمّان)"],
  SuppliersBalancesPrevious: ["Previous suppliers", "الموردون السابقون"],
  SuppliersBalancesNext: ["Next suppliers", "الموردون التاليون"],
  SuppliersEdit: ["Edit supplier", "تعديل المورّد"],
  SuppliersDiscardTitle: ["Discard unsaved changes?", "تجاهل التغييرات غير المحفوظة؟"],
  SuppliersDiscardBody: ["Your changes have not been saved.", "لم يتم حفظ تغييراتك."],
  SuppliersDiscard: ["Discard changes", "تجاهل التغييرات"],
  SuppliersKeepEditing: ["Keep editing", "متابعة التعديل"],
  SuppliersTabOutstanding: ["Outstanding", "القائم"],
  SuppliersTabSettled: ["Settled", "المسدّد"],
  SuppliersTabPayments: ["Payments", "الدفعات"],
  SuppliersStmtType: ["Obligation", "الالتزام"],
  SuppliersAccountActivity: ["Account activity", "حركة الحساب"],
  SuppliersStmtAmount: ["Amount", "المبلغ"],
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
  SuppliersSearchTruncatedNoMatch: [
    "The search reached its limit before finding a match, so it is not complete. Narrow your search or change the status filter.",
    "بلغ البحث حدّه الأقصى قبل العثور على نتيجة مطابقة، لذا فهو غير مكتمل. حدّد البحث أكثر أو غيّر تصفية الحالة.",
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
  ServerError_SUPPLIER_ALIAS_EXISTS: [
    "This supplier already has that alias.",
    "لدى هذا المورّد هذا الاسم المستعار بالفعل.",
  ],
  ServerError_SUPPLIER_ALIAS_LIMIT: [
    "This supplier has reached the maximum number of aliases.",
    "بلغ هذا المورّد الحد الأقصى لعدد الأسماء المستعارة.",
  ],
  ServerError_SUPPLIER_ALIAS_ALREADY_RETIRED: ["This alias is already retired.", "هذا الاسم المستعار موقوف بالفعل."],

  // Supplier statement (SCRUM-869 slice 2). A/P and A/R are separate regions; nothing is netted.
  SuppliersStmtTitle: ["Statement", "كشف الحساب"],
  SuppliersStmtNoNetNote: [
    "Amounts we owe this supplier and amounts this supplier owes us are shown separately. They are never offset against each other, and each currency is totalled on its own.",
    "المبالغ المستحقة للمورّد والمبالغ المستحقة منه تُعرض منفصلة. لا تُقاصّ إحداهما بالأخرى أبداً، وتُجمع كل عملة على حدة.",
  ],
  SuppliersStmtPayableTitle: ["We owe this supplier (A/P)", "مستحق للمورّد علينا (ذمم دائنة)"],
  SuppliersStmtReceivableTitle: ["This supplier owes us (A/R)", "مستحق لنا على المورّد (ذمم مدينة)"],
  SuppliersStmtPayableEmpty: [
    "No outstanding payable lines are linked to this supplier.",
    "لا توجد بنود مستحقة للمورّد مرتبطة به.",
  ],
  SuppliersStmtReceivableEmpty: [
    "No outstanding receivable lines are linked to this supplier.",
    "لا توجد بنود مستحقة على المورّد مرتبطة به.",
  ],
  SuppliersStmtScopeNote: [
    "This lists lines linked by supplier id, including linked opening entries. Older records without a supplier link are excluded; their count is unavailable here.",
    "تعرض هذه القائمة البنود المرتبطة بمعرّف المورّد، بما فيها الأرصدة الافتتاحية المرتبطة. تُستبعد السجلات القديمة غير المرتبطة بمورّد؛ عددها غير متاح هنا.",
  ],
  SuppliersStmtPlanGate: [
    "The supplier statement is not included in your current plan.",
    "كشف حساب المورّد غير مشمول في خطتك الحالية.",
  ],
  // SCRUM-902: shown instead of the sourcing lists to a role that holds view:finance without view:cost_price.
  SourcingCostAccessRequired: [
    "Supplier payables and special orders show what each sourced car cost. Your role needs cost-price access as well as finance access to see them. Ask an administrator to update your role.",
    "تعرض مستحقات الموردين والطلبات الخاصة تكلفة كل مركبة مورَّدة. يحتاج دورك إلى صلاحية عرض سعر التكلفة إضافةً إلى صلاحية المالية. اطلب من المسؤول تحديث دورك.",
  ],
  SuppliersStmtLoading: ["Loading the statement…", "جارٍ تحميل كشف الحساب…"],
  SuppliersStmtLoadError: [
    "The statement could not be loaded. Reload the page and try again.",
    "تعذّر تحميل كشف الحساب. أعد تحميل الصفحة وحاول مرة أخرى.",
  ],
  SuppliersStmtIncomplete: [
    "More lines exist than can be shown here. The lines above are partial, so no total is shown.",
    "توجد بنود أكثر من المعروض هنا. البنود أعلاه جزئية، لذلك لا يُعرض إجمالي.",
  ],
  SuppliersStmtIncompleteBudget: [
    "Not every line could be read in one request, so the lines above are partial and no total is shown. Narrow the supplier or try again.",
    "تعذّرت قراءة كل البنود في طلب واحد، لذلك البنود أعلاه جزئية ولا يُعرض إجمالي. ضيّق نطاق المورّد أو حاول مرة أخرى.",
  ],
  SuppliersStmtKindPayable: ["Supplier payable", "مستحق للمورّد"],
  SuppliersStmtKindReceivable: ["Margin receivable", "هامش مستحق على المورّد"],
  SuppliersStmtKindRecovery: ["Cost recovery", "استرداد تكلفة"],
  SuppliersStmtDue: ["Due", "الاستحقاق"],
  SuppliersStmtNoDueDate: ["No due date", "بلا تاريخ استحقاق"],
  SuppliersStmtDaysOverdue: ["{days} days overdue", "متأخر {days} يوماً"],
  SuppliersStmtDisputed: ["Disputed", "متنازع عليه"],
  SuppliersStmtOverdue: ["Overdue", "متأخر"],
  SuppliersStmtTotal: ["Total outstanding on linked lines", "إجمالي المستحق على البنود المرتبطة"],
  SuppliersStmtHistoryTitle: ["Settled history", "سجل التسويات"],
  SuppliersStmtHistoryPaidTitle: ["Paid to this supplier (A/P)", "المدفوع للمورّد (ذمم دائنة)"],
  SuppliersStmtHistoryReceivedTitle: ["Received from this supplier (A/R)", "المقبوض من المورّد (ذمم مدينة)"],
  SuppliersStmtHistoryPaidEmpty: [
    "No payments linked to this supplier are recorded yet.",
    "لا توجد دفعات مرتبطة بهذا المورّد مسجّلة بعد.",
  ],
  SuppliersStmtHistoryReceivedEmpty: [
    "No receipts linked to this supplier are recorded yet.",
    "لا توجد مقبوضات مرتبطة بهذا المورّد مسجّلة بعد.",
  ],
  SuppliersStmtHistoryTotalPaid: ["Total paid", "إجمالي المدفوع"],
  SuppliersStmtHistoryTotalReceived: ["Total received", "إجمالي المقبوض"],
  SuppliersStmtHistoryOf: ["of", "من"],
  SuppliersStmtHistorySettled: ["Settled in full", "مُسوّى بالكامل"],
  SuppliersStmtHistoryPartly: ["Partly settled", "مُسوّى جزئياً"],
  SuppliersStmtHistoryLastChange: ["Last change", "آخر تحديث"],
  SuppliersStmtHistoryClaimTotal: ["Claim total", "إجمالي المطالبة"],
  SuppliersStmtReconTitle: ["Payments check against the ledger", "مطابقة الدفعات مع دفتر الأستاذ"],
  SuppliersStmtReconOk: [
    "Payments recorded for this supplier match the ledger (account 2400).",
    "الدفعات المسجلة لهذا المورد تطابق دفتر الأستاذ (حساب 2400).",
  ],
  SuppliersStmtReconDiffers: [
    "Payments recorded for this supplier differ from the ledger (account 2400). Ask an accountant to review.",
    "الدفعات المسجلة لهذا المورد تختلف عن دفتر الأستاذ (حساب 2400). اطلب مراجعة المحاسب.",
  ],
  SuppliersStmtReconUnavailable: ["Check unavailable", "المطابقة غير متاحة"],
  SuppliersStmtReconReasonOverLimit: ["too many records to check at once", "عدد السجلات أكبر من أن يُفحص دفعة واحدة"],
  SuppliersStmtReconReasonPending: ["postings are still being processed", "ما زالت القيود قيد المعالجة"],
  SuppliersStmtReconReasonNoAccount: ["the ledger account is missing", "حساب دفتر الأستاذ غير موجود"],
  SuppliersStmtReconReasonInconsistent: ["a ledger record is inconsistent", "سجل في دفتر الأستاذ غير متسق"],
  SuppliersStmtReconSubledger: ["Paid (supplier record)", "المدفوع (سجل المورد)"],
  SuppliersStmtReconLedger: ["Ledger", "دفتر الأستاذ"],
  SuppliersStmtReconCreditNote: [
    "Amounts owed to a supplier cannot be traced to one supplier in the ledger, so only payments are checked. This check does not flag an overpaid payable.",
    "لا يمكن ربط المبالغ المستحقة للمورد بمورد محدد في دفتر الأستاذ، لذلك تُفحص الدفعات فقط. ولا يرصد هذا الفحص الدفعة الزائدة عن المستحق.",
  ],
  SuppliersStmtReconOpeningNote: [
    "{count} opening-balance record(s) are not part of this check.",
    "{count} سجل(ات) رصيد افتتاحي ليست ضمن هذه المطابقة.",
  ],
  SuppliersStmtHistoryInferred: [
    "Amount taken from the paid status of an older record; no payment details were saved for it.",
    "المبلغ مأخوذ من حالة السداد في سجل قديم؛ لم تُحفظ تفاصيل دفعة لهذا السجل.",
  ],
  SuppliersStmtHistoryUnverified: [
    "{count} margin claim(s) have a receipt recorded that is not confirmed in the ledger yet, so the amount received from the supplier cannot be shown for them. The lines above may be partial, so no total is shown.",
    "{count} مطالبة هامش لها مقبوض مسجّل لم يتأكد في دفتر الأستاذ بعد، لذلك لا يمكن عرض المبلغ المقبوض من المورّد لها. قد تكون البنود أعلاه جزئية، لذلك لا يُعرض إجمالي.",
  ],
  SuppliersStmtHistoryReceivedScope: [
    "Only money the supplier paid is counted here. A customer deposit applied to the settlement is not a supplier payment and is not included.",
    "يُحتسب هنا فقط ما دفعه المورّد. عربون العميل المطبّق على التسوية ليس دفعة من المورّد ولا يُدرج.",
  ],
  SuppliersStmtTotalUnavailable: [
    "Total unavailable: this list is incomplete",
    "الإجمالي غير متاح: القائمة غير مكتملة",
  ],
});

export const suppliersEn = suppliersMessages.en;
export const suppliersAr = suppliersMessages.ar;
