/**
 * The fixed rules of the cross-screen consistency oracle (SCRUM-617, epic
 * SCRUM-760 gate G6). One fact — a count, a total, a status — is often shown on
 * several screens; this decides whether those screens agree. Jev may only
 * choose which fact to check next; whether the screens agree is decided here,
 * by code that never consults a model (the SCRUM-350 rule).
 *
 * Pure on purpose: no Playwright, no I/O. The spec reads each surface and hands
 * the readings in, so every rule has a unit test.
 *
 * Money is out of scope: ledger and deal-economics figures belong to the
 * SCRUM-486 oracle, which checks them against owner-ruled literals.
 */

/** A relation the readings of one fact must satisfy. */
export type Relation =
  | { kind: "equal" } // every surface shows the same number
  | { kind: "parts-within-first" }; // surfaces[1..] added together never exceed surfaces[0]

export type Surface = {
  /** Stable id used in findings, e.g. "dashboard.activeLeads". */
  id: string;
  /** Route the reading comes from, relative to /{orgId}. */
  route: string;
  /** What is read there, in words a reviewer can check by eye. */
  reads: string;
};

export type Fact = {
  id: string;
  description: string;
  relation: Relation;
  surfaces: Surface[];
  /** Set when a surface counts rows that another surface may legitimately omit. */
  caveat?: string;
};

/** One surface's value as the spec observed it; null when it could not be read. */
export type Reading = { surface: string; value: number | null };

export type Verdict =
  | { fact: string; result: "AGREE" }
  | { fact: string; result: "DISAGREE"; expected: number; observed: Reading[] }
  /** A surface could not be read. Counts as a failure, never a skip (SCRUM-760 R4). */
  | { fact: string; result: "UNREADABLE"; missing: string[] };

/**
 * The checked-in catalogue. Every surface is a read of one screen's own number,
 * not of the query behind it, so a screen that miscounts its own data is seen.
 */
export const FACTS: Fact[] = [
  {
    id: "leads.tilesWithinTotal",
    description: "Dashboard Leads card: the New and Qualified tiles together cannot exceed the Total Leads headline.",
    relation: { kind: "parts-within-first" },
    surfaces: [
      { id: "dashboard.totalLeads", route: "/dashboard", reads: "Total Leads headline" },
      { id: "dashboard.tileNew", route: "/dashboard", reads: "New tile" },
      { id: "dashboard.tileQualified", route: "/dashboard", reads: "Qualified tile (interested + test drive)" },
    ],
    caveat: "Other stages have no tile, so the parts may be smaller than the headline; only a part total ABOVE it is a contradiction.",
  },
  {
    id: "leads.tilesWithinActive",
    description: "Dashboard Leads card: New and Qualified are non-terminal stages, so together they cannot exceed the \"still active\" line.",
    relation: { kind: "parts-within-first" },
    surfaces: [
      { id: "dashboard.stillActive", route: "/dashboard", reads: "\"N still active\" line" },
      { id: "dashboard.tileNew", route: "/dashboard", reads: "New tile" },
      { id: "dashboard.tileQualified", route: "/dashboard", reads: "Qualified tile (interested + test drive)" },
    ],
  },
  {
    id: "notifications.unread",
    description: "Unread notifications: the bell badge equals the unread rows on the Notifications page once every page is loaded.",
    relation: { kind: "equal" },
    surfaces: [
      { id: "nav.bellBadge", route: "/dashboard", reads: "bell badge (0 when absent)" },
      { id: "notifications.unreadRows", route: "/notifications", reads: "rows still showing the mark-as-read control, after Load more is exhausted" },
    ],
    caveat: "The bell counts only the newest 75 notifications (notifications.list takes 75) and the page counts all of them, so they diverge once an account holds more than 75.",
  },
];

const isCount = (v: number | null): v is number => v !== null && Number.isFinite(v) && v >= 0;

/** Decide one fact from the readings of its surfaces. */
export function judge(fact: Fact, readings: Reading[]): Verdict {
  const byId = new Map(readings.map((r) => [r.surface, r.value]));
  const missing = fact.surfaces.map((s) => s.id).filter((id) => !isCount(byId.get(id) ?? null));
  if (missing.length > 0) return { fact: fact.id, result: "UNREADABLE", missing };

  const values = fact.surfaces.map((s) => byId.get(s.id) as number);
  const observed = fact.surfaces.map((s) => ({ surface: s.id, value: byId.get(s.id) as number }));

  if (fact.relation.kind === "equal") {
    const [first, ...rest] = values;
    return rest.every((v) => v === first)
      ? { fact: fact.id, result: "AGREE" }
      : { fact: fact.id, result: "DISAGREE", expected: first, observed };
  }
  // parts-within-first: the parts may omit stages, so a part total BELOW the
  // headline is legitimate; only a total ABOVE it is a proven contradiction.
  const [head, ...parts] = values;
  const total = parts.reduce((a, b) => a + b, 0);
  return total <= head
    ? { fact: fact.id, result: "AGREE" }
    : { fact: fact.id, result: "DISAGREE", expected: head, observed };
}

/** A stable fingerprint so repeat findings merge (SCRUM-760 R1). */
export function fingerprint(v: Verdict): string {
  const extra = v.result === "UNREADABLE" ? [...v.missing].sort().join("+") : v.result === "DISAGREE" ? v.observed.map((o) => o.surface).sort().join("+") : "";
  return `cross-screen:${v.fact}:${v.result}:${extra}`;
}

/** Verdicts for every fact in the catalogue; a fact with no readings is UNREADABLE. */
export function judgeAll(readings: Reading[], facts: Fact[] = FACTS): Verdict[] {
  return facts.map((f) => judge(f, readings));
}

/** True when the run found nothing wrong. UNREADABLE is a failure, never a pass. */
export const allAgree = (vs: Verdict[]) => vs.every((v) => v.result === "AGREE");
