// SCRUM-1005: readers for `bombadil trace <file> --json` output, one JSON object
// per state. Pure functions: the runner and its tests share this one parser, so
// every count below is over the same list of parsed states.

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

/** The http(s) URL of a state, or undefined (chrome-error://, no url). */
function webUrl(state) {
  try {
    const url = new URL(state.metadata.state.url);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The parsed states, or with `origin` only those on that origin. The count is
 * what the minimum is compared with, so an off-origin or error page never
 * counts as exploring the app.
 */
export function countStates(jsonLines, origin) {
  const states = parseStates(jsonLines);
  if (origin === undefined) return states.length;
  const wanted = new URL(origin).origin;
  return states.filter((state) => webUrl(state)?.origin === wanted).length;
}

/**
 * Parsed http(s) states on another origin. Reported, not judged: in CI Clerk's
 * dev-instance handshake may legitimately bounce through a Clerk domain, so the
 * verdict does not depend on this number.
 */
export function offOriginStates(jsonLines, origin) {
  const wanted = new URL(origin).origin;
  return parseStates(jsonLines).filter((state) => {
    const url = webUrl(state);
    return url !== undefined && url.origin !== wanted;
  }).length;
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
  const wanted = origin === undefined ? undefined : new URL(origin).origin;
  const paths = new Set();
  for (const state of parseStates(jsonLines)) {
    const url = webUrl(state);
    if (url !== undefined && (wanted === undefined || url.origin === wanted)) {
      paths.add(url.pathname);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}
