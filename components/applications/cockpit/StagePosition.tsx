"use client";

/**
 * "Stage 5 of 8" (SCRUM-417 UX5, SCRUM-468).
 *
 * It used to be `Stage <bdi dir="ltr">5 / 8</bdi>`. In an Arabic paragraph that
 * LTR-isolated run sits inside a right-to-left line, and a reader scanning the
 * line meets the 8 first: the header read "المرحلة 8 / 7" for stage 7 of 8. A
 * sentence -- "المرحلة 7 من 8" -- reads in the same order in either language,
 * and each number is its own isolated run, so neither can be reordered by the
 * words around it. The position is also held to 1..total here, so a stale index
 * can never print a count above its own total.
 */
export function StagePosition({
  t,
  position,
  total,
  labelKey = "StageOfLabel",
}: Readonly<{ t: (key: string) => string; position: number; total: number; labelKey?: string }>) {
  const safeTotal = Math.max(1, Math.trunc(total) || 1);
  const safePosition = Math.min(safeTotal, Math.max(1, Math.trunc(position) || 1));
  return (
    <>
      {t(labelKey)} <bdi>{safePosition}</bdi> {t("StageOfSeparator")} <bdi>{safeTotal}</bdi>
    </>
  );
}