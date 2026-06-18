"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { MarketingShell } from "@/components/marketing/MarketingShell";

const LAST_UPDATED = "June 18, 2026";
const LAST_UPDATED_AR = "18 يونيو 2026";

const sections = {
  en: [
    {
      title: "1. Who we are",
      body: [
        "AutoFlow (\"AutoFlow\", \"we\", \"us\") provides a multi-tenant software platform that helps car dealerships manage inventory, customers, sales, and related operations (the \"Service\"). This policy explains what information we collect through the Service, why we collect it, and the choices you have.",
        "If you are a dealership employee using AutoFlow, your employer (the \"Organization\") is generally the controller of customer and business data you enter into the Service, and AutoFlow acts as a processor on the Organization's behalf. For account-level data (such as your login credentials), AutoFlow is the controller.",
      ],
    },
    {
      title: "2. Information we collect",
      body: [
        "Account information: name, email address, and authentication data, handled by our authentication provider (Clerk) when you sign up or sign in.",
        "Organization data: vehicle inventory, customer records, leads, sales, expenses, and other business records that you or your Organization enter into the Service.",
        "Usage data: pages visited, actions taken, device and browser information, and approximate location derived from IP address, collected to operate, secure, and improve the Service.",
        "Local preferences: your selected language and active organization are stored in your browser's local storage so the app remembers your preferences between sessions.",
        "Communications: if you contact us (e.g. via the Contact Us form or support email), we collect your name, email address, and the content of your message.",
      ],
    },
    {
      title: "3. How we use information",
      body: [
        "To provide, maintain, and secure the Service, including authenticating users and enforcing organization-level access controls.",
        "To respond to support requests and the messages you send us.",
        "To send transactional emails such as account credentials, task reminders, and team invitations.",
        "To monitor for misuse, enforce rate limits, and protect the Service and its users from abuse.",
        "To improve the Service based on aggregated, de-identified usage patterns.",
      ],
    },
    {
      title: "4. Sharing of information",
      body: [
        "We do not sell personal information. We share information only with the following categories of service providers, each bound by appropriate confidentiality and data-processing terms:",
        "Authentication: Clerk, for account creation, sign-in, and identity verification.",
        "Database & backend: Convex, which stores and serves application data on our behalf.",
        "Email delivery: Resend, used to send transactional and support emails.",
        "We may also disclose information if required by law, or to protect the rights, property, or safety of AutoFlow, our users, or others.",
      ],
    },
    {
      title: "5. Data retention",
      body: [
        "We retain account and organization data for as long as your Organization maintains an active subscription, plus a reasonable period thereafter to allow for account recovery, unless a shorter period is required by law or requested by your Organization's administrator.",
        "Soft-deleted records (e.g. archived vehicles or customers) are retained in a recoverable state until permanently purged by an Organization administrator or super-admin.",
      ],
    },
    {
      title: "6. Security",
      body: [
        "We use industry-standard safeguards including encrypted transport (HTTPS/TLS), role-based access control, organization-scoped data isolation, and audit logging of administrative actions. No method of transmission or storage is 100% secure, and we cannot guarantee absolute security.",
      ],
    },
    {
      title: "7. Your rights",
      body: [
        "Depending on your jurisdiction, you may have the right to access, correct, or request deletion of your personal information. Dealership employees should generally contact their Organization administrator, who can manage or remove your account from the Team settings page. You may also contact us directly at the email below.",
      ],
    },
    {
      title: "8. International data transfers",
      body: [
        "Our service providers may process data in countries other than your own. Where this occurs, we rely on our providers' contractual and technical safeguards to protect your information.",
      ],
    },
    {
      title: "9. Changes to this policy",
      body: [
        "We may update this policy from time to time. Material changes will be reflected by updating the \"last updated\" date below. Continued use of the Service after changes take effect constitutes acceptance of the revised policy.",
      ],
    },
    {
      title: "10. Contact us",
      body: [
        "Questions about this policy can be sent to support@autoflowdealer.com or via our Contact Us page.",
      ],
    },
  ],
  ar: [
    {
      title: "١. من نحن",
      body: [
        "تقدّم أوتوفلو (\"أوتوفلو\"، \"نحن\") منصة برمجية متعددة المستأجرين تساعد معارض السيارات على إدارة المخزون والعملاء والمبيعات والعمليات المرتبطة بها (\"الخدمة\"). توضح هذه السياسة المعلومات التي نجمعها عبر الخدمة، وأسباب جمعها، والخيارات المتاحة لك.",
        "إذا كنت موظفاً في معرض يستخدم أوتوفلو، فإن جهة عملك (\"المؤسسة\") هي عادةً المتحكم في بيانات العملاء والأعمال التي تُدخلها في الخدمة، وتعمل أوتوفلو كمعالج لهذه البيانات نيابةً عن المؤسسة. أما بيانات الحساب (مثل بيانات تسجيل الدخول)، فتُعد أوتوفلو فيها الجهة المتحكمة.",
      ],
    },
    {
      title: "٢. المعلومات التي نجمعها",
      body: [
        "بيانات الحساب: الاسم والبريد الإلكتروني وبيانات المصادقة، التي يديرها مزوّد المصادقة لدينا (Clerk) عند التسجيل أو تسجيل الدخول.",
        "بيانات المؤسسة: مخزون السيارات وسجلات العملاء والعملاء المحتملين والمبيعات والمصاريف وغيرها من السجلات التجارية التي تُدخلها أنت أو مؤسستك في الخدمة.",
        "بيانات الاستخدام: الصفحات التي تمت زيارتها والإجراءات المتخذة ومعلومات الجهاز والمتصفح والموقع التقريبي المستنتج من عنوان IP، وتُجمع لتشغيل الخدمة وتأمينها وتحسينها.",
        "التفضيلات المحلية: تُحفظ اللغة المختارة والمؤسسة النشطة في ذاكرة التخزين المحلية للمتصفح حتى يتذكر التطبيق تفضيلاتك بين الجلسات.",
        "المراسلات: في حال تواصلك معنا (مثلاً عبر نموذج تواصل معنا أو بريد الدعم)، نقوم بجمع اسمك وبريدك الإلكتروني ومحتوى رسالتك.",
      ],
    },
    {
      title: "٣. كيفية استخدام المعلومات",
      body: [
        "لتوفير الخدمة وصيانتها وتأمينها، بما في ذلك مصادقة المستخدمين وفرض ضوابط الوصول على مستوى المؤسسة.",
        "للرد على طلبات الدعم والرسائل التي ترسلها لنا.",
        "لإرسال رسائل بريد إلكتروني تشغيلية مثل بيانات الحساب وتذكيرات المهام ودعوات الفريق.",
        "لمراقبة سوء الاستخدام وفرض حدود معدل الطلبات وحماية الخدمة ومستخدميها من الإساءة.",
        "لتحسين الخدمة بناءً على أنماط استخدام مجمّعة وغير قابلة لتحديد الهوية.",
      ],
    },
    {
      title: "٤. مشاركة المعلومات",
      body: [
        "نحن لا نبيع المعلومات الشخصية. نشارك المعلومات فقط مع الفئات التالية من مزودي الخدمة، الملتزمين جميعاً بشروط سرية ومعالجة بيانات مناسبة:",
        "المصادقة: Clerk، لإنشاء الحسابات وتسجيل الدخول والتحقق من الهوية.",
        "قاعدة البيانات والخادم الخلفي: Convex، التي تخزّن وتقدّم بيانات التطبيق نيابةً عنا.",
        "إرسال البريد الإلكتروني: Resend، المستخدمة لإرسال رسائل الدعم والرسائل التشغيلية.",
        "قد نكشف أيضاً عن المعلومات إذا تطلب القانون ذلك، أو لحماية حقوق أوتوفلو أو ممتلكاتها أو سلامة مستخدميها أو الآخرين.",
      ],
    },
    {
      title: "٥. الاحتفاظ بالبيانات",
      body: [
        "نحتفظ ببيانات الحساب والمؤسسة طوال فترة اشتراك مؤسستك النشط، بالإضافة إلى فترة معقولة بعد ذلك للسماح باسترجاع الحساب، ما لم يتطلب القانون فترة أقصر أو يطلب مسؤول مؤسستك ذلك.",
        "تبقى السجلات المحذوفة بشكل مؤقت (مثل السيارات أو العملاء المؤرشفين) قابلة للاسترجاع إلى أن يقوم مسؤول المؤسسة أو المسؤول الأعلى بحذفها نهائياً.",
      ],
    },
    {
      title: "٦. الأمان",
      body: [
        "نستخدم إجراءات حماية معيارية في الصناعة، بما في ذلك النقل المشفّر (HTTPS/TLS)، والتحكم في الوصول حسب الأدوار، وعزل البيانات على مستوى المؤسسة، وتسجيل عمليات التدقيق للإجراءات الإدارية. لا توجد طريقة نقل أو تخزين آمنة بنسبة 100%، ولا يمكننا ضمان الأمان المطلق.",
      ],
    },
    {
      title: "٧. حقوقك",
      body: [
        "بحسب الولاية القضائية التي تخضع لها، قد يكون لديك الحق في الوصول إلى معلوماتك الشخصية أو تصحيحها أو طلب حذفها. يجب على موظفي المعارض عادةً التواصل مع مسؤول مؤسستهم، الذي يمكنه إدارة حسابك أو إزالته من صفحة إعدادات الفريق. يمكنك أيضاً التواصل معنا مباشرة عبر البريد الإلكتروني أدناه.",
      ],
    },
    {
      title: "٨. نقل البيانات الدولي",
      body: [
        "قد يقوم مزودو الخدمة لدينا بمعالجة البيانات في دول غير دولتك. في هذه الحالة، نعتمد على الضمانات التعاقدية والتقنية لدى مزودينا لحماية معلوماتك.",
      ],
    },
    {
      title: "٩. التعديلات على هذه السياسة",
      body: [
        "قد نقوم بتحديث هذه السياسة من وقت لآخر. سيتم توضيح أي تغييرات جوهرية بتحديث تاريخ \"آخر تحديث\" أدناه. يُعد استمرار استخدامك للخدمة بعد سريان التغييرات بمثابة موافقة على السياسة المُحدّثة.",
      ],
    },
    {
      title: "١٠. تواصل معنا",
      body: [
        "يمكن إرسال الأسئلة حول هذه السياسة إلى support@autoflowdealer.com أو عبر صفحة تواصل معنا.",
      ],
    },
  ],
};

export default function PrivacyPolicyPage() {
  const { locale } = useLanguage();
  const items = sections[locale] || sections.en;
  const lastUpdated = locale === "ar" ? LAST_UPDATED_AR : LAST_UPDATED;
  const title = locale === "ar" ? "سياسة الخصوصية" : "Privacy Policy";
  const updatedLabel = locale === "ar" ? "آخر تحديث:" : "Last updated:";

  return (
    <MarketingShell>
      <section className="container mx-auto px-6 py-20 max-w-3xl">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white mb-2">{title}</h1>
        <p className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-12">
          {updatedLabel} {lastUpdated}
        </p>

        <div className="space-y-10">
          {items.map((section, idx) => (
            <div key={idx}>
              <h2 className="text-lg font-bold text-white mb-3">{section.title}</h2>
              <div className="space-y-3">
                {section.body.map((paragraph, i) => (
                  <p key={i} className="text-sm text-white/65 leading-relaxed">
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </MarketingShell>
  );
}
