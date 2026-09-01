# Dependency scanning: what is gated, what is reported

Baseline commit: `52be7b4f86db9b3e9cc9d7ea19cdcc6c8aadbdc1`.

AutoFlow separates two SCA signals deliberately, because mixing them made the
Security dashboard unusable: 289 of 301 findings came from a single file that
cannot answer the only question a merge gate cares about — *does this ship?*

There are three dependency graphs and they do not overlap:

| graph | resolved by | scanned as |
| --- | --- | --- |
| JS / server / worker | pnpm, npm | **gating** |
| Android release runtime (native AAR/JAR) | Gradle | **gating** |
| Everything Gradle ever downloaded | Gradle, historically | reporting only |

## 1. Runtime SCA — the gating signal

Job: `osv-runtime` in `.github/workflows/security.yml`.
Publishes to GitHub Code Scanning. This is the signal a merge gate uses.

| manifest | covers |
| --- | --- |
| `pnpm-lock.yaml` | web app, Convex backend, `packages/*`, **and `apps/mobile`** — `apps/*` is a pnpm workspace member, so the React Native / Expo **JS** graph is included here |
| `dealer-worker/package-lock.json` | the Cloudflare Worker |
| `apps/mobile/android/app/gradle.lockfile` | the Android **native** release runtime — `androidx.*`, `com.facebook.react:react-android`, okhttp/okio, and everything the autolinked Expo modules and the Clerk Android SDK pull in |

These are listed explicitly rather than scanned with `--recursive ./`, because a
recursive scan also picks up the Gradle ledger described in §2.

An explicit list goes stale silently, so the job first fails if the set of
OSV-parsable manifests on disk does not match the set that has been
**classified**. The invariant is not "these four files" — it is:

> every dependency source in the repo is explicitly either GATING (it ships or
> runs) or REPORTING (build machine only), and anything unclassified fails CI
> until a human decides which it is.

Adding a workspace, worker, or ecosystem breaks that step on purpose.

### The Android release runtime lock

`apps/mobile/android/app/gradle.lockfile` is a committed Gradle dependency lock
covering exactly one configuration: `:app`'s `releaseRuntimeClasspath`.

That name was verified, not assumed. `./gradlew :app:resolvableConfigurations`
describes it as *"Runtime classpath of '/release'"*, distinct from
`releaseCompileClasspath` (compile-only deps that are not packaged),
`releaseUnitTestRuntimeClasspath` (tests), and the `debug` / `debugOptimized`
variants.

Locking is activated **only** on that configuration
(`apps/mobile/android/app/build.gradle`), never with `lockAllConfigurations()`.
Locking changes resolution behaviour — Gradle fails the build when a locked
configuration resolves to anything other than the recorded versions. Applying
that to every configuration would let unrelated build/test/tooling classpaths
break the APK build for no security benefit.

To regenerate after any native dependency change:

```bash
cd apps/mobile/android
./gradlew :app:dependencies --write-locks
```

Use the repo's own wrapper (Gradle 9.3.1) so the version is the pinned one, and
commit the result.

Two notes on that command:

- It is `:app:dependencies`, **not**
  `:app:dependencies --configuration releaseRuntimeClasspath`. Gradle puts task
  *options* into `startParameter.taskNames`, so passing the configuration name
  makes `apps/mobile/android/app/build.gradle`'s release-signing guard match
  `"release"` and abort. Only `releaseRuntimeClasspath` has locking activated,
  so the unfiltered form writes the same lock state.
- It also emits `apps/mobile/android/settings-gradle.lockfile`, which only ever
  contains `empty=incomingCatalogForLibs0`. It carries no dependency data and
  OSV-Scanner has no parser for that filename, so it is git-ignored.

CI never runs Gradle: it scans the committed lockfile. No JDK, no Android SDK,
no autolinking in the security workflow. Reproducibility of the *scanned* graph
is therefore structural — CI reads a file in git, so it cannot differ between
runs, and it cannot depend on network resolution or an SDK being present.

**Enforcement is proven, by injection rather than by assertion.** Running

```bash
./gradlew :app:dependencies -Pexpo.webp.animated=true
```

adds `com.facebook.fresco:animated-webp:3.6.0`, which is not in the lock. It
resolves cleanly in `debugRuntimeClasspath`, `debugOptimizedRuntimeClasspath`,
`releaseCompileClasspath` and the unit-test classpaths, and is `FAILED` **only**
under `releaseRuntimeClasspath`. That establishes three things at once: locking
is active on the intended configuration; it has no collateral effect on the
debug/test/compile classpaths, which is the point of not using
`lockAllConfigurations()`; and a native dependency change without a lock
regeneration makes the release runtime classpath unresolvable.

Caveat worth knowing: `:app:dependencies` is a *report* task — it prints
`FAILED` inline and still exits 0. Only a real build task throws. So "the
dependencies report succeeded" is not evidence the lock is satisfied; read the
tree.

Not exercised: a full `assembleRelease`, which needs
`apps/mobile/android/release-signing.properties` (not in the repo).

Practical consequence to be aware of: this repo already has one tripwire that
breaks the APK build when a native module is added (dependency *verification*,
via `verification-metadata.xml`). Dependency *locking* is a second one. If a
release build starts failing with a dependency-lock message after adding or
upgrading a native module, that is expected — regenerate the lock with the
command above and commit it, exactly as you would regenerate the verification
metadata. No CI job builds the APK, so this surfaces at local build time.

## 2. Gradle artifact ledger — reporting only, never gating

Job: `osv-toolchain`. Scans
`apps/mobile/android/gradle/verification-metadata.xml`, writes a job summary and
uploads `osv-toolchain.json` as an artifact. It has **no**
`security-events: write` permission, so it cannot publish alerts even by
mistake.

It is fail-closed as an *analysis* job: a missing, unparsable, or
results-less report fails the job. Only *vulnerability findings* are
non-blocking. A crashed scanner and a clean scan must never look alike.

### Why this file cannot decide what ships

`verification-metadata.xml` is Gradle's *artifact checksum ledger* (schema
`dependency-verification-1.3.xsd`). It records a SHA-256 for every artifact
Gradle has ever resolved, and it is append-only. At the baseline it holds
**2,232 components**, against **444** that actually ship.

It is a **mixed** ledger — build plugins, test-only jars, stale versions and
genuine shipped runtime libraries sit in it side by side with nothing marking
which is which:

- Several versions of the same artifact at once — `commons-io` at 1.4, 2.4, 2.6
  and 2.16.1, of which only **1.4** ships; `io.netty` at five versions, of which
  **none** ship. One CVE therefore appears repeatedly, against versions that are
  not in the product.
- Test-only artifacts: `junit`, `org.assertj`,
  `com.squareup.okhttp3:mockwebserver`, `org.robolectric`.
- The buildscript classpath: `com.android.tools.build:gradle`,
  `org.jetbrains.kotlin:kotlin-gradle-plugin`.

Verified by comparing the ledger against the release runtime lock: none of
`com.android.tools.build:gradle`, `kotlin-gradle-plugin`, `junit:junit`,
`assertj-core`, `mockwebserver` or `robolectric` appear in the runtime graph.

### What the ledger's findings actually are

Measured with OSV-Scanner 2.3.8 against the committed ledger on 2026-08-10:
**289 advisory entries** across **73 vulnerable package-versions**, resolving to
**95 distinct advisory IDs** (the same advisory recurs against several versions
of the same artifact).

By severity, counted per entry so it reconciles to the total:
**4 Critical + 115 High + 153 Medium + 10 Low + 7 unscored = 289.**

Three numbers, three different things — quoting one as another is how the
falsified claim below got made in the first place.

| ledger group | advisories | of which ship | what it is |
| --- | --- | --- | --- |
| `io.netty` | 202 | **0** | AGP / Google build tooling |
| `org.bouncycastle` | 23 | **2** | mostly `apksigner`; but see below |
| `com.google.protobuf` | 15 | 0 | AGP internals |
| `com.google.guava` | 10 | 0 | AGP internals |
| `org.apache.commons` | 8 | 0 | build tooling |
| `commons-io` | 5 | **1** | mostly build tooling; but see below |
| `org.bitbucket.b_c` (jose4j) | 5 | 0 | build tooling |
| `org.jetbrains.kotlin` | 4 | 0 | Kotlin Gradle plugin |
| `com.squareup.okio` | 3 | 0 | stale versions only |
| others (jgit, xerces, json, jdom, gson, tink, httpcomponents) | — | 0 | build/test tooling |

> **Correction.** An earlier revision of this document and of PR #215 stated
> that *"not one finding lands on a library that ships in the APK."* **That was
> false.** Three advisories on two artifacts are in the release runtime graph:
>
> | artifact | advisory | severity | reached via |
> | --- | --- | --- | --- |
> | `org.bouncycastle:bcprov-jdk15to18:1.81` | `GHSA-574f-3g2m-x479` / `CVE-2025-14813` | **Critical, CVSS 9.3** | `bcutil-jdk15to18` ← `project :expo` |
> | `org.bouncycastle:bcprov-jdk15to18:1.81` | `GHSA-c3fc-8qff-9hwx` / `CVE-2026-0636` | Moderate | same |
> | `commons-io:commons-io:1.4` | `GHSA-gwrp-pvrq-jmwv` / `CVE-2021-29425` | Moderate | `host.exp.exponent:expo.modules.filesystem:57.0.0` |
>
> The general shape of the claim held — 202 of the advisories are `io.netty`,
> which genuinely does not ship — but the absolute form was wrong, and it was
> wrong on the one case that matters most: a Critical. Scanning the ledger and
> scanning what ships are different questions, and the ledger cannot answer the
> second in *either* direction. That is why the Android runtime graph is gated
> in its own right rather than inferred from the ledger.

`com.squareup.okhttp3` / `okio` needed individual proof rather than a blanket
dismissal, because React Native genuinely ships OkHttp. The ledger holds okhttp
`3.14.9`, `4.9.2`, `4.12.0` and `logging-interceptor 5.4.0`, plus okio `1.17.2`
through `3.17.0`. Only the **stale** versions are flagged (okhttp 3.14.9 /
CVE-2021-0341; okio ≤2.9.0 / CVE-2023-3635), alongside `mockwebserver`, which is
test-only. The versions actually in the runtime lock are unflagged.

## Open item

`GHSA-574f-3g2m-x479` (Critical) is on the gating surface as of this change,
against a library that ships. It is **not** dismissed here. The advisory
concerns GOST 28147 CTR-mode keystream reuse in
`G3413CTRBlockCipher`; whether any AutoFlow code path can reach a GOST cipher
requires its own dataflow evidence, and a dismissal without that evidence is
exactly what this workstream forbids. Tracked as follow-up.
