import type { MobileOrgSummary } from "../../convexApi";

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
