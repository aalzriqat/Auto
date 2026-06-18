// Pre-chat self-service content for the dealer-facing live chat widget.
// Lets a dealer find a quick answer before (or instead of) waiting for a
// live agent — every step still offers a direct path to a human.

export type FaqEntry = {
  id: string;
  question: { en: string; ar: string };
  answer: { en: string; ar: string };
};

export type FaqCategory = {
  id: string;
  label: { en: string; ar: string };
  entries: FaqEntry[];
};

export const supportFaqCategories: FaqCategory[] = [
  {
    id: "vehicles",
    label: { en: "Vehicles & Inventory", ar: "المركبات والمخزون" },
    entries: [
      {
        id: "vehicle-not-showing",
        question: {
          en: "Why isn't my new vehicle showing up in inventory yet?",
          ar: "لماذا لا تظهر المركبة الجديدة في المخزون بعد؟",
        },
        answer: {
          en: "New vehicles (and edits to existing ones) can require approval depending on your dealership's settings. Check the Approvals page, or ask your Owner/Manager to review it — once approved it appears in Vehicles immediately.",
          ar: "قد تحتاج المركبات الجديدة (وتعديلات المركبات الحالية) إلى موافقة حسب إعدادات معرض السيارات الخاص بك. تحقق من صفحة الموافقات، أو اطلب من المالك/المدير مراجعتها — بمجرد الموافقة تظهر في المركبات فورًا.",
        },
      },
      {
        id: "vehicle-bulk-import",
        question: {
          en: "How do I add a lot of vehicles at once?",
          ar: "كيف أضيف عدداً كبيراً من المركبات دفعة واحدة؟",
        },
        answer: {
          en: "Use the Excel import wizard on the Vehicles page. Upload your spreadsheet and map the columns once — AutoFlow remembers that mapping for next time.",
          ar: "استخدم معالج استيراد Excel في صفحة المركبات. ارفع جدول البيانات وحدد الأعمدة مرة واحدة — يتذكر AutoFlow هذا التحديد للمرات القادمة.",
        },
      },
      {
        id: "vehicle-statuses",
        question: {
          en: "What do the vehicle statuses mean?",
          ar: "ماذا تعني حالات المركبة؟",
        },
        answer: {
          en: "Available, Reserved, Sold, In Inspection, In Repair, and Archived. Archived removes a vehicle from active inventory without deleting its history — useful for old listings you don't want to sell anymore.",
          ar: "متاحة، محجوزة، مباعة، قيد الفحص، قيد الإصلاح، ومؤرشفة. الأرشفة تزيل المركبة من المخزون النشط دون حذف سجلها — مفيدة للمركبات القديمة التي لم تعد ترغب ببيعها.",
        },
      },
      {
        id: "vehicle-deleted",
        question: {
          en: "I deleted a vehicle by mistake — can it be recovered?",
          ar: "حذفت مركبة بالخطأ — هل يمكن استعادتها؟",
        },
        answer: {
          en: "Vehicles are soft-deleted, so the record usually can be recovered. Ask your dealership's Owner first — if you can't reach them, chat with an agent and we'll help.",
          ar: "يتم حذف المركبات بشكل مؤقت (soft delete)، لذا يمكن عادة استعادة السجل. اطلب من مالك معرض السيارات أولاً — وإذا تعذر التواصل معه، تحدث مع أحد موظفي الدعم وسنساعدك.",
        },
      },
    ],
  },
  {
    id: "customers-leads",
    label: { en: "Customers & Leads", ar: "العملاء والعملاء المحتملون" },
    entries: [
      {
        id: "customer-import",
        question: {
          en: "Can I import my existing customer list?",
          ar: "هل يمكنني استيراد قائمة عملائي الحالية؟",
        },
        answer: {
          en: "Yes — the same Excel import wizard used for vehicles works for customers. Go to Customers, choose Import, and map your spreadsheet columns once.",
          ar: "نعم — معالج استيراد Excel نفسه المستخدم للمركبات يعمل للعملاء أيضاً. اذهب إلى صفحة العملاء، اختر استيراد، وحدد أعمدة جدول البيانات مرة واحدة.",
        },
      },
      {
        id: "lead-stages",
        question: {
          en: "What are the lead pipeline stages and how do I move a lead?",
          ar: "ما هي مراحل خط أنابيب العملاء المحتملين وكيف أنقل عميلاً محتملاً؟",
        },
        answer: {
          en: "New → Contacted → Interested → Test Drive → Negotiation → Reserved → Won/Lost. Drag a lead's card between columns on the Leads page, or open the lead and change its stage directly.",
          ar: "جديد ← تم التواصل ← مهتم ← تجربة قيادة ← تفاوض ← محجوز ← فوز/خسارة. اسحب بطاقة العميل المحتمل بين الأعمدة في صفحة العملاء المحتملين، أو افتح العميل المحتمل وغيّر مرحلته مباشرة.",
        },
      },
      {
        id: "customer-statuses",
        question: {
          en: "Can we customize our customer statuses?",
          ar: "هل يمكننا تخصيص حالات العملاء؟",
        },
        answer: {
          en: "Yes — your Owner can add, rename, or reorder customer statuses for your dealership under Settings.",
          ar: "نعم — يمكن للمالك إضافة أو إعادة تسمية أو إعادة ترتيب حالات العملاء الخاصة بمعرضك من خلال الإعدادات.",
        },
      },
    ],
  },
  {
    id: "sales-financing",
    label: { en: "Sales & Financing", ar: "المبيعات والتمويل" },
    entries: [
      {
        id: "record-cash-sale",
        question: {
          en: "How do I record a cash sale?",
          ar: "كيف أسجل عملية بيع نقدية؟",
        },
        answer: {
          en: "Open the sales wizard from the Sales page, pick the vehicle and customer, choose Cash, and confirm — inventory status and commissions update automatically.",
          ar: "افتح معالج المبيعات من صفحة المبيعات، اختر المركبة والعميل، اختر نقدي، وأكّد — تتحدث حالة المخزون والعمولات تلقائياً.",
        },
      },
      {
        id: "why-approval-needed",
        question: {
          en: "Why does my sale need approval before it's finalized?",
          ar: "لماذا تحتاج عملية البيع إلى موافقة قبل إتمامها؟",
        },
        answer: {
          en: "If a deal's profit falls below your dealership's configured minimum-profit threshold, it's automatically routed to a Manager/Owner for approval. You'll see it waiting on the Approvals page.",
          ar: "إذا كان ربح الصفقة أقل من الحد الأدنى للربح المحدد لمعرضكم، يتم توجيهها تلقائياً إلى المدير/المالك للموافقة. ستجدها بانتظار الموافقة في صفحة الموافقات.",
        },
      },
      {
        id: "financing-quotes",
        question: {
          en: "How do installment/financing quotes work?",
          ar: "كيف تعمل عروض الأقساط/التمويل؟",
        },
        answer: {
          en: "In the sales wizard, choose the financing option to generate a quote against your dealership's configured finance companies — the monthly installment, profit rate, and term are calculated for you.",
          ar: "في معالج المبيعات، اختر خيار التمويل لإنشاء عرض سعر بناءً على شركات التمويل المُعدّة لمعرضكم — يتم حساب القسط الشهري ونسبة الربح والمدة تلقائياً لك.",
        },
      },
    ],
  },
  {
    id: "team-roles",
    label: { en: "Team & Roles", ar: "الفريق والأدوار" },
    entries: [
      {
        id: "invite-teammate",
        question: {
          en: "How do I invite a teammate?",
          ar: "كيف أدعو زميلاً في الفريق؟",
        },
        answer: {
          en: "Go to Team and send an invite by email, picking a role (Owner, Manager, Sales, Reception, Accountant, or a custom role your Owner created). They get access once they sign in with that email.",
          ar: "اذهب إلى صفحة الفريق وأرسل دعوة عبر البريد الإلكتروني، واختر دوراً (مالك، مدير، مبيعات، استقبال، محاسب، أو دور مخصص أنشأه المالك). يحصلون على الوصول بمجرد تسجيل الدخول بذلك البريد الإلكتروني.",
        },
      },
      {
        id: "permission-denied",
        question: {
          en: "I don't have permission to do something I need to do — why?",
          ar: "لا أملك صلاحية للقيام بشيء أحتاجه — لماذا؟",
        },
        answer: {
          en: "Each role has its own customizable set of permissions per dealership. Ask your Owner or Manager to check or adjust your role under Team.",
          ar: "كل دور له مجموعة صلاحيات قابلة للتخصيص خاصة بمعرضكم. اطلب من المالك أو المدير مراجعة أو تعديل دورك من صفحة الفريق.",
        },
      },
    ],
  },
  {
    id: "reports-settings",
    label: { en: "Reports & Settings", ar: "التقارير والإعدادات" },
    entries: [
      {
        id: "filter-reports-date",
        question: {
          en: "How do I see sales/profit for a specific date range?",
          ar: "كيف أعرض المبيعات/الأرباح لفترة زمنية محددة؟",
        },
        answer: {
          en: "Open Reports and use the date range filter at the top — every metric on the page updates instantly for the selected period.",
          ar: "افتح صفحة التقارير واستخدم مرشح الفترة الزمنية في الأعلى — تتحدث جميع المؤشرات في الصفحة فورياً للفترة المحددة.",
        },
      },
      {
        id: "switch-language",
        question: {
          en: "How do I switch the app to Arabic (or back to English)?",
          ar: "كيف أبدّل التطبيق إلى العربية (أو أعود إلى الإنجليزية)؟",
        },
        answer: {
          en: "Use the language toggle in the top navigation — the whole interface, including layout direction, switches instantly.",
          ar: "استخدم مفتاح تبديل اللغة في شريط التنقل العلوي — تتبدل الواجهة بالكامل، بما في ذلك اتجاه التخطيط، فوراً.",
        },
      },
      {
        id: "change-currency-branding",
        question: {
          en: "How do I change our currency, logo, or brand color?",
          ar: "كيف أغيّر العملة أو الشعار أو لون العلامة التجارية؟",
        },
        answer: {
          en: "Your Owner can set the currency, logo, and brand color under Settings → General.",
          ar: "يمكن للمالك ضبط العملة والشعار ولون العلامة التجارية من الإعدادات ← عام.",
        },
      },
    ],
  },
  {
    id: "account-access",
    label: { en: "Account & Access", ar: "الحساب والوصول" },
    entries: [
      {
        id: "no-dealership-visible",
        question: {
          en: "I'm signed in but don't see any dealership.",
          ar: "أنا مسجل الدخول لكن لا أرى أي معرض سيارات.",
        },
        answer: {
          en: "Either you haven't been invited to one yet, or you're a brand-new user — finish the onboarding steps to create your first dealership, or ask whoever invited you to double-check the email address they used.",
          ar: "إما أنه لم تتم دعوتك إلى أحدها بعد، أو أنك مستخدم جديد تماماً — أكمل خطوات الإعداد لإنشاء معرضك الأول، أو اطلب ممن دعاك التأكد من البريد الإلكتروني الذي استخدمه.",
        },
      },
      {
        id: "switch-org",
        question: {
          en: "How do I switch between dealerships if I belong to more than one?",
          ar: "كيف أتنقل بين معارض السيارات إذا كنت أنتمي لأكثر من واحد؟",
        },
        answer: {
          en: "Use the organization switcher in the top navigation to jump between any dealership you're a member of.",
          ar: "استخدم محوّل المؤسسات في شريط التنقل العلوي للتنقل بين أي معرض سيارات أنت عضو فيه.",
        },
      },
    ],
  },
];
