# SCRUM-964: maintained picomatch security backports

These **private, repository-maintained forks are not upstream releases**. They replace
the installed v2 and v4 implementations while preserving each major's public API.
They have not been published to npm. The original MIT notices remain in each archive.

## Cause and invariant

GHSA-fc5q-39xc-vjpf identifies nested, unbounded repetition in generated regular
expressions. A repeated extglob containing a wildcard can block Node's event loop.
The parser patch uses the actual owning parser tokens, applies restricted
unambiguous transformations, and retains the existing defensive literal fallback
for unsupported shapes. An explicit `maxExtglobRecursion: false` remains an unsafe
caller opt-out; this is not a claim that arbitrary regex syntax is safe.

The invariant is that every installed consumer uses the correct reviewed major,
with the exact reproducible patched bytes, and the inherited advisory feed remains
checked. A different package name or green registry audit alone proves none of it.

## Source and alternatives

Original npm archives and their published SHA-512 integrities are retained alongside
the two fork archives. `provenance.json` identifies all files, artifact hashes and
the exact source patch commits. The readable patches are in `patches/`.

* v2: upstream 2.3.2, parser patch from
  [PR 263](https://github.com/micromatch/picomatch/pull/263), commit
  `9ca61909ab0ec680953e21bac80a6e825e1ede81`.
* v4: upstream 4.0.7, parser patch from
  [PR 262](https://github.com/micromatch/picomatch/pull/262), commit
  `3222059ac27492d9c0147fee5c65f751bbd851ab`.

Only `lib/parse.js` changes at runtime. Package metadata declares the private fork
identity, provenance and version; lifecycle scripts and development dependencies
are removed. Other files and original license notices are unchanged. The required
verifier reconstructs this contract from the original archives and readable patch;
editing a hash manifest cannot bless unrelated or unpatched bytes.

As of implementation, the upstream proposals remain unreleased. Waiting for an
upstream release did not remediate the installed code. The published
`@ryotsu/picomatch@4.0.7-a` alternative was rejected: `+(*a|b)b` and `+([*a)` still
exceeded a 1-second subprocess deadline on 32-character inputs. No blanket v2-to-v4
override, fabricated upstream version or new registry advisory ignore is used.

## Required verification

The existing `dependency-audit` job now runs
`node scripts/security/verifyPicomatchBackport.mjs` before the unchanged high-severity
root registry audit. Both root and worker transport errors now fail instead of
being converted into success.

The verifier refuses unless it can:

1. bind both archives and all lockfile edges to the exact policy;
2. reconstruct the runtime files from the original integrity-pinned npm archives
   and the parser-only patches, preserving original file inventories;
3. enumerate the installed pnpm copies, verify every file, and resolve each actual
   consumer through Node's native resolver to the expected major;
4. run all 78 bounded security and positive compatibility controls per installed
   copy; the current graph has 12 edges and 2 copies, so 156 controls;
5. inspect the separate worker npm graph (currently no picomatch consumer); and
6. query the original picomatch identities in the registry's advisory feed.

The one remediated advisory is recognized only after installed-source reconstruction
and runtime checks succeed. A new inherited high/critical advisory, changed scope
or severity of the known advisory, bad response, timeout, missing source, empty
execution, unmatched edge or wrong major fails. Registry-name changes cannot remove
this inherited coverage. Existing unrelated advisory decisions remain unchanged.

The twelve consumer parents, original majors and dependency/optional edge kinds
are pinned independently from main `0406a7efc2751e2eb61ca652f552844218ac1fc7`.
Missing or duplicate parent edges and jointly changed lock/link majors fail.
The exact private name/version/upstream tuples are fixed in the verifier.
Reconstruction canonicalizes only the patched parser to the retained archives'
CRLF bytes; neither archive hashes nor unrelated upstream bytes change.

The original pnpm overrides are the local precedent: maintain each consumer's
supported major. Native pnpm file overrides, Git patch application and Node module
resolution supply the mechanisms. No package-manager fork is introduced.

## Evidence and limits

The initial real pnpm 11.13.0 frozen install passed. The required verifier measured
12 actual edges, 2 installed copies, 156 passing controls and the inherited advisory.
Actual root audit reported 1,954 dependencies and zero high/critical findings;
worker lockfile audit reported zero vulnerabilities. These are local facts, not CI
certification, independent approval, merge, deployment or production verification.

The patched v4 passed all 1,983 upstream tests. On Windows, patched v2 and original
v2 both produced 1,970 passes and the same two pre-existing POSIX-regex-string
assertion failures out of 1,972 tests. That establishes outcome parity on this
platform; it is not a claim that the upstream Windows run was wholly green.
The project typecheck passed after restoring the native in-project virtual-store
layout; the root configuration excludes Convex and does not typecheck these `.mjs`
files. Runtime checks, lint and the verifier tests cover those executable files.

The finite regression set is not a formal proof of all regex behavior or every
possible glob. Existing independent exact-head review, CI, browser/role and release
obligations remain required. This package must not be called production verified
until the normal release evidence exists.

## Removal

When upstream publishes supported v2/v4 fixes, compare the source and behavior,
replace both native overrides with genuine releases, remove the forks and this
temporary backport verifier together, and verify frozen installation, inherited
and ordinary audits, compatibility, and the existing independent/release gates.
Do not remove the verifier while any private fork remains installed.
