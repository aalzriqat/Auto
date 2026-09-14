/**
 * The LTV write authority, tested as a truth table against the predicate itself.
 *
 * `convex/financeApplicationBoundary.test.ts` exercises this through the two
 * mutations, which is the right level for "can a real caller move a real
 * figure" — and it is structurally incapable of covering one half of the rule.
 * The Sonnet MAX closure round found the hole and the mutant confirmed it:
 *
 *   • `mayEstablishAppliedLtv = VIEW_FINANCE && APPROVE_FINANCE_APPLICATION`;
 *   • dropping the VIEW_FINANCE conjunct is caught at both writers, by the
 *     default MANAGER who holds the approval without the visibility;
 *   • dropping the APPROVE conjunct can only be caught by a caller who holds
 *     VIEW_FINANCE, does NOT hold the approval, and still reaches the guard.
 *     At `approveDealerPurchaseAmount` no such caller exists — the endpoint's
 *     own permission IS the approval, so `requireTenantAuth` answers first and
 *     that mutant is unkillable there BY CONSTRUCTION, not by omission.
 *
 * An integration suite therefore cannot prove this rule on its own, however
 * many roles it enumerates. Hence a direct test: all four rows, stated against
 * the predicate rather than against whatever the default role templates happen
 * to contain today. The templates are per-org customizable and have already
 * changed once during this lane; a rule asserted only through them would
 * silently lose its meaning the next time they move.
 */
import { describe, expect, test } from "vitest";
import { Doc } from "../_generated/dataModel";
import { PERMISSIONS, type Permission } from "./permissions";
import { mayEstablishAppliedLtv } from "./financeApplicationProjection";

/**
 * The minimum a `roles` row needs to answer a permission question.
 *
 * Cast rather than fully constructed on purpose: the predicate reads
 * `permissions` and the system-owner marker and nothing else, and a fixture
 * carrying fields the code never touches invites the reader to believe they
 * matter.
 */
const role = (permissions: Permission[], isSystemOwnerRole = false): Doc<"roles"> =>
  ({ permissions, isSystemOwnerRole }) as unknown as Doc<"roles">;

const VIEW = PERMISSIONS.VIEW_FINANCE;
const APPROVE = PERMISSIONS.APPROVE_FINANCE_APPLICATION;

describe("mayEstablishAppliedLtv — the per-deal LTV write authority (SCRUM-117)", () => {
  /**
   * The whole truth table, because the rule is a conjunction and a conjunction
   * is exactly what gets weakened to a disjunction by accident.
   */
  test.each([
    ["neither permission", [] as Permission[], false],
    ["APPROVE alone — the reproduction actor, a default MANAGER", [APPROVE], false],
    ["VIEW_FINANCE alone — read authority is not write authority", [VIEW], false],
    ["both", [VIEW, APPROVE], true],
  ])("%s", (_label, permissions, expected) => {
    expect(mayEstablishAppliedLtv(role(permissions))).toBe(expected);
  });

  /**
   * The row an integration test cannot reach at the approval writer, spelled
   * out on its own because it is the one a weakened predicate would let
   * through: a role that may READ every economic figure but was never given
   * approval authority. An ACCOUNTANT is that role today.
   */
  test("read authority alone never becomes write authority", () => {
    expect(mayEstablishAppliedLtv(role([VIEW]))).toBe(false);
    // …and adding unrelated finance-workflow permissions does not change it.
    expect(
      mayEstablishAppliedLtv(
        role([VIEW, PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.VIEW_FINANCE_APPLICATIONS])
      )
    ).toBe(false);
  });

  /**
   * The system owner passes through `allows()` on both conjuncts rather than
   * being special-cased here. Asserted so that a future refactor which reaches
   * for `role.permissions.includes(...)` directly — losing the owner bypass —
   * fails here rather than in production, where it would lock an owner out of
   * their own deal.
   */
  test("the system owner holds it without the permissions being listed", () => {
    expect(mayEstablishAppliedLtv(role([], true))).toBe(true);
  });
});
