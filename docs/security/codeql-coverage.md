# CodeQL coverage, and the one thing it does not cover

**AutoFlow does not have full-repository CodeQL coverage.** Two Kotlin files are
outside it, deliberately and with a documented reason. Everything else is
scanned.

## What is covered

CodeQL runs as GitHub **default setup** (not advanced setup — there is no
`.github/workflows/codeql.yml`, and there never has been).

| configuration | status | scope at `687d2f66` |
| --- | --- | --- |
| `javascript-typescript` | green | 949/949 TypeScript files, 16/16 JavaScript files, 0 extraction errors |
| `actions` | green | 5/5 workflow files |

`Analyze (javascript-typescript)` is one of the ten required status checks on
`main` (with `enforce_admins` enabled), so JS/TS analysis genuinely gates merges.

## What is NOT covered

Exactly two files — the complete set of `.kt`/`.java`/`.kts` in the repository:

```
apps/mobile/android/app/src/main/java/com/autoflowdealer/mobile/MainActivity.kt
apps/mobile/android/app/src/main/java/com/autoflowdealer/mobile/MainApplication.kt
```

Both are React Native / Expo bootstrap boilerplate: `MainActivity` wires up the
RN root view and `MainApplication` registers the RN host and packages. Neither
contains AutoFlow business logic, authentication, tenancy, or financial code.

## Why, and what was actually tried

This is not an assumption — `java-kotlin` was enabled on default setup on
2026-08-08 and the analysis was allowed to run. It failed:

```
CodeQL detected code written in Java/Kotlin but could not process any of it
using the 'none' build mode. Set up manual build steps
```

Default setup analyses Java/Kotlin with `build-mode: none` and exposes no
setting to change that. Its autobuild fallback downloads **its own Gradle
9.3.1** rather than using the project's wrapper, and the build then fails at
`apps/mobile/android/settings.gradle:1`, which uses React Native / Expo plugin
APIs that Gradle 9.3.1 rejects:

```
[ERROR] Spawned process exited abnormally (code 1; tried to run: [./gradlew ...])
[WARN]  Running gradle to determine the project dependency graph failed.
BUILD FAILED in 10s
```

GitHub's supported route from here is **advanced setup with explicit manual
build steps**. That was evaluated and deliberately declined for now, because it
is not proportionate:

- Enabling advanced setup **disables default setup for every language**. The
  working `javascript-typescript` and `actions` analyses would have to be
  re-authored in a hand-written workflow.
- The resulting job must keep emitting a status context named exactly
  `Analyze (javascript-typescript)`, or the required check disappears and
  **every open PR blocks** (`enforce_admins: true`).
- It introduces an Android SDK + Gradle build into security CI. No CI job builds
  the Android app today, and this repo's Gradle dependency verification is known
  to break on any new native module.

Replacing a healthy, merge-gating pipeline and adding an Android build toolchain,
in order to scan two boilerplate files, trades a large amount of reliability for
a very small amount of signal.

The alternative — leaving `java-kotlin` enabled and permanently failing — was
also rejected. A red security dashboard has to mean "something broke, act on
it." A dashboard that is permanently red for a known, accepted reason trains
everyone to ignore it, which costs more than the two files are worth.

So: green dashboard, one written-down exception.

## Mandatory revisit trigger

Kotlin CodeQL coverage **must be revisited, and an advanced/manual-build setup
evaluated, before the work is considered complete** if any of the following
happens:

- first-party Android native code is added or materially modified;
- any additional `.kt`, `.kts` or `.java` file is added;
- a native module is added to the Android app;
- security-sensitive logic (auth, tokens, credentials, tenancy, payments,
  crypto, deep-link or intent handling) moves into Android native code.

Reviewers: treat a PR that touches `apps/mobile/android/**` Kotlin or Java
sources as triggering this. The exception above is scoped to boilerplate, and
stops applying the moment the code stops being boilerplate.

## Related

- Dependency scanning coverage and its own known gap (the Android native AAR
  graph): `docs/security/dependency-scanning.md`.
- Historical note: a `python` configuration was also registered on default setup
  and erroring. The repository contains zero `.py` files; its 108 analyses all
  had `results_count: 0` and were deleted on 2026-08-08. No finding was lost.
