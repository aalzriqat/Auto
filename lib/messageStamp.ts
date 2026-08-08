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
  /**
   * Locale for the date/time parts. Defaults to the runtime locale, matching
   * the rest of components/messages (ConversationList, FloatingMessenger),
   * so a bubble stamp and a conversation-row stamp never disagree. Tests pin
   * this to keep assertions independent of the CI machine's locale.
   */
  locale?: string | string[];
}

/**
 * A stamp split into a localised prefix and the Latin date/time run.
 *
 * They are kept apart because the prefix comes from the app's dictionary
 * (Arabic under an Arabic UI) while the date/time comes from the runtime
 * locale (Latin digits + AM/PM). Concatenating them yields a mixed-direction
 * string, and rendering that as one bidi-isolated run reorders it to
 * `04:53 أمس PM` — the AM/PM marker torn away from its time. Callers must
 * render `prefix` and `body` as separate isolated runs.
 */
export interface MessageStampParts {
  /** Localised day label, or null when the body already carries the date. */
  prefix: string | null;
  /** The date/time run, always in the formatting locale's own direction. */
  body: string;
}

/**
 * Formats a message timestamp:
 * - today             → prefix `null`, body `14:32`
 * - yesterday         → prefix `Yesterday`, body `14:32`
 * - earlier this year → prefix `null`, body `Mar 12 14:32`
 * - a previous year   → prefix `null`, body `Mar 12, 2025 14:32`
 */
export function formatMessageStampParts(
  ts: number,
  options: FormatStampOptions
): MessageStampParts {
  const { yesterdayLabel, now = Date.now(), locale = [] } = options;

  const d = new Date(ts);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

  const reference = new Date(now);
  // Day arithmetic through the Date constructor rather than adding/subtracting
  // 24h, so a DST transition cannot shift a boundary onto the wrong calendar day.
  const dayStart = (offset: number) =>
    new Date(
      reference.getFullYear(),
      reference.getMonth(),
      reference.getDate() + offset
    ).getTime();

  const yesterdayStart = dayStart(-1);
  const todayStart = dayStart(0);
  const tomorrowStart = dayStart(1);

  // Both windows are bounded above: a timestamp beyond tonight's midnight (which
  // clock skew between server and client can produce) must fall through to the
  // dated branch rather than masquerading as a bare time from today.
  if (ts >= todayStart && ts < tomorrowStart) return { prefix: null, body: time };
  if (ts >= yesterdayStart && ts < todayStart) {
    return { prefix: yesterdayLabel, body: time };
  }

  const datePart = d.toLocaleDateString(
    locale,
    d.getFullYear() === reference.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" }
  );
  return { prefix: null, body: `${datePart} ${time}` };
}

/**
 * The stamp as one logical string. Correct for assertions, `title`/`aria-label`
 * and any non-visual use — but do NOT render it as a single bidi-isolated run
 * under an RTL UI; use {@link formatMessageStampParts} for that.
 */
export function formatMessageStamp(ts: number, options: FormatStampOptions): string {
  const { prefix, body } = formatMessageStampParts(ts, options);
  return prefix ? `${prefix} ${body}` : body;
}
