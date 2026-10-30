// Captured before installing guards: their own bookkeeping must not observe them.
const native = { apply: Reflect.apply, construct: Reflect.construct, get: Reflect.get,
  descriptors: Object.getOwnPropertyDescriptors,
  define: Object.defineProperty, prototype: Object.getPrototypeOf, ownKeys: Reflect.ownKeys,
  descriptor: Object.getOwnPropertyDescriptor, remove: Reflect.deleteProperty,
  extensible: Object.isExtensible, same: Object.is, Proxy,
  weakHas: WeakSet.prototype.has, weakAdd: WeakSet.prototype.add, hasInstance: Symbol.hasInstance };
const bindings = new WeakSet();
export const guardedBindings = {
  has: (binding) => native.apply(native.weakHas, bindings, [binding]),
  add: (binding) => native.apply(native.weakAdd, bindings, [binding]),
};
export const isGuardedTarget = (target) => guardedBindings.has(target);

/** Replacements may be called, but their implementation is never evidence. */
export function guardCallable(callable, deny, overrides = {}) {
  const refuse = () => deny("synthetic binding reflection");
  // A constructible bridge makes `new` reach the refusal even when the stand-in
  // is an arrow. Otherwise V8 throws before the Proxy trap and a caught error
  // can become synthetic validator evidence.
  const guarded = new native.Proxy(function () {}, {
    ...observationTraps(refuse),
    get(_target, key) {
      // These are unchanged native Function.prototype methods. Returning a new
      // wrapper would itself expose a different identity through ===.
      if (key === "call" || key === "apply" || key === "bind" || key === native.hasInstance) return native.get(callable, key);
      return refuse();
    },
    apply: (_target, receiver, args) => native.apply(callable, receiver, args),
    construct: () => deny("synthetic binding construction"),
    ...overrides,
  });
  guardedBindings.add(guarded);
  return guarded;
}

/** Allow explicit semantic reads; refuse descriptors, membership and enumeration. */
export function guardHost(host, deny, get) {
  const guarded = new native.Proxy(host, { ...observationTraps(() => deny("synthetic host reflection")), get });
  guardedBindings.add(guarded);
  return guarded;
}

function observationTraps(refuse) {
  return { get: refuse, has: refuse, ownKeys: refuse, getOwnPropertyDescriptor: refuse,
    getPrototypeOf: refuse, isExtensible: refuse, set: refuse, defineProperty: refuse,
    deleteProperty: refuse, setPrototypeOf: refuse, preventExtensions: refuse };
}

/** Install last, after setup's own descriptor operations have finished. */
export function installObservationGuards(target, deny) {
  const owners = [Object, Reflect, Object.prototype, native.prototype(function(){}),
    native.prototype(async function(){}), native.prototype(function*(){}), native.prototype(async function*(){})];
  for (const owner of owners) {
    for (const [key, descriptor] of Object.entries(native.descriptors(owner))) {
      if (guardedBindings.has(descriptor.value)) {
        native.define(owner, key, { ...descriptor, value: guardCallable(descriptor.value, deny) });
      }
    }
  }
  const proxy = target.Proxy;
  const revocable = guardCallable(proxy.revocable, deny);
  target.Proxy = guardCallable(proxy, deny, {
    get: (_owner, key) => key === "revocable" ? revocable : deny("synthetic binding reflection"),
    construct: (_method, args) => native.construct(proxy, args),
  });
  // Convex also installs prepareStackTrace (udf-runtime/src/errors.ts). Keep
  // native Error inheritance while refusing the host's lazy stack formatting.
  // Node may already own a non-enumerable formatter; Convex starts without it.
  native.remove(target.Error, "prepareStackTrace");
  target.Error.prepareStackTrace = guardCallable(() => deny("error stack"), deny);
  return errorShapeVerifier(target, deny);
}

/** errors.ts db914cf0:23 assigns the hook; all other Error own state is native.
 * Compare residue, not writes: Convex's analyzer gives each entry a fresh realm.
 * Captured native operations cannot be replaced by the entry being inspected.
 */
function errorShapeVerifier(target, deny) {
  const names = ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"];
  const bindings = names.map((name) => ({ name, descriptor: native.descriptor(target, name) }));
  const snapshots = names.flatMap((name) => [target[name], target[name].prototype]).map((owner) => ({
    owner, descriptors: native.descriptors(owner), keys: native.ownKeys(owner),
    prototype: native.prototype(owner), extensible: native.extensible(owner),
  }));
  return () => {
    for (let index = 0; index < bindings.length; index++) {
      const binding = bindings[index];
      if (!sameDescriptor(binding.descriptor, native.descriptor(target, binding.name))) return deny("Error family residue");
    }
    for (let snapshotIndex = 0; snapshotIndex < snapshots.length; snapshotIndex++) {
      const snapshot = snapshots[snapshotIndex];
      const keys = native.ownKeys(snapshot.owner);
      if (keys.length !== snapshot.keys.length || native.prototype(snapshot.owner) !== snapshot.prototype ||
          native.extensible(snapshot.owner) !== snapshot.extensible) return deny("Error family residue");
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key !== snapshot.keys[index] || !sameDescriptor(native.descriptor(snapshot.owner, key),
          native.descriptor(snapshot.descriptors, key)?.value)) {
          return deny("Error family residue");
        }
      }
    }
  };
}

function sameDescriptor(expected, current) {
  if (!expected || !current) return expected === current;
  const fields = ["value", "get", "set", "writable", "enumerable", "configurable"];
  for (let index = 0; index < fields.length; index++) {
    const key = fields[index];
    if (!native.same(expected[key], current[key])) return false;
  }
  return true;
}
