import { notificationsEn, notificationsAr } from "../i18n/domains/notifications";
import { NotificationType, isNotificationType } from "./types";

/** Same {placeholder} interpolation convention as convex/utils/smartReplyBuilder.ts. */
function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`\\{${key}\\}`, "g"), String(value)),
    template
  );
}

/** "vehicle.status_request_created" -> "VehicleStatusRequestCreated" */
function toPascalCase(type: string): string {
  return type
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export interface RenderedNotification {
  title: string;
  message: string;
}

/**
 * Renders a typed notification's title/message in the given locale. Used by
 * every channel (in-app bell/page, email, WhatsApp) so copy never drifts
 * between them. Pure and defensive: an unknown type or missing template
 * falls back to the raw type string rather than throwing, since this runs
 * from contexts (scheduled actions) that shouldn't fail loudly over copy.
 */
export function renderNotification(
  locale: "en" | "ar",
  type: string,
  data: Record<string, string | number> | undefined
): RenderedNotification {
  const strings = locale === "ar" ? notificationsAr : notificationsEn;
  const values = data ?? {};

  if (!isNotificationType(type)) {
    return { title: type, message: "" };
  }

  // Admin-authored broadcasts carry their own free-form text in `data`
  // (a super admin types it directly, so there's no per-locale template).
  if (type === "system.announcement") {
    return { title: String(values.title ?? ""), message: String(values.message ?? "") };
  }

  const key = toPascalCase(type as NotificationType);
  const titleTemplate = (strings as Record<string, string>)[`Notif_${key}_Title`];
  const messageTemplate = (strings as Record<string, string>)[`Notif_${key}_Message`];

  return {
    title: titleTemplate ? fill(titleTemplate, values) : type,
    message: messageTemplate ? fill(messageTemplate, values) : "",
  };
}
