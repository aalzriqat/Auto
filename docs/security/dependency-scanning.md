# Dependency scanning: what is gated, what is reported

Baseline commit: `52be7b4f86db9b3e9cc9d7ea19cdcc6c8aadbdc1`.

AutoFlow runs two separate SCA signals, deliberately. Mixing them is what made
the Security dashboard unusable: 289 of 301 findings came from one file that
describes the *build machine*, not the product.

## 1. Runtime SCA — the gating signal

Job: `osv-runtime` in `.github/workflows/security.yml`.
Publishes to GitHub Code Scanning. This is the signal a merge gate should use.

Scanned:

| manifest | covers |
| --- | --- |
| `pnpm-lock.yaml` | web app, Convex backend, `packages/*`, **and `apps/mobile`** — `apps/*` is a pnpm workspace member, so the React Native / Expo JS graph is included here |
| `dealer-worker/package-lock.json` | the Cloudflare Worker |

These are listed explicitly rather than scanned with `--recursive ./`. An
explicit list can go stale silently, so the job first fails loudly if the set of
OSV-parsable manifests in the repo no longer matches the set accounted for. It
watches the **full** list of filenames OSV-Scanner supports, not just the
npm-family ones, so a future `gradle.lockfile` or `requirements.txt` cannot land
unscanned and unnoticed. Adding a new workspace, worker or ecosystem breaks that
step on purpose; update `scan-args` when it does.

Job: `osv-toolchain`. Scans
`apps/mobile/android/gradle/verification-metadata.xml`. It writes a job summary
and uploads `osv-toolchain.json` as an artifact. It has **no**
`security-events: write` permission, so it cannot publish alerts even by
mistake, and it cannot drown the runtime dashboard.

### Why this file is not a dependency manifest

`verification-metadata.xml` is Gradle's *artifact checksum ledger* (schema
`dependency-verification-1.3.xsd`). It records a SHA-256 for every artifact
Gradle has ever resolved, and it is append-only. At the baseline commit it holds
**2,232 components across 16,274 lines**, and it demonstrably does not describe
what ships:

- It records several versions of the same artifact simultaneously —
  `androidx.activity` at 1.10.1, 1.11.0 **and** 1.13.0; `io.netty` at 4.1.34,
  4.1.52, 4.1.72, 4.1.93 and 4.1.110. A single CVE therefore appears five times.
- It records **test-only** artifacts: `junit`, `org.assertj`,
  `com.squareup.okhttp3:mockwebserver`.
- It records the **buildscript classpath**. `io.netty` and `org.bouncycastle`
  appear in no `.gradle` file in this repo; they arrive via
  `com.android.tools.build:gradle` and `com.google.gms:google-services`, which
  run on the build machine. `apps/mobile/android/app/build.gradle` declares only
  `com.facebook.react:react-android`, `com.facebook.react:hermes-android` and
  optional Fresco codecs.

### Findings at the baseline (all build-time)

289 findings: 4 Critical, 115 High, 153 Medium, 10 Low, 7 unscored.

| maven group | count | C | H | what it is |
| --- | --- | --- | --- | --- |
| `io.netty` | 202 | 1 | 86 | AGP / Google build tooling |
| `org.bouncycastle` | 23 | 3 | 1 | `apksigner` signing, build time |
| `com.google.protobuf` | 15 | 0 | 12 | AGP internals |
| `com.google.guava` | 10 | 0 | 0 | AGP internals |
| `org.apache.commons`, `commons-io` | 13 | 0 | 6 | build tooling |
| `org.bitbucket.b_c` (jose4j) | 5 | 0 | 3 | build tooling |
| `org.jetbrains.kotlin` | 4 | 0 | 0 | Kotlin Gradle plugin |
| others (jgit, xerces, json, jdom, gson, tink, httpcomponents, okio, okhttp) | 17 | 0 | 5 | build/test tooling |

**Not one finding lands on `androidx.*`, `com.facebook.*` or `expo.*`** — i.e.
none on a library that ships in the APK.

The one group that needed individual proof rather than a blanket dismissal is
`com.squareup.okhttp3` / `okio`, because React Native genuinely ships OkHttp.
The ledger holds okhttp `3.14.9`, `4.9.2`, `4.12.0` and `logging-interceptor
5.4.0`, plus okio `1.17.2` through `3.17.0`. Only the **stale** versions are
flagged (okhttp 3.14.9 / CVE-2021-0341; okio ≤2.9.0 / CVE-2023-3635), alongside
`mockwebserver`, which is test-only. The modern versions present are unflagged.

## Known gap: Android native AAR graph

Neither job resolves the Android **native** dependency graph — `androidx.*`,
`com.facebook.react:react-android` and the autolinked Expo modules. Only Gradle
can resolve it, and `verification-metadata.xml` cannot stand in for it because
it cannot distinguish a shipped artifact from a build-time or stale one.

Closing it properly means enabling Gradle dependency locking so a real,
resolved, machine-readable runtime graph exists to scan:

```
# apps/mobile/android/app/build.gradle
dependencyLocking { lockAllConfigurations() }

./gradlew :app:dependencies --write-locks \
  --configuration releaseRuntimeClasspath \
  --dependency-verification=off
```

That produces `gradle.lockfile`, which OSV-Scanner parses natively and which
would then join the **runtime** job above.

This is deliberately **not** done in the same change as the scanner split:
it requires a working Android SDK + Gradle run in CI, no CI job currently builds
the APK, and this repo's dependency verification is known to break on any new
native module. It needs its own PR with its own CI validation.

Risk while the gap is open: low but real. It is bounded by the fact that the
mobile app's JS/RN dependencies — where nearly all of its actual attack surface
lives — are already covered through `pnpm-lock.yaml`, and that no native AAR has
ever produced a finding here.
