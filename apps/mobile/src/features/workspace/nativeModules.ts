export type NativeModuleCategory = "operations" | "pipeline" | "finance" | "admin";

export type NativeModuleId =
  | "marketplace"
  | "vehicles"
  | "customers"
  | "leads"
  | "messages"
  | "socialInbox"
  | "notifications"
  | "tasks"
  | "sales"
  | "expenses"
  | "accounting"
  | "sourcing"
  | "reports"
  | "team"
  | "applications"
  | "approvals"
  | "commissions"
  | "quotes"
  | "financeCompanies"
  | "valuationCompanies"
  | "branches"
  | "roles"
  | "pipelineSettings"
  | "leadSources"
  | "customFields"
  | "commissionSettings"
  | "integrations"
  | "website"
  | "marketplaceSettings"
  | "feedback"
  | "billing"
  | "settings";

export type LocalizedLabel = {
  en: string;
  ar: string;
};

export interface NativeModuleDefinition {
  id: NativeModuleId;
  category: NativeModuleCategory;
  ownerOnly?: boolean;
  permission?: string;
  title: LocalizedLabel;
  subtitle: LocalizedLabel;
}

export const nativeModuleCategories: ReadonlyArray<{
  id: NativeModuleCategory;
  title: LocalizedLabel;
}> = [
  { id: "operations", title: { en: "Operations", ar: "التشغيل" } },
  { id: "pipeline", title: { en: "Pipeline", ar: "المتابعة" } },
  { id: "finance", title: { en: "Finance", ar: "المالية" } },
  { id: "admin", title: { en: "Admin", ar: "الإدارة" } },
];

export const nativeModules: ReadonlyArray<NativeModuleDefinition> = [
  {
    id: "marketplace",
    category: "operations",
    permission: "marketplace:respond",
    title: { en: "Marketplace Requests", ar: "طلبات السوق" },
    subtitle: { en: "Respond to buyer requests and trade-ins.", ar: "الرد على طلبات المشترين وطلبات البدل." },
  },
  {
    id: "vehicles",
    category: "operations",
    permission: "view:vehicles",
    title: { en: "Inventory", ar: "المخزون" },
    subtitle: { en: "View, add, edit, and archive vehicles.", ar: "عرض وإضافة وتعديل وأرشفة السيارات." },
  },
  {
    id: "customers",
    category: "operations",
    permission: "view:customers",
    title: { en: "Customers", ar: "العملاء" },
    subtitle: { en: "Manage customer profiles and contact details.", ar: "إدارة ملفات العملاء وبيانات التواصل." },
  },
  {
    id: "leads",
    category: "pipeline",
    permission: "view:leads",
    title: { en: "Leads", ar: "العملاء المحتملون" },
    subtitle: { en: "Track stages, assignments, and notes.", ar: "تتبع المراحل والتعيينات والملاحظات." },
  },
  {
    id: "messages",
    category: "pipeline",
    title: { en: "Messages", ar: "الرسائل" },
    subtitle: { en: "Chat with team members and groups.", ar: "محادثة أعضاء الفريق والمجموعات." },
  },
  {
    id: "socialInbox",
    category: "pipeline",
    permission: "view:leads",
    title: { en: "Social Inbox", ar: "وارد التواصل" },
    subtitle: { en: "Review Instagram and Facebook conversations.", ar: "مراجعة محادثات إنستغرام وفيسبوك." },
  },
  {
    id: "notifications",
    category: "pipeline",
    title: { en: "Notifications", ar: "الإشعارات" },
    subtitle: { en: "Read, archive, and clear workspace alerts.", ar: "قراءة وأرشفة تنبيهات مساحة العمل." },
  },
  {
    id: "tasks",
    category: "pipeline",
    permission: "view:tasks",
    title: { en: "Tasks", ar: "المهام" },
    subtitle: { en: "Assign follow-ups and close work.", ar: "تعيين المتابعات وإنهاء الأعمال." },
  },
  {
    id: "sales",
    category: "finance",
    permission: "view:sales",
    title: { en: "Sales", ar: "المبيعات" },
    subtitle: { en: "Create drafts, complete deals, and cancel safely.", ar: "إنشاء مسودات وإتمام الصفقات وإلغاؤها بأمان." },
  },
  {
    id: "expenses",
    category: "finance",
    permission: "view:expenses",
    title: { en: "Expenses", ar: "المصاريف" },
    subtitle: { en: "Record and review operational costs.", ar: "تسجيل ومراجعة المصاريف التشغيلية." },
  },
  {
    id: "accounting",
    category: "finance",
    permission: "view:finance",
    title: { en: "Accounting", ar: "المحاسبة" },
    subtitle: { en: "Manage ledger transactions and cash movement.", ar: "إدارة قيود الدفتر وحركة النقد." },
  },
  {
    id: "sourcing",
    category: "finance",
    permission: "view:finance",
    title: { en: "Sourcing", ar: "التوريد" },
    subtitle: { en: "Track supplier payables for sourced vehicles.", ar: "متابعة مستحقات الموردين للسيارات الموردة." },
  },
  {
    id: "reports",
    category: "finance",
    permission: "view:reports",
    title: { en: "Reports", ar: "التقارير" },
    subtitle: { en: "Sales, inventory, expenses, and conversion.", ar: "المبيعات والمخزون والمصاريف والتحويل." },
  },
  {
    id: "commissions",
    category: "finance",
    permission: "view:commissions",
    title: { en: "Commissions", ar: "العمولات" },
    subtitle: { en: "Review and mark commission payments.", ar: "مراجعة وتسجيل دفعات العمولات." },
  },
  {
    id: "quotes",
    category: "finance",
    title: { en: "Quotes", ar: "العروض" },
    subtitle: { en: "Build finance quotes and update statuses.", ar: "إنشاء عروض التمويل وتحديث حالاتها." },
  },
  {
    id: "team",
    category: "admin",
    permission: "manage:users",
    title: { en: "Team", ar: "الفريق" },
    subtitle: { en: "See members, roles, and commission rates.", ar: "عرض الأعضاء والأدوار ونسب العمولة." },
  },
  {
    id: "applications",
    category: "finance",
    permission: "view:sales",
    title: { en: "Applications", ar: "طلبات التمويل" },
    subtitle: { en: "Review finance applications and statuses.", ar: "مراجعة طلبات التمويل وحالاتها." },
  },
  {
    id: "approvals",
    category: "admin",
    permission: "manage:users",
    title: { en: "Approvals", ar: "الموافقات" },
    subtitle: { en: "Approve or reject pending deal requests.", ar: "قبول أو رفض طلبات الصفقات المعلقة." },
  },
  {
    id: "financeCompanies",
    category: "admin",
    ownerOnly: true,
    title: { en: "Finance Companies", ar: "شركات التمويل" },
    subtitle: { en: "Configure lending rates and terms.", ar: "ضبط نسب وشروط شركات التمويل." },
  },
  {
    id: "valuationCompanies",
    category: "admin",
    ownerOnly: true,
    title: { en: "Valuation Companies", ar: "شركات التقييم" },
    subtitle: { en: "Manage trade-in valuation partners.", ar: "إدارة جهات تقييم سيارات البدل." },
  },
  {
    id: "branches",
    category: "admin",
    ownerOnly: true,
    title: { en: "Branches", ar: "الفروع" },
    subtitle: { en: "Manage showroom locations and managers.", ar: "إدارة مواقع المعارض والمدراء." },
  },
  {
    id: "roles",
    category: "admin",
    ownerOnly: true,
    title: { en: "Roles", ar: "الأدوار" },
    subtitle: { en: "Create and edit permission groups.", ar: "إنشاء وتعديل مجموعات الصلاحيات." },
  },
  {
    id: "pipelineSettings",
    category: "admin",
    ownerOnly: true,
    title: { en: "Pipeline Settings", ar: "إعدادات المتابعة" },
    subtitle: { en: "Seed, rename, color, and activate lead stages.", ar: "تهيئة وتسمية وتلوين مراحل العملاء المحتملين." },
  },
  {
    id: "leadSources",
    category: "admin",
    ownerOnly: true,
    title: { en: "Lead Sources", ar: "مصادر العملاء" },
    subtitle: { en: "Manage source lists used by leads and reports.", ar: "إدارة مصادر العملاء المستخدمة في المتابعة والتقارير." },
  },
  {
    id: "customFields",
    category: "admin",
    ownerOnly: true,
    title: { en: "Custom Fields", ar: "الحقول المخصصة" },
    subtitle: { en: "Create extra fields for vehicles, customers, and leads.", ar: "إنشاء حقول إضافية للسيارات والعملاء والعملاء المحتملين." },
  },
  {
    id: "commissionSettings",
    category: "admin",
    ownerOnly: true,
    title: { en: "Commission Settings", ar: "إعدادات العمولات" },
    subtitle: { en: "Set commission mode and profit tiers.", ar: "ضبط نظام العمولة وشرائح الربح." },
  },
  {
    id: "integrations",
    category: "admin",
    ownerOnly: true,
    title: { en: "Integrations", ar: "الربط" },
    subtitle: { en: "Configure social auto-replies and lead creation.", ar: "ضبط الردود التلقائية وإنشاء العملاء من التواصل." },
  },
  {
    id: "website",
    category: "admin",
    ownerOnly: true,
    title: { en: "Website", ar: "الموقع" },
    subtitle: { en: "Manage the public dealer website natively.", ar: "إدارة موقع المعرض العام من التطبيق." },
  },
  {
    id: "marketplaceSettings",
    category: "admin",
    ownerOnly: true,
    title: { en: "Marketplace Settings", ar: "إعدادات السوق" },
    subtitle: { en: "Control dealer directory profile and lead package status.", ar: "إدارة ملف السوق وحالة باقة العملاء." },
  },
  {
    id: "feedback",
    category: "admin",
    ownerOnly: true,
    title: { en: "Feedback", ar: "الملاحظات" },
    subtitle: { en: "Submit and resolve product feedback.", ar: "إرسال ومتابعة ملاحظات المنتج." },
  },
  {
    id: "billing",
    category: "admin",
    ownerOnly: true,
    title: { en: "Billing", ar: "الفوترة" },
    subtitle: { en: "Review plan limits and request upgrades.", ar: "مراجعة حدود الخطة وطلب الترقية." },
  },
  {
    id: "settings",
    category: "admin",
    ownerOnly: true,
    title: { en: "Settings", ar: "الإعدادات" },
    subtitle: { en: "View workspace configuration and permissions.", ar: "عرض إعدادات مساحة العمل والصلاحيات." },
  },
];

export function labelFor(label: LocalizedLabel, locale: "en" | "ar"): string {
  return label[locale] || label.en;
}

export function getNativeModule(moduleId: string | null | undefined): NativeModuleDefinition | null {
  return nativeModules.find((module) => module.id === moduleId) ?? null;
}

export function getNativeModulesByCategory(
  category: NativeModuleCategory,
): NativeModuleDefinition[] {
  return nativeModules.filter((module) => module.category === category);
}

export function canAccessNativeModule(
  module: NativeModuleDefinition,
  permissions: readonly string[] = [],
  roleName?: string,
): boolean {
  if (module.ownerOnly) {
    return roleName?.toUpperCase() === "OWNER";
  }

  if (!module.permission) {
    return true;
  }

  return permissions.includes(module.permission);
}

export function getVisibleNativeModulesByCategory(
  category: NativeModuleCategory,
  permissions: readonly string[] = [],
  roleName?: string,
): NativeModuleDefinition[] {
  return getNativeModulesByCategory(category).filter((module) =>
    canAccessNativeModule(module, permissions, roleName),
  );
}
