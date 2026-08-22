import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RULE_IDS,
  formatDiagnostic,
  scanAdminSuperAdmin,
  scanAggregateWiring,
  scanEconomicsRevision,
  scanRawConvexBuilders,
  scanRepository,
} from "../autoflow-rules.mjs";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "../..");

function messages(diagnostics) {
  return diagnostics.map((item) => item.message);
}

describe("admin-super-admin-first", () => {
  test("accepts aliased imports with direct literal registrations", () => {
    const source = `
      import { query as defineQuery } from "./_generated/server";
      import * as generated from "./_generated/server";
      import * as builders from "./functions";
      import * as tenancy from "./utils/tenancy";

      const listHandler = async (ctx) => {
        type Result = { ok: true };
        await tenancy.requireSuperAdmin(ctx);
        return { ok: true };
      };
      const build = defineQuery;
      export const list = build({ args: {}, handler: listHandler });

      const wrapped = builders;
      const { mutation: buildMutation } = wrapped;
      export const update = buildMutation({
        args: {},
        async handler(ctx, limit = 0) {
          const admin = await tenancy.requireSuperAdmin(ctx);
          return admin._id;
        },
      });

      const generatedAlias = generated;
      const { action: buildAction } = generatedAlias;
      export const audit = buildAction({
        handler: async (ctx) => {
          await tenancy.requireSuperAdmin(ctx);
          return true;
        },
      });

      const tenancyAlias = tenancy;
      export const throughTenancyAlias = defineQuery({
        handler: async (ctx) => {
          await tenancyAlias.requireSuperAdmin(ctx);
          return true;
        },
      });
    `;

    assert.deepEqual(scanAdminSuperAdmin(source, "convex/adminAliases.ts"), []);
  });

  test("accepts the non-throwing admin probe and catch-wrapped auth", () => {
    const source = `
      import { query } from "./_generated/server";
      import { requireSuperAdmin } from "./utils/tenancy";

      export const probe = query({
        args: {},
        handler: async (ctx) => {
          try {
            await requireSuperAdmin(ctx);
            return true;
          } catch {
            return false;
          }
        },
      });

      export const optionalBanner = query({
        args: {},
        handler: async (ctx) => {
          const admin = await requireSuperAdmin(ctx).catch(() => null);
          if (!admin) return null;
          return await ctx.db.get(admin._id);
        },
      });
    `;

    assert.deepEqual(scanAdminSuperAdmin(source, "convex/adminAuth.ts"), []);
  });

  test("accepts the existing action-to-authenticated-internal-query delegation", () => {
    const source = `
      import { action, internalQuery } from "./_generated/server";
      import { internal } from "./_generated/api";
      import { requireSuperAdmin } from "./utils/tenancy";

      export const deleteUser = action({
        args: {},
        handler: async (ctx) => {
          const admin = await ctx.runQuery(internal.adminUsers.authorizeAction, {});
          return admin._id;
        },
      });

      export const deleteUserWithoutArgs = action({
        args: {},
        handler: async (ctx) => {
          const admin = await ctx.runQuery(internal.adminUsers.authorizeAction);
          return admin._id;
        },
      });

      export const authorizeAction = internalQuery({
        args: {},
        handler: async (ctx) => {
          return await requireSuperAdmin(ctx);
        },
      });
    `;

    assert.deepEqual(scanAdminSuperAdmin(source, "convex/adminUsers.ts"), []);
  });

  test("rejects executable authentication-call arguments evaluated before auth", () => {
    const source = `
      import { action, internalQuery } from "./_generated/server";
      import { internal } from "./_generated/api";
      import { requireSuperAdmin } from "./utils/tenancy";

      export const direct = action({ handler: async (ctx) => {
        await requireSuperAdmin(ctx, await fetch("https://example.invalid/pre-auth"));
      }});
      export const delegated = action({ handler: async (ctx) => {
        await ctx.runQuery(internal.adminAuth.authorizeAction, {
          value: await fetch("https://example.invalid/pre-auth"),
        });
      }});
      Array.prototype.toString = () => {
        void fetch("https://example.invalid/pre-auth");
        return "value";
      };
      export const coercingKey = action({ handler: async (ctx) => {
        await ctx.runQuery(internal.adminAuth.authorizeAction, {
          [["value"]]: true,
        });
      }});
      export const authorizeAction = internalQuery({
        handler: async (ctx) => await requireSuperAdmin(ctx),
      });
    `;

    const diagnostics = scanAdminSuperAdmin(source, "convex/adminAuth.ts");
    assert.equal(diagnostics.length, 3);
    assert.deepEqual(
      messages(diagnostics).map((message) => message.match(/"([^"]+)"/)?.[1]),
      ["direct", "delegated", "coercingKey"],
    );
  });

  test("does not trust a same-named delegated query unless that query authenticates", () => {
    const source = `
      import { action, internalQuery } from "./_generated/server";
      import { internal } from "./_generated/api";

      export const deleteUser = action({
        args: {},
        handler: async (ctx) => {
          await ctx.runQuery(internal.adminUsers.authorizeAction, {});
          return true;
        },
      });
      export const authorizeAction = internalQuery({
        args: {},
        handler: async (ctx) => await ctx.db.query("users").first(),
      });
    `;

    const diagnostics = scanAdminSuperAdmin(source, "convex/adminUsers.ts");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /deleteUser/);
  });

  test("rejects missing, late, unawaited, conditional, swallowed, and dead-closure auth", () => {
    const source = `
      import { query } from "./_generated/server";
      import { requireSuperAdmin } from "./utils/tenancy";

      export const missing = query({ handler: async (ctx) => ctx.db.query("users").first() });
      export const late = query({ handler: async (ctx) => {
        const row = await ctx.db.query("users").first();
        await requireSuperAdmin(ctx);
        return row;
      }});
      export const unawaited = query({ handler: async (ctx) => {
        requireSuperAdmin(ctx);
        return ctx.db.query("users").first();
      }});
      export const conditional = query({ handler: async (ctx, args) => {
        if (args.check) await requireSuperAdmin(ctx);
        return ctx.db.query("users").first();
      }});
      export const deadClosure = query({ handler: async (ctx) => {
        const authenticate = async () => requireSuperAdmin(ctx);
        return ctx.db.query("users").first();
      }});
      export const swallowed = query({ handler: async (ctx) => {
        await requireSuperAdmin(ctx).catch(() => null);
        return ctx.db.query("users").first();
      }});
      export const swallowedTry = query({ handler: async (ctx) => {
        try {
          await requireSuperAdmin(ctx);
        } catch {}
        return ctx.db.query("users").first();
      }});
      export const forgedCatch = query({ handler: async (ctx) => {
        const admin = await requireSuperAdmin(ctx).catch(() => ({ _id: "forged" }));
        if (!admin) return null;
        return ctx.db.query("users").first();
      }});
      export const leakingCatch = query({ handler: async (ctx) => {
        try {
          await requireSuperAdmin(ctx);
        } catch {
          return await ctx.db.query("users").first();
        }
      }});
      export const destructiveCatch = query({ handler: async (ctx) => {
        const admin = await requireSuperAdmin(ctx).catch(() => null);
        if (!admin) return await ctx.db.delete("victim");
        return true;
      }});
      const defaultUnsafe = query({ handler: async (ctx) => ctx.db.query("users").first() });
      export default defaultUnsafe;
    `;

    const diagnostics = scanAdminSuperAdmin(source, "convex/adminUnsafe.ts");
    const namedDiagnostics = messages(diagnostics)
      .map((message) => message.match(/"([^"]+)"/)?.[1])
      .filter(Boolean);
    assert.deepEqual(namedDiagnostics, [
      "missing",
      "late",
      "unawaited",
      "conditional",
      "deadClosure",
      "swallowed",
      "swallowedTry",
      "forgedCatch",
      "leakingCatch",
      "destructiveCatch",
      "defaultUnsafe",
    ]);
    assert.equal(
      diagnostics.filter((entry) => /runtime re-export/.test(entry.message))
        .length,
      1,
    );
  });

  test("ignores exported internal workers", () => {
    const source = `
      import { internalMutation } from "./functions";
      export const worker = internalMutation({
        handler: async (ctx) => ctx.db.insert("jobs", {}),
      });
    `;
    assert.deepEqual(scanAdminSuperAdmin(source, "convex/adminJobs.ts"), []);
  });

  test("rejects pre-auth parameter initializers and unproven exported factories", () => {
    const source = `
      import { query } from "./_generated/server";
      import { requireSuperAdmin } from "./utils/tenancy";

      export const defaultBeforeAuth = query({
        handler: async (ctx, value = doNetwork()) => {
          await requireSuperAdmin(ctx);
          return value;
        },
      });
      export const destructuredBeforeAuth = query({
        handler: async (ctx, { value = doNetwork() }) => {
          await requireSuperAdmin(ctx);
          return value;
        },
      });
      const make = () => query({
        handler: async (ctx) => {
          await requireSuperAdmin(ctx);
          return true;
        },
      });
      export const hiddenBuilder = make();
    `;

    const diagnostics = scanAdminSuperAdmin(source, "convex/adminFactories.ts");
    assert.equal(diagnostics.length, 3);
    assert.deepEqual(
      messages(diagnostics).map((message) => message.match(/"([^"]+)"/)?.[1]),
      ["defaultBeforeAuth", "destructuredBeforeAuth", "hiddenBuilder"],
    );
  });

  test("does not trust direct or namespace auth bindings shadowed inside handlers", () => {
    const source = `
      import { query } from "./_generated/server";
      import { requireSuperAdmin } from "./utils/tenancy";
      import * as tenancy from "./utils/tenancy";
      const authenticate = requireSuperAdmin;

      export const directParameter = query({
        handler: async (ctx, requireSuperAdmin) => await requireSuperAdmin(ctx),
      });
      export const aliasParameter = query({
        handler: async (ctx, authenticate) => await authenticate(ctx),
      });
      export const namespaceParameter = query({
        handler: async (ctx, tenancy) => await tenancy.requireSuperAdmin(ctx),
      });
      export const directHoisted = query({ handler: async (ctx) => {
        await requireSuperAdmin(ctx);
        function requireSuperAdmin() { return { _id: "forged" }; }
      }});
      export const namespaceLexical = query({ handler: async (ctx) => {
        await tenancy.requireSuperAdmin(ctx);
        const tenancy = { requireSuperAdmin: async () => ({ _id: "forged" }) };
      }});
    `;

    const diagnostics = scanAdminSuperAdmin(source, "convex/adminShadowed.ts");
    assert.equal(diagnostics.length, 5);
    assert.deepEqual(
      messages(diagnostics).map((message) => message.match(/"([^"]+)"/)?.[1]),
      [
        "directParameter",
        "aliasParameter",
        "namespaceParameter",
        "directHoisted",
        "namespaceLexical",
      ],
    );
  });

  test("fails closed for exported public builders hidden in wrapper expressions", () => {
    const source = `
      import { query } from "./_generated/server";
      const definition = { handler: async (ctx) => ctx.db.query("users").first() };
      export const conditional = enabled ? query(definition) : null;
      export const logical = enabled && query(definition);
      export default Object.freeze(query(definition));
    `;

    const diagnostics = scanAdminSuperAdmin(source, "convex/adminWrapped.ts");
    assert.equal(diagnostics.length, 3);
    assert.deepEqual(
      messages(diagnostics).map((message) => message.match(/"([^"]+)"/)?.[1]),
      ["conditional", "logical", "default"],
    );
    assert.ok(
      messages(diagnostics).every((message) => /unrecognized/.test(message)),
    );
  });

  test("rejects mutable and destructured exported admin registrations", () => {
    const source = `
      import { query } from "./_generated/server";
      import { requireSuperAdmin } from "./utils/tenancy";
      export let direct = query({ handler: async (ctx) => {
        await requireSuperAdmin(ctx);
        return true;
      }});
      direct = query({ handler: async () => true });

      let named = query({ handler: async (ctx) => {
        await requireSuperAdmin(ctx);
        return true;
      }});
      named = query({ handler: async () => true });
      export { named };

      export let assignedLater;
      assignedLater = query({ handler: async () => true });

      export const { destructured } = {
        destructured: query({ handler: async (ctx) => ctx.db.query("users").first() }),
      };
    `;

    const diagnostics = scanAdminSuperAdmin(source, "convex/adminExports.ts");
    const diagnosticNames = messages(diagnostics)
      .map((message) => message.match(/"([^"]+)"/)?.[1])
      .filter(Boolean);
    assert.deepEqual(
      [...new Set(diagnosticNames)],
      ["direct", "named", "assignedLater", "destructured"],
    );
    assert.match(
      diagnostics.find((entry) => entry.message.includes('"direct"')).message,
      /immutable const/,
    );
    assert.match(
      diagnostics.find((entry) => entry.message.includes('"named"')).message,
      /immutable const/,
    );
    assert.match(
      diagnostics.find((entry) => entry.message.includes('"assignedLater"'))
        .message,
      /unrecognized/,
    );
    assert.match(
      diagnostics.find((entry) => entry.message.includes('"destructured"'))
        .message,
      /unrecognized/,
    );
    assert.equal(
      diagnostics.filter((entry) => /runtime re-export/.test(entry.message))
        .length,
      2,
    );
  });

  test("rejects runtime module re-exports while allowing type-only exports", () => {
    const unsafeCases = [
      `export { bad } from "./hidden";`,
      `export { bad as renamed } from "./hidden";`,
      `export * from "./hidden";`,
      `export * as hidden from "./hidden";`,
      `import { bad } from "./hidden"; export { bad };`,
      `import hidden from "./hidden"; export default hidden;`,
      `module.exports = require("./hidden");`,
      `exports.bad = require("./hidden").bad;`,
      `module.exports.bad = require("./hidden").bad;`,
      `Object.assign(module.exports, require("./hidden"));`,
      `Object.assign(exports, require("./hidden"));`,
      `exports.bad ??= require("./hidden").bad;`,
      `export import hidden = require("./hidden");`,
      `import hidden = require("./hidden"); export { hidden };`,
      `import { bad } from "./hidden"; export const leak = bad;`,
      `
        import { bad } from "./hidden";
        const holder = { bad };
        export const leak = holder.bad;
      `,
      `
        import { bad } from "./hidden";
        const reveal = () => bad;
        export const leak = reveal();
      `,
      `
        import { bad } from "./hidden";
        const reveal = () => bad;
        export { reveal };
      `,
      `
        import { bad } from "./hidden";
        export const leak = { nested: [bad] };
      `,
    ];
    for (const [index, source] of unsafeCases.entries()) {
      const diagnostics = scanAdminSuperAdmin(
        source,
        `convex/admin/runtime-reexport-${index}.ts`,
      );
      assert.equal(
        diagnostics.length,
        1,
        `expected runtime re-export ${index} to fail exactly once`,
      );
      assert.equal(diagnostics[0].ruleId, RULE_IDS.ADMIN_SUPER_ADMIN_FIRST);
      assert.match(
        diagnostics[0].message,
        /runtime re-export|unrecognized Convex builder provenance/,
      );
    }

    const typeOnly = `
      export type { Hidden } from "./hidden";
      export { type AlsoHidden } from "./hidden";
      export type * from "./hidden";
      import type { LocalHidden } from "./hidden";
      export type { LocalHidden };
    `;
    assert.deepEqual(
      scanAdminSuperAdmin(typeOnly, "convex/admin/type-exports.ts"),
      [],
    );

    const shadowedCommonJs = `
      const local = {};
      {
        const module = { exports: {} };
        module.exports = local;
      }
      {
        const exports = {};
        exports.bad = local;
      }
    `;
    assert.deepEqual(
      scanAdminSuperAdmin(
        shadowedCommonJs,
        "convex/admin/shadowed-commonjs.ts",
      ),
      [],
    );
  });

  test("allows only the established admin audit helper alias", () => {
    const establishedHelper = `
      import { writeAuditLog } from "./utils/auditLog";
      export const logAdminAction = writeAuditLog;
    `;
    for (const file of ["convex/adminAudit.ts", "convex\\adminAudit.ts"]) {
      assert.deepEqual(scanAdminSuperAdmin(establishedHelper, file), []);
    }

    const nearMisses = [
      `
        import { writeAuditLog } from "./other";
        export const logAdminAction = writeAuditLog;
      `,
      `
        import { writeAuditLog } from "./utils/auditLog";
        export const otherAction = writeAuditLog;
      `,
      `
        import { writeAuditLog } from "./utils/auditLog";
        export const logAdminAction = { writeAuditLog };
      `,
    ];
    for (const source of nearMisses) {
      const diagnostics = scanAdminSuperAdmin(source, "convex/adminAudit.ts");
      assert.ok(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.ruleId === RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
        ),
      );
    }
  });

  test("rejects live, computed, class, call, and prototype runtime exports", () => {
    const cases = [
      `
        import { bad } from "./hidden";
        let alias = bad;
        export { alias };
      `,
      `
        import { bad } from "./hidden";
        const { missing = bad } = {};
        export { missing };
      `,
      `
        import { bad } from "./hidden";
        const { safe, ...rest } = { safe: true, bad };
        export { rest };
      `,
      `
        import { bad } from "./hidden";
        export default ({ leak: bad })[process.env.KEY];
      `,
      `
        import { bad } from "./hidden";
        class Helpers { static leak = bad; }
        export default Helpers.leak;
      `,
      `
        import { bad } from "./hidden";
        class BaseHelpers { static expose() { return bad; } }
        export class Helpers extends BaseHelpers {}
      `,
      `
        import { bad } from "./hidden";
        export class Helpers {
          static #hidden = () => bad;
          static expose() { return this.#hidden(); }
        }
      `,
      `
        import { bad } from "./hidden";
        const identity = (value) => value;
        export default { bad: identity.call(null, bad) };
      `,
      `
        import { bad } from "./hidden";
        const identity = (value) => value;
        export default identity.apply(null, [bad]);
      `,
      `
        import { bad } from "./hidden";
        const identity = (value) => value;
        export default identity.bind(null, bad)();
      `,
      `
        import { bad } from "./hidden";
        const holder = { identity(value) { return value; } };
        export default holder.identity(bad);
      `,
      `
        import { bad } from "./hidden";
        const pick = (value) => value.bad;
        export default pick({ bad });
      `,
      `
        import { bad } from "./hidden";
        export default { holder: Object.create({ bad }) };
      `,
      `
        import { bad } from "./hidden";
        export const api = {};
        api.bad = bad;
      `,
      `
        import { bad } from "./hidden";
        const outer = (value) => () => value;
        export default outer(bad)();
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const diagnostics = scanAdminSuperAdmin(
        source,
        `convex/admin/runtime-live-${index}.ts`,
      );
      assert.ok(
        diagnostics.some(
          (entry) => entry.ruleId === RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
        ),
        `expected runtime export case ${index} to fail`,
      );
    }

    const unsupported = `
      import { bad } from "./hidden";
      export default false && bad;
    `;
    assert.ok(
      scanAdminSuperAdmin(
        unsupported,
        "convex/admin/unreachable-runtime-export.ts",
      ).some((entry) => /runtime re-export/.test(entry.message)),
    );
  });

  test("accepts the canonical direct admin surface and rejects lookalike imports", () => {
    const canonical = `
      import { query } from "../_generated/server";
      import { requireSuperAdmin } from "../utils/tenancy";

      export const metadata = {
        revision: 1n,
        flags: [, true, false, null, \`literal\`],
        nested: { label: "admin" },
      };
      export type AdminMetadata = typeof metadata;
      export type { ExternalMetadata } from "./types";
      export const list = query({
        args: {},
        handler: async (ctx) => {
          await requireSuperAdmin(ctx);
          return true;
        },
      });
    `;
    assert.deepEqual(
      scanAdminSuperAdmin(canonical, "convex/admin/users.ts"),
      [],
    );

    const lookalikes = [
      `
        import { query } from "./_generated/server";
        export const list = query({ handler: async () => true });
      `,
      `
        import { mutation } from "./functions";
        export const update = mutation({ handler: async () => true });
      `,
      `
        import { query } from "../_generated/server";
        import { requireSuperAdmin } from "./utils/tenancy";
        export const list = query({ handler: async (ctx) => {
          await requireSuperAdmin(ctx);
          return true;
        }});
      `,
      `
        import { action, internalQuery } from "../_generated/server";
        import { internal } from "./_generated/api";
        import { requireSuperAdmin } from "../utils/tenancy";
        export const remove = action({ handler: async (ctx) => {
          await ctx.runQuery(internal.adminUsers.authorize, {});
          return true;
        }});
        export const authorize = internalQuery({ handler: async (ctx) => {
          await requireSuperAdmin(ctx);
          return true;
        }});
      `,
    ];
    for (const [index, source] of lookalikes.entries()) {
      assert.ok(
        scanAdminSuperAdmin(source, `convex/admin/lookalike-${index}.ts`).some(
          (entry) => entry.ruleId === RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
        ),
        `expected lookalike import ${index} to be rejected`,
      );
    }
  });

  test("requires unambiguous direct builder configurations", () => {
    const source = `
      import { query } from "./_generated/server";
      import { requireSuperAdmin } from "./utils/tenancy";
      const guarded = async (ctx) => {
        await requireSuperAdmin(ctx);
        return true;
      };
      const unguarded = async () => true;
      const dynamicKey = process.env.CONFIG_KEY;
      const definition = { handler: guarded };

      export const spread = query({ handler: guarded, ...{ handler: unguarded } });
      export const duplicate = query({ handler: guarded, handler: unguarded });
      export const computed = query({ handler: guarded, [dynamicKey]: unguarded });
      export const aliased = query(definition);
    `;
    const diagnostics = scanAdminSuperAdmin(
      source,
      "convex/adminConfigurations.ts",
    );
    assert.deepEqual(
      diagnostics.map((entry) => entry.message.match(/"([^"]+)"/)?.[1]),
      ["spread", "duplicate", "computed", "aliased"],
    );
  });

  test("accepts only inert authentication recovery paths", () => {
    const source = `
      import { query } from "./_generated/server";
      import { requireSuperAdmin } from "./utils/tenancy";
      import { fallback as undefined } from "./fallback";
      const doWork = () => null;

      export const importedUndefined = query({ handler: async (ctx) => {
        const admin = await requireSuperAdmin(ctx).catch(() => undefined);
        if (!admin) return null;
        return true;
      }});
      export const recoveryParameter = query({ handler: async (ctx) => {
        const admin = await requireSuperAdmin(ctx).catch((undefined) => undefined);
        if (!admin) return null;
        return true;
      }});
      export const handlerParameter = query({ handler: async (ctx, undefined) => {
        const admin = await requireSuperAdmin(ctx).catch(() => undefined);
        if (!admin) return null;
        return true;
      }});
      export const recoveryPattern = query({ handler: async (ctx) => {
        const admin = await requireSuperAdmin(ctx).catch(
          ({ [doWork()]: value }) => null,
        );
        if (!admin) return null;
        return true;
      }});
      export const catchPattern = query({ handler: async (ctx) => {
        try {
          await requireSuperAdmin(ctx);
        } catch ({ [doWork()]: value }) {
          return null;
        }
        return true;
      }});
      export const throwingCatch = query({ handler: async (ctx) => {
        try {
          await requireSuperAdmin(ctx);
        } catch {
          throw doWork();
        }
      }});
    `;
    const diagnostics = scanAdminSuperAdmin(source, "convex/adminRecovery.ts");
    assert.deepEqual(
      diagnostics.map((entry) => entry.message.match(/"([^"]+)"/)?.[1]),
      [
        "importedUndefined",
        "recoveryParameter",
        "handlerParameter",
        "recoveryPattern",
        "catchPattern",
        "throwingCatch",
      ],
    );
  });

  test("rejects registrations exported through containers", () => {
    const source = `
      import { query } from "./_generated/server";
      const registration = query({ handler: async () => true });
      export const indexed = [registration][0];
      export const nested = { endpoint: registration };
      const holder = [registration];
      export { holder };
      export default { endpoint: registration };
    `;
    const diagnostics = scanAdminSuperAdmin(
      source,
      "convex/adminContainers.ts",
    );
    assert.equal(diagnostics.length, 4);
    assert.ok(
      diagnostics.every((entry) => /runtime re-export/.test(entry.message)),
    );
  });

  test("trusts only immutable generated internal references for delegated auth", () => {
    const safe = `
      import { action, internalQuery } from "./_generated/server";
      import { internal as generatedInternal } from "./_generated/api";
      import * as generatedApi from "./_generated/api";
      import { requireSuperAdmin } from "./utils/tenancy";
      const aliasedInternal = generatedInternal;
      const { internal: destructuredInternal } = generatedApi;

      export const direct = action({ handler: async (ctx) => {
        await ctx.runQuery(generatedInternal.adminRefs.authorize, {});
        return true;
      }});
      export const aliased = action({ handler: async (ctx) => {
        await ctx.runQuery(aliasedInternal.adminRefs.authorize, {});
        return true;
      }});
      export const namespaced = action({ handler: async (ctx) => {
        await ctx.runQuery(generatedApi.internal.adminRefs.authorize, {});
        return true;
      }});
      export const destructured = action({ handler: async (ctx) => {
        await ctx.runQuery(destructuredInternal.adminRefs.authorize, {});
        return true;
      }});
      export const authorize = internalQuery({ handler: async (ctx) => {
        await requireSuperAdmin(ctx);
        return true;
      }});
    `;
    assert.deepEqual(scanAdminSuperAdmin(safe, "convex/adminRefs.ts"), []);

    const unsafe = `
      import { action, internalQuery } from "./_generated/server";
      import { internal as generatedInternal } from "./_generated/api";
      import { requireSuperAdmin } from "./utils/tenancy";
      const fake = { adminRefs: { authorize: localRef } };
      let reassignedInternal = generatedInternal;
      reassignedInternal = fake;
      generatedInternal = fake;

      export const forged = action({ handler: async (ctx) => {
        await ctx.runQuery(fake.adminRefs.authorize, {});
        return true;
      }});
      export const shadowed = action({ handler: async (ctx, generatedInternal) => {
        await ctx.runQuery(generatedInternal.adminRefs.authorize, {});
        return true;
      }});
      export const reassigned = action({ handler: async (ctx) => {
        await ctx.runQuery(reassignedInternal.adminRefs.authorize, {});
        return true;
      }});
      export const directReassigned = action({ handler: async (ctx) => {
        await ctx.runQuery(generatedInternal.adminRefs.authorize, {});
        return true;
      }});
      export const authorize = internalQuery({ handler: async (ctx) => {
        await requireSuperAdmin(ctx);
        return true;
      }});
    `;
    const diagnostics = scanAdminSuperAdmin(unsafe, "convex/adminRefs.ts");
    assert.equal(diagnostics.length, 4);
    assert.deepEqual(
      messages(diagnostics).map((message) => message.match(/"([^"]+)"/)?.[1]),
      ["forged", "shadowed", "reassigned", "directReassigned"],
    );

    const wrongNestedModule = `
      import { action, internalQuery } from "../_generated/server";
      import { internal } from "../_generated/api";
      import { requireSuperAdmin } from "../utils/tenancy";
      export const forged = action({ handler: async (ctx) => {
        await ctx.runQuery(internal.other.users.authorize, {});
        return true;
      }});
      export const authorize = internalQuery({ handler: async (ctx) => {
        await requireSuperAdmin(ctx);
        return true;
      }});
    `;
    assert.equal(
      scanAdminSuperAdmin(wrongNestedModule, "convex/admin/users.ts").length,
      1,
    );
  });
});

describe("economics-revision", () => {
  test("accepts direct, shorthand, spread, branch, loader, and helper-proven bumps", () => {
    const source = `
      import { requireOwnedRow } from "./utils/tenancy";
      const app = await ctx.db.get(id);
      const stamp = { economicsRevision: (app.economicsRevision ?? 0) + 1 };
      const approvedDealerPurchaseAmountMinor = amount;
      const payload = { ...stamp, approvedDealerPurchaseAmountMinor };
      await ctx.db.patch(id, payload);

      const bumpRevision = (revision) => revision + 1;
      await ctx.db.replace(app._id, condition
        ? {
            economicsRevision: bumpRevision(app.economicsRevision ?? 0),
            dealerContributionMinor: 10,
          }
        : {
            economicsRevision: (app.economicsRevision ?? 0) + 1,
            unfinancedPortionMinor: 20,
          });

      {
        const current = await requireOwnedRow(ctx, orgId, "financeApplications", id);
        const economicsRevision = (current.economicsRevision ?? 0) + 1;
        await ctx.db.patch(id, {
          economicsRevision,
          financeCompanyFundedPortionMinor: 30,
        });
      }
    `;
    assert.deepEqual(scanEconomicsRevision(source, "convex/finance.ts"), []);
  });

  test("rejects same, missing, zero, forged, unrelated, and mutable revision proofs", () => {
    const source = `
      const app = await ctx.db.get(id);
      const other = await ctx.db.get(otherId);
      await ctx.db.patch(id, {
        dealerContributionMinor: 1,
        economicsRevision: app.economicsRevision,
      });
      await ctx.db.patch(id, {
        dealerContributionMinor: 2,
        economicsRevision: undefined,
      });
      await ctx.db.patch(id, {
        dealerContributionMinor: 3,
        economicsRevision: 0,
      });
      await ctx.db.patch(id, {
        dealerContributionMinor: 4,
        economicsRevision: next,
      });
      await ctx.db.patch(id, {
        dealerContributionMinor: 5,
        economicsRevision: (({ economicsRevision: 8 }).economicsRevision ?? 0) + 1,
      });
      await ctx.db.patch(id, {
        dealerContributionMinor: 6,
        economicsRevision: (getForged().economicsRevision ?? 0) + 1,
      });
      await ctx.db.patch(id, {
        dealerContributionMinor: 7,
        economicsRevision: (other.economicsRevision ?? 0) + 1,
      });
      let revision = (app.economicsRevision ?? 0) + 1;
      revision = 0;
      await ctx.db.patch(id, {
        dealerContributionMinor: 8,
        economicsRevision: revision,
      });
      const mutablePayload = {
        dealerContributionMinor: 9,
        economicsRevision: (app.economicsRevision ?? 0) + 1,
      };
      mutablePayload.economicsRevision = 0;
      await ctx.db.patch(id, mutablePayload);
    `;
    assert.equal(scanEconomicsRevision(source, "convex/finance.ts").length, 9);
  });

  test("folds computed economics keys and fails closed on unresolved keys", () => {
    const source = `
      const app = await ctx.db.get(id);
      const suffix = "ContributionMinor";
      await ctx.db.patch(id, { ["dealer" + suffix]: amount });
      await ctx.db.patch(id, { [runtimeKey]: amount });
      await ctx.db.patch(id, {
        ["dealer" + suffix]: amount,
        ["economics" + "Revision"]: (app.economicsRevision ?? 0) + 1,
      });
    `;
    assert.equal(scanEconomicsRevision(source, "convex/finance.ts").length, 2);
  });

  test("flags patch, replace, computed-key, variable, and unknown-spread bypasses", () => {
    const source = `
      await ctx.db.patch(id, { approvedDealerPurchaseAmountMinor: amount });
      await ctx.db.replace(id, { dealerContributionMinor: amount });
      await ctx.db["patch"](id, { ["unfinancedPortionMinor"]: amount });
      const changes = { financeCompanyFundedPortionMinor: amount };
      await db.patch(id, changes);
      await ctx.db.patch(id, { ...unknownChanges, approvedDealerPurchaseAmountMinor: amount });
      const database = ctx.db;
      await database.patch(id, { dealerContributionMinor: amount });
    `;
    const diagnostics = scanEconomicsRevision(source, "convex/finance.ts");
    assert.equal(diagnostics.length, 6);
    assert.ok(
      diagnostics.every((item) => item.ruleId === RULE_IDS.ECONOMICS_REVISION),
    );
  });

  test("requires the revision at payload top level and in every relevant branch", () => {
    const source = `
      await ctx.db.patch(id, {
        metadata: { economicsRevision: next },
        approvedDealerPurchaseAmountMinor: amount,
      });
      await ctx.db.patch(id, condition
        ? { economicsRevision: next, dealerContributionMinor: 10 }
        : { dealerContributionMinor: 20 });
    `;
    assert.equal(scanEconomicsRevision(source, "convex/finance.ts").length, 2);
  });

  test("does not confuse evidence reads, nested fields, unknown payloads, or other patch APIs with writes", () => {
    const source = `
      await ctx.db.patch(id, {
        supplierDisbursementApprovedAtRecordingMinor: app.approvedDealerPurchaseAmountMinor,
        snapshot: { approvedDealerPurchaseAmountMinor: amount },
      });
      await ctx.db.patch(id, getChanges());
      await cache.patch(id, { approvedDealerPurchaseAmountMinor: amount });
    `;
    assert.deepEqual(scanEconomicsRevision(source, "convex/finance.ts"), []);
  });

  test("resolves local payload factories with call-site argument mapping", () => {
    const source = `
      import { requireOwnedRow } from "./utils/tenancy";
      function changesFor(current, amount) {
        const payload = {};
        Object.assign(payload, {
          dealerContributionMinor: amount,
          economicsRevision: (current.economicsRevision ?? 0) + 1,
        });
        return payload;
      }
      const current = await requireOwnedRow(
        ctx, orgId, "financeApplications", applicationId,
      );
      await ctx.db.patch(applicationId, changesFor(current, amount));
    `;
    assert.deepEqual(scanEconomicsRevision(source, "convex/finance.ts"), []);

    const forged = source.replace(
      "await ctx.db.patch(applicationId, changesFor(current, amount));",
      "await ctx.db.patch(applicationId, changesFor(args.application, amount));",
    );
    assert.equal(scanEconomicsRevision(forged, "convex/finance.ts").length, 1);
  });

  test("tracks property mutation, Object.assign, and conditional revision writes", () => {
    const source = `
      const current = await ctx.db.get(id);
      const safe = {};
      safe.dealerContributionMinor = amount;
      safe.economicsRevision = (current.economicsRevision ?? 0) + 1;
      await ctx.db.patch(id, safe);

      const overwritten = {
        dealerContributionMinor: amount,
        economicsRevision: (current.economicsRevision ?? 0) + 1,
      };
      Object.assign(overwritten, { economicsRevision: 0 });
      await ctx.db.patch(id, overwritten);

      const assigned = {};
      Object.assign(assigned, { financeCompanyFundedPortionMinor: amount });
      await ctx.db.patch(id, assigned);

      const conditional = { unfinancedPortionMinor: amount };
      if (approved) {
        conditional.economicsRevision = (current.economicsRevision ?? 0) + 1;
      }
      await ctx.db.patch(id, conditional);

      const computed = {};
      computed.dealerContributionMinor = amount;
      computed.economicsRevision = (current.economicsRevision ?? 0) + 1;
      computed[runtimeField] = amount;
      await ctx.db.patch(id, computed);
    `;
    const diagnostics = scanEconomicsRevision(source, "convex/finance.ts");
    assert.equal(diagnostics.length, 4);
    assert.ok(
      messages(diagnostics).some((message) =>
        /unresolved computed/.test(message),
      ),
    );
  });

  test("recognizes destructured, direct, and computed database write methods", () => {
    const source = `
      const current = await ctx.db.get(id);
      const operation = "pa" + "tch";
      await ctx.db[operation](id, {
        dealerContributionMinor: amount,
        economicsRevision: (current.economicsRevision ?? 0) + 1,
      });

      const directPatch = ctx.db.patch;
      directPatch(id, { approvedDealerPurchaseAmountMinor: amount });
      const { replace: directReplace } = ctx.db;
      directReplace(id, { dealerContributionMinor: amount });
      const { db: database } = ctx;
      const { patch: destructuredPatch } = database;
      destructuredPatch(id, { unfinancedPortionMinor: amount });
    `;
    assert.equal(scanEconomicsRevision(source, "convex/finance.ts").length, 3);
  });

  test("requires record reads to use the same database and exact owned-row id slot", () => {
    const source = `
      import { requireOwnedRow } from "./utils/tenancy";
      const attackerLoaded = await attacker.db.get(id);
      await ctx.db.patch(id, {
        dealerContributionMinor: amount,
        economicsRevision: (attackerLoaded.economicsRevision ?? 0) + 1,
      });

      const wrongId = await requireOwnedRow(
        ctx, orgId, "financeApplications", otherId, id,
      );
      await ctx.db.patch(id, {
        dealerContributionMinor: amount,
        economicsRevision: (wrongId.economicsRevision ?? 0) + 1,
      });

      const wrongContext = await requireOwnedRow(
        attacker, orgId, "financeApplications", id,
      );
      await ctx.db.patch(id, {
        dealerContributionMinor: amount,
        economicsRevision: (wrongContext.economicsRevision ?? 0) + 1,
      });

      async function handler(ctx, args) {
        await ctx.db.patch(args.id, {
          dealerContributionMinor: amount,
          economicsRevision: (args.application.economicsRevision ?? 0) + 1,
        });
      }
    `;
    assert.equal(scanEconomicsRevision(source, "convex/finance.ts").length, 4);
  });

  test("proves named helper record parameters only from every local call site", () => {
    const safe = `
      async function persist(ctx, current) {
        await ctx.db.patch(current._id, {
          dealerContributionMinor: amount,
          economicsRevision: (current.economicsRevision ?? 0) + 1,
        });
      }
      const current = await ctx.db.get(id);
      if (current) await persist(ctx, current);
    `;
    assert.deepEqual(scanEconomicsRevision(safe, "convex/finance.ts"), []);

    const unsafe = safe + "\nawait persist(ctx, args.application);\n";
    assert.equal(scanEconomicsRevision(unsafe, "convex/finance.ts").length, 1);
  });

  test("rejects conditional, logical, and deleted revision mutations", () => {
    const unsafeMutations = [
      {
        initialRevision: "",
        statement: "approved && (payload.economicsRevision = bump);",
      },
      {
        initialRevision: "",
        statement: "payload.economicsRevision &&= bump;",
      },
      {
        initialRevision: "economicsRevision: bump,",
        statement: "delete payload.economicsRevision;",
      },
      {
        initialRevision: "economicsRevision: bump,",
        statement: 'Reflect.deleteProperty(payload, "economicsRevision");',
      },
    ];

    for (const { initialRevision, statement } of unsafeMutations) {
      const source = `
        import { requireOwnedRow } from "./utils/tenancy";
        const current = await requireOwnedRow(
          ctx, orgId, "financeApplications", id,
        );
        const bump = (current.economicsRevision ?? 0) + 1;
        const payload: {
          dealerContributionMinor: number;
          economicsRevision?: number;
        } = {
          dealerContributionMinor: amount,
          ${initialRevision}
        };
        ${statement}
        await ctx.db.patch(id, payload);
      `;
      assert.equal(
        scanEconomicsRevision(source, "convex/finance.ts").length,
        1,
      );
    }
  });

  test("resolves destructured and defaulted local payload factory parameters", () => {
    const destructured = `
      import { requireOwnedRow } from "./utils/tenancy";
      const current = await requireOwnedRow(
        ctx, orgId, "financeApplications", id,
      );
      function makeChanges({ record, amount }: {
        record: { economicsRevision?: number };
        amount: number;
      }) {
        return {
          dealerContributionMinor: amount,
          economicsRevision: (record.economicsRevision ?? 0) + 1,
        };
      }
      await ctx.db.patch(
        id,
        makeChanges({ record: args.application, amount }),
      );
    `;
    assert.equal(
      scanEconomicsRevision(destructured, "convex/finance.ts").length,
      1,
    );

    const defaulted = `
      function makeChanges(amount = 1) {
        return { dealerContributionMinor: amount };
      }
      await ctx.db.patch(id, makeChanges());
    `;
    assert.equal(
      scanEconomicsRevision(defaulted, "convex/finance.ts").length,
      1,
    );
  });

  test("recognizes mutable database aliases and bound write methods", () => {
    const mutableAlias = `
      let database = ctx.db;
      await database.patch(id, { dealerContributionMinor: amount });
    `;
    assert.equal(
      scanEconomicsRevision(mutableAlias, "convex/finance.ts").length,
      1,
    );

    const boundMethod = `
      const patch = ctx.db.patch.bind(ctx.db);
      await patch(id, { dealerContributionMinor: amount });
    `;
    assert.equal(
      scanEconomicsRevision(boundMethod, "convex/finance.ts").length,
      1,
    );
  });

  test("rejects shadowed loaders and nested revision owners", () => {
    const shadowedLoader = `
      import { requireOwnedRow } from "./utils/tenancy";
      async function handler(ctx, args) {
        const requireOwnedRow = async () => args.application;
        const forged = await requireOwnedRow(
          ctx, orgId, "financeApplications", id,
        );
        await ctx.db.patch(id, {
          dealerContributionMinor: amount,
          economicsRevision: (forged.economicsRevision ?? 0) + 1,
        });
      }
    `;
    assert.equal(
      scanEconomicsRevision(shadowedLoader, "convex/finance.ts").length,
      1,
    );

    const shadowedParameter = `
      import { requireOwnedRow } from "./utils/tenancy";
      async function handler(ctx, requireOwnedRow) {
        const forged = await requireOwnedRow(
          ctx, orgId, "financeApplications", id,
        );
        await ctx.db.patch(id, {
          dealerContributionMinor: amount,
          economicsRevision: (forged.economicsRevision ?? 0) + 1,
        });
      }
    `;
    assert.equal(
      scanEconomicsRevision(shadowedParameter, "convex/finance.ts").length,
      1,
    );

    const nestedOwner = `
      import { requireOwnedRow } from "./utils/tenancy";
      const current = await requireOwnedRow(
        ctx, orgId, "financeApplications", id,
      );
      await ctx.db.patch(id, {
        dealerContributionMinor: amount,
        economicsRevision: (current.snapshot.economicsRevision ?? 0) + 1,
      });
    `;
    assert.equal(
      scanEconomicsRevision(nestedOwner, "convex/finance.ts").length,
      1,
    );
  });

  test("invalidates loaded rows poisoned through local helpers and aliases", () => {
    const unsafeEffects = [
      `function poison(row, otherId) {
         row._id = otherId;
         row.economicsRevision = 999;
       }
       poison(current, otherId);`,
      `function poison(row) { row.economicsRevision = 999; }
       const alias = current;
       poison(alias);`,
      `function poison(row) {
         Object.assign(row, { economicsRevision: 999 });
       }
       poison(current);`,
      `function poison(row, otherId) {
         Reflect.set(row, "_id", otherId);
       }
       poison(current, otherId);`,
      `function invoke(row, callback) { return callback(row); }
       invoke(current, (row) => { row.economicsRevision = 999; });`,
      `queueMicrotask(() => { current.economicsRevision = 999; });`,
      `function poison(row) { row.economicsRevision = 999; }
       poison.call(null, current);`,
      `function poison(row) { row.economicsRevision = 999; }
       poison.apply(null, [current]);`,
      `function poison(row) { row.economicsRevision = 999; }
       Reflect.apply(poison, null, [current]);`,
      `function poison(row) { row.economicsRevision = 999; }
       poison.bind(null, current)();`,
      `function poison(row) { row.economicsRevision = 999; }
       ({ poison }).poison(current);`,
      `function poison(row) { row.economicsRevision = 999; }
       [poison][0](current);`,
      `function poison(row) { row.economicsRevision = 999; }
       (enabled ? poison : poison)(current);`,
      `function poison(row) { row.economicsRevision = 999; }
       Reflect.get({ poison }, "poison")(current);`,
      `function poison(row) { arguments[0].economicsRevision = 999; }
       poison(current);`,
      `function poison(row = current) { row.economicsRevision = 999; }
       poison();`,
      `function later(row) {
         return () => { row.economicsRevision = 999; };
       }
       later(current)();`,
      `function poison() { this.economicsRevision = 999; }
       poison.call(current);`,
      `function poison() { this.economicsRevision = 999; }
       poison.apply(current, []);`,
      `function poison() { this.economicsRevision = 999; }
       poison.bind(current)();`,
      `function poison() { this.economicsRevision = 999; }
       Reflect.apply(poison, current, []);`,
      `function Poison(row) { row.economicsRevision = 999; }
       new Poison(current);`,
      `class Poison {
         constructor(row) { row.economicsRevision = 999; }
       }
       new Poison(current);`,
      `new Proxy(current, {});`,
      `function Poison(row) { row.economicsRevision = 999; }
       Reflect.construct(Poison, [current]);`,
      `function poisonTag(parts, row) { row.economicsRevision = 999; }
       poisonTag\`${"${current}"}\`;`,
      `const maybePoison = enabled
         ? (row) => { row.economicsRevision = 999; }
         : undefined;
       maybePoison?.(current);`,
    ];

    for (const effect of unsafeEffects) {
      const source = `
        const current = await ctx.db.get(id);
        ${effect}
        await ctx.db.patch(current._id, {
          approvedDealerPurchaseAmountMinor: amount,
          economicsRevision: (current.economicsRevision ?? 0) + 1,
        });
      `;
      assert.equal(
        scanEconomicsRevision(source, "convex/finance.ts").length,
        1,
      );
    }
  });

  test("retains provenance through read-only local helpers and callbacks", () => {
    const source = `
      function inspect(row) {
        const alias = row;
        return alias.economicsRevision;
      }
      function invoke(row, callback) { return callback(row); }
      function Snapshot(row) { this.id = row._id; }
      function readTag(parts, revision) { return revision; }
      function inspectDefault(row = current) { return row.economicsRevision; }
      function later(row) { return () => row.economicsRevision; }
      const current = await ctx.db.get(id);
      const observed = inspect(current);
      const defaultObserved = inspectDefault();
      const laterObserved = later(current)();
      const called = inspect.call(null, current);
      const applied = Reflect.apply(inspect, null, [current]);
      const bound = inspect.bind(null, current)();
      const callbackObserved = invoke(
        current,
        (row) => row.economicsRevision,
      );
      const snapshot = new Snapshot(current);
      const tagged = readTag\`${"${current.economicsRevision}"}\`;
      queueMicrotask(() => current.economicsRevision);
      await ctx.db.patch(current._id, {
        approvedDealerPurchaseAmountMinor: amount,
        economicsRevision: (current.economicsRevision ?? 0) + 1,
      });
    `;
    assert.deepEqual(scanEconomicsRevision(source, "convex/finance.ts"), []);
  });

  test("fails closed for imported row helpers except the exact reviewed projection", () => {
    const routeFile = "convex/utils/vehicleOwnership.ts";
    const routeSource = fs.readFileSync(
      path.join(REPOSITORY_ROOT, routeFile),
      "utf8",
    );
    const source = `
      import { consignedSettlementRoute } from "./utils/vehicleOwnership";
      const current = await ctx.db.get(id);
      consignedSettlementRoute(current);
      await ctx.db.patch(current._id, {
        approvedDealerPurchaseAmountMinor: amount,
        economicsRevision: (current.economicsRevision ?? 0) + 1,
      });
    `;
    const scan = (helperSource) =>
      scanEconomicsRevision(source, "convex/finance.ts", {
        moduleSources: new Map([[routeFile, helperSource]]),
      });

    assert.equal(scanEconomicsRevision(source, "convex/finance.ts").length, 1);
    const routeLf = routeSource.replaceAll("\r\n", "\n");
    const routeCrlf = routeLf.replaceAll("\n", "\r\n");
    assert.deepEqual(scan(routeLf), []);
    assert.deepEqual(scan(routeCrlf), []);

    const changedHelpers = [
      routeSource.replace(
        'return sale.supplierSettlementRoute ?? "THROUGH_DEALERSHIP";',
        `sale.economicsRevision = 999;
         return sale.supplierSettlementRoute ?? "THROUGH_DEALERSHIP";`,
      ),
      routeSource.replace(
        'return sale.supplierSettlementRoute ?? "THROUGH_DEALERSHIP";',
        `return
         sale.supplierSettlementRoute ?? "THROUGH_DEALERSHIP";`,
      ),
      `${routeSource}\nconsignedSettlementRoute = (sale) => {
        sale.economicsRevision = 999;
        return "THROUGH_DEALERSHIP";
      };`,
      `${routeSource}\nObject.defineProperty(
        Object.prototype,
        "supplierSettlementRoute",
        { get() { this.economicsRevision = 999; return "THROUGH_DEALERSHIP"; } },
      );`,
    ];
    for (const helperSource of changedHelpers) {
      assert.equal(scan(helperSource).length, 1);
    }
  });

  test("rejects aliases, wrappers, containers, and malicious imported helpers", () => {
    const routeFile = "convex/utils/vehicleOwnership.ts";
    const routeSource = fs.readFileSync(
      path.join(REPOSITORY_ROOT, routeFile),
      "utf8",
    );
    const importedCalls = [
      [
        `import type { consignedSettlementRoute } from "./utils/vehicleOwnership";`,
        `consignedSettlementRoute(current);`,
      ],
      [
        `import { consignedSettlementRoute as route } from "./utils/vehicleOwnership";`,
        `route(current);`,
      ],
      [
        `import * as ownership from "./utils/vehicleOwnership";`,
        `ownership.consignedSettlementRoute(current);`,
      ],
      [
        `import { consignedSettlementRoute } from "./route-wrapper";`,
        `consignedSettlementRoute(current);`,
      ],
      [
        `import { consignedSettlementRoute } from "./utils/vehicleOwnership";`,
        `consignedSettlementRoute?.(current);`,
      ],
      [
        `import { consignedSettlementRoute } from "./utils/vehicleOwnership";`,
        `consignedSettlementRoute({ row: current });`,
      ],
      [
        `import { consignedSettlementRoute } from "./utils/vehicleOwnership";`,
        `consignedSettlementRoute(current, other);`,
      ],
      [`import { poison } from "./poison";`, `poison(current, other);`],
    ];
    const moduleSources = new Map([
      [routeFile, routeSource],
      [
        "convex/route-wrapper.ts",
        `export { consignedSettlementRoute } from "./utils/vehicleOwnership";`,
      ],
      [
        "convex/poison.ts",
        `export function poison(row, other) {
        row._id = other;
        row.economicsRevision = 999;
      }`,
      ],
    ]);

    for (const [importStatement, importedCall] of importedCalls) {
      const source = `
        ${importStatement}
        const current = await ctx.db.get(id);
        ${importedCall}
        await ctx.db.patch(current._id, {
          approvedDealerPurchaseAmountMinor: amount,
          economicsRevision: (current.economicsRevision ?? 0) + 1,
        });
      `;
      assert.equal(
        scanEconomicsRevision(source, "convex/finance.ts", {
          moduleSources,
        }).length,
        1,
      );
    }
  });

  test("resolves named, namespace, default, aliased, and re-exported payload factories", () => {
    const moduleSources = new Map([
      [
        "convex/payload.ts",
        `
          export function named(amount) {
            return { dealerContributionMinor: amount };
          }
          export default function defaultPayload(amount) {
            return { unfinancedPortionMinor: amount };
          }
          export function ordinary(name) {
            return { displayName: name };
          }
        `,
      ],
      [
        "convex/payload/index.ts",
        `export { named as indexed } from "../payload.js";`,
      ],
      [
        "convex/barrel.ts",
        `export { named as reexported } from "./payload.js";`,
      ],
    ]);
    const unsafeImports = [
      [
        `import { named as makeChanges } from "./payload.js";`,
        `makeChanges(amount)`,
      ],
      [`import * as payloads from "./payload";`, `payloads.named(amount)`],
      [`import makeChanges from "./payload.ts";`, `makeChanges(amount)`],
      [`import { reexported } from "./barrel";`, `reexported(amount)`],
      [`import { indexed } from "./payload/index.js";`, `indexed(amount)`],
    ];

    for (const [importStatement, payload] of unsafeImports) {
      const source = `${importStatement}
        await ctx.db.patch(id, ${payload});`;
      assert.equal(
        scanEconomicsRevision(source, "convex/finance.ts", {
          moduleSources,
        }).length,
        1,
      );
    }

    const ordinary = `
      import { requireOwnedRow } from "./utils/tenancy";
      import { ordinary as makeChanges } from "./payload.js";
      await requireOwnedRow(
        ctx, orgId, "financeApplications", applicationId,
      );
      await ctx.db.patch(applicationId, makeChanges(name));
    `;
    assert.deepEqual(
      scanEconomicsRevision(ordinary, "convex/finance.ts", { moduleSources }),
      [],
    );
  });

  test("uses NodeNext source substitutions for explicit runtime extensions", () => {
    const extensionPairs = [
      [".js", ".ts"],
      [".jsx", ".tsx"],
      [".mjs", ".mts"],
      [".cjs", ".cts"],
    ];
    for (const [runtimeExtension, sourceExtension] of extensionPairs) {
      const moduleSources = new Map([
        [
          `convex/payload${runtimeExtension}`,
          `export function build() { return { displayName: "ordinary" }; }`,
        ],
        [
          `convex/payload${sourceExtension}`,
          `export function build() { return { dealerContributionMinor: 7 }; }`,
        ],
      ]);
      const source = `
        import { build } from "./payload${runtimeExtension}";
        await ctx.db.patch(id, build());
      `;
      assert.equal(
        scanEconomicsRevision(source, "convex/finance.ts", {
          moduleSources,
        }).length,
        1,
      );
    }
  });

  test("maps imported factory arguments across branches and spreads", () => {
    const moduleSources = new Map([
      [
        "convex/payload.ts",
        `
          export function safe(current, amount, enabled) {
            const money = { dealerContributionMinor: amount };
            return enabled
              ? {
                  ...money,
                  economicsRevision: (current.economicsRevision ?? 0) + 1,
                }
              : {
                  economicsRevision: 1 + (current.economicsRevision ?? 0),
                  ...money,
                };
          }
          export function stale(current, amount) {
            return {
              dealerContributionMinor: amount,
              economicsRevision: current.economicsRevision,
            };
          }
          export function unsafeBranch(current, amount, enabled) {
            return enabled
              ? {
                  dealerContributionMinor: amount,
                  economicsRevision: (current.economicsRevision ?? 0) + 1,
                }
              : { dealerContributionMinor: amount };
          }
          export function shadowed(current, amount) {
            {
              const current = forged;
              return {
                dealerContributionMinor: amount,
                economicsRevision: (current.economicsRevision ?? 0) + 1,
              };
            }
          }
        `,
      ],
    ]);
    const sourceFor = (factory) => `
      import { requireOwnedRow } from "./utils/tenancy";
      import { ${factory} as makeChanges } from "./payload.js";
      const current = await requireOwnedRow(
        ctx, orgId, "financeApplications", applicationId,
      );
      await ctx.db.patch(
        applicationId,
        makeChanges(current, amount, enabled),
      );
    `;
    assert.deepEqual(
      scanEconomicsRevision(sourceFor("safe"), "convex/finance.ts", {
        moduleSources,
      }),
      [],
    );
    assert.equal(
      scanEconomicsRevision(sourceFor("stale"), "convex/finance.ts", {
        moduleSources,
      }).length,
      1,
    );
    assert.equal(
      scanEconomicsRevision(sourceFor("unsafeBranch"), "convex/finance.ts", {
        moduleSources,
      }).length,
      1,
    );
    assert.equal(
      scanEconomicsRevision(sourceFor("shadowed"), "convex/finance.ts", {
        moduleSources,
      }).length,
      1,
    );
  });

  test("fails closed for reassigned, side-effectful, recursive, and ambiguous factories", () => {
    const financeSource = (specifier = "./payload") => `
      import { requireOwnedRow } from "./utils/tenancy";
      import { build } from "${specifier}";
      const current = await requireOwnedRow(
        ctx, orgId, "financeApplications", applicationId,
      );
      await ctx.db.patch(applicationId, build(current, amount));
    `;
    const cases = [
      new Map([
        [
          "convex/payload.ts",
          `
            export function build() { return { displayName: "before" }; }
            build = () => ({ displayName: "after" });
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            export function build() { return { displayName: "before" }; }
            eval("build = () => ({ dealerContributionMinor: 7 })");
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            export function build() { return { displayName: "before" }; }
            for (build of [evil]) {}
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            export function build(
              current,
              amount,
              ignored = (current.economicsRevision = -1),
            ) {
              return {
                dealerContributionMinor: amount,
                economicsRevision: (current.economicsRevision ?? 0) + 1,
              };
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            export function build(current, amount) {
              const payload = {
                dealerContributionMinor: amount,
                economicsRevision: (current.economicsRevision ?? 0) + 1,
              };
              for (payload.economicsRevision of [0]) {}
              return payload;
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            export function build(current, amount) {
              audit(current);
              return {
                dealerContributionMinor: amount,
                economicsRevision: (current.economicsRevision ?? 0) + 1,
              };
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            let counter = 0;
            export function build(current, amount) {
              const payload = {
                dealerContributionMinor: amount,
                economicsRevision: (current.economicsRevision ?? 0) + 1,
              };
              payload.economicsRevision--;
              counter++;
              return payload;
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            export function build(current, amount) {
              let payload = {};
              payload = current;
              payload.dealerContributionMinor = amount;
              return payload;
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            let leaked;
            export function build() {
              leaked = {};
              return { displayName: "ordinary" };
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            Object.assign = evil;
            export function build(current, amount) {
              return Object.assign({}, {
                dealerContributionMinor: amount,
                economicsRevision: (current.economicsRevision ?? 0) + 1,
              });
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            function poison(target) {
              target.dealerContributionMinor = 7;
            }
            export function build() {
              const target = {};
              const source = {
                get displayName() {
                  poison(target);
                  return "safe";
                },
              };
              return { ...source, ...target };
            }
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            import { poisoner } from "./helper";
            export const target = { displayName: "safe" };
            export function build() {
              const ignored = poisoner.value;
              return { ...target };
            }
          `,
        ],
        [
          "convex/helper.ts",
          `
            import { target } from "./payload";
            export const poisoner = {
              get value() {
                target.dealerContributionMinor = 7;
                return 0;
              },
            };
          `,
        ],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `
            export function build(target, source) {
              const ignored = source.value;
              return { ...target };
            }
          `,
        ],
      ]),
      new Map([
        ["convex/payload.ts", `export function build() { return build(); }`],
      ]),
      new Map([
        [
          "convex/payload.ts",
          `export * from "./first"; export * from "./second";`,
        ],
        ["convex/first.ts", `export function build() { return {}; }`],
        ["convex/second.ts", `export function build() { return {}; }`],
      ]),
    ];

    for (const moduleSources of cases) {
      const diagnostics = scanEconomicsRevision(
        financeSource(),
        "convex/finance.ts",
        { moduleSources },
      );
      assert.equal(diagnostics.length, 1);
      assert.match(
        diagnostics[0].message,
        /unstable imported payload|dealerContributionMinor/,
      );
    }
  });

  test("applies module-initialization mutations to captured factory payloads", () => {
    const payloadSources = [
      `
          const payload = { displayName: "before" };
          payload.dealerContributionMinor = 7;
          export function build() { return payload; }
        `,
      `
          const payload = { displayName: "before" };
          const alias = payload;
          alias.dealerContributionMinor = 7;
          export function build() { return payload; }
        `,
      `
          const payload = { displayName: "before" };
          function poison(value) { value.dealerContributionMinor = 7; }
          poison(payload);
          export function build() { return payload; }
        `,
      `
          const platform = globalThis;
          platform.Object.assign = evil;
          export function build() {
            return Object.assign({}, { dealerContributionMinor: 7 });
          }
        `,
      `
          (() => { Object.assign = evil; })();
          export function build() {
            return Object.assign({}, { dealerContributionMinor: 7 });
          }
        `,
    ];
    const source = `
      import { build } from "./payload";
      await ctx.db.patch(id, build());
    `;
    for (const payloadSource of payloadSources) {
      assert.equal(
        scanEconomicsRevision(source, "convex/finance.ts", {
          moduleSources: new Map([["convex/payload.ts", payloadSource]]),
        }).length,
        1,
      );
    }
  });

  test("requires call-site proof before trusting factory parameter reads", () => {
    const moduleSources = new Map([
      [
        "convex/payload.ts",
        `
          export function build(target, source) {
            const ignored = source.value;
            return { ...target };
          }
        `,
      ],
    ]);
    const source = `
      import { build } from "./payload";
      const target = { displayName: "safe" };
      const source = {
        get value() {
          target.dealerContributionMinor = 7;
          return 0;
        },
      };
      await ctx.db.patch(id, build(target, source));
    `;
    assert.equal(
      scanEconomicsRevision(source, "convex/finance.ts", {
        moduleSources,
      }).length,
      1,
    );
  });

  test("distrusts re-export intermediates with module initialization effects", () => {
    const moduleSources = new Map([
      [
        "convex/payload.ts",
        `
          export const shared = { displayName: "before" };
          export function build() { return shared; }
        `,
      ],
      [
        "convex/barrel.ts",
        `
          import { shared } from "./payload";
          shared.dealerContributionMinor = 7;
          export { build } from "./payload";
        `,
      ],
    ]);
    const source = `
      import { build } from "./barrel";
      await ctx.db.patch(id, build());
    `;
    assert.equal(
      scanEconomicsRevision(source, "convex/finance.ts", {
        moduleSources,
      }).length,
      1,
    );
  });

  test("distrusts dependency getters read during module initialization", () => {
    const moduleSources = new Map([
      [
        "convex/payload.ts",
        `
          import { poisoner } from "./helper";
          export const shared = { displayName: "safe" };
          const ignored = poisoner.value;
          export function build() { return shared; }
        `,
      ],
      [
        "convex/helper.ts",
        `
          import { shared } from "./payload";
          export const poisoner = {
            get value() {
              shared.dealerContributionMinor = 7;
              return 0;
            },
          };
        `,
      ],
    ]);
    const source = `
      import { build } from "./payload";
      await ctx.db.patch(id, build());
    `;
    assert.equal(
      scanEconomicsRevision(source, "convex/finance.ts", {
        moduleSources,
      }).length,
      1,
    );
  });

  test("fails closed for opaque payloads only when the finance target is proven", () => {
    const proven = `
      import { requireOwnedRow } from "./utils/tenancy";
      const current = await requireOwnedRow(
        ctx, orgId, "financeApplications", applicationId,
      );
      await ctx.db.patch(applicationId, getChanges());
      await ctx.db.patch(current._id, getOtherChanges());
    `;
    const diagnostics = scanEconomicsRevision(proven, "convex/finance.ts");
    assert.equal(diagnostics.length, 2);
    assert.ok(
      diagnostics.every((item) => /unresolved payload/.test(item.message)),
    );

    const ordinary = `
      await ctx.db.patch(userId, getChanges());
    `;
    const otherTable = `
      import { requireOwnedRow } from "./utils/tenancy";
      await requireOwnedRow(ctx, orgId, "users", userId);
      await ctx.db.patch(userId, getChanges());
    `;
    const unawaited = `
      import { requireOwnedRow } from "./utils/tenancy";
      requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
      await ctx.db.patch(applicationId, getChanges());
    `;
    assert.deepEqual(scanEconomicsRevision(ordinary, "convex/users.ts"), []);
    assert.deepEqual(scanEconomicsRevision(otherTable, "convex/users.ts"), []);
    assert.deepEqual(scanEconomicsRevision(unawaited, "convex/finance.ts"), []);
  });
});

describe("raw-convex-mutation-builder", () => {
  test("allows static named safe imports and type-only raw references", () => {
    const source = `
      import {
        query,
        action,
        internalQuery,
        internalAction,
        httpAction,
        type MutationCtx,
      } from "./_generated/server";
      import type { mutation as RawMutation } from "./_generated/server";
      import * as server from "./_generated/server";
      export type { internalMutation } from "./_generated/server";
      export { query } from "./_generated/server";
      export { query as server };
      export type { server as ServerNamespace };
      type RawInternalMutation = typeof server.internalMutation;
      const read = server.query;
      const act = server.action;
      const internalRead = server["internalQuery"];
    `;
    assert.deepEqual(scanRawConvexBuilders(source, "convex/safe.ts"), []);
  });

  test("rejects raw names, namespace escapes, re-exports, and dynamic imports", () => {
    const source = `
      import { mutation as define, internalMutation } from './_generated/server.js';
      import * as server from "./_generated/server";
      const first = server.mutation;
      const second = server["internalMutation"];
      const { mutation: third } = server;
      export { mutation as raw } from "../_generated/server";
      export * from "../_generated/server.js";

      async function load() {
        const fourth = (await import("./_generated/server")).mutation;
        const generated = await import("./_generated/server");
        const fifth = generated.internalMutation;
        const { mutation: sixth } = await import("./_generated/server.js");
        return import("./_generated/server").then(({ internalMutation: seventh }) => seventh);
      }
    `;
    const diagnostics = scanRawConvexBuilders(source, "convex/unsafe.ts");
    assert.equal(diagnostics.length, 9);
    assert.ok(
      diagnostics.every(
        (item) => item.ruleId === RULE_IDS.RAW_CONVEX_MUTATION_BUILDER,
      ),
    );
  });

  test("rejects a namespace rest binding because it exposes both raw builders", () => {
    const source = `
      import * as server from "./_generated/server";
      const { query, ...raw } = server;
    `;
    const diagnostics = scanRawConvexBuilders(source, "convex/unsafe.ts");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /namespace escapes/);
  });

  test("allows only the canonical wrapping module to import raw mutation builders", () => {
    const source = `
      import { mutation as rawMutation, internalMutation as rawInternalMutation }
        from "./_generated/server";
      export const mutation = wrap(rawMutation);
      export const internalMutation = wrap(rawInternalMutation);
    `;
    assert.deepEqual(scanRawConvexBuilders(source, "convex/functions.ts"), []);
    assert.deepEqual(scanRawConvexBuilders(source, "convex\\functions.ts"), []);
    assert.deepEqual(
      scanRawConvexBuilders(source, "./convex/functions.ts"),
      [],
    );

    const unsafePaths = [
      "C:/checkout/convex/functions.ts",
      "convex/functions.js",
    ];
    for (const file of unsafePaths) {
      assert.ok(
        scanRawConvexBuilders(source, file).length > 0,
        `expected non-canonical wrapper path ${file} to fail`,
      );
    }

    for (const spoofedFile of [
      "convex/evil/convex/functions.ts",
      "Convex/functions.ts",
    ]) {
      assert.deepEqual(scanRawConvexBuilders(source, spoofedFile), []);
    }
  });

  test("rejects namespace aliases and nonliteral computed members", () => {
    const unsafe = `
      import * as server from "./_generated/server";
      const namespace = server;
      const raw = namespace.mutation;
      const ending = "tion";
      const concatenated = server["muta" + ending];
      const unknown = server[runtimeMember];
      const { internalMutation: destructured } = namespace;
    `;
    assert.equal(scanRawConvexBuilders(unsafe, "convex/unsafe.ts").length, 3);

    const safe = `
      import { query, action } from "./_generated/server";
      const read = query;
      const run = action;
    `;
    assert.deepEqual(scanRawConvexBuilders(safe, "convex/safe.ts"), []);
  });

  test("rejects generated-server dynamic imports", () => {
    const unsafe = `
      import * as server from "./_generated/server";
      const unknownKey = getRuntimeMember();
      const { [unknownKey]: staticUnknown } = server;
      import("./_generated/server").then((generated) => generated.mutation);
      import("./_generated/server").then((generated) => generated["internalMutation"]);
      import("./_generated/server").then((generated) => {
        const alias = generated;
        return alias.mutation;
      });
      import("./_generated/server").then((generated) => {
        const { [unknownKey]: callbackUnknown } = generated;
        return callbackUnknown;
      });
      import("./_generated/server").then(({ [unknownKey]: parameterUnknown }) =>
        parameterUnknown,
      );
    `;
    assert.equal(scanRawConvexBuilders(unsafe, "convex/unsafe.ts").length, 6);

    const safe = `
      import { query, action, internalAction } from "./_generated/server";
      const read = query;
      const run = action;
      const internalRun = internalAction;
    `;
    assert.deepEqual(scanRawConvexBuilders(safe, "convex/safe.ts"), []);
  });

  test("rejects indirect namespace exposure variants without blocking safe members", () => {
    const unsafeCases = [
      `
        const takeMutation = (generated) => generated.mutation;
        import("./_generated/server").then(takeMutation);
      `,
      `
        import * as server from "./_generated/server";
        function expose({ mutation } = server) { return mutation; }
      `,
      `
        import * as server from "./_generated/server";
        let raw;
        ({ internalMutation: raw } = server);
      `,
      `
        const loadServer = () => import("./_generated/server");
        loadServer().then((generated) => generated.mutation);
      `,
      `
        import * as server from "./_generated/server";
        const copied = { ...server };
        const raw = copied.mutation;
      `,
      `module.exports = require("./_generated/server");`,
    ];
    for (const [index, source] of unsafeCases.entries()) {
      const diagnostics = scanRawConvexBuilders(
        source,
        `convex/raw-variant-${index}.ts`,
      );
      assert.ok(
        diagnostics.length > 0,
        `expected raw variant ${index} to fail`,
      );
      assert.ok(
        diagnostics.every(
          (item) => item.ruleId === RULE_IDS.RAW_CONVEX_MUTATION_BUILDER,
        ),
      );
    }

    const safeCases = [
      `import { query } from "./_generated/server"; export const read = query;`,
      `import { action, internalAction } from "./_generated/server"; void action; void internalAction;`,
      `const server = require("./_generated/server"); module.exports = { query: server.query };`,
    ];
    for (const [index, source] of safeCases.entries()) {
      assert.deepEqual(
        scanRawConvexBuilders(source, `convex/safe-variant-${index}.ts`),
        [],
      );
    }
  });

  test("rejects reflection, containment, copying, loader, and import-equals escapes", () => {
    const unsafeCases = [
      `
        const key = "mutation";
        Reflect.get(require("./_generated/server"), key);
      `,
      `
        import * as server from "./_generated/server";
        const holder = [server];
        const [{ mutation }] = holder;
      `,
      `
        import * as server from "./_generated/server";
        const copied = Object.assign({}, server);
        const raw = copied.mutation;
      `,
      `
        const load = () => {
          const marker = 1;
          return require("./_generated/server");
        };
        const server = load();
        const raw = server.mutation;
      `,
      `
        import server = require("./_generated/server");
        server.mutation({});
      `,
    ];
    for (const [index, source] of unsafeCases.entries()) {
      const diagnostics = scanRawConvexBuilders(
        source,
        `convex/raw-escape-${index}.ts`,
      );
      assert.ok(diagnostics.length > 0, `expected raw escape ${index} to fail`);
      assert.ok(
        diagnostics.every(
          (item) => item.ruleId === RULE_IDS.RAW_CONVEX_MUTATION_BUILDER,
        ),
      );
    }

    const safeCases = [
      `import { query } from "./_generated/server"; const read = query;`,
      `import { query, action } from "./_generated/server"; const holder = [query, action];`,
      `import * as server from "./_generated/server"; const read = server.query;`,
      `const server = require("./_generated/server"); const read = server.query;`,
      `import server = require("./_generated/server"); server.query({});`,
    ];
    for (const [index, source] of safeCases.entries()) {
      assert.deepEqual(
        scanRawConvexBuilders(source, `convex/safe-escape-${index}.ts`),
        [],
      );
    }
  });
});

const SAFE_AGGREGATES = `
  import { TableAggregate as Aggregate } from "@convex-dev/aggregate";
  const RuntimeAggregate = Aggregate;
  const vehiclesByOrg = new RuntimeAggregate<{ TableName: "vehicles" }>(componentA, {});
  const vehicleQualityByOrg = new RuntimeAggregate<{ TableName: "vehicles" }>(componentB, {});
  const aggregateTriggers = createTriggers();
  const deferredThreadTriggers = createTriggers();

  function registerCountingTriggers(triggers) {
    triggers.register("vehicles", vehiclesByOrg.idempotentTrigger());
    triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger());
  }

  registerCountingTriggers(aggregateTriggers);
  registerCountingTriggers(deferredThreadTriggers);
`;

describe("aggregate-registration", () => {
  test("correlates two aggregate instances that count the same table", () => {
    assert.deepEqual(scanAggregateWiring(SAFE_AGGREGATES), []);
  });

  test("does not let one registration answer for a second aggregate on the same table", () => {
    const source = SAFE_AGGREGATES.replace(
      '    triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger());\n',
      "",
    );
    const diagnostics = scanAggregateWiring(source);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /vehicleQualityByOrg/);
  });

  test("requires the registrar parameter and idempotent trigger", () => {
    const unsafeSources = [
      SAFE_AGGREGATES.replace(
        "vehicleQualityByOrg.idempotentTrigger()",
        "vehicleQualityByOrg.trigger()",
      ),
      SAFE_AGGREGATES.replace(
        'triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger())',
        'other.register("vehicles", vehicleQualityByOrg.idempotentTrigger())',
      ),
    ];
    for (const source of unsafeSources) {
      const diagnostics = scanAggregateWiring(source);
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0].message, /idempotentTrigger/);
    }
  });

  test("rejects registering an aggregate under the wrong table", () => {
    const source = SAFE_AGGREGATES.replace(
      'triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger())',
      'triggers.register("customers", vehicleQualityByOrg.idempotentTrigger())',
    );
    const diagnostics = scanAggregateWiring(source);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /counts "vehicles"/);
  });

  test("does not count a registration hidden in a never-invoked closure", () => {
    const source = SAFE_AGGREGATES.replace(
      '    triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger());',
      '    const installLater = () => triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger());',
    );
    const diagnostics = scanAggregateWiring(source);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /vehicleQualityByOrg/);
  });

  test("requires both writer sets to invoke the shared registrar unconditionally", () => {
    const source = SAFE_AGGREGATES.replace(
      "  registerCountingTriggers(deferredThreadTriggers);",
      "  if (enabled) registerCountingTriggers(deferredThreadTriggers);",
    );
    const diagnostics = scanAggregateWiring(source);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /deferredThreadTriggers/);
  });

  test("rejects duplicate instance registration", () => {
    const source = SAFE_AGGREGATES.replace(
      '    triggers.register("vehicles", vehiclesByOrg.idempotentTrigger());',
      '    triggers.register("vehicles", vehiclesByOrg.idempotentTrigger());\n' +
        '    triggers.register("vehicles", vehiclesByOrg.idempotentTrigger());',
    );
    const diagnostics = scanAggregateWiring(source);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /registered 2 times/);
  });

  test("recognizes namespace and destructured constructor aliases", () => {
    const source = SAFE_AGGREGATES.replace(
      'import { TableAggregate as Aggregate } from "@convex-dev/aggregate";\n  const RuntimeAggregate = Aggregate;',
      'import * as aggregatePackage from "@convex-dev/aggregate";\n' +
        "  const packageAlias = aggregatePackage;\n" +
        "  const { TableAggregate: Aggregate } = packageAlias;\n" +
        "  const RuntimeAggregate = Aggregate;",
    );
    assert.deepEqual(scanAggregateWiring(source), []);
  });

  test("ignores unrelated local classes without package provenance", () => {
    const source = `
      class TableAggregate {}
      const local = new TableAggregate();
    `;
    assert.deepEqual(scanAggregateWiring(source, "convex/local.ts"), []);
  });

  test("rejects aggregate constructors hidden outside a named const", () => {
    const source = SAFE_AGGREGATES.replace(
      "  const aggregateTriggers = createTriggers();",
      `  const holder = {
        hidden: new RuntimeAggregate<{ TableName: "vehicles" }>(componentC, {}),
      };
      const aggregateTriggers = createTriggers();`,
    );
    const diagnostics = scanAggregateWiring(source, "convex/hidden.ts");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /assigned directly to a named const/);
  });

  test("resolves table and instance aliases when validating registrations", () => {
    const source = SAFE_AGGREGATES.replace(
      'const vehiclesByOrg = new RuntimeAggregate<{ TableName: "vehicles" }>',
      `type VehicleTable = "vehicles";
  type VehicleSpec = { TableName: VehicleTable };
  const vehiclesByOrg = new RuntimeAggregate<VehicleSpec>`,
    ).replace(
      'triggers.register("vehicles", vehiclesByOrg.idempotentTrigger());',
      `const vehicleTable = "vehicles";
    const aggregateAlias = vehiclesByOrg;
    triggers.register(vehicleTable, aggregateAlias.idempotentTrigger());`,
    );
    assert.deepEqual(scanAggregateWiring(source), []);
  });

  test("fails closed on unresolved TableName and wrong-table aliases", () => {
    const unresolved = SAFE_AGGREGATES.replace(
      '<{ TableName: "vehicles" }>(componentB',
      "<UnknownAggregateSpec>(componentB",
    );
    const unresolvedDiagnostics = scanAggregateWiring(unresolved);
    assert.equal(unresolvedDiagnostics.length, 1);
    assert.match(unresolvedDiagnostics[0].message, /statically resolvable/);

    const wrongTable = SAFE_AGGREGATES.replace(
      "  function registerCountingTriggers(triggers) {",
      '  const wrongTable = "customers";\n\n  function registerCountingTriggers(triggers) {',
    ).replace(
      'triggers.register("vehicles", vehicleQualityByOrg.idempotentTrigger())',
      "triggers.register(wrongTable, vehicleQualityByOrg.idempotentTrigger())",
    );
    const wrongDiagnostics = scanAggregateWiring(wrongTable);
    assert.equal(wrongDiagnostics.length, 1);
    assert.match(wrongDiagnostics[0].message, /counts "vehicles"/);
  });

  test("rejects mutable, conditional, and subclass constructor provenance", () => {
    const unsafeSources = [
      SAFE_AGGREGATES.replace(
        "const RuntimeAggregate = Aggregate;",
        "let RuntimeAggregate = Aggregate;",
      ),
      SAFE_AGGREGATES.replace(
        "const RuntimeAggregate = Aggregate;",
        "const RuntimeAggregate = enabled ? Aggregate : Aggregate;",
      ),
      SAFE_AGGREGATES.replace(
        "const RuntimeAggregate = Aggregate;",
        "class RuntimeAggregate extends Aggregate {}",
      ),
    ];

    for (const source of unsafeSources) {
      const diagnostics = scanAggregateWiring(source, "convex/aggregates.ts");
      assert.ok(diagnostics.length > 0);
      assert.ok(
        diagnostics.some((item) =>
          /direct immutable package-proven binding/.test(item.message),
        ),
      );
    }
  });

  test("rejects a reassigned aggregate registrar", () => {
    const source = SAFE_AGGREGATES.replace(
      "  registerCountingTriggers(aggregateTriggers);",
      "  registerCountingTriggers = () => {};\n" +
        "  registerCountingTriggers(aggregateTriggers);",
    );
    const diagnostics = scanAggregateWiring(source, "convex/aggregates.ts");
    assert.ok(diagnostics.length > 0);
    assert.ok(diagnostics.some((item) => /reassigned/.test(item.message)));
  });
});

test("repository scanning covers every Convex executable extension and handwritten generated files", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "autoflow-rules-"),
  );
  try {
    const convexRoot = path.join(temporaryRoot, "convex");
    const generatedRoot = path.join(convexRoot, "_generated");
    fs.mkdirSync(generatedRoot, { recursive: true });
    const extensions = ["js", "mjs", "cjs", "ts", "tsx", "mts", "cts", "jsx"];
    for (const extension of extensions) {
      fs.writeFileSync(
        path.join(convexRoot, `entry${extension.toUpperCase()}.${extension}`),
        'import { mutation } from "./_generated/server";\n',
      );
    }
    fs.writeFileSync(
      path.join(generatedRoot, "handwritten.ts"),
      'import { internalMutation } from "../_generated/server";\n',
    );
    for (const output of [
      "api.d.ts",
      "api.js",
      "dataModel.d.ts",
      "server.d.ts",
      "server.js",
    ]) {
      fs.writeFileSync(
        path.join(generatedRoot, output),
        'import { mutation } from "./server";\n',
      );
    }

    const diagnostics = scanRepository(temporaryRoot);
    assert.equal(diagnostics.length, 9);
    assert.ok(
      diagnostics.some((item) =>
        item.file.endsWith("_generated/handwritten.ts"),
      ),
    );
    assert.ok(
      diagnostics.every(
        (item) =>
          ![
            "api.d.ts",
            "api.js",
            "dataModel.d.ts",
            "server.d.ts",
            "server.js",
          ].some((output) => item.file.endsWith(`_generated/${output}`)),
      ),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("repository scanning resolves imported economics payload factories", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "autoflow-economics-import-"),
  );
  try {
    const convexRoot = path.join(temporaryRoot, "convex");
    fs.mkdirSync(convexRoot, { recursive: true });
    fs.writeFileSync(
      path.join(convexRoot, "payload.ts"),
      `
        export function protectedChanges(amount) {
          return { dealerContributionMinor: amount };
        }
        export function ordinaryChanges(name) {
          return { displayName: name };
        }
      `,
    );
    fs.writeFileSync(
      path.join(convexRoot, "finance.ts"),
      `
        import {
          protectedChanges as unsafeChanges,
          ordinaryChanges as safeChanges,
        } from "./payload.js";
        await ctx.db.patch(applicationId, unsafeChanges(amount));
        await ctx.db.patch(userId, safeChanges(name));
      `,
    );

    const diagnostics = scanRepository(temporaryRoot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].ruleId, RULE_IDS.ECONOMICS_REVISION);
    assert.equal(diagnostics[0].file, "convex/finance.ts");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("repository scanning treats nested convex/admin modules as admin surfaces", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "autoflow-admin-"),
  );
  try {
    const nestedAdminRoot = path.join(
      temporaryRoot,
      "convex",
      "admin",
      "users",
    );
    fs.mkdirSync(nestedAdminRoot, { recursive: true });
    fs.writeFileSync(
      path.join(nestedAdminRoot, "remove.ts"),
      `
        import { query } from "../../_generated/server";
        export const remove = query({ handler: async (ctx) => ctx.db.get("user") });
      `,
    );

    const diagnostics = scanRepository(temporaryRoot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].ruleId, RULE_IDS.ADMIN_SUPER_ADMIN_FIRST);
    assert.equal(diagnostics[0].file, "convex/admin/users/remove.ts");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("repository scanning treats case variants as admin surfaces", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "autoflow-admin-case-"),
  );
  try {
    const convexRoot = path.join(temporaryRoot, "convex");
    const nestedAdminRoot = path.join(convexRoot, "ADMIN", "users");
    fs.mkdirSync(nestedAdminRoot, { recursive: true });
    fs.writeFileSync(
      path.join(convexRoot, "AdminUsers.ts"),
      `
        import { query } from "./_generated/server";
        export const list = query({ handler: async (ctx) => ctx.db.get("user") });
      `,
    );
    fs.writeFileSync(
      path.join(nestedAdminRoot, "remove.ts"),
      `
        import { query } from "../../_generated/server";
        export const remove = query({ handler: async (ctx) => ctx.db.get("user") });
      `,
    );

    const diagnostics = scanRepository(temporaryRoot);
    assert.equal(diagnostics.length, 2);
    assert.ok(
      diagnostics.every(
        (item) => item.ruleId === RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
      ),
    );
    assert.deepEqual(
      diagnostics.map((item) => item.file),
      ["convex/ADMIN/users/remove.ts", "convex/AdminUsers.ts"],
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("repository scanning finds TableAggregate instances outside aggregates.ts", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "autoflow-aggregate-"),
  );
  try {
    const convexRoot = path.join(temporaryRoot, "convex", "features");
    fs.mkdirSync(convexRoot, { recursive: true });
    fs.writeFileSync(
      path.join(convexRoot, "moved.ts"),
      `
        import { TableAggregate } from "@convex-dev/aggregate";
        const moved = new TableAggregate<{ TableName: "vehicles" }>(component, {});
      `,
    );

    const diagnostics = scanRepository(temporaryRoot);
    assert.ok(diagnostics.length > 0);
    assert.ok(
      diagnostics.every(
        (item) =>
          item.ruleId === RULE_IDS.AGGREGATE_REGISTRATION &&
          item.file === "convex/features/moved.ts",
      ),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("repository scanning resolves locally re-exported aggregate constructors", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "autoflow-aggregate-reexport-"),
  );
  try {
    const convexRoot = path.join(temporaryRoot, "convex");
    const featureRoot = path.join(convexRoot, "features");
    fs.mkdirSync(featureRoot, { recursive: true });
    fs.writeFileSync(
      path.join(convexRoot, "aggregate-export.ts"),
      'export { TableAggregate as Aggregate } from "@convex-dev/aggregate";',
    );
    fs.writeFileSync(
      path.join(featureRoot, "split.ts"),
      `
        import { Aggregate } from "../aggregate-export";
        const hidden = new Aggregate(component, {});
      `,
    );

    const diagnostics = scanRepository(temporaryRoot);
    assert.ok(diagnostics.length > 0);
    assert.ok(
      diagnostics.every(
        (item) =>
          item.ruleId === RULE_IDS.AGGREGATE_REGISTRATION &&
          item.file === "convex/features/split.ts",
      ),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("current repository satisfies every AST safety rule", () => {
  assert.deepEqual(scanRepository(REPOSITORY_ROOT), []);
});

test("diagnostics use actionable file:line:column formatting", () => {
  const [item] = scanEconomicsRevision(
    "await ctx.db.patch(id, { dealerContributionMinor: amount });",
    "convex/example.ts",
  );
  assert.match(
    formatDiagnostic(item),
    /^convex\/example\.ts:1:\d+ \[economics-revision\] /,
  );
});
