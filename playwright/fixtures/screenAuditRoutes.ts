/** Reviewed audit scope shared by the original screen hunter and the role matrix. */
export const SCREEN_AUDIT_ROUTES = [
  "dashboard", "accounting", "applications", "approvals", "commissions", "customers", "deals", "expenses",
  "leads", "marketplace/requests", "messages", "notifications", "payroll", "reports", "sales", "sales/sales",
  "settings/billing", "settings/branches", "settings/commission", "settings/custom-fields", "settings/feedback",
  "settings/finance", "settings/general", "settings/integrations", "settings/lead-sources", "settings/marketplace",
  "settings/pipeline", "settings/valuation-companies", "settings/website", "social-inbox", "sourcing", "tasks", "team", "vehicles",
] as const;

export type ScreenAuditRoute = typeof SCREEN_AUDIT_ROUTES[number];

/**
 * Source-enumerated route-level RoleGuard requirements. Navigation has its own
 * permission metadata in lib/navigation.ts; neither proves backend dominance.
 * Settings inherit settings/layout.tsx's ownerOnly guard. Applications redirects
 * to Deals. Unguarded shells (e.g. Approvals) gate each data queue separately.
 */
export const ROLE_ROUTE_GUARDS: Partial<Record<ScreenAuditRoute, readonly string[]>> = {
  accounting: ["view:finance"], applications: ["view:sales"], commissions: ["view:commissions"],
  customers: ["view:customers"], deals: ["view:sales"], expenses: ["view:expenses"],
  leads: ["view:leads"], payroll: ["view:payroll"], reports: ["view:reports"],
  sales: ["view:sales"], "sales/sales": ["view:sales"], "social-inbox": ["view:leads"],
  tasks: ["view:tasks"], team: ["view:users"], vehicles: ["view:vehicles"],
};
