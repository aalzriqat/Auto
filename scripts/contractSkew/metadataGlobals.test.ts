// @vitest-environment node
import { expect, test } from "vitest";
import { installConstructorGuards, installGlobals } from "./metadataGlobals.mjs";

/** The host global object is the system boundary. Copy real descriptors so
 * setup can be tested without replacing the test runner's own globals. */
function runtime(world: Record<string, unknown> = {}) {
  const descriptors = Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(globalThis))
    .map(([key, descriptor]) => [key, { ...descriptor, configurable: true }]));
  const target = Object.create(Object.getPrototypeOf(globalThis), descriptors) as typeof globalThis;
  const reads = { keys: new Set<string>(), enumerations: 0, capabilityProbes: new Set<string>() };
  const state = { reason: "" };
  const deny = (reason: string): never => { state.reason ||= reason; throw new Error(reason); };
  installGlobals({ target, deny, world, reads });
  return { target, reads, state };
}

test("world setup preserves the host, same-realm intrinsics and pure UTC conversion", () => {
  const hostRandom = Math.random;
  const hostProcess = process;
  const { target } = runtime();
  expect(Math.random).toBe(hostRandom);
  expect(process).toBe(hostProcess);
  expect({}).toBeInstanceOf(target.Object);
  expect([]).toBeInstanceOf(target.Array);
  expect(target.globalThis.Object).toBe(Object);
  expect(target.Date.UTC(2020, 0, 1)).toBe(1577836800000);
  expect(() => target.Date.now()).toThrow("clock");
  expect(() => target.Math.random()).toThrow("randomness");
});

test.each([
  ["environment read", (g: typeof globalThis) => g.process.env.PRESENT],
  ["environment read", (g: typeof globalThis) => "PRESENT" in g.process.env],
  ["environment read", (g: typeof globalThis) => Object.getOwnPropertyDescriptor(g.process.env, "PRESENT")],
  ["environment enumeration", (g: typeof globalThis) => Reflect.ownKeys(g.process.env)],
])("environment access always refuses: %s", (reason, operation) => {
  const { target, reads, state } = runtime();
  expect(() => operation(target)).toThrow(reason);
  expect(state.reason).toBe(reason);
  if (reason === "environment read") expect([...reads.keys]).toEqual(["PRESENT"]);
  else expect(reads.enumerations).toBe(1);
});

test.each([
  ["environment write", (g: typeof globalThis) => { g.process.env.KEY = "value"; }],
  ["process input", (g: typeof globalThis) => g.process.platform],
  ["process enumeration", (g: typeof globalThis) => Object.keys(g.process)],
  ["process membership", (g: typeof globalThis) => "env" in g.process],
  ["process descriptor", (g: typeof globalThis) => Object.getOwnPropertyDescriptor(g.process, "env")],
  ["process write", (g: typeof globalThis) => { g.process.env = { NODE_ENV: "test" }; }],
  ["unsupported environment key", (g: typeof globalThis) => Reflect.get(g.process.env, Symbol.iterator)],
  ["unavailable global Buffer", (g: typeof globalThis) => g.Buffer],
  ["global enumeration", (g: typeof globalThis) => Object.keys(g.globalThis)],
  ["global membership", (g: typeof globalThis) => "File" in g.globalThis],
  ["global descriptor", (g: typeof globalThis) => Object.getOwnPropertyDescriptor(g.globalThis, "File")],
])("caught input denial remains latched: %s", (reason, operation) => {
  const { target, state } = runtime();
  expect(() => operation(target)).toThrow(reason);
  expect(state.reason).toBe(reason);
});

test("navigator presence and userAgent descriptors represent the selected world", () => {
  const absent = runtime();
  expect(absent.target.navigator).toBeUndefined();
  expect("navigator" in absent.target.globalThis).toBe(false);
  expect(Object.getOwnPropertyDescriptor(absent.target.globalThis, "navigator")).toBeUndefined();
  const present = runtime({ runtime: { userAgent: "Cloudflare-Workers" }, zodConfig: true });
  expect(present.target.navigator.userAgent).toBe("Cloudflare-Workers");
  expect("navigator" in present.target.globalThis).toBe(true);
  expect("userAgent" in present.target.navigator).toBe(true);
  expect(Object.getOwnPropertyDescriptor(present.target.navigator, "userAgent")?.value).toBe("Cloudflare-Workers");
  expect(Object.getOwnPropertyDescriptor(present.target.globalThis, "navigator")?.value).toBe(present.target.navigator);
  expect([...present.reads.capabilityProbes]).toContain("navigator.userAgent");
  expect(() => Object.getOwnPropertyDescriptor(present.target.navigator, "platform")).toThrow("unsupported navigator probe");
});

test("code-generation probes prove empty capability checks and refuse invented results", () => {
  const enabled = runtime();
  expect(() => enabled.target.Function("")).not.toThrow();
  expect(() => new enabled.target.Function()).not.toThrow();
  expect(enabled.target.eval("")).toBeUndefined();
  expect(Reflect.apply(enabled.target.eval, undefined, [42])).toBe(42);
  expect(() => enabled.target.Function("return true")).toThrow("dynamic function source");
  expect(() => enabled.target.Function("")()).toThrow("generated function execution");
  expect(() => enabled.target.Function("").name).toThrow("generated function reflection");
  expect(() => enabled.target.eval("true")).toThrow("dynamic evaluation source");
  const disabled = runtime({ runtime: { evalThrows: true } });
  expect(() => disabled.target.Function("")).toThrow("Code generation unavailable");
  expect(() => disabled.target.eval("")).toThrow("Code generation unavailable");
  expect(disabled.state.reason).toBe("");
});


test("constructor guards refuse native reflection and restore the host after synchronous inspection", () => {
  const prototypes = [Function.prototype, Object.getPrototypeOf(async function(){}),
    Object.getPrototypeOf(function*(){}), Object.getPrototypeOf(async function*(){})];
  const owners = [...prototypes, Object, Reflect, Object.prototype];
  const restoreDescriptors = Object.defineProperties;
  const restoreDescriptor = Object.defineProperty;
  const proxyDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Proxy");
  if (!proxyDescriptor) throw new Error("Native Proxy unavailable");
  const snapshots = owners.map((owner) => ({ owner, descriptors: Object.getOwnPropertyDescriptors(owner) }));
  const probes = new Set<string>();
  const outcomes: string[] = [];
  const legacyLookup = (method: string, receiver: object, key: unknown, callback?: () => unknown): unknown => {
    const candidate: unknown = Reflect.get(Object.prototype, method);
    if (typeof candidate !== "function") throw new Error("Legacy reflection unavailable");
    return Reflect.apply(candidate, receiver, callback ? [key, callback] : [key]);
  };
  const deny = (reason: string): never => { throw new Error(reason); };
  try {
    installConstructorGuards(deny, probes);
    const operations = [
      () => (async function(){}).constructor,
      () => Reflect.set(prototypes[0], "constructor", function marker(){}),
      () => Object.getOwnPropertyDescriptor(prototypes[1], "constructor"),
      () => Reflect.getOwnPropertyDescriptor(prototypes[2], "constructor"),
      () => Object.getOwnPropertyDescriptors(prototypes[3]),
      () => legacyLookup("__lookupGetter__", {}, "constructor"),
      () => legacyLookup("__lookupSetter__", {}, Object.assign(function key(){}, { toString: () => "constructor" })),
      () => Object.getOwnPropertyDescriptor.toString(),
      () => Object.defineProperty(prototypes[0], "constructor", { value: 0 }),
      () => Object.defineProperties(prototypes[0], { constructor: { value: 0 } }),
      () => Reflect.defineProperty(prototypes[0], "constructor", { value: 0 }),
      () => legacyLookup("__defineGetter__", prototypes[0], "constructor", () => 0),
      () => legacyLookup("__defineSetter__", prototypes[0], "constructor", () => undefined),
      () => new Proxy(prototypes[0], {}),
      () => Proxy.revocable(prototypes[1], {}),
      () => Object.getOwnPropertyDescriptor(Proxy, "revocable")?.value(prototypes[2], {}),
    ];
    for (const operation of operations) {
      try { operation(); outcomes.push("unexpected success"); }
      catch (error) { outcomes.push(error instanceof Error ? error.message : "unknown failure"); }
    }
    outcomes.push(Object.getOwnPropertyDescriptor({ value: 42 }, "value")?.value === 42 ? "ordinary descriptor" : "wrong descriptor");
    outcomes.push(legacyLookup("__lookupGetter__", { get value() { return 1; } }, "value") ? "ordinary getter" : "wrong getter");
    outcomes.push((function example(){}).toString().includes("example") ? "ordinary source" : "wrong source");
    outcomes.push(new Proxy({ value: 42 }, {}).value === 42 ? "ordinary proxy" : "wrong proxy");
    outcomes.push(Proxy.revocable({ value: 42 }, {}).proxy.value === 42 ? "ordinary revocable" : "wrong revocable");
    outcomes.push(Object.getOwnPropertyDescriptor(Proxy, "revocable")?.value === Proxy.revocable ? "revocable identity" : "wrong identity");
    outcomes.push(Reflect.deleteProperty(prototypes[1], "constructor") ? "native deletion" : "wrong deletion");
  } finally {
    for (const { owner, descriptors } of snapshots) restoreDescriptors(owner, descriptors);
    restoreDescriptor(globalThis, "Proxy", proxyDescriptor);
  }
  expect(outcomes).toEqual([...Array<string>(16).fill("dynamic function constructor"),
    "ordinary descriptor", "ordinary getter", "ordinary source", "ordinary proxy", "ordinary revocable", "revocable identity", "native deletion"]);
  expect([...probes]).toEqual(["Function.constructor"]);
  expect(typeof Object.getOwnPropertyDescriptor(Function.prototype, "constructor")?.value).toBe("function");
});
