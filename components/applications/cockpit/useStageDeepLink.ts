"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { STAGE_PARAM, type StageDeepLink } from "./dealStepView";

/**
 * The `?stage=` deep link, read and written with the Next router (SCRUM-417
 * UX4, O3).
 *
 * The value is handed down untouched: whether it names a real stage is the
 * cockpit's call (an unknown key falls back to the live step there), and
 * nothing here can change the live stage, the workbench or any command -- it is
 * the address of a VIEW. Writes use `replace`, so browsing a deal's steps does
 * not fill the history with entries the back button would have to walk through,
 * and every other query parameter is kept.
 */
export function useStageDeepLink(): StageDeepLink {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams?.get(STAGE_PARAM) ?? null;
  const current = searchParams?.toString() ?? "";

  const onChange = useCallback(
    (key: string | null) => {
      if (pathname === null) return;
      const next = new URLSearchParams(current);
      if (key === null) next.delete(STAGE_PARAM);
      else next.set(STAGE_PARAM, key);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [router, pathname, current]
  );

  return { value, onChange };
}
