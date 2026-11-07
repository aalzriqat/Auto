import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { api } from "./_generated/api";
import schema from "./schema";
import { PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.ts");
const grants = [
  PERMISSIONS.MANAGE_FINANCE,
  PERMISSIONS.VIEW_FINANCE,
  PERMISSIONS.VIEW_COST_PRICE,
];
const account = {
  code: "2500",
  name: "Partner Payables",
  nameAr: "ذمم الشركاء",
  type: "LIABILITY",
  normalBalance: "CREDIT",
} as const;

async function fixture() {
  const t = convexTestWithComponents(schema, modules);
  const finance = await seedOrgWithMember(t, {
    clerkId: "coa-finance",
    permissions: grants,
  });
  return { t, ...finance };
}

test("duplicate account codes are refused with a localized code, including inactive accounts", async () => {
  const { t, orgId, identity } = await fixture();
  const accountId = await identity.mutation(api.chartOfAccounts.create, {
    orgId,
    ...account,
  });
  await identity.mutation(api.chartOfAccounts.update, {
    orgId,
    accountId,
    active: false,
  });
  await expect(
    identity.mutation(api.chartOfAccounts.create, { orgId, ...account }),
  ).rejects.toMatchObject({
    data: { code: "ACCOUNT_CODE_EXISTS" },
  });
  expect(
    await identity.query(api.chartOfAccounts.list, { orgId }),
  ).toHaveLength(1);
  const other = await seedOrgWithMember(t, {
    clerkId: "coa-other",
    permissions: grants,
  });
  await expect(
    other.identity.mutation(api.chartOfAccounts.create, {
      orgId: other.orgId,
      ...account,
    }),
  ).resolves.toBeDefined();
});

test.each([
  { role: "sales", permissions: [], canList: false },
  {
    role: "finance-reader",
    permissions: [PERMISSIONS.VIEW_FINANCE],
    canList: true,
  },
  {
    role: "manage-without-view",
    permissions: [PERMISSIONS.MANAGE_FINANCE],
    canList: false,
  },
])(
  "$role respects separate chart read and write grants",
  async ({ role, permissions, canList }) => {
    const { t, orgId, identity } = await fixture();
    const accountId = await identity.mutation(api.chartOfAccounts.create, {
      orgId,
      ...account,
    });
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId: role,
        email: `${role}@example.test`,
      });
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: role,
        permissions,
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
    });
    const user = t.withIdentity({ subject: role });
    if (canList)
      expect(
        await user.query(api.chartOfAccounts.list, { orgId }),
      ).toHaveLength(1);
    else
      await expect(
        user.query(api.chartOfAccounts.list, { orgId }),
      ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    if (!new Set<string>(permissions).has(PERMISSIONS.MANAGE_FINANCE)) {
      await expect(
        user.mutation(api.chartOfAccounts.create, {
          orgId,
          ...account,
          code: "2510",
        }),
      ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
      await expect(
        user.mutation(api.chartOfAccounts.update, {
          orgId,
          accountId,
          name: "Changed",
        }),
      ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    }
    expect(
      (await identity.query(api.chartOfAccounts.list, { orgId }))[0].name,
    ).toBe("Partner Payables");
  },
);

test("foreign organizations are refused for chart create update and list", async () => {
  const { t, orgId, identity } = await fixture();
  const other = await seedOrgWithMember(t, {
    clerkId: "foreign-finance",
    permissions: grants,
  });
  const foreignAccountId = await other.identity.mutation(
    api.chartOfAccounts.create,
    { orgId: other.orgId, ...account },
  );
  await expect(
    identity.query(api.chartOfAccounts.list, { orgId: other.orgId }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  await expect(
    identity.mutation(api.chartOfAccounts.create, {
      orgId: other.orgId,
      ...account,
      code: "2510",
    }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  await expect(
    identity.mutation(api.chartOfAccounts.update, {
      orgId: other.orgId,
      accountId: foreignAccountId,
      active: false,
    }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  await expect(
    identity.mutation(api.chartOfAccounts.update, {
      orgId,
      accountId: foreignAccountId,
      active: false,
    }),
  ).rejects.toThrow(/not found/i);
  expect(
    await other.identity.query(api.chartOfAccounts.list, {
      orgId: other.orgId,
    }),
  ).toMatchObject([{ active: true }]);
});

test("custom 2500 and 2510 OTHER_PAYABLE allocations draft and approve without automatic accounts", async () => {
  const { t, orgId, identity } = await fixture();
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    }),
  );
  await identity.mutation(api.chartOfAccounts.initialize, { orgId });
  await expect(
    identity.mutation(api.chartOfAccounts.initialize, { orgId }),
  ).rejects.toThrow(/already initialized/);
  const seeded = await identity.query(api.chartOfAccounts.list, { orgId });
  expect(seeded.filter((row) => ["2500", "2510"].includes(row.code))).toEqual(
    [],
  );
  expect(new Set(seeded.map((row) => row.code)).size).toBe(seeded.length);
  const retained = seeded.find((row) => row.systemKey === "RETAINED_EARNINGS");
  if (!retained) throw new Error("Missing seeded retained earnings");
  const partnerId = await identity.mutation(api.chartOfAccounts.create, {
    orgId,
    ...account,
  });
  const serviceId = await identity.mutation(api.chartOfAccounts.create, {
    orgId,
    ...account,
    code: "2510",
    name: "Service Provider Payables",
  });
  const policies = await identity.query(
    api.accountingCutover.listOpeningAccountPolicies,
    { orgId },
  );
  for (const accountId of [partnerId, serviceId]) {
    expect(policies.find((row) => row.accountId === accountId)).toMatchObject({
      policy: "DECLARED_LIABILITY",
      allowedKinds: expect.arrayContaining(["OTHER_PAYABLE"]),
    });
  }
  const asOfDate = Date.UTC(2026, 10, 8);
  await identity.mutation(api.accountingPeriods.create, {
    orgId,
    fiscalYear: 2026,
    periodNumber: 1,
    startDate: Date.UTC(2026, 0, 1),
    endDate: Date.UTC(2026, 11, 31),
    openImmediately: true,
  });
  const opening = {
    orgId,
    asOfDate,
    expectedCurrency: "JOD",
    lines: [
      { accountId: partnerId, debitMinor: 0, creditMinor: 100_000 },
      { accountId: serviceId, debitMinor: 0, creditMinor: 50_000 },
      { accountId: retained._id, debitMinor: 150_000, creditMinor: 0 },
    ],
    allocations: [
      {
        kind: "OTHER_PAYABLE" as const,
        rowKey: "partner",
        accountId: partnerId,
        amountMinor: 100_000,
        title: "Partner obligation",
        counterpartyName: "Synthetic partner",
      },
      {
        kind: "OTHER_PAYABLE" as const,
        rowKey: "service",
        accountId: serviceId,
        amountMinor: 50_000,
        title: "Service obligation",
        counterpartyName: "Synthetic provider",
      },
    ],
  };
  await identity.mutation(api.chartOfAccounts.update, {
    orgId,
    accountId: partnerId,
    active: false,
  });
  expect(
    (
      await identity.query(api.accountingCutover.listOpeningAccountPolicies, {
        orgId,
      })
    ).find((row) => row.accountId === partnerId)?.allowedKinds,
  ).not.toContain("OTHER_PAYABLE");
  await expect(
    identity.mutation(api.accountingCutover.draftOpeningBalance, opening),
  ).rejects.toThrow(/inactive/);
  expect(
    await t.run((ctx) => ctx.db.query("openingBalanceDrafts").collect()),
  ).toEqual([]);
  await identity.mutation(api.chartOfAccounts.update, {
    orgId,
    accountId: partnerId,
    active: true,
  });
  await identity.mutation(api.accountingCutover.draftOpeningBalance, opening);
  const [draft] = await identity.query(
    api.accountingCutover.listPendingOpeningBalanceDrafts,
    { orgId },
  );
  expect(draft).toBeDefined();
  await expect(
    identity.mutation(api.accountingCutover.approveOpeningBalance, {
      orgId,
      draftId: draft._id,
    }),
  ).rejects.toThrow(/same as the preparer/);
  const approver = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId: "coa-approver",
      email: "approver@example.test",
    });
    const roleId = await ctx.db.insert("roles", {
      orgId,
      name: "APPROVER",
      permissions: grants,
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    return userId;
  });
  await t
    .withIdentity({ subject: "coa-approver" })
    .mutation(api.accountingCutover.approveOpeningBalance, {
      orgId,
      draftId: draft._id,
    });
  expect(await t.run((ctx) => ctx.db.get(draft._id))).toMatchObject({
    status: "POSTED",
    reviewedBy: approver,
  });
  const payables = await t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").collect(),
  );
  expect(payables).toHaveLength(2);
  expect(payables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        openingKind: "OTHER_PAYABLE",
        openingRowKey: "partner",
        amountDue: 100,
        amountPaid: 0,
      }),
      expect.objectContaining({
        openingKind: "OTHER_PAYABLE",
        openingRowKey: "service",
        amountDue: 50,
        amountPaid: 0,
      }),
    ]),
  );
  expect(
    (await identity.query(api.chartOfAccounts.list, { orgId })).filter((row) =>
      ["2500", "2510"].includes(row.code),
    ),
  ).toHaveLength(2);
});
