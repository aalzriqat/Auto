/**
 * The order the stage rail DISPLAYS: the order the steps can actually be done.
 *
 * The server lists the disbursement stage at step 6, before handover, because
 * that is the sequence a dealer describes (`DEAL_STAGE_ORDER`, pinned by
 * `dealCockpitDerivation.test.ts`). It can only be confirmed once the deal is
 * CLOSED: both disbursement mutations refuse any other status, `finalizeDeal`
 * closes the deal, and finalization refuses until the handover is registered.
 * So the rail shown to an operator would put a step they cannot yet take ahead
 * of two they must take first.
 *
 * This is DISPLAY ONLY. It returns the same stage objects, re-sequenced by KEY
 * (never by index), so a stage's state, blocker and authority are exactly what
 * the server derived, and the server's order and `deriveDealStages` are
 * untouched. Rail node numbers, the "Stage n / total" kicker and the live-stage
 * position are all read from this order so they cannot disagree with the rail.
 *
 * A rail without the stage (the cash rail) comes back as it arrived, and every
 * other stage keeps its relative order, so a stage the server adds later does
 * not silently jump.
 */
const PAYMENT_CONFIRMATION_KEY = "DISBURSEMENT";

export function orderStagesForDisplay<T extends Readonly<{ key: string }>>(
  stages: ReadonlyArray<T>
): T[] {
  const payment = stages.filter((stage) => stage.key === PAYMENT_CONFIRMATION_KEY);
  if (payment.length === 0) return [...stages];
  return [...stages.filter((stage) => stage.key !== PAYMENT_CONFIRMATION_KEY), ...payment];
}
