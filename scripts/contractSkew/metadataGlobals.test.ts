// @vitest-environment node
import { expect, test } from "vitest";
import { installGlobals } from "./metadataGlobals.mjs";

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

test("environment reads record only the world's keys, descriptors and enumeration", () => {
  const { target, reads } = runtime({ env: { PRESENT: "value", UNDEFINED: null } });
  expect(target.process.env.PRESENT).toBe("value");
  expect(target.process.env.UNDEFINED).toBeUndefined();
  expect("PRESENT" in target.process.env).toBe(true);
  expect(Object.getOwnPropertyDescriptor(target.process.env, "PRESENT")?.value).toBe("value");
  expect(Object.keys(target.process.env)).toEqual(["PRESENT", "UNDEFINED"]);
  expect([...reads.keys]).toEqual(["PRESENT", "UNDEFINED"]);
  expect(reads.enumerations).toBe(1);
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
