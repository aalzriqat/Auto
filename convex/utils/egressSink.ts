/**
 * Preview egress sink (SCRUM-639).
 *
 * Invariant: a deployment that declares itself a disposable preview never
 * delivers a notification to a real person — no email, WhatsApp, SMS, web
 * push or Expo push leaves it. Every other deployment behaves exactly as if
 * this module did not exist.
 *
 * QA explorers create customers, leads and tasks on the shared E2E preview,
 * and those writes fan out to `dispatch()`, the task-alarm cron and collection
 * reminders. Most senders only stay quiet there because a provider key happens
 * to be unset; WhatsApp (per-org DB credentials) and Expo push (no credential
 * at all) have no such accident to rely on. So the check sits at the top of
 * each sender, after any rate limit and before any network call — not in
 * `dispatch()` alone, which the cron and the reminders bypass.
 *
 * Both conditions must hold, so a single misconfiguration cannot turn
 * delivery off in production:
 *
 * 1. `AUTOFLOW_DEPLOYMENT_CLASS` is exactly `"preview"`. It is a Convex project
 *    default scoped to Preview only, which production and dev never carry
 *    (see convex/e2eBootstrap.ts — CI must never supply it).
 * 2. The deployment's own `CONVEX_CLOUD_URL` names a deployment, and that name
 *    is not production's. An unreadable URL fails toward delivering, i.e.
 *    toward today's behaviour.
 *
 * Reads `process.env` directly rather than `getValidatedEnv()`: several
 * senders never validate the env, and this must not add a way for them to
 * throw.
 */

/** The production deployment. Delivery there must never be sunk. */
export const PRODUCTION_DEPLOYMENT_NAME = "kindly-hound-172";

export type EgressChannel = "email" | "whatsapp" | "sms" | "web-push" | "expo-push";

/**
 * The deployment's name from its host's first label. Same parse as
 * `deploymentNameFromUrl` in convex/e2eBootstrap.ts, which is module-private
 * there and lives beside Convex function registrations this helper should not
 * import.
 */
function deploymentName(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const [name] = new URL(url.trim()).hostname.split(".");
    return name?.trim() ? name : null;
  } catch {
    return null;
  }
}

export function isEgressSinkActive(): boolean {
  if (process.env.AUTOFLOW_DEPLOYMENT_CLASS !== "preview") return false;
  const name = deploymentName(process.env.CONVEX_CLOUD_URL);
  return name !== null && name !== PRODUCTION_DEPLOYMENT_NAME;
}

/**
 * True when this send must be dropped. Logs the channel and the sender only —
 * never a recipient, token or body.
 */
export function sinkEgress(channel: EgressChannel, sender: string): boolean {
  if (!isEgressSinkActive()) return false;
  console.log(`[egressSink] preview: ${channel} send held by the sink: sender=${sender}`);
  return true;
}
