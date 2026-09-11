import { redirect } from "next/navigation";

/**
 * The legacy applications list. Its two jobs moved: the list is the Deals
 * list, and the "Review" dialog it mounted is retired — every command it
 * called is called from the Deal screen on the same mutation (SCRUM-215).
 *
 * Kept as a route so every existing link and notification that lands here
 * (`/{orgId}/applications`) keeps working; it forwards to `/deals`. The deal
 * deep links under `applications/[applicationId]/deal` are untouched.
 * Authorization is unchanged: `/deals` carries the same `view:sales` guard.
 */
export default async function ApplicationsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(`/${orgId}/deals`);
}
