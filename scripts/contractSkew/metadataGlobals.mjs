/** Install a world's inputs before importing any bundled module. */
export function installGlobals({ target, deny, world, reads }) {
  // Node initializes these lazily through Undici, which itself needs Buffer.
  // Materialize the supported web intrinsics before host inputs are denied.
  for (const [key, value] of Object.entries({ TextEncoder, TextDecoder, URL, URLSearchParams,
    Request, Response, Headers, Blob, AbortController, ReadableStream, WritableStream, TransformStream, atob, btoa })) {
    Object.defineProperty(target, key, { configurable: true, value });
  }
  const record = (key) => {
    if (typeof key !== "string") return deny("unsupported environment key");
    reads.keys.add(key);
    return deny("environment read");
  };
  const env = new Proxy(Object.create(null), {
    get: (_target, key) => record(key),
    ownKeys: () => { reads.enumerations++; return deny("environment enumeration"); },
    has: (_target, key) => record(key),
    getOwnPropertyDescriptor: (_target, key) => record(key),
    getPrototypeOf: () => deny("environment reflection"),
    isExtensible: () => deny("environment reflection"),
    ...writeDenials(deny, "environment write"),
  });
  const processProxy = new Proxy({ env }, {
    get: (_target, key) => key === "env" ? env : deny("process input"),
    ownKeys: () => deny("process enumeration"), has: () => deny("process membership"),
    getOwnPropertyDescriptor: () => deny("process descriptor"),
    ...writeDenials(deny, "process write"),
  });
  Object.defineProperty(target, "process", { configurable: true, value: processProxy });
  Object.defineProperty(target, "console", { configurable: true, value: new Proxy({}, { get: () => () => {} }) });
  installRuntime(target, deny, world.runtime ?? {}, reads.capabilityProbes);
  installInputGuards(target, deny);
  target.__zod_globalConfig = world.zodConfig ? {} : undefined;
  target.__zod_globalRegistry = undefined;
  Object.defineProperty(target, "window", { configurable: true, value: undefined });
  const backing = target;
  // A proxy assigned to globalThis cannot intercept an unqualified `typeof
  // MissingRuntime`. Global binding lookup also walks the real global object's
  // prototype; guard that path and refuse Node-only own properties separately.
  guardGlobalBindings(backing, deny);
  const capabilities = new Set(/** @type {Array<string | symbol>} */ (["navigator", "Function", "eval", "__zod_globalConfig", "__zod_globalRegistry"]));
  const guardedGlobal = new Proxy(backing, {
    get: (target, key) => {
      if (capabilities.has(key)) reads.capabilityProbes.add(key);
      return Reflect.has(target, key) ? Reflect.get(target, key) : deny(`unavailable global ${String(key)}`);
    },
    has: (target, key) => {
      if (!capabilities.has(key)) return deny("global membership");
      reads.capabilityProbes.add(key);
      if (key === "navigator") return world.runtime?.userAgent !== undefined;
      return Reflect.has(target, key);
    },
    ownKeys: () => deny("global enumeration"),
    getOwnPropertyDescriptor: (target, key) => {
      if (!capabilities.has(key)) return deny("global descriptor");
      reads.capabilityProbes.add(key);
      if (key === "navigator" && world.runtime?.userAgent === undefined) return undefined;
      if (["navigator", "Function", "eval"].includes(String(key))) {
        return { configurable: true, enumerable: key === "navigator", writable: true, value: Reflect.get(target, key) };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  Object.defineProperty(backing, "globalThis", { configurable: true, value: guardedGlobal });
}

function guardGlobalBindings(backing, deny) {
  const supported = new Set(("Object Function Array Number parseFloat parseInt Infinity NaN undefined Boolean String Symbol Date Promise RegExp Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError " +
    "JSON Math Intl Reflect Proxy Map Set WeakMap WeakSet WeakRef FinalizationRegistry BigInt ArrayBuffer SharedArrayBuffer DataView Atomics " +
    "Uint8Array Int8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float16Array Float32Array Float64Array BigInt64Array BigUint64Array " +
    "eval isFinite isNaN decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape " +
    "globalThis process console window navigator __zod_globalConfig __zod_globalRegistry crypto performance WebAssembly " +
    "TextEncoder TextDecoder URL URLSearchParams Request Response Headers Blob AbortController ReadableStream WritableStream TransformStream atob btoa").split(" "));
  for (const key of Object.getOwnPropertyNames(backing)) {
    if (!supported.has(key)) Object.defineProperty(backing, key, { configurable: true, get: () => deny(`unavailable global ${key}`) });
  }
  const prototype = Object.getPrototypeOf(backing);
  Object.setPrototypeOf(backing, new Proxy(prototype, {
    has: (target, key) => Reflect.has(target, key) || deny(`unavailable global ${String(key)}`),
    get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : deny(`unavailable global ${String(key)}`),
  }));
}

function writeDenials(deny, reason) {
  const refuse = () => deny(reason);
  return { set: refuse, defineProperty: refuse, deleteProperty: refuse, setPrototypeOf: refuse, preventExtensions: refuse };
}

/** Function/eval are capability probes only; supplied strings are NEVER run. */
function installRuntime(target, deny, runtime, probes) {
  const unavailable = () => { throw new EvalError("Code generation unavailable"); };
  const generated = new Proxy(function () {}, {
    apply: () => deny("generated function execution"),
    construct: () => deny("generated function execution"),
    ...reflectionDenials(deny, "generated function reflection"),
  });
  const createFunction = (args) => {
    if (runtime.evalThrows) return unavailable();
    if (args.length > 1 || (args.length === 1 && args[0] !== "")) return deny("dynamic function source");
    return generated;
  };
  const functionProbe = new Proxy(function () {}, {
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
  const navigator = runtime.userAgent === undefined ? undefined : new Proxy({ userAgent: runtime.userAgent }, {
    get: (target, key) => {
      if (key !== "userAgent") return deny("unsupported navigator probe");
      probes.add("navigator.userAgent");
      return target.userAgent;
    },
    has: (_target, key) => {
      if (key !== "userAgent") return deny("unsupported navigator probe");
      probes.add("navigator.userAgent");
      return true;
    },
    getOwnPropertyDescriptor: (target, key) => {
      if (key !== "userAgent") return deny("unsupported navigator probe");
      probes.add("navigator.userAgent");
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const guardedEval = new Proxy(evalProbe, reflectionDenials(deny, "dynamic evaluation reflection"));
  for (const [key, value] of Object.entries({ Function: functionProbe, eval: guardedEval, navigator })) {
    Object.defineProperty(target, key, { configurable: true, get() { probes.add(key); return value; } });
  }
}

/** Capability stand-ins may establish presence, never invented result values. */
function reflectionDenials(deny, reason) {
  const refuse = () => deny(reason);
  return { get: refuse, has: refuse, ownKeys: refuse, getOwnPropertyDescriptor: refuse,
    getPrototypeOf: refuse, ...writeDenials(deny, reason) };
}

/** Keep same-realm intrinsics, but refuse clocks, entropy and host-only globals. */
function installInputGuards(target, deny) {
  target.Date = new Proxy(target.Date, {
    apply: () => deny("clock"), construct: () => deny("clock"),
    get: (target, key) => key === "UTC" ? target.UTC : () => deny("clock"),
  });
  const math = Object.create(Object.getPrototypeOf(target.Math), Object.getOwnPropertyDescriptors(target.Math));
  math.random = () => deny("randomness");
  Object.defineProperty(target, "Math", { configurable: true, value: math });
  for (const [key, reason] of [["crypto", "crypto input"], ["performance", "clock"], ["Intl", "locale input"]]) {
    Object.defineProperty(target, key, { configurable: true, value: new Proxy({}, { get: () => deny(reason) }) });
  }
  for (const key of ["File", "Buffer", "module", "exports", "require", "global", "fetch", "setTimeout", "setInterval", "setImmediate", "WebAssembly"]) {
    Object.defineProperty(target, key, { configurable: true, get: () => deny(`unavailable global ${key}`) });
  }
}

/** Called only inside the disposable realm: these are that realm's intrinsics. */
export function installConstructorGuards(deny, probes) {
  const refuse = () => { probes.add("Function.constructor"); return deny("dynamic function constructor"); };
  const constructor = new Proxy(function () {}, {
    apply: refuse, construct: refuse, ...reflectionDenials(deny, "dynamic constructor reflection"),
  });
  for (const prototype of [Function.prototype, Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) {
    Object.defineProperty(prototype, "constructor", { configurable: false, get() {
      probes.add("Function.constructor");
      return constructor;
    } });
  }
}
