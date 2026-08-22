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
      `
        const { query } = require("./_generated/server");
        const unsafe = query({ handler: async (ctx) => ctx.db.query("users").first() });
        function publish(target) { target.unsafe = unsafe; }
        publish(module.exports);
      `,
      `
        const { query } = require("./_generated/server");
        const unsafe = query({ handler: async (ctx) => ctx.db.query("users").first() });
        const setPrototype = Object.setPrototypeOf;
        setPrototype(module.exports, { unsafe });
      `,
      `
        const { query } = require("./_generated/server");
        const unsafe = query({ handler: async (ctx) => ctx.db.query("users").first() });
        Reflect.setPrototypeOf(exports, { unsafe });
      `,
      `
        const { query } = require("./_generated/server");
        const { exports: published } = module;
        published.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        function published() {
          try { return module.exports; } finally {}
        }
        published().unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        let published = module.exports;
        published.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const { missing: published = module.exports } = {};
        published.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const holder = { published: module.exports };
        const { ...copy } = holder;
        copy.published.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const identity = (value) => value;
        identity.call(null, module.exports).unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const identity = (value) => value;
        identity.bind(null, module.exports)().unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const outer = () => () => module.exports;
        outer()().unsafe = query({ handler: async () => true });
      `,
      `
        const unsafe = require("./hidden");
        const api = {};
        module.exports = { api };
        api.unsafe = unsafe;
      `,
      `
        const unsafe = require("./hidden");
        function publish(target) { target.unsafe = unsafe; }
        publish(module.exports);
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

  test("blocks export objects hidden in containers and assignment patterns", () => {
    const cases = [
      `
        const { query } = require("./_generated/server");
        const holder = { out: module.exports };
        holder.out.unsafe = query({ handler: async (ctx) => ctx.db.query("users").first() });
      `,
      `
        const { query } = require("./_generated/server");
        const holder = [module.exports];
        holder[0].unsafe = query({ handler: async (ctx) => ctx.db.query("users").first() });
      `,
      `
        const output = exports;
        const holder = { nested: [{ output }] };
      `,
      `
        const { query } = require("./_generated/server");
        const holder = { out: true ? exports : {} };
        holder.out.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const enabled = true;
        const holder = [enabled && module.exports];
        holder[0].unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const identity = (value) => value;
        const holder = { out: identity(exports) };
        holder.out.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const holder = { out: (() => exports)() };
        holder.out.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const getExports = () => exports;
        const holder = { out: getExports() };
        holder.out.unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const identity = (value) => value;
        identity(exports).unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        (true ? exports : {}).unsafe = query({ handler: async () => true });
      `,
      `
        const { query } = require("./_generated/server");
        const key = process.env.KEY;
        module[key].unsafe = query({ handler: async () => true });
      `,
      `
        ({ endpoint: exports.endpoint } = { endpoint: true });
      `,
      `
        [module.exports.endpoint] = [true];
      `,
    ];
    for (const [index, source] of cases.entries()) {
      assertRuleBlocked(
        scanAdminSuperAdmin,
        source,
        `convex/admin/contained-runtime-export-${index}.cjs`,
        RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
      );
    }
  });

  test("rejects unsupported ESM runtime export forms consistently", () => {
    const cases = [
      `export const load = () => import("./hidden");`,
      `export default import("./hidden").then((value) => ({ reveal: () => value }));`,
      `import { bad } from "./hidden"; export const pending = Promise.resolve(bad);`,
      `import { bad } from "./hidden"; export const reflected = Reflect.get({ bad }, "bad");`,
      `
        import { bad } from "./hidden";
        class Holder { constructor(value) { this.value = value; } }
        export const instance = new Holder(bad);
      `,
      `
        import { bad } from "./hidden";
        export class Holder { constructor() { this.value = bad; } }
      `,
      `
        import { bad } from "./hidden";
        export class Holder {
          static #value = bad;
          static reveal() { return this.#value; }
        }
      `,
      `export const reveal = (...values) => values;`,
      `
        import { bad } from "./hidden";
        export const { value = bad } = {};
      `,
      `export function reveal() { return arguments[0]; }`,
      `
        import { bad } from "./hidden";
        export function reveal(value = bad) { return value; }
      `,
      `
        import { bad } from "./hidden";
        export const holder = { ...bad };
      `,
      `
        import { bad } from "./hidden";
        function reveal(): unknown;
        function reveal() { return bad; }
        export { reveal };
      `,
    ];
    for (const [index, source] of cases.entries()) {
      assertRuleBlocked(
        scanAdminSuperAdmin,
        source,
        `convex/admin/unsupported-esm-${index}.ts`,
        RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
      );
    }
  });

  test("rejects ambient CommonJS references in deferred and descriptor forms", () => {
    const cases = [
      `function publish(target = module.exports) { return target; } publish();`,
      `const holder = { get published() { return module.exports; } }; holder.published;`,
      `const holder = { published() { return module.exports; } }; holder.published();`,
      `Object.defineProperty({}, "published", { get: () => exports });`,
      `Promise.resolve().then(() => module.exports);`,
      `const { exports: published } = module; published.value = true;`,
    ];
    for (const [index, source] of cases.entries()) {
      assertRuleBlocked(
        scanAdminSuperAdmin,
        source,
        `convex/admin/commonjs-form-${index}.cjs`,
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

    const contained = `
      const exports = {};
      const module = { exports: {} };
      const one = { out: exports };
      const two = [module.exports];
      const identity = (value) => value;
      (() => exports)().unsafe = true;
      identity(exports).unsafe = true;
      (true ? exports : {}).unsafe = true;
      ({ endpoint: exports.endpoint } = { endpoint: true });
      [module.exports.endpoint] = [true];
    `;
    assert.deepEqual(
      scanAdminSuperAdmin(contained, "convex/admin/local-containers.cjs"),
      [],
    );
  });

  test(
    "resolves shared safe alias graphs without exponential traversal",
    { timeout: 3_000 },
    () => {
      const aliases = Array.from(
        { length: 22 },
        (_, index) =>
          `const value${index + 1} = flag ? value${index} : value${index};`,
      ).join("\n");
      const source = `
        const flag = true;
        const value0 = {};
        ${aliases}
        value22.safe = true;
      `;
      assert.deepEqual(
        scanAdminSuperAdmin(source, "convex/admin/shared-aliases.cjs"),
        [],
      );
    },
  );

  test(
    "rejects a deep unsupported export alias chain without recursion",
    { timeout: 3_000 },
    () => {
      const aliases = Array.from(
        { length: 2_400 },
        (_, index) => `const value${index + 1} = value${index};`,
      ).join("\n");
      const source = `
        import { bad } from "./hidden";
        const value0 = bad;
        ${aliases}
        export const leak = value2400;
      `;
      assertRuleBlocked(
        scanAdminSuperAdmin,
        source,
        "convex/admin/deep-runtime-alias.ts",
        RULE_IDS.ADMIN_SUPER_ADMIN_FIRST,
      );
    },
  );
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
      `
        import * as server from "./_generated/server";
        function expose() { return server; }
        export const unsafe = expose().mutation({});
      `,
      `
        import * as server from "./_generated/server";
        const expose = () => server;
        const alias = expose;
        export const unsafe = alias().mutation({});
      `,
      `
        import * as server from "./_generated/server";
        function expose() {
          try { return server; } finally {}
        }
        export const unsafe = expose().internalMutation({});
      `,
      `
        import * as server from "./_generated/server";
        export const expose = () => server;
      `,
      `
        import * as server from "./_generated/server";
        export function* expose() { yield server; }
      `,
      `
        import * as server from "./_generated/server";
        export { server };
      `,
      `
        import * as server from "./_generated/server";
        function expose() { return server; }
        export { expose };
      `,
      `
        import * as server from "./_generated/server";
        const expose = () => server;
        export default expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        module.exports.expose = expose;
      `,
      `
        import * as server from "./_generated/server";
        const expose = () => server;
        export default { expose };
      `,
      `
        import * as server from "./_generated/server";
        const expose = () => server;
        const api = [expose];
        export { api };
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        module.exports = { expose };
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Object.assign(module.exports, { expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const inner = { out: module.exports };
        const holder = true ? inner : inner;
        holder.out.expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const inner = { out: module.exports };
        const holder = { ...inner };
        holder.out.expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const assign = Object.assign;
        assign(module.exports, { expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const identity = (value) => value;
        Object.assign(identity(exports), { expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const getExports = () => module.exports;
        getExports().expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const holder = {
          get out() { return module.exports; },
        };
        holder.out.expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const holder = {
          out() { return module.exports; },
        };
        holder.out().expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Object.assign.apply(null, [exports, { expose }]);
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Object.assign.call(null, exports, { expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Reflect.apply(Object.assign, null, [exports, { expose }]);
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Reflect.set.apply(null, [module.exports, "expose", expose]);
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        function publish(target, value) { target.expose = value; }
        publish(module.exports, expose);
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Object.assign(exports, { expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Object.defineProperty(exports, "expose", { value: expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Reflect.set(exports, "expose", expose);
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Reflect.defineProperty(exports, "expose", { value: expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        Object.setPrototypeOf(exports, { expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const setPrototype = Reflect.setPrototypeOf;
        setPrototype(module.exports, { expose });
      `,
      `
        import * as server from "./_generated/server";
        export function exposeFactory() { return () => server; }
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          static expose() { return server; }
        }
      `,
      `
        import * as server from "./_generated/server";
        export default class Helpers {
          constructor() { return server; }
        }
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          static #server() { return server; }
          static expose() { return Helpers.#server(); }
        }
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          #server() { return server; }
          expose() { return this.#server(); }
        }
      `,
      `
        import * as server from "./_generated/server";
        export const expose = () => () => () => server;
      `,
      `
        import * as server from "./_generated/server";
        function inner() { return server; }
        function middle() { return inner; }
        function outer() { return middle; }
        export { outer };
      `,
      `
        import * as server from "./_generated/server";
        function* expose() { yield server; }
        export default { expose };
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          static get #capability() { return server; }
          static expose() { return this.#capability; }
        }
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          static #capability = () => server;
          static expose() { return this.#capability(); }
        }
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          #capability = () => server;
          expose() { return this.#capability(); }
        }
      `,
      `
        import * as server from "./_generated/server";
        class BaseHelpers {
          expose() { return server; }
        }
        export class Helpers extends BaseHelpers {}
      `,
      `
        import * as server from "./_generated/server";
        class Helpers {
          static expose() { return server.query; }
        }
        Helpers = class {
          static expose() { return server; }
        };
        export { Helpers };
      `,
      `
        const promise = import("./_generated/server").then(
          (namespace) => namespace,
        );
        export { promise };
      `,
      `
        import * as server from "./_generated/server";
        const memo = (() => {
          let cached;
          return () => (cached ??= server);
        })();
        export { memo };
      `,
      `
        import * as server from "./_generated/server";
        const holder = {};
        Object.defineProperty(holder, "capability", { get: () => server });
        export const leak = holder.capability;
      `,
      `
        const server = require("./_generated/server");
        const { exports: published } = module;
        published.load = () => server;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const unwrap = ({ out }) => out;
        unwrap({ out: module.exports }).expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const holder = {
          out: module.exports,
          get published() { return this.out; },
        };
        holder.published.expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const holder = {
          out: module.exports,
          published() { return this.out; },
        };
        holder.published().expose = expose;
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        const publish = Object.assign.bind(null, exports);
        publish({ expose });
      `,
      `
        const server = require("./_generated/server");
        const expose = () => server;
        function publish(target, value) { target.expose = value; }
        publish.bind(null, module.exports)(expose);
      `,
      `
        import * as server from "./_generated/server";
        function expose(): typeof server.query;
        function expose() { return server; }
        export { expose };
      `,
      `
        import * as server from "./_generated/server";
        export let expose = () => server.query;
        expose = () => server;
      `,
      `
        import * as server from "./_generated/server";
        function expose() { return server.query; }
        expose = () => server;
        export { expose };
      `,
      `
        import * as server from "./_generated/server";
        class Helpers { static expose() { return server.query; } }
        if (process.env.ENABLED) {
          Helpers = class { static expose() { return server; } };
        }
        export { Helpers };
      `,
      `
        import * as server from "./_generated/server";
        class Helpers { static expose() { return server.query; } }
        export { Helpers };
        Helpers = class { static expose() { return server; } };
      `,
      `
        import * as server from "./_generated/server";
        const expose = () => server;
        const identity = (value) => value;
        export const leak = identity(expose);
      `,
      `
        import * as server from "./_generated/server";
        export function leak(value = () => server) { return value; }
      `,
      `
        export const leak = import("./_generated/server").then();
      `,
      `
        export const leak = import("./_generated/server").finally(() => {});
      `,
      `
        export const leak = import("./_generated/server").then(
          (server) => ({ ...server }),
        );
      `,
      `
        export default import("./_generated/server").then(
          (server) => () => server,
        );
      `,
      `
        export default import("./_generated/server").then(
          (server) => ({ reveal: () => server }),
        );
      `,
      `
        export default import("./_generated/server").then(
          (server) => class { static reveal() { return server; } },
        );
      `,
      `
        import * as server from "./_generated/server";
        class Helpers { expose() { return server; } }
        export const leak = new Helpers().expose();
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          constructor() { this.expose = () => server; }
        }
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          static { this.expose = () => server; }
        }
      `,
      `
        import * as server from "./_generated/server";
        export class Helpers {
          #capability = () => server;
          expose = () => this.#capability();
        }
      `,
      `
        import * as server from "./_generated/server";
        const holder = {};
        holder.expose = () => server;
        export { holder };
      `,
      `
        import * as server from "./_generated/server";
        const holder = {};
        const define = Object.defineProperty;
        define(holder, "capability", { get: () => server });
        export { holder };
      `,
      `
        const server = require("./_generated/server");
        let published = module.exports;
        published.expose = () => server;
      `,
      `
        const server = require("./_generated/server");
        const { missing: published = module.exports } = {};
        published.expose = () => server;
      `,
      `
        const server = require("./_generated/server");
        const holder = { published: module.exports };
        const { ...copy } = holder;
        copy.published.expose = () => server;
      `,
      `
        const server = require("./_generated/server");
        const identity = (value) => value;
        identity.call(null, module.exports).expose = () => server;
      `,
      `
        const server = require("./_generated/server");
        const identity = (value) => value;
        identity.bind(null, module.exports)().expose = () => server;
      `,
      `
        const server = require("./_generated/server");
        const outer = () => () => module.exports;
        outer()().expose = () => server;
      `,
      `
        const server = require("./_generated/server");
        module.exports = Object.create({
          get expose() { return () => server; },
        });
      `,
      `
        const server = require("./_generated/server");
        const api = {};
        module.exports = { api };
        api.expose = () => server;
      `,
      `
        const server = require("./_generated/server");
        function publish(target) { target.expose = () => server; }
        publish(module.exports);
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

  test("preserves static named safe members", () => {
    const source = `
      import { query, action, internalAction } from "./_generated/server";
      const box = { query, action };
      const consume = (value) => value;
      consume(query);
      const read = query;
      const proxiedRead = new Proxy(query, {});
      function exposeQuery() { return query; }
      export class SafeHelpers {
        static exposeQuery() { return query; }
      }
      export class SafePrivateHelpers {
        static #query() { return query; }
        static exposeQuery() { return SafePrivateHelpers.#query(); }
      }
      export class SafePrivateInstanceHelpers {
        #query() { return query; }
        exposeQuery() { return this.#query(); }
      }
      class SafeOverloadedHelpers {
        static expose(): typeof query;
        static expose() { return query; }
      }
      function safeOverloaded(): typeof query;
      function safeOverloaded() { return query; }
      const helperRead = exposeQuery();
      const overloadedRead = SafeOverloadedHelpers.expose();
      consume(internalAction);
      export { box, helperRead, overloadedRead, proxiedRead, read, safeOverloaded };
    `;
    assert.deepEqual(scanRawConvexBuilders(source, "convex/safe.ts"), []);
  });

  test("preserves named safe members through ordinary control flow", () => {
    const source = `
      import { query, action } from "./_generated/server";
      export const disabled = false && query;
      export const firstAvailable = query || action;
      export const projected = query && action;
      export const nonNullish = query ?? action;
      export const conditional = true ? query : action;
      export const bigintFallback = 1n || query;

      class Helpers {
        static expose() { return action; }
      }
      Helpers = class {
        static expose() { return query; }
      };
      export { Helpers };
    `;
    assert.deepEqual(
      scanRawConvexBuilders(source, "convex/safe-logical-results.ts"),
      [],
    );
  });

  test("preserves safe bound calls, clones, and lexical this", () => {
    const source = `
      import { query } from "./_generated/server";
      const clone = { ...module.exports };
      Object.assign.bind(null, clone)({ expose: () => query });

      function publish(target, value) { target.expose = value; }
      publish.bind(null, {})(() => query);

      const custom = { bind: (...values) => () => values.length };
      custom.bind(null, module.exports)(query);

      const holder = {
        out: module.exports,
        published: () => this.out,
      };
      holder.published().query = query;

      const disabled = false && module.exports;
      disabled.expose = () => query;
      exports = {};
      exports.expose = () => query;
      module.exports = {};
      exports.anotherExpose = () => query;
    `;
    assert.deepEqual(
      scanRawConvexBuilders(source, "convex/safe-bound-exports.cjs"),
      [],
    );
  });

  test(
    "resolves shared safe capability graphs without exponential traversal",
    { timeout: 3_000 },
    () => {
      const aliases = Array.from(
        { length: 22 },
        (_, index) =>
          `const value${index + 1} = flag ? value${index} : value${index};`,
      ).join("\n");
      const source = `
        const flag = true;
        const value0 = { query: true };
        ${aliases}
        export const safe = value22;
      `;
      assert.deepEqual(scanRawConvexBuilders(source, "convex/safe-dag.ts"), []);
    },
  );

  test(
    "resolves shared unknown-key container paths without exponential traversal",
    { timeout: 3_000 },
    () => {
      const aliases = Array.from(
        { length: 20 },
        (_, index) =>
          `const value${index + 1} = { left: value${index}, right: value${index} };`,
      ).join("\n");
      const path = "[key]".repeat(20);
      const source = `
        const key = process.env.KEY;
        const value0 = {};
        ${aliases}
        value20${path}.safe = true;
      `;
      assert.deepEqual(
        scanRawConvexBuilders(source, "convex/safe-container-dag.cjs"),
        [],
      );
    },
  );

  test(
    "resolves shared function-return graphs without exponential traversal",
    { timeout: 3_000 },
    () => {
      const wrappers = Array.from(
        { length: 20 },
        (_, index) =>
          `const value${index + 1} = () => flag ? value${index}() : value${index}();`,
      ).join("\n");
      const source = `
        import * as server from "./_generated/server";
        const flag = true;
        const value0 = () => server.query;
        ${wrappers}
        export const safe = value20();
      `;
      assert.deepEqual(
        scanRawConvexBuilders(source, "convex/safe-function-dag.ts"),
        [],
      );
    },
  );

  test(
    "resolves deep CommonJS alias chains iteratively and reuses results",
    { timeout: 3_000 },
    () => {
      const aliases = Array.from(
        { length: 2_400 },
        (_, index) => `const output${index + 1} = output${index};`,
      ).join("\n");
      const writes = Array.from(
        { length: 30 },
        (_, index) => `output2400.safe${index} = server.query;`,
      ).join("\n");
      const source = `
        const server = require("./_generated/server");
        const output0 = module.exports;
        ${aliases}
        ${writes}
      `;
      assert.deepEqual(
        scanRawConvexBuilders(source, "convex/deep-safe-exports.cjs"),
        [],
      );
    },
  );
});
