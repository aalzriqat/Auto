# Bombadil signed-out explorer (SCRUM-1005)

[Bombadil](https://antithesishq.github.io/bombadil/) is a property-based testing tool for web UIs. It opens a real
Chrome, picks actions at random (click, type, scroll, back, reload), and after every step checks the properties
written in `public-surface.spec.ts`. This folder holds the first thin slice: the signed-out pages of AutoFlow only.

## What it is good for here, and what it is not

- Good for: crashes and console errors on public pages, HTTP error responses, `<html lang>` and `dir` agreeing after
  the language toggle, a visitor never leaving the public route list, and literal `NaN`, `undefined` or
  `[object Object]` on screen. It finds paths nobody scripted.
- Not good for money. It sees the rendered screen only. It cannot read the ledger, the journal or any Convex state, so it
  never certifies an accounting or deal number. Money and permission rules stay with backend Vitest tests and the
  SCRUM-486 matrix.
- Random exploration is not reproducible from a seed. `--reproduce <trace>` replays a recorded run on a best-effort
  basis and fails when the page diverges. A violation is only real once you have reproduced it by hand or by replay.
- It is a screen-level, unscripted explorer. It does not replace the scripted E2E suite or the screen audit.

## Where it sits among the three bug hunters (SCRUM-760)

SCRUM-760 requires three hunters at every change: scripted E2E, screen audit (roles x EN/AR x phone/desktop), and an
unscripted explorer swarm (Jev). Bombadil is a second unscripted explorer next to the Jev swarm. Scenarios it finds
are recorded with `source.hunter: "explorer"`. This slice is advisory and signed-out only, so it does not satisfy
the three-hunter gate by itself. Nothing here says AutoFlow is ready for the pilot.

## Run it

Bombadil 0.8.0 ships Linux x64, Linux arm64 and macOS arm64 binaries. There is no Windows binary, so on Windows use
WSL or Docker. The runner refuses on any other platform (`CANNOT_RUN`, exit 1).

1. Serve a local production build on `127.0.0.1:3000` (`pnpm build && pnpm start`) against a disposable backend.
   The explorer types random text into public forms (contact form, chat widget), so never point it at a shared
   or production deployment.
2. `pnpm run bombadil:public`

Entry points. The runner makes five separate Bombadil runs, one per entry point, each with its own
`trace-<slug>.bin` and `run-<slug>.log`: `/` (home), `/marketplace/cars`, `/contact`, `/privacy`, `/terms`. The origin
given to Bombadil may carry a path; exploration then stays on that origin's scheme, host and port, so a run can still
follow links to other public pages. Bare `/marketplace` has no page (it returns 404), so the marketplace entry is
`/marketplace/cars`. The total time is split evenly across the five entries.

Options (environment or flags): `BOMBADIL_BASE_URL` / `--base-url` (default `http://127.0.0.1:3000`),
`BOMBADIL_TIME_LIMIT` / `--time-limit` (total, default `5m`), `BOMBADIL_OUT_DIR` / `--out-dir` (default
`test-results/bombadil`), `BOMBADIL_MIN_STATES` / `--min-states` (per entry, default 10), `--allow-url <chrome match
pattern>` (repeatable), `--allow-host <host>` (names one non-loopback host explicitly), `BOMBADIL_BIN` /
`--bombadil-bin <path>`, and `BOMBADIL_NO_SANDBOX=1` (adds `--no-sandbox`; off by default; only for a container that
runs Chrome as root, never set in CI).

Verdict. `PASS` only when every entry exits 0 with at least the minimum states. Any entry exiting 2 (property
violation) gives `FAIL` naming the entry and the properties. Any other failure gives `CANNOT_RUN`: the platform has no
binary; the host is not loopback and not named with `--allow-host`; the host ends in `autoflowdealer.com`,
`convex.cloud`, `convex.site` or `vercel.app` (never allowed); `GET /api/health` is not 200; the binary cannot start;
an entry exits 1; or an entry explored too few states. If a violation and a `CANNOT_RUN` cause occur together, `FAIL`
wins and the other causes are still listed. There is no skip path. Only `PASS` exits 0.

Container recipe (Windows or any host without the binary). Use Node 22 on Debian with `chromium` and `ca-certificates`
installed (without CA certificates Chrome's DevTools handshake fails). Mount the worktree read-only, mount a writable
directory for `BOMBADIL_OUT_DIR`, make the app reachable at `127.0.0.1:3000` inside the container (for example
`socat` to `host.docker.internal:3000`), and run `BOMBADIL_NO_SANDBOX=1 node scripts/bombadil/runPublicSurface.mjs`.
`pnpm` links `@antithesishq/bombadil` into `node_modules` through a junction on Windows, so mount the real package
directory over that path.

In CI: `.github/workflows/bombadil-explorer.yml` (push to main, nightly, manual). It is advisory because it is not in
branch protection, but nothing is `continue-on-error`. It has no pull request trigger, starts a disposable local Convex
backend, and runs the explorer in a step with no secrets.

## Read a result

- `test-results/bombadil/verdict.json`: `PASS`, `FAIL` or `CANNOT_RUN`, with the reason, the violations
  (`entry: property`), the problems, and per entry the exit code, state count, distinct pathnames reached and
  violated property names.
- `bombadil trace test-results/bombadil/trace-<slug>.bin --json`: one JSON object per state.
  `--screenshots <dir>` exports each state's screenshot.
- `bombadil browser inspect` for interactive inspection, and `bombadil browser test --reproduce trace.bin <origin>` to
  replay (see `bombadil --help`).

## A violation becomes a permanent regression scenario

1. Reproduce it (replay or by hand). A violation that does not reproduce is recorded as such, not fixed blindly.
2. File a SCRUM bug.
3. Write a failing-first test at the lowest level that catches it: money or permission rule, a backend Vitest test plus
   a SCRUM-486 matrix row; screen-only, a Playwright replay under `playwright/tests/`.
4. Add `regression/scenarios/<domain>/<id>.scenario.json` bound to that test with `source.hunter: "explorer"` and a
   `runId` such as `bombadil-<run>` (schema `scripts/regression/scenarioRecord.ts`; check with
   `pnpm test:regression-library`).
5. Fix the defect. The record stays active.

No record is added for Bombadil itself in this slice: an active browser record must bind a Playwright spec, and a
`candidate` record makes the nightly full tier fail with `CANDIDATE_RECORDS_ARE_NOT_EXECUTED`.

## Limits and next slices

Signed-out only; one viewport (1024x768); no authenticated state; no backend oracle.

1. Signed-in exploration: attach (`bombadil browser test-external --remote-debugger`) to a contained Chromium that
   holds the existing `playwright/.auth` state, behind the SCRUM-784 egress proxy.
2. Role properties (RECEPTION and SALES never see profit) and a deal page versus Sales & Profit report money check
   through a custom action.
3. PR-time execution inside the trusted swarm.

## Sources

- Manual: https://antithesishq.github.io/bombadil/ (browser testing, specification language, default properties and
  actions, CLI). Types read from `node_modules/@antithesishq/bombadil/dist`; the `--help` output of 0.8.0 is the
  authority where the manual differs.
- Chrome lookup (`google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `chrome` on `PATH`) was read
  from strings in the 0.8.0 Linux binary, not from the manual.
- Route list copied from `proxy.ts`; `publicRoutes.test.ts` fails when they drift.
