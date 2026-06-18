// Pre-chat self-service content for the public marketing-site chat widget.
// Lets a prospective dealership get a quick answer before (or instead of)
// waiting for a live agent — every step still offers a direct path to a human.
import type { FaqCategory } from "./supportFaq";

export const marketingFaqCategories: FaqCategory[] = [
  {
    id: "getting-started",
    label: { en: "Getting Started", ar: "البدء" },
    entries: [
      {
        id: "how-to-start",
        question: {
          en: "How do I get started with AutoFlow?",
          ar: "كيف أبدأ باستخدام أوتوفلو؟",
        },
        answer: {
          en: "Click \"Get Started\" at the top of the page to create your account and your first dealership organization — you can be exploring AutoFlow with your own data in minutes.",
          ar: "اضغط \"ابدأ الآن\" أعلى الصفحة لإنشاء حسابك وأول مؤسسة (معرض) لك — يمكنك استكشاف أوتوفلو ببياناتك الخاصة خلال دقائق.",
        },
      },
      {
        id: "data-migration",
        question: {
          en: "Can we transfer our existing vehicle stock and customer list?",
          ar: "هل يمكننا نقل قائمة السيارات والعملاء الحالية لدينا بسهولة؟",
        },
        answer: {
          en: "Absolutely. AutoFlow provides clean CSV and JSON templates to batch-import your entire inventory and customer history in minutes. Our team is also available for direct database migrations.",
          ar: "بالتأكيد. يوفر أوتوفلو قوالب استيراد مرنة بصيغة CSV و JSON لرفع مخزونك وبيانات العملاء دفعة واحدة خلال دقائق. فريقنا متواجد أيضاً لمساعدتك في نقل البيانات بالكامل.",
        },
      },
    ],
  },
  {
    id: "features-permissions",
    label: { en: "Features & Permissions", ar: "الميزات والصلاحيات" },
    entries: [
      {
        id: "roles-permissions",
        question: {
          en: "Can we control exactly what each employee sees and does?",
          ar: "هل يمكننا التحكم بدقة بما يراه ويفعله كل موظف؟",
        },
        answer: {
          en: "Yes. AutoFlow ships with five role templates (Owner, Manager, Sales, Reception, Accountant), and every permission is individually toggleable per role — so you can lock down cost prices, deletions, or financial views exactly the way you want.",
          ar: "نعم. يأتي أوتوفلو بخمسة قوالب أدوار جاهزة (مالك، مدير، مبيعات، استقبال، محاسب)، وكل صلاحية قابلة للتفعيل أو التعطيل بشكل فردي لكل دور، فتستطيع التحكم بدقة في من يرى سعر التكلفة أو يحذف السجلات أو يصل للبيانات المالية.",
        },
      },
      {
        id: "profit-approvals",
        question: {
          en: "How do profit protection thresholds and approvals work?",
          ar: "كيف تعمل حماية هوامش أرباح الصفقات واعتماد المعاملات؟",
        },
        answer: {
          en: "You set target profit percentages per branch. If a salesperson configures a deal below that margin, AutoFlow automatically routes a secure approval request to the manager's dashboard before it can be finalized.",
          ar: "يمكنك تحديد هوامش الربح المستهدفة لكل فرع. إذا حاول موظف المبيعات إدخال صفقة بأرباح أقل، يقوم النظام تلقائياً بتجميدها وإرسال طلب موافقة فوري للمدير قبل إتمامها.",
        },
      },
    ],
  },
  {
    id: "multi-branch-language",
    label: { en: "Multi-Branch & Arabic", ar: "الفروع المتعددة والعربية" },
    entries: [
      {
        id: "multi-branch",
        question: {
          en: "Is AutoFlow optimized for multi-branch dealerships?",
          ar: "هل يدعم أوتوفلو معارض السيارات ذات الفروع المتعددة؟",
        },
        answer: {
          en: "Yes. AutoFlow supports granular branch-scoping, letting salespeople view local stock while executives monitor consolidated inventory, sales, and analytics across all regional sites.",
          ar: "نعم. يدعم أوتوفلو تقسيم الصلاحيات والمخزون للفروع المتعددة، حيث يمكن للموظف رؤية سيارات فرعه المحلي فقط، بينما يستطيع المسؤول العام تتبع كافة الفروع والتقارير المالية المدمجة.",
        },
      },
      {
        id: "arabic-support",
        question: {
          en: "Is the Arabic interface a real translation or just a mirrored layout?",
          ar: "هل واجهة اللغة العربية ترجمة حقيقية أم مجرد انعكاس للتصميم؟",
        },
        answer: {
          en: "It's a genuine right-to-left experience, not a CSS mirror trick. Every screen, form, and report is fully translated and laid out natively for Arabic, and switching languages is instant — no reload, no broken layouts.",
          ar: "هي تجربة عربية حقيقية بترتيب من اليمين لليسار، وليست مجرد انعكاس بصري. كل شاشة ونموذج وتقرير مترجم بالكامل ومصمم بشكل أصلي للغة العربية، والتبديل بين اللغتين فوري دون إعادة تحميل أو أي خلل بالتصميم.",
        },
      },
    ],
  },
];
