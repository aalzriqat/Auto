import type { MobileOrgSummary } from "../../convexApi";

export type HomeLocale = "en" | "ar";

export type HomeWorkflowTarget =
  | "dashboard"
  | "vehicles"
  | "leads"
  | "sales"
  | "messages"
  | "marketplace";

export type HomeWorkflowAction = {
  kicker: string;
  moduleId?: "vehicles" | "leads" | "sales" | "messages";
  subtitle: string;
  target: HomeWorkflowTarget;
  title: string;
  tone: "dark" | "mint" | "amber" | "blue";
};

type WorkflowDefinition = {
  moduleId?: HomeWorkflowAction["moduleId"];
  target: HomeWorkflowTarget;
  tone: HomeWorkflowAction["tone"];
  en: Pick<HomeWorkflowAction, "kicker" | "subtitle" | "title">;
  ar: Pick<HomeWorkflowAction, "kicker" | "subtitle" | "title">;
};

const WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  {
    target: "dashboard",
    tone: "dark",
    en: {
      kicker: "Cockpit",
      title: "Open dashboard",
      subtitle: "KPIs, work queues, quality warnings",
    },
    ar: {
      kicker: "القيادة",
      title: "لوحة التحكم",
      subtitle: "المؤشرات، قوائم العمل، تنبيهات الجودة",
    },
  },
  {
    target: "vehicles",
    moduleId: "vehicles",
    tone: "mint",
    en: {
      kicker: "Inventory",
      title: "Manage stock",
      subtitle: "Media, pricing, status, margin",
    },
    ar: {
      kicker: "المخزون",
      title: "إدارة السيارات",
      subtitle: "الصور، الأسعار، الحالة، الهامش",
    },
  },
  {
    target: "leads",
    moduleId: "leads",
    tone: "amber",
    en: {
      kicker: "CRM",
      title: "Capture lead",
      subtitle: "Customer, vehicle, owner, stage",
    },
    ar: {
      kicker: "العملاء",
      title: "تسجيل عميل محتمل",
      subtitle: "العميل، السيارة، المسؤول، المرحلة",
    },
  },
  {
    target: "sales",
    moduleId: "sales",
    tone: "blue",
    en: {
      kicker: "Sales",
      title: "Start deal",
      subtitle: "Buyer, vehicle, financing, review",
    },
    ar: {
      kicker: "المبيعات",
      title: "بدء صفقة",
      subtitle: "المشتري، السيارة، التمويل، المراجعة",
    },
  },
  {
    target: "messages",
    moduleId: "messages",
    tone: "mint",
    en: {
      kicker: "Inbox",
      title: "Open messages",
      subtitle: "Team conversations and follow ups",
    },
    ar: {
      kicker: "الرسائل",
      title: "فتح المحادثات",
      subtitle: "محادثات الفريق والمتابعة",
    },
  },
  {
    target: "marketplace",
    tone: "amber",
    en: {
      kicker: "Market",
      title: "Browse marketplace",
      subtitle: "Dealers, requests, trade-ins",
    },
    ar: {
      kicker: "السوق",
      title: "تصفح السوق",
      subtitle: "المعارض، الطلبات، الاستبدال",
    },
  },
];

export function workspaceInitials(name: string | undefined): string {
  const parts = (name || "Auto Flow")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? "A";
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? "F";
  return `${first}${second}`.toUpperCase();
}

export function workspaceSearchText(org: MobileOrgSummary): string {
  return [org.name, org.roleName, org._id].filter(Boolean).join(" ").toLowerCase();
}

export function getSafeWorkspaces(
  orgs: Array<MobileOrgSummary | null> | undefined,
): MobileOrgSummary[] {
  return (orgs ?? []).filter((org): org is MobileOrgSummary => org !== null);
}

export function filterWorkspaces(
  orgs: Array<MobileOrgSummary | null> | undefined,
  query: string,
): MobileOrgSummary[] {
  const safeOrgs = getSafeWorkspaces(orgs);
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return safeOrgs;
  }

  return safeOrgs.filter((org) => workspaceSearchText(org).includes(normalizedQuery));
}

export function getPrimaryWorkspace(
  filteredOrgs: readonly MobileOrgSummary[],
  allOrgs: readonly MobileOrgSummary[],
): MobileOrgSummary | null {
  return filteredOrgs[0] ?? allOrgs[0] ?? null;
}

export function getHomeWorkflowActions(locale: HomeLocale): HomeWorkflowAction[] {
  return WORKFLOW_DEFINITIONS.map((definition) => {
    const labels = locale === "ar" ? definition.ar : definition.en;

    return {
      ...labels,
      moduleId: definition.moduleId,
      target: definition.target,
      tone: definition.tone,
    };
  });
}
