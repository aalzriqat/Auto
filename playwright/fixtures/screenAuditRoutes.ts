/** Reviewed audit scope shared by the original screen hunter and the role matrix. */
export const SCREEN_AUDIT_ROUTES = [
  "dashboard", "accounting", "applications", "approvals", "commissions", "customers", "deals", "expenses",
  "leads", "marketplace/requests", "messages", "notifications", "payroll", "reports", "sales", "sales/sales",
  "settings/billing", "settings/branches", "settings/commission", "settings/custom-fields", "settings/feedback",
  "settings/finance", "settings/general", "settings/integrations", "settings/lead-sources", "settings/marketplace",
  "settings/pipeline", "settings/valuation-companies", "settings/website", "social-inbox", "sourcing", "suppliers", "tasks", "team", "vehicles",
] as const;

export type ScreenAuditRoute = typeof SCREEN_AUDIT_ROUTES[number];

/** Intentional redirects in applications/page.tsx and dashboard/page.tsx. */
export function auditDestination(route: ScreenAuditRoute, roleName: string): ScreenAuditRoute {
  if (route === "applications") return "deals";
  if (route !== "dashboard") return route;
  switch (roleName.toUpperCase()) {
    case "SALES":
    case "SALESPERSON": return "sales";
    case "RECEPTION": return "leads";
    case "ACCOUNTANT":
    case "SENIOR_ACCOUNTANT": return "accounting";
    default: return route;
  }
}

/**
 * Source-enumerated route-level RoleGuard requirements. Navigation has its own
 * permission metadata in lib/navigation.ts; neither proves backend dominance.
 * Settings inherit settings/layout.tsx's ownerOnly guard. Applications redirects
 * to Deals. Approvals requires either queue authority, then gates each queue.
 */
export const ROLE_ROUTE_GUARDS: Partial<Record<ScreenAuditRoute, readonly string[]>> = {
  accounting: ["view:finance"], applications: ["view:sales"], commissions: ["view:commissions"],
  customers: ["view:customers"], deals: ["view:sales"], expenses: ["view:expenses"],
  leads: ["view:leads"], payroll: ["view:payroll"], reports: ["view:reports"],
  sales: ["view:sales"], "sales/sales": ["view:sales"], "social-inbox": ["view:leads"],
  tasks: ["view:tasks"], team: ["view:users"], vehicles: ["view:vehicles"],
  sourcing: ["view:finance"], suppliers: ["view:finance"],
  "marketplace/requests": ["marketplace:respond"],
};

/** Approvals contains independent profit and deposit confirmation queues. */
export const ROLE_ROUTE_ANY_GUARDS: Partial<Record<ScreenAuditRoute, readonly string[]>> = {
  approvals: ["approve:requests", "confirm:finance_disbursement"],
};
