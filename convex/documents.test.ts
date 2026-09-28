/**
 * SCRUM-421 — a required document rule added AFTER an application exists.
 *
 * `createFromQuote` materializes one `applicationDocuments` row per applicable
 * rule at creation, and nothing else ever inserts one. The approval and
 * finalize guard (`assertRequiredApplicationDocumentsComplete`) and the
 * cockpit read LIVE rules, so a rule added later is MISSING and blocks the
 * deal — while `getForApplication` listed only materialized rows and every
 * document command needed an existing row id. Nobody could act on it.
 *
 * Policy (owner, decided): a new rule keeps applying to in-flight deals. The
 * repair is lazy and idempotent — `documents.ensureApplicationDocument`
 * materializes the row on first use, under the same authority as an upload.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.ts");

const FULL = [
  "create:sales",
  "view:sales",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "verify:finance_documents",
];

async function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Docs Dealer", createdAt: Date.now() })
  );
  const mk = async (clerkId: string, permissions: string[], org: Id<"organizations"> = orgId) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId: org, name: clerkId, permissions })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId: org, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: clerkId, clerkId }) };
  };
  const seller = await mk("docs_seller", FULL);
  const approver = await mk("docs_approver", FULL);
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A444444",
      make: "Kia",
      model: "Sportage",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Sam", lastName: "Lee" })
  );
  return { t, orgId, mk, seller, approver, vehicleId, customerId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function createApplication({ orgId, seller, vehicleId, customerId }: Setup) {
  const quoteId = await seller.as.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    vehiclePrice: 20000,
    downPayment: 3000,
    termMonths: 48,
    mode: "MANUAL_FINANCE_COMPANY",
    manualProviderName: "Manual Bank",
    manualAdminFees: 0,
    totalFinancedAmount: 17000,
  });
  const applicationId = await seller.as.mutation(api.applications.createFromQuote, { orgId, quoteId });
  return { quoteId, applicationId };
}

function addRule(s: Setup, name: string, extra: { companyId?: Id<"financeCompanies"> } = {}) {
  return s.t.run((ctx) =>
    ctx.db.insert("companyDocumentRules", { orgId: s.orgId, documentName: name, isRequired: true, ...extra })
  );
}

function rowsForApplication(s: Setup, applicationId: Id<"financeApplications">) {
  return s.t.run((ctx) =>
    ctx.db
      .query("applicationDocuments")
      .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
      .collect()
  );
}

async function toUnderReview(s: Setup, applicationId: Id<"financeApplications">) {
  await s.seller.as.mutation(api.applications.updateStatus, {
    orgId: s.orgId,
    applicationId,
    status: "UNDER_REVIEW",
  });
}

/**
 * convex-test does not record a blob's type as `_storage.contentType` (the
 * platform takes it from the upload's Content-Type), so it is patched on — the
 * same workaround `marketplaceListings.test.ts` uses.
 */
async function storePdf(s: Setup) {
  const storageId = await s.t.run((ctx) =>
    ctx.storage.store(new Blob(["%PDF-1.4"], { type: "application/pdf" }))
  );
  await s.t.run((ctx) =>
    (ctx.db as unknown as { patch: (id: unknown, patch: unknown) => Promise<void> }).patch(storageId, {
      contentType: "application/pdf",
    })
  );
  return storageId;
}

describe("CONTROL — a rule that existed when the application was created", () => {
  test("its row is materialized at creation and ensure returns that same row", async () => {
    const s = await setup();
    const ruleId = await addRule(s, "Salary Certificate");
    const { applicationId } = await createApplication(s);

    const rows = await rowsForApplication(s, applicationId);
    expect(rows).toHaveLength(1);
    const listed = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
    expect(listed.map((doc) => doc._id)).toEqual([rows[0]._id]);

    const ensured = await s.seller.as.mutation(api.documents.ensureApplicationDocument, {
      orgId: s.orgId,
      applicationId,
      ruleId,
    });
    expect(ensured).toBe(rows[0]._id);
    expect(await rowsForApplication(s, applicationId)).toHaveLength(1);
  });
});

describe("a required rule added AFTER the application exists", () => {
  test("getForApplication lists it as MISSING with no row, so the checklist can act on it", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    const ruleId = await addRule(s, "Late Salary Certificate");

    const listed = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
    expect(listed).toEqual([
      {
        _id: null,
        ruleId,
        status: "MISSING",
        ruleName: "Late Salary Certificate",
        isRequired: true,
        fileUrl: null,
      },
    ]);
  });

  test("ensure creates exactly one row, and a second call returns the same id", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    const ruleId = await addRule(s, "Late Bank Statement");

    const first = await s.seller.as.mutation(api.documents.ensureApplicationDocument, {
      orgId: s.orgId,
      applicationId,
      ruleId,
    });
    const second = await s.approver.as.mutation(api.documents.ensureApplicationDocument, {
      orgId: s.orgId,
      applicationId,
      ruleId,
    });
    expect(second).toBe(first);

    const rows = await rowsForApplication(s, applicationId);
    expect(rows).toHaveLength(1);
    // Exactly the row `createFromQuote` would have inserted.
    expect(rows[0]).toMatchObject({ orgId: s.orgId, applicationId, ruleId, status: "MISSING" });
    expect(rows[0].fileId).toBeUndefined();

    const listed = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
    expect(listed.map((doc) => doc._id)).toEqual([first]);
  });

  test("upload then verify on the ensured row clears the approval guard", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    await toUnderReview(s, applicationId);
    const ruleId = await addRule(s, "Late Passport");

    // Refused while the late rule is outstanding — the gate this repair serves.
    await expect(
      s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" })
    ).rejects.toThrow(/Late Passport/);

    const documentId = await s.seller.as.mutation(api.documents.ensureApplicationDocument, {
      orgId: s.orgId,
      applicationId,
      ruleId,
    });
    await s.seller.as.mutation(api.documents.saveDocumentFile, {
      orgId: s.orgId,
      documentId,
      fileId: await storePdf(s),
    });
    await s.approver.as.mutation(api.documents.updateDocumentStatus, {
      orgId: s.orgId,
      documentId,
      status: "VERIFIED",
    });
    await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });

    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("APPROVED");
  });

  test("waiving the ensured row clears the approval guard", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    await toUnderReview(s, applicationId);
    const ruleId = await addRule(s, "Late Guarantor Letter");

    const documentId = await s.approver.as.mutation(api.documents.ensureApplicationDocument, {
      orgId: s.orgId,
      applicationId,
      ruleId,
    });
    await s.approver.as.mutation(api.documents.updateDocumentStatus, {
      orgId: s.orgId,
      documentId,
      status: "WAIVED",
      waiverReason: "Finance company accepted the existing file.",
    });
    await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });

    const [doc, app] = await s.t.run(async (ctx) => [await ctx.db.get(documentId), await ctx.db.get(applicationId)]);
    expect(doc?.status).toBe("WAIVED");
    expect(app?.status).toBe("APPROVED");
  });

  test("a rule for THIS deal's finance company applies; one for another company does not", async () => {
    const s = await setup();
    const { quoteId, applicationId } = await createApplication(s);
    const [companyA, companyB] = await s.t.run(async (ctx) => {
      const base = { orgId: s.orgId, profitRate: 6, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true };
      return [
        await ctx.db.insert("financeCompanies", { ...base, name: "Company A" }),
        await ctx.db.insert("financeCompanies", { ...base, name: "Company B" }),
      ];
    });
    await s.t.run((ctx) => ctx.db.patch(quoteId, { companyId: companyA }));
    const ruleA = await addRule(s, "Company A form", { companyId: companyA });
    const ruleB = await addRule(s, "Company B form", { companyId: companyB });

    const listed = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
    expect(listed.map((doc) => doc.ruleId)).toEqual([ruleA]);

    await expect(
      s.seller.as.mutation(api.documents.ensureApplicationDocument, { orgId: s.orgId, applicationId, ruleId: ruleB })
    ).rejects.toThrow(/does not apply/i);
    expect(
      await s.seller.as.mutation(api.documents.ensureApplicationDocument, {
        orgId: s.orgId,
        applicationId,
        ruleId: ruleA,
      })
    ).toBeTruthy();
    expect(await rowsForApplication(s, applicationId)).toHaveLength(1);
  });
});

describe("ensureApplicationDocument refusals", () => {
  test("another org's application or rule is not found, and nothing is written", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    const ruleId = await addRule(s, "Late ID");

    const otherOrgId = await s.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const outsider = await s.mk("docs_outsider", FULL, otherOrgId);
    const otherRuleId = await s.t.run((ctx) =>
      ctx.db.insert("companyDocumentRules", { orgId: otherOrgId, documentName: "Theirs", isRequired: true })
    );

    // The outsider, authorized in THEIR org, naming OUR application and rule.
    await expect(
      outsider.as.mutation(api.documents.ensureApplicationDocument, { orgId: otherOrgId, applicationId, ruleId })
    ).rejects.toThrow(/application not found/i);
    // Our member naming ANOTHER org's rule against our application.
    await expect(
      s.seller.as.mutation(api.documents.ensureApplicationDocument, {
        orgId: s.orgId,
        applicationId,
        ruleId: otherRuleId,
      })
    ).rejects.toThrow(/rule not found/i);
    // An outsider cannot use our orgId at all.
    await expect(
      outsider.as.mutation(api.documents.ensureApplicationDocument, { orgId: s.orgId, applicationId, ruleId })
    ).rejects.toThrow();

    expect(await rowsForApplication(s, applicationId)).toHaveLength(0);
  });

  test("a caller with neither create:finance_application nor verify:finance_documents is refused", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    const ruleId = await addRule(s, "Late Utility Bill");
    const reviewer = await s.mk("docs_reviewer_only", [
      "view:finance_applications",
      "review:finance_application",
      "approve:finance_application",
    ]);

    await expect(
      reviewer.as.mutation(api.documents.ensureApplicationDocument, { orgId: s.orgId, applicationId, ruleId })
    ).rejects.toThrow(/permission/i);
    expect(await rowsForApplication(s, applicationId)).toHaveLength(0);
  });

  test("a verifier without create:finance_application may materialize the row", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    const ruleId = await addRule(s, "Late Insurance");
    const verifier = await s.mk("docs_verifier_only", ["view:finance_applications", "verify:finance_documents"]);

    const id = await verifier.as.mutation(api.documents.ensureApplicationDocument, {
      orgId: s.orgId,
      applicationId,
      ruleId,
    });
    expect((await rowsForApplication(s, applicationId)).map((row) => row._id)).toEqual([id]);
  });
});

/**
 * SCRUM-417 round 2 — Codex S421-R2-4 = Sol S421-R2-3: the active panel and the
 * approval guard read the SAME set of currently applicable rules. A row whose
 * rule was removed stays in storage (its file is history, not garbage) but is
 * not listed as work: the guard and the cockpit no longer require it, so an
 * Upload/Verify control on it would act on a requirement nobody enforces.
 */
describe("the panel lists exactly the rules that currently apply — the guard's and the cockpit's set", () => {
  /** What the panel and the cockpit each say applies, by rule id. */
  async function surfaces(s: Setup, applicationId: Id<"financeApplications">) {
    const panel = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
    const cockpit = await s.seller.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    return {
      panel: panel.map((doc) => doc.ruleId).sort(),
      cockpit: (cockpit?.documents ?? []).map((doc) => doc.ruleId).sort(),
    };
  }

  test("a removed rule's row stays stored but leaves the panel, matching the cockpit and the guard", async () => {
    const s = await setup();
    const kept = await addRule(s, "National ID");
    const removed = await addRule(s, "Old Bank Letter");
    const { applicationId } = await createApplication(s);
    const removedRow = (await rowsForApplication(s, applicationId)).find((row) => row.ruleId === removed);
    expect(removedRow).toBeTruthy();

    // Exactly what `documents.removeRule` does after its owner check.
    await s.t.run((ctx) => ctx.db.delete(removed));

    const after = await surfaces(s, applicationId);
    expect(after.panel).toEqual([kept]);
    expect(after.panel).toEqual(after.cockpit);
    // Stored history is untouched: the row and its status are still there.
    expect(await s.t.run((ctx) => ctx.db.get(removedRow!._id))).toMatchObject({ ruleId: removed, status: "MISSING" });

    // The guard agrees: with the kept rule verified, approval passes even
    // though the removed rule's row is still MISSING.
    await toUnderReview(s, applicationId);
    const keptRow = (await rowsForApplication(s, applicationId)).find((row) => row.ruleId === kept);
    await s.seller.as.mutation(api.documents.saveDocumentFile, {
      orgId: s.orgId,
      documentId: keptRow!._id,
      fileId: await storePdf(s),
    });
    await s.approver.as.mutation(api.documents.updateDocumentStatus, {
      orgId: s.orgId,
      documentId: keptRow!._id,
      status: "VERIFIED",
    });
    await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("APPROVED");
  });

  test("CONTROL — re-adding a rule of the same name is a NEW rule: listed row-less, the old row stays hidden", async () => {
    const s = await setup();
    const original = await addRule(s, "Salary Certificate");
    const { applicationId } = await createApplication(s);
    const oldRow = (await rowsForApplication(s, applicationId))[0];
    await s.t.run((ctx) => ctx.db.delete(original));
    const readded = await addRule(s, "Salary Certificate");

    const listed = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
    expect(listed).toEqual([
      { _id: null, ruleId: readded, status: "MISSING", ruleName: "Salary Certificate", isRequired: true, fileUrl: null },
    ]);
    expect(listed.some((doc) => doc._id === oldRow._id)).toBe(false);
    const { panel, cockpit } = await surfaces(s, applicationId);
    expect(panel).toEqual(cockpit);
  });

  test("CONTROL — an active late rule and an active materialized rule are both listed, as the cockpit lists them", async () => {
    const s = await setup();
    const early = await addRule(s, "Passport");
    const { applicationId } = await createApplication(s);
    const late = await addRule(s, "Late Utility Bill");
    const { panel, cockpit } = await surfaces(s, applicationId);
    expect(panel).toEqual([early, late].sort());
    expect(panel).toEqual(cockpit);
  });
});

/**
 * SCRUM-417 round 2 — Sonnet S417-R2-1 (HIGH): a late rule is materialized only
 * for a deal still in the finance pipeline — `IN_FLIGHT_FINANCE_STATUSES`, the
 * one shared definition. A CANCELLED, CLOSED or REJECTED application (REJECTED
 * cannot re-enter the pipeline: `updateStatus` refuses REJECTED → PENDING_DOCS)
 * gets no new row, and the panel does not synthesize one for it either.
 */
describe("ensureApplicationDocument only materializes rows for an in-flight deal", () => {
  async function withStatus(s: Setup, applicationId: Id<"financeApplications">, status: string) {
    await s.t.run((ctx) => ctx.db.patch(applicationId, { status: status as never }));
  }

  test.each(["CANCELLED", "CLOSED", "REJECTED"])(
    "%s: ensure is refused, nothing is inserted, and the panel offers no row-less line",
    async (status) => {
      const s = await setup();
      const existing = await addRule(s, "Passport");
      const { applicationId } = await createApplication(s);
      const existingRow = (await rowsForApplication(s, applicationId))[0];
      await withStatus(s, applicationId, status);
      const late = await addRule(s, "Late Insurance Letter");

      await expect(
        s.seller.as.mutation(api.documents.ensureApplicationDocument, { orgId: s.orgId, applicationId, ruleId: late })
      ).rejects.toThrow(/no longer in progress/i);
      expect((await rowsForApplication(s, applicationId)).map((row) => row._id)).toEqual([existingRow._id]);

      // Existing stored rows of applicable rules are still listed; the late
      // rule is not synthesized, so no control offers to create it.
      const listed = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
      expect(listed.map((doc) => doc._id)).toEqual([existingRow._id]);
      expect(listed.map((doc) => doc.ruleId)).toEqual([existing]);
    }
  );

  test.each(["DRAFT", "PENDING_DOCS", "UNDER_REVIEW", "APPROVED"])(
    "CONTROL — %s (in flight): the late rule is listed row-less and ensure creates its row",
    async (status) => {
      const s = await setup();
      const { applicationId } = await createApplication(s);
      await withStatus(s, applicationId, status);
      const late = await addRule(s, "Late Insurance Letter");

      const listed = await s.seller.as.query(api.documents.getForApplication, { orgId: s.orgId, applicationId });
      expect(listed).toMatchObject([{ _id: null, ruleId: late }]);
      const id = await s.seller.as.mutation(api.documents.ensureApplicationDocument, {
        orgId: s.orgId,
        applicationId,
        ruleId: late,
      });
      expect((await rowsForApplication(s, applicationId)).map((row) => row._id)).toEqual([id]);
    }
  );
});

/**
 * SCRUM-417 round 2 — Sonnet S417-R2-2: simultaneous first uploads converge.
 *
 * ⚠️ convex-test SERIALIZES mutations — there is no OCC in the harness — so this
 * proves the handler CONVERGES when calls interleave at the transaction
 * boundary (each later call sees the first's insert and returns its id). It
 * does not, and cannot, prove real-runtime OCC behaviour; that rests on the
 * handler reading the `by_application` range it then inserts into.
 */
describe("concurrent ensure calls", () => {
  test("four simultaneous calls for the same rule return one id and leave exactly one row", async () => {
    const s = await setup();
    const { applicationId } = await createApplication(s);
    const ruleId = await addRule(s, "Late Passport Copy");
    const args = { orgId: s.orgId, applicationId, ruleId };

    const ids = await Promise.all([
      s.seller.as.mutation(api.documents.ensureApplicationDocument, args),
      s.approver.as.mutation(api.documents.ensureApplicationDocument, args),
      s.seller.as.mutation(api.documents.ensureApplicationDocument, args),
      s.approver.as.mutation(api.documents.ensureApplicationDocument, args),
    ]);
    expect(new Set(ids).size).toBe(1);
    const rows = await rowsForApplication(s, applicationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(ids[0]);
  });
});
