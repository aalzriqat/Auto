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
  const dictionary = strings as Record<string, string>;
  const directional = supplierDirectionTemplate(type, values, dictionary);
  // A notification may omit a value it must not disclose (SCRUM-901: the supplier alert's `amount` for a recipient without
  // the statement permissions). Where the dictionary has a `_MessageNoAmount` sentence, that sentence is used when the
  // key is absent, so no raw {amount} placeholder is ever shown.
  const messageTemplate =
    ("amount" in values ? undefined : dictionary[`Notif_${key}_MessageNoAmount`]) ?? dictionary[`Notif_${key}_Message`];

  return {
    title: titleTemplate ? fill(titleTemplate, values) : type,
    message: directional ?? (messageTemplate ? fill(messageTemplate, values) : ""),
  };
}

/** Existing generic keys still render old/unknown-kind rows. Recognized obligations state both parties' direction. */
function supplierDirectionTemplate(type: string, values: Record<string, string | number>, dictionary: Record<string, string>): string | undefined {
  if (type !== "accounting.supplierObligationDue" && type !== "accounting.supplierObligationOverdue") return undefined;
  if (values.kind !== "PAYABLE" && values.kind !== "RECEIVABLE" && values.kind !== "RECOVERY") return undefined;
  const direction = values.kind === "PAYABLE" ? "YouOwe" : "OwesYou";
  const identity = typeof values.supplier === "string" && values.supplier.trim() ? "Named" : "Unnamed";
  const phraseKey = `Notif_Supplier${direction}${identity}`;
  const phrase = fill(("amount" in values ? undefined : dictionary[`${phraseKey}NoAmount`]) ?? dictionary[phraseKey], values);
  const key = toPascalCase(type);
  const suffix = "amount" in values ? "Directional" : "DirectionalNoAmount";
  return fill(dictionary[`Notif_${key}_${suffix}`], { ...values, direction: phrase });
}
