/**
 * SCRUM-178 v2 F5-2. Source fixture: a VALUE finding for null must follow the
 * type the TypeScript checker assigns to the argument AT THE CALL SITE
 * (flow-narrowed), not the binding's declared type.
 *
 * The first four cases are the shapes found in the real mobile app (an early
 * return guard, then the call in a try, a closure, or a `||` guard). The
 * NEGATIVE cases are the same calls where the value really can be null.
 * Analysed by the extractor, never compiled by the detector's own project.
 */
/* eslint-disable react-hooks/immutability -- the reassigned-to-null NEGATIVE case is the subject of the fixture */
declare function useMutation(fn: unknown): (args: unknown) => Promise<unknown>;
declare function useState<T>(initial: T): [T, (next: T) => void];
declare function run(fn: () => Promise<void>): void;
declare const api: Record<string, Record<string, unknown>>;

/** Guard, then a call inside try — shorthand property. */
export function GuardThenTry() {
  const [quoteId] = useState<string | null>(null);
  const update = useMutation(api.narrow.guardThenTry);
  async function go() {
    if (!quoteId) return;
    try {
      await update({ orgId: "o", quoteId });
    } catch {
      // ignored in the fixture
    }
  }
  return go;
}

/** `||` guard with three operands, shorthand properties. */
export function OrGuardThree() {
  const [orgId] = useState<string | null>(null);
  const [vehicleId] = useState<string | null>(null);
  const [note] = useState<string | null>(null);
  const update = useMutation(api.narrow.orGuardThree);
  async function go() {
    if (!orgId || !vehicleId || !note) return;
    await update({ orgId, vehicleId, note });
  }
  return go;
}

/** Guard, then the call inside an async closure. */
export function GuardThenClosure() {
  const [customerId] = useState<string | null>(null);
  const update = useMutation(api.narrow.guardThenClosure);
  function press() {
    if (!customerId) return;
    run(async () => {
      await update({ orgId: "o", customerId });
    });
  }
  return press;
}

/** Guard, then an explicit `name: value` property rather than shorthand. */
export function GuardThenExplicitProperty() {
  const [targetPlan] = useState<string | null>(null);
  const update = useMutation(api.narrow.guardThenExplicit);
  async function go() {
    if (!targetPlan) return;
    await update({ orgId: "o", targetPlan: targetPlan });
  }
  return go;
}

/** A guarded literal union stays an exact enumerable domain (no literal widening). */
export function GuardedLiteralUnion() {
  const [status] = useState<"A" | "B" | null>(null);
  const update = useMutation(api.narrow.guardedLiteral);
  async function go() {
    if (!status) return;
    await update({ orgId: "o", status });
  }
  return go;
}

/** NEGATIVE — no guard at all: the value really can be null. */
export function NoGuard() {
  const [quoteId] = useState<string | null>(null);
  const update = useMutation(api.narrow.noGuard);
  async function go() {
    await update({ orgId: "o", quoteId });
  }
  return go;
}

/** NEGATIVE — the guard is on a DIFFERENT variable. */
export function GuardOnOtherVariable() {
  const [quoteId] = useState<string | null>(null);
  const [other] = useState<string | null>(null);
  const update = useMutation(api.narrow.guardOther);
  async function go() {
    if (!other) return;
    await update({ orgId: "o", quoteId });
  }
  return go;
}

/** NEGATIVE — narrowed by the guard, then reassigned to null before the call. */
export function ReassignedToNull() {
  let quoteId: string | null = "q";
  const update = useMutation(api.narrow.reassigned);
  async function go() {
    if (!quoteId) return;
    quoteId = null;
    await update({ orgId: "o", quoteId });
  }
  return go;
}

/** NEGATIVE — a guard that does not exit, so the call is reachable with null. */
export function GuardWithoutReturn() {
  const [quoteId] = useState<string | null>(null);
  const update = useMutation(api.narrow.guardNoReturn);
  async function go() {
    if (!quoteId) {
      console.warn("missing");
    }
    await update({ orgId: "o", quoteId });
  }
  return go;
}
