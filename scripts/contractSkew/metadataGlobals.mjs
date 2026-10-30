import { guardedBindings, guardCallable, guardHost, isGuardedTarget } from "./metadataObservation.mjs";
const defineIntrinsicProperty = Object.defineProperty;
const intrinsicProxy = Proxy;
const intrinsicString = String;
const intrinsicTag = Symbol.toStringTag;
const intrinsicReflect = { get: Reflect.get, has: Reflect.has, set: Reflect.set,
  apply: Reflect.apply, construct: Reflect.construct, getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor };
const intrinsicHasOwn = Object.hasOwn;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const hasSet = (set, key) => intrinsicReflect.apply(setHas, set, [key]);
const addSet = (set, key) => intrinsicReflect.apply(setAdd, set, [key]);

/** Install a world's inputs before importing any bundled module. */
export function installGlobals({ target, deny, world, reads }) {
  // Node initializes these lazily through Undici, which itself needs Buffer.
  // Materialize the supported web intrinsics before host inputs are denied.
  for (const [key, value] of Object.entries({ TextEncoder, TextDecoder, URL, URLSearchParams,
    Request, Response, Headers, Blob, AbortController, ReadableStream, WritableStream, TransformStream, atob, btoa })) {
    Object.defineProperty(target, key, { configurable: true, value: guardCallable(value, deny, {
      apply: () => deny("host API execution"), construct: () => deny("host API execution"),
    }) });
  }
  const record = (key) => {
    if (typeof key !== "string") return deny("unsupported environment key");
    addSet(reads.keys, key);
    return deny("environment read");
  };
  const env = new intrinsicProxy(Object.create(null), {
    get: (_target, key) => record(key),
    ownKeys: () => { reads.enumerations++; return deny("environment enumeration"); },
    has: (_target, key) => record(key),
    getOwnPropertyDescriptor: (_target, key) => record(key),
    getPrototypeOf: () => deny("environment reflection"),
    isExtensible: () => deny("environment reflection"),
    ...writeDenials(deny, "environment write"),
  });
  const processProxy = new intrinsicProxy({ env }, {
    get: (_target, key) => key === "env" ? env : deny("process input"),
    ownKeys: () => deny("process enumeration"), has: () => deny("process membership"),
    getOwnPropertyDescriptor: () => deny("process descriptor"),
    getPrototypeOf: () => deny("process reflection"), isExtensible: () => deny("process reflection"),
    ...writeDenials(deny, "process write"),
  });
  guardedBindings.add(env);
  guardedBindings.add(processProxy);
  Object.defineProperty(target, "process", { configurable: true, value: processProxy });
  const logs = Object.fromEntries(["log", "warn", "error", "info", "debug", "trace", "time", "timeLog", "timeEnd"]
    .map((key) => [key, guardCallable(() => deny("console host input"), deny)]));
  Object.defineProperty(target, "console", { configurable: true, value: guardHost({}, deny, (_host, key) =>
    typeof key === "string" && intrinsicHasOwn(logs, key) ? logs[key] : deny("console reflection")) });
  installRuntime(target, deny, world.runtime ?? {}, reads.capabilityProbes);
  installInputGuards(target, deny);
  Object.defineProperty(target, "window", { configurable: true, value: undefined });
  const backing = target;
  // A proxy assigned to globalThis cannot intercept an unqualified `typeof
  // MissingRuntime`. Global binding lookup also walks the real global object's
  // prototype; guard that path and refuse Node-only own properties separately.
  guardGlobalBindings(backing, deny);
  const capabilities = new Set(/** @type {Array<string | symbol>} */ (["navigator", "Function", "eval", "__zod_globalConfig", "__zod_globalRegistry"]));
  // These are library-owned realm-local slots, not renderer stand-ins. Let
  // Zod create its real singleton just as it does in a fresh Convex context.
  const localSlots = new Set(/** @type {Array<string | symbol>} */ (["__zod_globalConfig", "__zod_globalRegistry"]));
  const writtenSlots = new Set();
  const guardedGlobal = new intrinsicProxy(backing, {
    get: (target, key) => {
      if (hasSet(capabilities, key)) addSet(reads.capabilityProbes, key);
      if (hasSet(localSlots, key)) return intrinsicHasOwn(target, key) ? intrinsicReflect.get(target, key) : undefined;
      return intrinsicReflect.has(target, key) ? intrinsicReflect.get(target, key) : deny(`unavailable global ${intrinsicString(key)}`);
    },
    has: () => deny("global membership"),
    ownKeys: () => deny("global enumeration"),
    ...writeDenials(deny, "global write"),
    getOwnPropertyDescriptor: (target, key) => hasSet(writtenSlots, key) ? intrinsicReflect.getOwnPropertyDescriptor(target, key) : deny("global descriptor"),
    set: (target, key, value) => {
      if (!hasSet(localSlots, key)) return deny("global write");
      addSet(writtenSlots, key);
      return intrinsicReflect.set(target, key, value, target);
    },
    getPrototypeOf: () => deny("global prototype"),
    isExtensible: () => deny("global reflection"),
  });
  Object.defineProperty(backing, "globalThis", { configurable: true, value: guardedGlobal });
  guardedBindings.add(guardedGlobal);
}

function guardGlobalBindings(backing, deny) {
  const supported = new Set(("Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError " +
    "JSON Math Intl Reflect Proxy Map Set WeakMap WeakSet WeakRef FinalizationRegistry BigInt ArrayBuffer SharedArrayBuffer DataView Atomics " +
    "Uint8Array Int8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float16Array Float32Array Float64Array BigInt64Array BigUint64Array " +
    "eval isFinite isNaN decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape " +
    "globalThis process console window navigator __zod_globalConfig __zod_globalRegistry crypto performance WebAssembly " +
    "TextEncoder TextDecoder URL URLSearchParams Request Response Headers Blob AbortController ReadableStream WritableStream TransformStream atob btoa").split(" "));
  for (const key of Object.getOwnPropertyNames(backing)) {
    if (!hasSet(supported, key)) Object.defineProperty(backing, key, { configurable: true, get: () => deny(`unavailable global ${key}`) });
  }
  const prototype = Object.getPrototypeOf(backing);
  Object.setPrototypeOf(backing, new intrinsicProxy(prototype, {
    has: (target, key) => intrinsicReflect.has(target, key) || deny(`unavailable global ${intrinsicString(key)}`),
    get: (target, key) => intrinsicReflect.has(target, key) ? intrinsicReflect.get(target, key) : deny(`unavailable global ${intrinsicString(key)}`),
  }));
}

function writeDenials(deny, reason) {
  const refuse = () => deny(reason);
  return { set: refuse, defineProperty: refuse, deleteProperty: refuse, setPrototypeOf: refuse, preventExtensions: refuse };
}

/** Function/eval are capability probes only; supplied strings are NEVER run. */
function installRuntime(target, deny, runtime, probes) {
  const unavailable = () => { throw new EvalError("Code generation unavailable"); };
  const createFunction = (args) => {
    if (runtime.evalThrows) return unavailable();
    if (args.length > 1 || (args.length === 1 && args[0] !== "")) return deny("dynamic function source");
    const generated = new intrinsicProxy(function () {}, {
      apply: () => deny("generated function execution"), construct: () => deny("generated function execution"),
      ...reflectionDenials(deny, "generated function reflection"),
    });
    guardedBindings.add(generated);
    return generated;
  };
  const functionProbe = new intrinsicProxy(function () {}, {
    apply: (_target, _receiver, args) => createFunction(args),
    construct: (_target, args) => createFunction(args),
    ...reflectionDenials(deny, "dynamic function reflection"),
  });
  const evalProbe = (source) => {
    if (runtime.evalThrows) return unavailable();
    if (typeof source !== "string") return source;
    if (source !== "") return deny("dynamic evaluation source");
    return undefined;
  };
  const navigator = runtime.userAgent === undefined ? undefined : guardHost({ userAgent: runtime.userAgent }, deny,
    (target, key) => {
      if (key !== "userAgent") return deny("unsupported navigator probe");
      addSet(probes, "navigator.userAgent");
      return target.userAgent;
    });
  const guardedEval = new intrinsicProxy(evalProbe, reflectionDenials(deny, "dynamic evaluation reflection"));
  for (const callable of [functionProbe, guardedEval]) guardedBindings.add(callable);
  for (const [key, value] of Object.entries({ Function: functionProbe, eval: guardedEval, navigator })) {
    Object.defineProperty(target, key, { configurable: true, get() { addSet(probes, key); return value; } });
  }
}

/** Capability stand-ins may establish presence, never invented result values. */
function reflectionDenials(deny, reason) {
  const refuse = () => deny(reason);
  return { get: refuse, has: refuse, ownKeys: refuse, getOwnPropertyDescriptor: refuse,
    getPrototypeOf: refuse, isExtensible: refuse, ...writeDenials(deny, reason) };
}

/** Keep same-realm intrinsics, but refuse clocks, entropy and host-only globals. */
function installInputGuards(target, deny) {
  const now = guardCallable(() => deny("clock"), deny);
  target.Date = new intrinsicProxy(target.Date, {
    apply: () => deny("clock"), construct: () => deny("clock"),
    ...reflectionDenials(deny, "synthetic Date reflection"),
    get: (target, key) => key === "UTC" ? target.UTC : key === "now" ? now : deny("synthetic Date reflection"),
  });
  guardedBindings.add(target.Date);
  const math = Object.create(Object.getPrototypeOf(target.Math), Object.getOwnPropertyDescriptors(target.Math));
  math.random = guardCallable(() => deny("randomness"), deny);
  Object.defineProperty(target, "Math", { configurable: true, value: guardHost(math, deny, (host, key) =>
    intrinsicHasOwn(host, key) && key !== intrinsicTag ? intrinsicReflect.get(host, key) : deny("synthetic Math reflection")) });
  for (const [key, reason] of [["crypto", "crypto input"], ["performance", "clock"], ["Intl", "locale input"]]) {
    Object.defineProperty(target, key, { configurable: true, value: guardHost({}, deny, () => deny(reason)) });
  }
  for (const key of ["File", "Buffer", "module", "exports", "require", "global", "fetch", "setTimeout", "setInterval", "setImmediate", "WebAssembly"]) {
    Object.defineProperty(target, key, { configurable: true, get: () => deny(`unavailable global ${key}`) });
  }
}

/** Called only inside the disposable realm: these are that realm's intrinsics. */
export function installConstructorGuards(deny, probes) {
  const refuse = () => { addSet(probes, "Function.constructor"); return deny("dynamic function constructor"); };
  const prototypes = new Set([Function.prototype, Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]);
  guardConstructorReflection(prototypes, refuse);
  guardPrototypeAliases(prototypes, refuse);
  for (const prototype of prototypes) {
    // Preserve native deletion semantics. Removing a guard cannot recover the
    // native constructor it replaced; assignment must latch instead of failing silently.
    defineIntrinsicProperty(prototype, "constructor", { configurable: true, get: refuse, set: refuse });
  }
}

/** The guard's accessor descriptor is not deployment metadata. */
function guardConstructorReflection(prototypes, refuse) {
  const sourceDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
  if (!sourceDescriptor || typeof sourceDescriptor.value !== "function") throw new Error("Native callable reflection unavailable");
  /** @type {Array<[object, string]>} */
  const methods = [[Object, "getOwnPropertyDescriptor"], [Reflect, "getOwnPropertyDescriptor"],
    [Object, "getOwnPropertyDescriptors"], [Object, "defineProperty"], [Object, "defineProperties"],
    [Reflect, "defineProperty"], [Object.prototype, "__lookupGetter__"], [Object.prototype, "__lookupSetter__"],
    [Object.prototype, "__defineGetter__"], [Object.prototype, "__defineSetter__"]];
  for (const [owner, key] of methods) {
    const legacy = key.startsWith("__");
    const original = intrinsicReflect.get(owner, key);
    if (typeof original !== "function") throw new Error("Native constructor reflection unavailable");
    const guarded = new intrinsicProxy(original, { apply(method, receiver, args) {
      // Refuse opaque legacy keys rather than executing coercion differently
      // from native ToPropertyKey; constructor lookups can walk inherited guards.
      const constructorLookup = legacy && ((typeof args[0] === "object" || typeof args[0] === "function") || args[0] === "constructor");
      if (hasSet(prototypes, legacy ? receiver : args[0]) || constructorLookup) return refuse();
      return intrinsicReflect.apply(method, receiver, args);
    } });
    guardedBindings.add(guarded);
    defineIntrinsicProperty(owner, key, { ...Object.getOwnPropertyDescriptor(owner, key), value: guarded });
  }
  const sourceGuard = new intrinsicProxy(sourceDescriptor.value, { apply(method, receiver, args) {
    if (guardedBindings.has(receiver)) return refuse();
    return intrinsicReflect.apply(method, receiver, args);
  } });
  guardedBindings.add(sourceGuard);
  defineIntrinsicProperty(Function.prototype, "toString", { ...sourceDescriptor, value: sourceGuard });
}

/** Native proxy aliases must not bypass the prototype identity fence. */
function guardPrototypeAliases(prototypes, refuse) {
  const nativeProxy = Proxy;
  const revocable = new nativeProxy(nativeProxy.revocable, { apply(method, receiver, args) {
    if (hasSet(prototypes, args[0]) || isGuardedTarget(args[0])) return refuse();
    return intrinsicReflect.apply(method, receiver, args);
  } });
  const guarded = new nativeProxy(nativeProxy, {
    construct(method, args, newTarget) {
      if (hasSet(prototypes, args[0]) || isGuardedTarget(args[0])) return refuse();
      return intrinsicReflect.construct(method, args, newTarget);
    },
    get: (method, key, receiver) => key === "revocable" ? revocable : intrinsicReflect.get(method, key, receiver),
    getOwnPropertyDescriptor(method, key) {
      const descriptor = intrinsicReflect.getOwnPropertyDescriptor(method, key);
      return key === "revocable" && descriptor ? { ...descriptor, value: revocable } : descriptor;
    },
    ...writeDenials(refuse, "proxy constructor mutation"),
  });
  guardedBindings.add(guarded);
  guardedBindings.add(revocable);
  defineIntrinsicProperty(globalThis, "Proxy", { configurable: true, writable: true, value: guarded });
}
