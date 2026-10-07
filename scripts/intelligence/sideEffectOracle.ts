/**
 * The fixed rules of the Jev side-effect checker (SCRUM-620, epic SCRUM-760
 * gate G6). After an action, the app must have produced each expected
 * consequence EXACTLY ONCE for the right audience, and nothing for anyone else.
 * Jev may only choose which action to trigger next; whether the consequences
 * are right is decided here, by code that never consults a model.
 *
 * Pure on purpose: the spec (or a backend test) reads the notifications each
 * user actually received and hands them in as Effect rows.
 *
 * Outbound channels (email, WhatsApp, push) are out of scope here: they must be
 * stubbed on the preview, so only the in-app notification row is observable.
 */

/** Who a notification is addressed to, as a rule over the org's members. */
export type Audience =
  | { kind: "user"; userId: string } // one specific user (e.g. the new assignee)
  | { kind: "managers"; excludeActor: boolean } // members holding MANAGE_USERS
  | { kind: "none" }; // the action must notify nobody

export type Expectation = {
  /** The notification type from lib/notifications/types.ts. */
  type: string;
  audience: Audience;
};

/** One notification row as observed for one user after the action. */
export type Effect = { userId: string; type: string };

export type Member = { userId: string; isManager: boolean };

export type Finding =
  | { kind: "missing"; type: string; userId: string }
  | { kind: "duplicate"; type: string; userId: string; count: number }
  | { kind: "unexpected"; type: string; userId: string };

/** The members an audience resolves to for this actor. */
export function recipients(audience: Audience, members: Member[], actorId: string): string[] {
  switch (audience.kind) {
    case "user":
      return [audience.userId];
    case "managers":
      return members.filter((m) => m.isManager && !(audience.excludeActor && m.userId === actorId)).map((m) => m.userId);
    case "none":
      return [];
  }
}

/**
 * Compare what happened with what the action should have produced. `observed`
 * must be the rows created BY the action (the spec diffs before/after), and
 * `touchedTypes` the notification types this action is allowed to speak about:
 * anything of another type is noise from elsewhere and is not judged.
 */
export function judgeEffects(
  expectations: Expectation[],
  observed: Effect[],
  members: Member[],
  actorId: string,
  touchedTypes: string[] = expectations.map((e) => e.type),
): Finding[] {
  const findings: Finding[] = [];
  const key = (type: string, userId: string) => `${type}\u0000${userId}`;

  const want = new Map<string, number>();
  for (const e of expectations) {
    for (const userId of recipients(e.audience, members, actorId)) {
      want.set(key(e.type, userId), (want.get(key(e.type, userId)) ?? 0) + 1);
    }
  }
  const got = new Map<string, number>();
  for (const o of observed) {
    if (!touchedTypes.includes(o.type)) continue;
    got.set(key(o.type, o.userId), (got.get(key(o.type, o.userId)) ?? 0) + 1);
  }

  for (const [k, n] of want) {
    const [type, userId] = k.split("\u0000");
    const have = got.get(k) ?? 0;
    if (have < n) findings.push({ kind: "missing", type, userId });
    else if (have > n) findings.push({ kind: "duplicate", type, userId, count: have });
  }
  for (const [k] of got) {
    if (want.has(k)) continue;
    const [type, userId] = k.split("\u0000");
    findings.push({ kind: "unexpected", type, userId });
  }
  return findings;
}

/** A stable fingerprint so repeat findings merge (SCRUM-760 R1). */
export const fingerprintEffect = (action: string, f: Finding) => `side-effect:${action}:${f.kind}:${f.type}`;
