"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /**
   * Id of the newest message in the thread. `listMessages` returns newest-first,
   * so this is `results[0]?._id` — it changes when a message genuinely arrives
   * but NOT when `loadMore` appends an older page. Keying on the array length
   * instead would scroll a reader who is paging back through history straight
   * to the bottom, making "Load older" a closed loop.
   */
  newestMessageId: string | undefined;
  /** False while the thread is hidden (e.g. a minimized floating window). */
  enabled?: boolean;
}

/**
 * Keeps a chat pane pinned to its newest message.
 *
 * Shared by FloatingChatWindow and ChatThread so the two cannot drift apart —
 * they previously carried two copies of this logic and only one got fixed.
 *
 * Scrolls the pane element directly rather than calling `scrollIntoView` on a
 * sentinel: `scrollIntoView` walks every scrollable ancestor, which would also
 * move the dashboard behind a `fixed` floating window and the page behind the
 * mobile sheet.
 */
export function useChatAutoScroll({ newestMessageId, enabled = true }: Options) {
  // State-backed callback ref rather than useRef: the effect below must re-run
  // when the pane mounts. With a plain ref nothing changes at mount time, so a
  // conversation whose messages resolve BEFORE its metadata would render the
  // pane already populated and never scroll — leaving the user parked on the
  // oldest message.
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const hasScrolledRef = useRef(false);

  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      if (!pane) return false;
      // `behavior: "smooth"` is not suppressed by prefers-reduced-motion the way
      // the CSS animations in globals.css are, so check it explicitly.
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      pane.scrollTo({
        top: pane.scrollHeight,
        behavior: smooth && !reduceMotion ? "smooth" : "auto",
      });
      return true;
    },
    [pane]
  );

  useEffect(() => {
    if (!enabled) {
      // The pane unmounts while hidden, so the next reveal starts at scroll-top
      // 0 and needs an instant jump rather than a long smooth scroll.
      hasScrolledRef.current = false;
      return;
    }
    if (!newestMessageId || !pane) return;
    // Only record the initial scroll once there was actually a pane to scroll.
    if (scrollToBottom(hasScrolledRef.current)) {
      hasScrolledRef.current = true;
    }
  }, [newestMessageId, enabled, pane, scrollToBottom]);

  return { paneRef: setPane, scrollToBottom };
}
