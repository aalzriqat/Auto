# Preserve authority in Finance Deal Costs

Status: proposed for SCRUM-963.

The registered Finance Deal Costs functions retain their validators and wrapped mutation builders at the current Convex path. The implementation functions receive the same query or mutation context. The registered module supplies the existing chart and financing operations to keep the extracted code independent of other Convex registration modules.

The expected-fee projection reads the application's frozen configuration and matches actual fees by stored template position. Overview and Settlement keep their currency and missing-evidence rules and use the existing fee summary. Custody and fee commands keep authorization, owned-row checks, idempotency, audit, posting and reversal in the original transaction. Legal-invoice audit and revision updates remain in that transaction too.

The risks are a lost permission or ownership check, a stale invoice revision, a wrong denomination or responsibility, a retry creating an extra fee or cash movement, and a reversal losing its original posting identity. Verification compares the registered interface and moved code with the base and exercises existing fee, custody, invoice, tenant and retry controls. A Finance-specific source test follows each mutation into its implementation and checks that the existing caller-ID writes remain detectable when ownership proof is removed. Protected disposable-backend replays and independent review provide release evidence.

[SCRUM-963](https://autoflowdealer.atlassian.net/browse/SCRUM-963) · [Convex shared helpers](https://docs.convex.dev/understanding/best-practices#use-helper-functions-to-write-shared-code) · [Convex transactions](https://docs.convex.dev/functions/mutation-functions#transactions)
