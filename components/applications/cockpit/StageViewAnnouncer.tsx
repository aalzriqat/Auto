"use client";

import { useState } from "react";

/**
 * A persistent polite live region (aria-live, deliberately without role=status, so it does not add a second status landmark to the page) for the step view (SCRUM-417 UX4, F6).
 *
 * Choosing a step from the rail swaps the card in place, and pressing Back
 * unmounts the very button that had focus; without an announcement a screen
 * reader user hears nothing change. The region itself is mounted for the whole
 * life of the cockpit (a live region inserted together with its text is often
 * not announced), and only its text changes: `message` while a step is being
 * viewed, `restoreMessage` once, on the way back, and nothing otherwise.
 */
export function StageViewAnnouncer({
  message,
  restoreMessage,
  recordedMessage = null,
}: Readonly<{
  message: string | null;
  restoreMessage: string;
  /** SCRUM-417 UX5 (S7): "Recorded. Next: ..." -- said before anything about the view. */
  recordedMessage?: string | null;
}>) {
  // Set during render (not in an effect): once a step has been viewed, the way
  // back has something to announce; until then the region stays empty.
  const [hasViewed, setHasViewed] = useState(false);
  if (message !== null && !hasViewed) setHasViewed(true);
  const text = recordedMessage ?? message ?? (hasViewed ? restoreMessage : "");

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
      data-testid="deal-stage-view-announcer"
    >
      {text}
    </div>
  );
}