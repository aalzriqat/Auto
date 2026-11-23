// @vitest-environment node
import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../../../test-utils/convexTest";
import { seedDealership } from "../../../test-utils/aiDraftsFixture";
import type { Doc } from "../../_generated/dataModel";
import schema from "../../schema";
import { buildSmartReplyText } from "../../utils/smartReplyBuilder";
import { buildSentenceTable } from "./draftSentences";

const SENTINEL = "SENTINEL_DISCOUNT_99_PERCENT_OFF";

async function seedDocs(
  orgSettings: Record<string, unknown> = {},
  vehicle: Record<string, unknown> = {}
): Promise<{ vehicle: Doc<"vehicles">; orgSettings: Doc<"orgSettings"> }> {
  const t = convexTestWithComponents(schema, import.meta.glob("../../**/*.*s"));
  const d = await seedDealership(t, { orgSettings, vehicle });
  return await t.run(async (ctx) => {
    const vehicleDoc = await ctx.db.get(d.vehicleId);
    const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).first();
    if (!vehicleDoc || !settings) throw new Error("seed failed");
    return { vehicle: vehicleDoc, orgSettings: settings };
  });
}

describe("buildSentenceTable", () => {
  test("renders the built-in Smart Reply sentences in both languages", async () => {
    const { vehicle, orgSettings } = await seedDocs();
    const table = buildSentenceTable({ vehicle, orgSettings, financeCompany: null });
    expect(table.en.price).toBe("Qin L (2025) is priced at 25000 JD. Would you like a sales rep to follow up?");
    expect(table.en.availability).toBe("Yes, Qin L (2025) is currently available. Would you like a sales rep to contact you?");
    expect(table.en.greeting).toBe("Hi! 👋 Ask us about price, financing, or availability for any vehicle.");
    expect(table.en.location).toBe("You can find us at Acme Motors, 1 Main Street.");
    expect(table.ar.price).toBe("Qin L (2025) سعرها 25000 JD. هل ترغب أن يتواصل معك أحد مندوبي المبيعات؟");
    expect(table.ar.greeting).toBe("أهلاً! 👋 اسألنا عن السعر أو التمويل أو التوفر لأي سيارة.");
    expect(table.ar.location).toBe("يمكنك زيارتنا في Acme Motors, 1 Main Street.");
  });

  test("an Owner's custom template never reaches a sentence", async () => {
    const custom = JSON.stringify({ priceAvailable: `${SENTINEL} {price}`, greeting: SENTINEL, availableYes: SENTINEL });
    const { vehicle, orgSettings } = await seedDocs({
      smartReplyCustomTemplatesEn: custom,
      smartReplyCustomTemplatesAr: custom,
    });
    // Control: the Smart Reply builder itself does honour the template, so the table's silence is its own doing.
    const direct = buildSmartReplyText({ intent: "greeting", vehicle, orgSettings, financeCompany: null, locale: "en" });
    expect(direct).toBe(SENTINEL);
    const table = buildSentenceTable({ vehicle, orgSettings, financeCompany: null });
    expect(JSON.stringify(table)).not.toContain(SENTINEL);
    expect(table.en.price).toBe("Qin L (2025) is priced at 25000 JD. Would you like a sales rep to follow up?");
  });

  test("no vehicle leaves every vehicle sentence empty and keeps greeting and location", async () => {
    const { orgSettings } = await seedDocs();
    const table = buildSentenceTable({ vehicle: null, orgSettings, financeCompany: null });
    for (const locale of [table.en, table.ar]) {
      expect(locale.availability).toBeNull();
      expect(locale.vehicleInfo).toBeNull();
      expect(locale.price).toBeNull();
      expect(locale.financing).toBeNull();
      expect(locale.greeting).not.toBeNull();
      expect(locale.location).not.toBeNull();
    }
  });

  test("a vehicle that is not available gets no availability sentence", async () => {
    const { vehicle, orgSettings } = await seedDocs({}, { status: "SOLD" });
    const table = buildSentenceTable({ vehicle, orgSettings, financeCompany: null });
    expect(table.en.availability).not.toBe("Yes, Qin L (2025) is currently available. Would you like a sales rep to contact you?");
    expect(table.ar.availability).not.toContain("متوفرة حالياً");
  });

});
