# Security Policy

## Reporting a vulnerability

Please report security issues privately — **do not open a public issue.**

Use GitHub's [private vulnerability reporting](https://github.com/aalzriqat/Auto/security/advisories/new)
on this repository. It is enabled, and it is the preferred channel.

What helps most in a report:

- the affected area (web dashboard, Convex backend, mobile app, dealer website, marketplace)
- steps to reproduce, or a proof of concept
- what an attacker gains — data read, data written, or access escalated
- whether it crosses an organization boundary (this is a multi-tenant system, so
  anything that reads or writes another dealership's data is treated as high severity)

You can expect an acknowledgement within a few days.

## Scope

In scope:

- the Next.js dashboard and its API surface
- the Convex backend (`convex/`), including scheduled jobs and webhooks
- the Expo mobile app and the public marketplace
- published dealer websites

Out of scope:

- findings in build tooling that is not shipped to users — for example the Gradle
  toolchain artifacts recorded in `apps/mobile/android/gradle/verification-metadata.xml`
- vulnerabilities in third-party services (Clerk, Convex, Vercel, Expo) that should be
  reported to those vendors directly
- reports produced only by an automated scanner, with no demonstrated impact

## Handling of tenant data

Every record is scoped to an organization. Authorization is enforced server-side in
`convex/utils/tenancy.ts`; the frontend is never the enforcement point. Reports that
demonstrate a way around those guards are prioritized above everything else.

## Automated scanning

Semgrep, osv-scanner, Checkov, ZAP and Nuclei run in `.github/workflows/security.yml`,
alongside CodeQL and Dependabot. These report rather than gate, so that findings can be
triaged before any of them blocks a merge.
