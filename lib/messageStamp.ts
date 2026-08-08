/**
 * Timestamp formatting for chat message bubbles.
 *
 * A bare "14:32" is ambiguous once a thread spans more than one day, so a stamp
 * only omits the date when the message was actually sent today.
 */

export interface FormatStampOptions {
  /** Localised label for "yesterday" (e.g. "Yesterday" / "أمس"). */
  yesterdayLabel: string;
  /** Injectable clock, so callers and tests can pin "now". Defaults to Date.now(). */
  now?: number;
}

/**
 * Formats a message timestamp:
 * - today             → `14:32`
 * - yesterday         → `Yesterday 14:32`
 * - earlier this year → `Mar 12, 14:32`
 * - a previous year   → `Mar 12, 2025, 14:32`
 */
export function formatMessageStamp(ts: number, options: FormatStampOptions): string {
  const { yesterdayLabel, now = Date.now() } = options;

  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const reference = new Date(now);
  const todayStart = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate()
  ).getTime();
  // Day arithmetic through the Date constructor rather than subtracting 24h, so
  // a DST transition cannot shift the boundary onto the wrong calendar day.
  const yesterdayStart = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() - 1
  ).getTime();

  if (ts >= todayStart) return time;
  if (ts >= yesterdayStart) return `${yesterdayLabel} ${time}`;

  const datePart = d.toLocaleDateString(
    [],
    d.getFullYear() === reference.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" }
  );
  return `${datePart} ${time}`;
}
