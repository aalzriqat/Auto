import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  RULE_IDS,
  scanAdminSuperAdmin,
  scanRawConvexBuilders,
} from "../autoflow-rules.mjs";
import { findNonliteralRuntimeImports } from "../architecture-runtime-imports.mjs";

function assertDynamicCodeBlocked(source, name) {
  const findings = findNonliteralRuntimeImports(
    source,
    `convex/admin/${name}.ts`,
  );
  assert.ok(
    findings.some((finding) => finding.kind === "DYNAMIC CODE GENERATION"),
    `expected ${name} to be rejected as dynamic code generation`,
  );
}

function assertRuleBlocked(scan, source, file, ruleId) {
  const findings = scan(source, file);
  assert.ok(
    findings.some((finding) => finding.ruleId === ruleId),
    `expected ${file} to violate ${ruleId}`,
  );
}

describe("runtime code-generation provenance", () => {
  test("blocks production-valid Function constructor aliases", () => {
    const cases = {
      inheritedObjectMethod: `
        const definition = { handler: async () => true };
        ({}).toString.constructor(
          "definition",
          "definition.handler = async () => false",
        )(definition);
      `,
      destructuredFunctionConstructor: `
        const { constructor: Compile } = (() => {});
        Compile("return import('./hidden')")();
      `,
      reflectedAlias: `
        const get = Reflect.get;
        get(() => {}, "constructor")("return import('./hidden')")();
      `,
      reflectedBoundKey: `
        const key = "constructor";
        Reflect.get(() => {}, key)("return import('./hidden')")();
      `,
    };
    for (const [name, source] of Object.entries(cases)) {
      assertDynamicCodeBlocked(source, name);
    }
  });

  test("preserves custom constructors, shadowed reflection, and metadata reads", () => {
    const safeCases = [
      `
        const { constructor: build } = {
          constructor: (value) => value,
        };
        export const result = build("plain value");
      `,
      `
        const Reflect = { get: (value, key) => value[key] };
        const get = Reflect.get;
        export const result = get({}, "constructor");
      `,
      `
        const get = Reflect.get;
        const key = "constructor";
        export const name = get(() => {}, key).name;
      `,
    ];
    for (const [index, source] of safeCases.entries()) {
      assert.deepEqual(
        findNonliteralRuntimeImports(source, `lib/safe-${index}.ts`),
        [],
      );
    }
  });
});

describe("admin CommonJS export provenance", () => {
  test("blocks immutable export aliases and folded builtin members", () => {
    const cases = [
      `
        const generated = require("./_generated/server");
        const unsafe = generated.query({ handler: async () => true });
        const output = exports;
        output.remove = unsafe;
      `,
      `
        const generated = require("./_generated/server");
        const unsafe = generated.query({ handler: async () => true });
        Object["as" + "sign"](exports, { remove: unsafe });
      `,
      `
        const generated = require("./_generated/server");
        const unsafe = generated.query({ handler: async () => true });
        const assign = Object.assign;
        assign(exports, { remove: unsafe });
      `,
    ];
    for (const [index, source] of cases.entries()) {
      assertRuleBlocked(
        scanAdminSuperAdmin,
        source,
        `convex/admin/runtime-export-${index}.cjs`,
        RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
      );
    }
  });

  test("preserves shadowed CommonJS-like objects", () => {
    const source = `
      const Object = { assign: (target, value) => ({ ...target, ...value }) };
      const exports = {};
      const output = exports;
      const assign = Object["as" + "sign"];
      assign(output, { remove: true });
    `;
    assert.deepEqual(
      scanAdminSuperAdmin(source, "convex/admin/local-objects.cjs"),
      [],
    );
  });
});

describe("raw generated-server namespace escapes", () => {
  test("blocks containers, helper calls, callbacks, proxies, and reflection aliases", () => {
    const cases = [
      `
        import * as server from "./_generated/server";
        const box = { generated: server };
        export const unsafe = box.generated.mutation({});
      `,
      `
        import * as server from "./_generated/server";
        const takeMutation = ({ mutation }) => mutation;
        export const unsafe = takeMutation(server)({});
      `,
      `
        const takeMutation = ({ mutation }) => mutation;
        import("./_generated/server").then((generated) =>
          takeMutation(generated)({}),
        );
      `,
      `
        import * as server from "./_generated/server";
        const proxied = new Proxy(server, {});
        export const unsafe = proxied.internalMutation({});
      `,
      `
        import * as server from "./_generated/server";
        const get = Reflect.get;
        export const unsafe = get(server, "mutation")({});
      `,
    ];
    for (const [index, source] of cases.entries()) {
      assertRuleBlocked(
        scanRawConvexBuilders,
        source,
        `convex/raw-runtime-escape-${index}.ts`,
        RULE_IDS.RAW_CONVEX_MUTATION_BUILDER,
      );
    }
  });

  test("preserves explicit safe members and direct safe reflection", () => {
    const source = `
      import * as server from "./_generated/server";
      const box = { query: server.query, action: server.action };
      const consume = (value) => value;
      consume(server.query);
      const read = Reflect.get(server, "query");
      const proxiedRead = new Proxy(server.query, {});
      import("./_generated/server").then((generated) =>
        consume(generated.action),
      );
      export { box, read, proxiedRead };
    `;
    assert.deepEqual(scanRawConvexBuilders(source, "convex/safe.ts"), []);
  });
});
