"use client";

/**
 * "Step 5 of 8" (SCRUM-417 UX5, SCRUM-468).
 *
 * It used to be `Stage <bdi dir="ltr">5 / 8</bdi>`. In an Arabic paragraph that
 * LTR-isolated run sits inside a right-to-left line, and a reader scanning the
 * line meets the 8 first: the header read "المرحلة 8 / 7" for step 7 of 8. A
 * sentence -- "الخطوة 7 من 8" -- reads in the same order in either language,
 * and each number is its own isolated run, so neither can be reordered by the
 * words around it.
 *
 * An invalid position (0, -1, past the total, not a whole number) renders
 * NOTHING. It used to be clamped into 1..total, which turned "the stage was not
 * found" into a confident, wrong "step 1 of 8"; an absent count is honest.
 */
export function StagePosition({
  t,
  position,
  total,
  labelKey = "StageOfLabel",
}: Readonly<{ t: (key: string) => string; position: number; total: number; labelKey?: string }>) {
  const valid =
    Number.isInteger(position) && Number.isInteger(total) && total >= 1 && position >= 1 && position <= total;
  if (!valid) return null;
  return (
    <>
      {t(labelKey)} <bdi>{position}</bdi> {t("StageOfSeparator")} <bdi>{total}</bdi>
    </>
  );
}
