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
