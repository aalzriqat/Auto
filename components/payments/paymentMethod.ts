/**
 * SCRUM-469: a payment method is an attribute of ONE money movement and is never
 * assumed. Every submit gate asks this one question so that "nothing chosen" means
 * the same thing everywhere: `undefined`, `null` and the empty string a cleared
 * select can hand back are all "not chosen".
 */
export function isChosenMethod<M extends string>(method: M | "" | null | undefined): method is M {
  return typeof method === "string" && method !== "";
}
