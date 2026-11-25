/** Why the report area shows a note instead of figures, or null when it may show them. */export function reportAccessMessage({ permissionsLoading, canSeeCost, report, requiresUpdate }: {
  permissionsLoading: boolean;
  canSeeCost: boolean;
  report: unknown;
  requiresUpdate: boolean;
}): "ReportsCostAccessRequired" | "ReportUpdateRequired" | "Loading" | null {
  if (!permissionsLoading && !canSeeCost) return "ReportsCostAccessRequired";
  if (report != null) return null;
  if (requiresUpdate) return "ReportUpdateRequired";
  if (report === null) return "ReportsCostAccessRequired";
  return "Loading";
}
