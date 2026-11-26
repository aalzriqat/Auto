// SCRUM-1005: readers for `bombadil trace <file> --json` output, one JSON object
// per state. Pure functions: the runner and its tests share this one parser.

/** The JSON objects (one per state) from `bombadil trace --json` output. */
export function parseStates(jsonLines) {
  const states = [];
  for (const line of jsonLines.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      states.push(JSON.parse(line));
    } catch {
      // A non-JSON line is not a state.
    }
  }
  return states;
}

export function countStates(jsonLines) {
  return jsonLines.split("\n").filter((l) => l.trim().startsWith("{")).length;
}

/** Names of violated properties. Bombadil 0.8.0 nests them under metadata.violations. */
export function violatedNames(jsonLines) {
  const names = new Set();
  for (const state of parseStates(jsonLines)) {
    for (const v of state.metadata?.violations ?? state.violations ?? []) {
      names.add(String(v.name ?? v.property ?? JSON.stringify(v)));
    }
  }
  return [...names];
}

/**
 * Distinct pathnames the trace visited (metadata.state.url, query and hash
 * dropped). With `origin`, only states on that origin count: an error page
 * (chrome-error://) or an off-origin URL is not the app.
 */
export function visitedPaths(jsonLines, origin) {
  const paths = new Set();
  const wanted = origin === undefined ? undefined : new URL(origin).origin;
  for (const state of parseStates(jsonLines)) {
    try {
      const url = new URL(state.metadata.state.url);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        (wanted === undefined || url.origin === wanted)
      )
        paths.add(url.pathname);
    } catch {
      // chrome-error:// and missing urls are not pathnames of the app.
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}
