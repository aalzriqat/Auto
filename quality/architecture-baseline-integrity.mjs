function edgeKey(edge) {
  return `${edge.from}\u0000${edge.to}`;
}

function differences(expected, actual, identity) {
  const expectedKeys = new Set(expected.map(identity));
  const actualKeys = new Set(actual.map(identity));
  return {
    missing: expected.filter((entry) => !actualKeys.has(identity(entry))),
    unexpected: actual.filter((entry) => !expectedKeys.has(identity(entry))),
  };
}

function formatEntries(label, entries, display) {
  if (entries.length === 0) return [];
  return [label, ...entries.map((entry) => `  ${display(entry)}`)];
}

function baselineIntegrityState({
  baseline,
  originBaseline,
  originMainCommit,
  sourceSnapshot,
  engineVersion,
}) {
  return {
    modules: differences(
      sourceSnapshot.cyclicModules,
      baseline.cyclicModules,
      String,
    ),
    edges: differences(
      sourceSnapshot.cyclicEdges,
      baseline.cyclicEdges,
      edgeKey,
    ),
    engineMismatch: baseline.engineVersion !== engineVersion,
    bootstrapSourceMismatch:
      !originBaseline && baseline.sourceCommit !== originMainCommit,
    originModules: originBaseline
      ? differences(
          originBaseline.cyclicModules,
          baseline.cyclicModules,
          String,
        )
      : { unexpected: [] },
    originEdges: originBaseline
      ? differences(originBaseline.cyclicEdges, baseline.cyclicEdges, edgeKey)
      : { unexpected: [] },
  };
}

function isBaselineIntegrityValid(state) {
  return (
    !state.engineMismatch &&
    !state.bootstrapSourceMismatch &&
    state.modules.unexpected.length === 0 &&
    state.edges.unexpected.length === 0 &&
    state.originModules.unexpected.length === 0 &&
    state.originEdges.unexpected.length === 0
  );
}

function baselineIntegrityDetails({
  state,
  baseline,
  originMainCommit,
  engineVersion,
}) {
  return [
    ...(state.bootstrapSourceMismatch
      ? [
          `Bootstrap source mismatch: baseline ${baseline.sourceCommit}; origin/main ${originMainCommit}.`,
          "The first architecture baseline must be generated from the exact current origin/main commit, not an older ancestor.",
        ]
      : []),
    ...(state.engineMismatch
      ? [
          `Engine mismatch: baseline ${baseline.engineVersion}; required ${engineVersion}.`,
        ]
      : []),
    ...formatEntries(
      "Unexpected cyclic modules not present in the source snapshot:",
      state.modules.unexpected,
      String,
    ),
    ...formatEntries(
      "Unexpected cyclic edges not present in the source snapshot:",
      state.edges.unexpected,
      (edge) => `${edge.from} -> ${edge.to}`,
    ),
    ...formatEntries(
      "Cyclic modules already pruned from the origin/main baseline:",
      state.originModules.unexpected,
      String,
    ),
    ...formatEntries(
      "Cyclic edges already pruned from the origin/main baseline:",
      state.originEdges.unexpected,
      (edge) => `${edge.from} -> ${edge.to}`,
    ),
  ];
}

export function assertArchitectureBaselineIntegrity({
  baseline,
  originBaseline,
  originMainCommit,
  sourceSnapshot,
  engineVersion,
}) {
  if (
    !baseline ||
    !sourceSnapshot ||
    !/^[0-9a-f]{40}$/u.test(originMainCommit ?? "")
  ) {
    throw new TypeError(
      "Architecture baseline integrity requires a baseline, source snapshot, and resolved origin/main commit.",
    );
  }

  const state = baselineIntegrityState({
    baseline,
    originBaseline,
    originMainCommit,
    sourceSnapshot,
    engineVersion,
  });
  if (isBaselineIntegrityValid(state)) return true;

  const details = baselineIntegrityDetails({
    state,
    baseline,
    originMainCommit,
    engineVersion,
  });

  throw new Error(
    [
      "ARCHITECTURE BASELINE INTEGRITY ERROR",
      `quality/baselines/architecture.json contains debt that is not in the runtime-cycle snapshot at ${baseline.sourceCommit}.`,
      ...details,
      "Do not add branch or previously pruned debt. Listed cycles must exist at the sourceCommit and, after bootstrap, in origin/main's committed baseline; removed debt may be pruned.",
    ].join("\n"),
  );
}
