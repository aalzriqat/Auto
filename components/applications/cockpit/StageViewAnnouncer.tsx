"use client";

import { useState } from "react";

/**
 * A persistent polite live region (aria-live, deliberately without role=status, so it does not add a second status landmark to the page) for the step view (SCRUM-417 UX4, F6; UX5 S7).
 *
 * Choosing a step from the rail swaps the card in place, and pressing Back
 * unmounts the very button that had focus; without an announcement a screen
 * reader user hears nothing change. The region itself is mounted for the whole
 * life of the cockpit (a live region inserted together with its text is often
 * not announced), and only its text changes.
 *
 * It announces TRANSITIONS, never the current state. What it says is decided at
 * the moment something changes and then held, so a re-render (another user
 * moving the live step, the "next" label changing under a recorded line) can
 * never re-announce:
 *   - `message` when a step starts being viewed or the viewed step changes;
 *   - `restoreMessage` once, on the viewed -> not-viewed transition;
 *   - `recordedMessage` once, when the recorded line is released (frozen then).
 * Whichever transition happened last owns the region, so navigating after
 * "Recorded" announces the step.
 */
type Spoken = Readonly<{ text: string; viewKey: string | null; recorded: string | null }>;

export function StageViewAnnouncer({
  message,
  viewKey = message,
  restoreMessage,
  recordedMessage = null,
}: Readonly<{
  message: string | null;
  /**
   * WHICH step is being viewed (its stage id), or null on the live step. The
   * transition is a change of this key -- never of `message`, which also carries
   * the step's state ("Credit, Current"): that state moving under the same viewed
   * step is not something the user did and must not be spoken again. Defaults to
   * `message` for a caller with no separate identity.
   */
  viewKey?: string | null;
  restoreMessage: string;
  /** SCRUM-417 UX5 (S7): "Recorded. Next: ..." -- said once, when it appears. */
  recordedMessage?: string | null;
}>) {
  // Adjusted during render (not in an effect): the region's text changes in the
  // same commit as the change that caused it, with no frame in between.
  const [spoken, setSpoken] = useState<Spoken>({ text: "", viewKey: null, recorded: null });
  if (spoken.viewKey !== viewKey || (spoken.recorded === null) !== (recordedMessage === null)) {
    let text = spoken.text;
    if (recordedMessage !== null && spoken.recorded === null) {
      text = recordedMessage;
    } else if (viewKey !== null && viewKey !== spoken.viewKey) {
      text = message ?? spoken.text;
    } else if (viewKey === null && spoken.viewKey !== null) {
      text = restoreMessage;
    } else if (recordedMessage === null && spoken.recorded !== null) {
      // The line went away (dismissed, or a new action began): nothing to say,
      // and clearing lets an identical line be announced again later.
      text = "";
    }
    setSpoken({ text, viewKey, recorded: recordedMessage });
  }

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="deal-stage-view-announcer"
    >
      {spoken.text}
    </div>
  );
}
