import { nativeRoutes } from "@autoflow/shared";

import type { SemanticIconName } from "../../components/Icon";

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
  icon: SemanticIconName;
  ownerOnly?: boolean;
  permission?: string;
  title: LocalizedLabel;
  subtitle: LocalizedLabel;
}

export const nativeModuleCategories: ReadonlyArray<{
  icon: SemanticIconName;
  id: NativeModuleCategory;
  title: LocalizedLabel;
}> = [
  { id: "operations", icon: "operations", title: { en: "Operations", ar: "التشغيل" } },
  { id: "pipeline", icon: "pipeline", title: { en: "Pipeline", ar: "المتابعة" } },
  { id: "finance", icon: "finance", title: { en: "Finance", ar: "المالية" } },
  { id: "admin", icon: "admin", title: { en: "Admin", ar: "الإدارة" } },
];

type NativeModuleAccessKind = "owner" | "permission" | "public";

type NativeModuleRow = readonly [
  NativeModuleId,
  NativeModuleCategory,
  NativeModuleAccessKind,
  SemanticIconName,
  string,
  string,
  string,
  string,
  string,
];

const nativeModuleRows = [
  ["marketplace", "operations", "permission", "marketplace", "marketplace:respond", "Marketplace Requests", "طلبات السوق", "Respond to buyer requests and trade-ins.", "الرد على طلبات المشترين وطلبات البدل."],
  ["vehicles", "operations", "permission", "vehicles", "view:vehicles", "Inventory", "المخزون", "View, add, edit, and archive vehicles.", "عرض وإضافة وتعديل وأرشفة السيارات."],
  ["customers", "operations", "permission", "customers", "view:customers", "Customers", "العملاء", "Manage customer profiles and contact details.", "إدارة ملفات العملاء وبيانات التواصل."],
  ["leads", "pipeline", "permission", "leads", "view:leads", "Leads", "العملاء المحتملون", "Track stages, assignments, and notes.", "تتبع المراحل والتعيينات والملاحظات."],
  ["messages", "pipeline", "public", "messages", "", "Messages", "الرسائل", "Chat with team members and groups.", "محادثة أعضاء الفريق والمجموعات."],
  ["socialInbox", "pipeline", "permission", "socialInbox", "view:leads", "Social Inbox", "وارد التواصل", "Review Instagram and Facebook conversations.", "مراجعة محادثات إنستغرام وفيسبوك."],
  ["notifications", "pipeline", "public", "notifications", "", "Notifications", "الإشعارات", "Read, archive, and clear workspace alerts.", "قراءة وأرشفة تنبيهات مساحة العمل."],
  ["tasks", "pipeline", "permission", "tasks", "view:tasks", "Tasks", "المهام", "Assign follow-ups and close work.", "تعيين المتابعات وإنهاء الأعمال."],
  ["sales", "finance", "permission", "sales", "view:sales", "Sales", "المبيعات", "Create drafts, complete deals, and cancel safely.", "إنشاء مسودات وإتمام الصفقات وإلغاؤها بأمان."],
  ["expenses", "finance", "permission", "expenses", "view:expenses", "Expenses", "المصاريف", "Record and review operational costs.", "تسجيل ومراجعة المصاريف التشغيلية."],
  ["accounting", "finance", "permission", "accounting", "view:finance", "Accounting", "المحاسبة", "Manage ledger transactions and cash movement.", "إدارة قيود الدفتر وحركة النقد."],
  ["sourcing", "finance", "permission", "sourcing", "view:finance", "Sourcing", "التوريد", "Track supplier payables for sourced vehicles.", "متابعة مستحقات الموردين للسيارات الموردة."],
  ["reports", "finance", "permission", "reports", "view:reports", "Reports", "التقارير", "Sales, inventory, expenses, and conversion.", "المبيعات والمخزون والمصاريف والتحويل."],
  ["commissions", "finance", "permission", "commissions", "view:commissions", "Commissions", "العمولات", "Review and mark commission payments.", "مراجعة وتسجيل دفعات العمولات."],
  ["quotes", "finance", "public", "quotes", "", "Quotes", "العروض", "Build finance quotes and update statuses.", "إنشاء عروض التمويل وتحديث حالاتها."],
  ["team", "admin", "permission", "team", "manage:users", "Team", "الفريق", "See members, roles, and commission rates.", "عرض الأعضاء والأدوار ونسب العمولة."],
  ["applications", "finance", "permission", "applications", "view:sales", "Applications", "طلبات التمويل", "Review finance applications and statuses.", "مراجعة طلبات التمويل وحالاتها."],
  ["approvals", "admin", "permission", "approvals", "manage:users", "Approvals", "الموافقات", "Approve or reject pending deal requests.", "قبول أو رفض طلبات الصفقات المعلقة."],
  ["financeCompanies", "admin", "owner", "financeCompanies", "", "Finance Companies", "شركات التمويل", "Configure lending rates and terms.", "ضبط نسب وشروط شركات التمويل."],
  ["valuationCompanies", "admin", "owner", "valuationCompanies", "", "Valuation Companies", "شركات التقييم", "Manage trade-in valuation partners.", "إدارة جهات تقييم سيارات البدل."],
  ["branches", "admin", "owner", "branches", "", "Branches", "الفروع", "Manage showroom locations and managers.", "إدارة مواقع المعارض والمدراء."],
  ["roles", "admin", "owner", "roles", "", "Roles", "الأدوار", "Create and edit permission groups.", "إنشاء وتعديل مجموعات الصلاحيات."],
  ["pipelineSettings", "admin", "owner", "pipelineSettings", "", "Pipeline Settings", "إعدادات المتابعة", "Seed, rename, color, and activate lead stages.", "تهيئة وتسمية وتلوين مراحل العملاء المحتملين."],
  ["leadSources", "admin", "owner", "leadSources", "", "Lead Sources", "مصادر العملاء", "Manage source lists used by leads and reports.", "إدارة مصادر العملاء المستخدمة في المتابعة والتقارير."],
  ["customFields", "admin", "owner", "customFields", "", "Custom Fields", "الحقول المخصصة", "Create extra fields for vehicles, customers, and leads.", "إنشاء حقول إضافية للسيارات والعملاء والعملاء المحتملين."],
  ["commissionSettings", "admin", "owner", "commissionSettings", "", "Commission Settings", "إعدادات العمولات", "Set commission mode and profit tiers.", "ضبط نظام العمولة وشرائح الربح."],
  ["integrations", "admin", "owner", "integrations", "", "Integrations", "الربط", "Configure social auto-replies and lead creation.", "ضبط الردود التلقائية وإنشاء العملاء من التواصل."],
  ["website", "admin", "owner", "website", "", "Website", "الموقع", "Manage the public dealer website natively.", "إدارة موقع المعرض العام من التطبيق."],
  ["marketplaceSettings", "admin", "owner", "marketplaceSettings", "", "Marketplace Settings", "إعدادات السوق", "Control dealer directory profile and lead package status.", "إدارة ملف السوق وحالة باقة العملاء."],
  ["feedback", "admin", "owner", "feedback", "", "Feedback", "الملاحظات", "Submit and resolve product feedback.", "إرسال ومتابعة ملاحظات المنتج."],
  ["billing", "admin", "owner", "billing", "", "Billing", "الفوترة", "Review plan limits and request upgrades.", "مراجعة حدود الخطة وطلب الترقية."],
  ["settings", "admin", "owner", "settings", "", "Settings", "الإعدادات", "View workspace configuration and permissions.", "عرض إعدادات مساحة العمل والصلاحيات."],
] as const satisfies ReadonlyArray<NativeModuleRow>;

function buildNativeModuleAccess(
  accessKind: NativeModuleAccessKind,
  permission: string,
): Pick<NativeModuleDefinition, "ownerOnly" | "permission"> {
  if (accessKind === "owner") {
    return { ownerOnly: true };
  }

  if (accessKind === "permission") {
    return { permission };
  }

  return {};
}

export const nativeModules: ReadonlyArray<NativeModuleDefinition> = nativeModuleRows.map((
  [id, category, accessKind, icon, permission, titleEn, titleAr, subtitleEn, subtitleAr],
) => ({
  id,
  category,
  icon,
  ...buildNativeModuleAccess(accessKind, permission),
  title: { en: titleEn, ar: titleAr },
  subtitle: { en: subtitleEn, ar: subtitleAr },
}));

export function labelFor(label: LocalizedLabel, locale: "en" | "ar"): string {
  return label[locale] || label.en;
}

export function compactInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "A";
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? "F";
  return `${first}${second}`.toUpperCase();
}

export function nativeModulePath(
  moduleId: NativeModuleId | string,
): typeof nativeRoutes.orgMarketplace | typeof nativeRoutes.orgModule {
  return moduleId === "marketplace" ? nativeRoutes.orgMarketplace : nativeRoutes.orgModule;
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

export function getVisibleNativeModules(
  permissions: readonly string[] = [],
  roleName?: string,
): NativeModuleDefinition[] {
  return nativeModules.filter((module) => canAccessNativeModule(module, permissions, roleName));
}

export function moduleSearchText(
  module: NativeModuleDefinition,
  locale: "en" | "ar",
): string {
  return [
    module.id,
    module.category,
    module.permission ?? "",
    labelFor(module.title, locale),
    labelFor(module.subtitle, locale),
    module.title.en,
    module.title.ar,
    module.subtitle.en,
    module.subtitle.ar,
  ]
    .join(" ")
    .toLowerCase();
}

export function searchNativeModules(
  modules: readonly NativeModuleDefinition[],
  query: string,
  locale: "en" | "ar",
): NativeModuleDefinition[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [...modules];
  }

  return modules.filter((module) => moduleSearchText(module, locale).includes(normalizedQuery));
}

export function countVisibleNativeModulesByCategory(
  category: NativeModuleCategory,
  permissions: readonly string[] = [],
  roleName?: string,
): number {
  return getVisibleNativeModulesByCategory(category, permissions, roleName).length;
}
