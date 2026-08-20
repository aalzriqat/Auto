import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import {
  scanAggregateWiring,
  scanEconomicsRevision,
  scanRepository,
} from "../autoflow-rules.mjs";

function economicsDiagnostics(source, name) {
  return scanEconomicsRevision(source, `convex/${name}.ts`);
}

function assertEconomicsViolation(source, name) {
  const diagnostics = economicsDiagnostics(source, name);
  assert.equal(diagnostics.length, 1, `${name} must fail exactly once`);
  assert.equal(diagnostics[0].ruleId, "economics-revision");
}

describe("economics write invocation escapes", () => {
  test("finds protected payloads through statically resolvable write forms", () => {
    const cases = [
      [
        "database-container",
        `
          const box = { database: ctx.db };
          await box.database.patch(id, { dealerContributionMinor: amount });
        `,
      ],
      [
        "local-persist-helper",
        `
          async function persist(ctx, id, payload) {
            await ctx.db.patch(id, payload);
          }
          await persist(ctx, id, { dealerContributionMinor: amount });
        `,
      ],
      [
        "function-call",
        `ctx.db.patch.call(ctx.db, id, { dealerContributionMinor: amount });`,
      ],
      [
        "function-apply",
        `ctx.db.patch.apply(ctx.db, [id, { dealerContributionMinor: amount }]);`,
      ],
      [
        "reflect-apply",
        `Reflect.apply(ctx.db.patch, ctx.db, [id, { dealerContributionMinor: amount }]);`,
      ],
      [
        "global-reflect-apply",
        `globalThis.Reflect.apply(ctx.db.patch, ctx.db, [id, { dealerContributionMinor: amount }]);`,
      ],
      [
        "reflect-get-call",
        `Reflect.get(ctx.db, "patch").call(ctx.db, id, { dealerContributionMinor: amount });`,
      ],
      [
        "inline-bound-write",
        `ctx.db.patch.bind(ctx.db)(id, { dealerContributionMinor: amount });`,
      ],
      [
        "reflect-get-bound-write",
        `Reflect.get(ctx.db, "patch").bind(ctx.db)(id, { dealerContributionMinor: amount });`,
      ],
      [
        "reflect-apply-bound-write",
        `Reflect.apply(ctx.db.patch.bind(ctx.db), null, [id, { dealerContributionMinor: amount }]);`,
      ],
      [
        "function-prototype-call",
        `Function.prototype.call.call(ctx.db.patch, ctx.db, id, { dealerContributionMinor: amount });`,
      ],
      [
        "function-prototype-apply",
        `Function.prototype.apply.call(ctx.db.patch, ctx.db, [id, { dealerContributionMinor: amount }]);`,
      ],
      [
        "tuple-spread",
        `
          const args = [id, { dealerContributionMinor: amount }] as const;
          await ctx.db.patch(...args);
        `,
      ],
      [
        "nested-destructuring",
        `
          const { db: { patch } } = ctx;
          await patch(id, { dealerContributionMinor: amount });
        `,
      ],
      [
        "from-entries",
        `
          const payload = Object.fromEntries([
            ["dealerContributionMinor", amount],
          ]);
          await ctx.db.patch(id, payload);
        `,
      ],
    ];

    for (const [name, source] of cases) {
      assertEconomicsViolation(source, name);
    }
  });

  test("accepts a reflected write with the exact same-row revision bump", () => {
    const source = `
      const current = await ctx.db.get(id);
      Reflect.apply(ctx.db.patch, ctx.db, [id, {
        dealerContributionMinor: amount,
        economicsRevision: (current.economicsRevision ?? 0) + 1,
      }]);
    `;
    assert.deepEqual(economicsDiagnostics(source, "reflected-valid"), []);
  });
});

describe("economics payload construction escapes", () => {
  test("rejects unsafe defineProperties and aliased Object.assign writes", () => {
    const cases = [
      [
        "define-properties",
        `
          const payload = {};
          Object.defineProperties(payload, {
            dealerContributionMinor: { value: amount, enumerable: true },
          });
          await ctx.db.patch(id, payload);
        `,
      ],
      [
        "assign-alias",
        `
          const payload = {};
          const assign = Object.assign;
          assign(payload, { dealerContributionMinor: amount });
          await ctx.db.patch(id, payload);
        `,
      ],
      [
        "assign-alias-overwrite",
        `
          const current = await ctx.db.get(id);
          const payload = {
            economicsRevision: (current.economicsRevision ?? 0) + 1,
          };
          const assign = Object.assign;
          assign(payload, {
            dealerContributionMinor: amount,
            economicsRevision: 0,
          });
          await ctx.db.patch(id, payload);
        `,
      ],
    ];

    for (const [name, source] of cases) {
      assertEconomicsViolation(source, name);
    }
  });

  test("allows the same operations when they co-write the correct revision", () => {
    const cases = [
      `
        const current = await ctx.db.get(id);
        const payload = {
          economicsRevision: (current.economicsRevision ?? 0) + 1,
        };
        Object.defineProperties(payload, {
          dealerContributionMinor: { value: amount, enumerable: true },
        });
        await ctx.db.patch(id, payload);
      `,
      `
        const current = await ctx.db.get(id);
        const payload = {};
        const assign = Object.assign;
        assign(payload, {
          dealerContributionMinor: amount,
          economicsRevision: (current.economicsRevision ?? 0) + 1,
        });
        await ctx.db.patch(id, payload);
      `,
    ];

    for (const [index, source] of cases.entries()) {
      assert.deepEqual(
        economicsDiagnostics(source, `safe-mutation-${index}`),
        [],
      );
    }
  });
});

const AGGREGATE_SOURCE = `
  import { TableAggregate } from "@convex-dev/aggregate";
  const box = { Aggregate: TableAggregate };
  const vehicles = new box.Aggregate<{ TableName: "vehicles" }>(component, {});
  const aggregateTriggers = createTriggers();
  const deferredThreadTriggers = createTriggers();
  function registerCountingTriggers(triggers) {
    REGISTRATION
  }
  registerCountingTriggers(aggregateTriggers);
  registerCountingTriggers(deferredThreadTriggers);
`;

describe("aggregate provenance escapes", () => {
  test("tracks constructors stored in immutable object properties", () => {
    const safe = AGGREGATE_SOURCE.replace(
      "REGISTRATION",
      'triggers.register("vehicles", vehicles.idempotentTrigger());',
    );
    assert.deepEqual(scanAggregateWiring(safe, "convex/aggregate-safe.ts"), []);

    const diagnostics = scanAggregateWiring(
      AGGREGATE_SOURCE.replace("REGISTRATION", ""),
      "convex/aggregate-missing.ts",
    );
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /vehicles\.idempotentTrigger/);
  });

  test("rejects aliases pretending to be the canonical writer registries", () => {
    const source = AGGREGATE_SOURCE.replace(
      "const aggregateTriggers = createTriggers();\n  const deferredThreadTriggers = createTriggers();",
      `const fakeRegistry = createTriggers();
  const aggregateTriggers = fakeRegistry;
  const deferredThreadTriggers = fakeRegistry;`,
    ).replace(
      "REGISTRATION",
      'triggers.register("vehicles", vehicles.idempotentTrigger());',
    );
    const diagnostics = scanAggregateWiring(source, "convex/aggregate-fake.ts");
    assert.equal(diagnostics.length, 2);
    assert.ok(
      diagnostics.every((item) =>
        /directly constructed trigger registry/.test(item.message),
      ),
    );
  });

  test("resolves a default re-export before validating its instance", () => {
    const repositoryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "autoflow-aggregate-default-"),
    );
    try {
      const convexRoot = path.join(repositoryRoot, "convex");
      fs.mkdirSync(path.join(convexRoot, "features"), { recursive: true });
      fs.writeFileSync(
        path.join(convexRoot, "aggregate-default.ts"),
        'export { TableAggregate as default } from "@convex-dev/aggregate";',
      );
      fs.writeFileSync(
        path.join(convexRoot, "features", "default-import.ts"),
        'import Aggregate from "../aggregate-default"; const hidden = new Aggregate(component, {});',
      );

      const diagnostics = scanRepository(repositoryRoot).filter((item) =>
        item.file.includes("features/default-import"),
      );
      assert.ok(diagnostics.length > 0);
      assert.ok(
        diagnostics.some(
          (item) =>
            item.ruleId === "aggregate-registration" &&
            /statically resolvable string-literal TableName/.test(item.message),
        ),
      );
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
