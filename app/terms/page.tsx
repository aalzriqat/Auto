"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { MarketingShell } from "@/components/marketing/MarketingShell";

const LAST_UPDATED = "June 18, 2026";
const LAST_UPDATED_AR = "18 يونيو 2026";

const sections = {
  en: [
    {
      title: "1. Agreement to terms",
      body: [
        "These Terms of Service (\"Terms\") govern access to and use of the AutoFlow platform (the \"Service\"), operated by AutoFlow (\"we\", \"us\"). By creating an account, joining an Organization, or otherwise using the Service, you agree to be bound by these Terms. If you do not agree, do not use the Service.",
      ],
    },
    {
      title: "2. Accounts and organizations",
      body: [
        "You must provide accurate information when creating an account. Each AutoFlow account belongs to one or more Organizations (dealerships); access within an Organization is governed by the role and permissions assigned by that Organization's administrators.",
        "You are responsible for safeguarding your login credentials and for all activity that occurs under your account. Notify us promptly if you suspect unauthorized access.",
      ],
    },
    {
      title: "3. Acceptable use",
      body: [
        "You agree not to: (a) use the Service for any unlawful purpose; (b) attempt to access data belonging to another Organization without authorization; (c) interfere with or disrupt the integrity or performance of the Service, including by circumventing rate limits or security controls; (d) reverse engineer or attempt to extract the source code of the Service except as permitted by law; or (e) upload content that infringes the rights of others.",
      ],
    },
    {
      title: "4. Subscriptions and payment",
      body: [
        "Paid plans are billed in advance on a monthly or annual basis as selected at signup. Fees are non-refundable except as required by law or expressly stated otherwise. We may change pricing with reasonable advance notice; continued use after a price change takes effect constitutes acceptance.",
        "Failure to pay applicable fees may result in suspension or termination of an Organization's access to the Service.",
      ],
    },
    {
      title: "5. Your data",
      body: [
        "As between you (or your Organization) and AutoFlow, you retain all rights to the business data you submit to the Service (vehicle records, customer information, sales data, and similar). You grant us a limited license to host, process, and display that data solely to provide the Service to you.",
        "You are responsible for ensuring you have the necessary rights and consents to submit customer and personal data into the Service, and for complying with applicable data protection laws in your jurisdiction.",
      ],
    },
    {
      title: "6. Approval workflows and data accuracy",
      body: [
        "The Service includes configurable approval workflows (e.g. for vehicle edits, status changes, and below-margin sales). These features are tools to support your internal processes; AutoFlow is not responsible for business decisions made using the Service, including pricing, financing, or sale terms offered to your customers.",
      ],
    },
    {
      title: "7. Suspension and termination",
      body: [
        "We may suspend or terminate access to the Service for any account or Organization that violates these Terms, poses a security risk, or fails to pay applicable fees, with notice where reasonably practicable. An Organization administrator may also deactivate or remove individual user accounts within their Organization at any time.",
        "Upon termination, your right to use the Service ceases immediately; provisions of these Terms that by their nature should survive (including Sections 5, 8, and 9) will continue to apply.",
      ],
    },
    {
      title: "8. Disclaimers and limitation of liability",
      body: [
        "The Service is provided \"as is\" and \"as available\" without warranties of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose, and non-infringement.",
        "To the maximum extent permitted by law, AutoFlow will not be liable for any indirect, incidental, special, consequential, or punitive damages, or for loss of profits, revenue, or data, arising out of or related to your use of the Service.",
      ],
    },
    {
      title: "9. Changes to these terms",
      body: [
        "We may update these Terms from time to time. Material changes will be reflected by updating the \"last updated\" date below. Continued use of the Service after changes take effect constitutes acceptance of the revised Terms.",
      ],
    },
    {
      title: "10. Contact us",
      body: [
        "Questions about these Terms can be sent to support@autoflowdealer.com or via our Contact Us page.",
      ],
    },
  ],
  ar: [
    {
      title: "١. الموافقة على الشروط",
      body: [
        "تحكم شروط الخدمة هذه (\"الشروط\") الوصول إلى منصة أوتوفلو واستخدامها (\"الخدمة\")، التي تديرها أوتوفلو (\"نحن\"). بإنشائك حساباً، أو انضمامك إلى مؤسسة، أو استخدامك للخدمة بأي شكل آخر، فإنك توافق على الالتزام بهذه الشروط. إذا كنت لا توافق، فالرجاء عدم استخدام الخدمة.",
      ],
    },
    {
      title: "٢. الحسابات والمؤسسات",
      body: [
        "يجب عليك تقديم معلومات دقيقة عند إنشاء الحساب. ينتمي كل حساب في أوتوفلو إلى مؤسسة واحدة أو أكثر (معارض السيارات)؛ ويُحدَّد الوصول داخل المؤسسة وفقاً للدور والصلاحيات التي يمنحها مسؤولو تلك المؤسسة.",
        "أنت مسؤول عن حماية بيانات تسجيل الدخول الخاصة بك وعن جميع الأنشطة التي تحدث ضمن حسابك. يرجى إبلاغنا فوراً في حال الاشتباه بوصول غير مصرح به.",
      ],
    },
    {
      title: "٣. الاستخدام المقبول",
      body: [
        "توافق على عدم: (أ) استخدام الخدمة لأي غرض غير قانوني؛ (ب) محاولة الوصول إلى بيانات تابعة لمؤسسة أخرى دون تصريح؛ (ج) التدخل في سلامة الخدمة أو أدائها أو تعطيلهما، بما في ذلك تجاوز حدود معدل الطلبات أو ضوابط الأمان؛ (د) إجراء هندسة عكسية أو محاولة استخراج الشيفرة المصدرية للخدمة إلا بما يسمح به القانون؛ أو (هـ) رفع محتوى ينتهك حقوق الآخرين.",
      ],
    },
    {
      title: "٤. الاشتراكات والدفع",
      body: [
        "تُفوتر الباقات المدفوعة مقدماً على أساس شهري أو سنوي حسب الاختيار عند التسجيل. الرسوم غير قابلة للاسترداد إلا إذا تطلب القانون ذلك أو نُص على خلاف ذلك صراحةً. يجوز لنا تغيير الأسعار بإشعار مسبق معقول؛ ويُعد استمرار الاستخدام بعد سريان تغيير السعر بمثابة موافقة عليه.",
        "قد يؤدي عدم سداد الرسوم المستحقة إلى تعليق أو إنهاء وصول المؤسسة إلى الخدمة.",
      ],
    },
    {
      title: "٥. بياناتك",
      body: [
        "فيما بينك (أو مؤسستك) وبين أوتوفلو، تحتفظ بجميع الحقوق على بيانات الأعمال التي تُدخلها في الخدمة (سجلات السيارات، معلومات العملاء، بيانات المبيعات، وما شابه). أنت تمنحنا ترخيصاً محدوداً لاستضافة هذه البيانات ومعالجتها وعرضها فقط لغرض تقديم الخدمة لك.",
        "أنت مسؤول عن التأكد من حصولك على الحقوق والموافقات اللازمة لإدخال بيانات العملاء والبيانات الشخصية في الخدمة، وعن الامتثال لقوانين حماية البيانات المعمول بها في ولايتك القضائية.",
      ],
    },
    {
      title: "٦. سلاسل الاعتماد ودقة البيانات",
      body: [
        "تتضمن الخدمة سلاسل اعتماد قابلة للتخصيص (مثل تعديلات السيارات وتغييرات الحالة والمبيعات منخفضة الهامش). هذه الميزات هي أدوات لدعم عملياتك الداخلية؛ ولا تتحمل أوتوفلو مسؤولية القرارات التجارية المتخذة باستخدام الخدمة، بما في ذلك التسعير أو التمويل أو شروط البيع المقدمة لعملائك.",
      ],
    },
    {
      title: "٧. التعليق والإنهاء",
      body: [
        "يجوز لنا تعليق أو إنهاء وصول أي حساب أو مؤسسة تنتهك هذه الشروط، أو تشكل خطراً أمنياً، أو تتخلف عن سداد الرسوم المستحقة، مع إشعار حيثما كان ذلك ممكناً عملياً. كما يمكن لمسؤول المؤسسة تعطيل أو إزالة حسابات مستخدمين فرديين داخل مؤسسته في أي وقت.",
        "عند الإنهاء، يتوقف حقك في استخدام الخدمة فوراً؛ وتستمر البنود التي تقتضي طبيعتها استمرارها (بما في ذلك البنود ٥ و٨ و٩) بالسريان.",
      ],
    },
    {
      title: "٨. إخلاء المسؤولية وتحديدها",
      body: [
        "تُقدَّم الخدمة \"كما هي\" و\"كما هي متاحة\" دون أي ضمانات من أي نوع، صريحة أو ضمنية، بما في ذلك ضمانات قابلية التسويق والملاءمة لغرض معين وعدم الانتهاك.",
        "إلى الحد الأقصى الذي يسمح به القانون، لن تكون أوتوفلو مسؤولة عن أي أضرار غير مباشرة أو عرضية أو خاصة أو تبعية أو تأديبية، أو عن خسارة الأرباح أو الإيرادات أو البيانات، الناشئة عن استخدامك للخدمة أو المرتبطة به.",
      ],
    },
    {
      title: "٩. التعديلات على هذه الشروط",
      body: [
        "قد نقوم بتحديث هذه الشروط من وقت لآخر. سيتم توضيح أي تغييرات جوهرية بتحديث تاريخ \"آخر تحديث\" أدناه. يُعد استمرار استخدامك للخدمة بعد سريان التغييرات بمثابة موافقة على الشروط المُحدّثة.",
      ],
    },
    {
      title: "١٠. تواصل معنا",
      body: [
        "يمكن إرسال الأسئلة حول هذه الشروط إلى support@autoflowdealer.com أو عبر صفحة تواصل معنا.",
      ],
    },
  ],
};

export default function TermsOfServicePage() {
  const { locale } = useLanguage();
  const items = sections[locale] || sections.en;
  const lastUpdated = locale === "ar" ? LAST_UPDATED_AR : LAST_UPDATED;
  const title = locale === "ar" ? "شروط الخدمة" : "Terms of Service";
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
