# SCRUM-949 implementation report

The local fix separates current sender text from Meta message context. Only the former can supply a contact number, satisfy the DM mobile requirement, or select the number-received reply. Combined context is retained. No production access, repair, migration, deploy, push, or PR was performed.

## Subject and requirements

- Worktree: `E:\tmp\auto-949`; branch: `claude/scrum949-dm-own-number`.
- Base: `029386d9b107c1ef7f71fb40d6785f280b41795b`. Fresh fetch before implementation and final validation found zero commits behind `origin/main`.
- Authority: [SCRUM-949](https://autoflowdealer.atlassian.net/browse/SCRUM-949), the supplied invariant and constraints, `AGENTS.md`, and `convex/_generated/ai/guidelines.md`.
- Risk: MEDIUM backend business logic affecting customer data. This changes neither money authority nor permissions. Reviewers receive the data-integrity finding contract.
- Test-only commits: `93aad51fc6ebb3f1d291a7eb81bab0bf55254d69` records the original reproduction; `3b048c45ac0e2d0704647756ae92445a826a7614` isolates the regressions and shares HTTP fixtures.
- Implementation revision: `788825dcda4a1a4573540aa686c8a5d2efccdf90`. The later report-only commit does not change that reviewed source.

## Re-derived root cause

I traced the local source rather than relying on the coordinator's diagnosis. `metaMessageText` in `convex/http.ts` calls `collectTextParts` on the message and referral. The collector includes attachment payload titles, captions, descriptions, reply context, and button-related fields. Both HTTP DM loops passed the resulting string as `text` to their internal intake mutations. Both mutations passed `text` to `readSettingsAndSharedMobile`.

That scanner returns a shared number before the lead gate, customer attachment, and mobile-received reply are evaluated. All three consume that same result. `attachSharedMobileNumberToCustomer` can refuse a duplicate phone without invalidating the already-selected number for the gate or reply. Thus two senders can get leads while only one receives the caption's phone.

Signed synthetic `ig_post`, `ig_reel`, Facebook share/fallback, and ad-referral deliveries reproduced incorrect leads. Optional-mobile cases reproduced a customer phone taken from the caption. This independently verifies the causal path in the harness; I did not independently access or reconfirm the reported production rows.

## Sources and field decisions

The material acceptance decision is an allowlist of message provenance, followed by the existing number-format parser and settings exclusion. [OWASP's Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html) recommends semantic validation and explicitly accepted fields at trust boundaries; a syntactically valid number does not establish its owner.

[Meta's official Messenger quick-reply collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api?entity=request-22794852-87cd5a4f-57a9-4345-adfc-8794954779da) states that tapping a quick reply posts its title as a message and sends the title and optional payload in the messages event. Its request examples also show business-defined payloads. Therefore accepting all `message.text` values without inspecting quick-reply metadata would still accept business-authored content.

[Meta's official phone-number quick-reply request](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api?entity=request-22794852-0d4d27c1-7ecc-4385-a089-8c7ce15b237c) establishes the `user_phone_number` feature. The retrieved material did not establish a distinct incoming discriminator proving sender-typed input. Such replies and contact attachments are refused under this task's typed-only rule; the sender can type their number instead. This is a conservative product decision, not a claim that platform contact sharing is illegitimate.

The following primary reference URLs were consulted but their bodies were inaccessible or returned HTTP 429. Their field definitions were not treated as verified documentation:

- [Messenger messages](https://developers.facebook.com/docs/messenger-platform/webhooks/webhook-events/messages/).
- [Messenger quick replies](https://developers.facebook.com/docs/messenger-platform/send-messages/quick-replies/).
- [Messenger postbacks](https://developers.facebook.com/docs/messenger-platform/webhooks/webhook-events/messaging_postbacks/).
- [Messenger referrals](https://developers.facebook.com/docs/messenger-platform/webhooks/webhook-events/messaging_referrals/).
- [Instagram messages reference](https://developers.facebook.com/docs/instagram-platform/webhooks/reference/messages/), [Instagram webhook examples](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/), and [Instagram post-share transition](https://developers.facebook.com/docs/instagram-platform/webhooks/new).

This leaves the full current Meta definitions of `share`, `ig_post`, `ig_reel`, `story_mention`, `reply_to`, and `referral` unverified from their primary reference bodies. Their refusal does not depend on identifying those attachment types. The root post/reel payload shape comes from the supplied incident evidence and was reconstructed with synthetic values. I did not rely on third-party mirrors as technical authority.

| Field or event | Contact evidence ruling on both platforms |
| --- | --- |
| Nonblank string `message.text`, with no quick-reply or postback marker | Accept as current sender text; still apply settings exclusions |
| `message.quick_reply`, including its displayed `message.text` and payload | Refuse, including null or unknown marker shapes |
| Event-level or message-level `postback`, title, or payload | Refuse; ordinary postback-only deliveries remain skipped by the existing loops |
| Attachment payloads of any type, including shares, reels, stories, link previews, and contacts | Refuse |
| `reply_to`, story context, nested/message-level or event-level `referral` | Refuse as contact evidence; retain existing combined context |
| Missing, blank, or malformed sender text | No contact evidence; never fall back to combined or stored text |
| Comments | Never extract a shared number, even if `senderText` is supplied |

## Chosen design and alternatives

`senderMessageText` performs the narrow boundary extraction. The two HTTP DM loops pass its output as optional `senderText`. Both internal mutations use only that argument for `readSettingsAndSharedMobile`. Consequently the existing shared result controls attachment, qualification, and the number-received reply together. The settings exclusion remains a second layer when the sender pastes a configured showroom number. No schema field or migration is needed.

A structurally different alternative was to remove caption, referral, reply, and attachment fields from `collectTextParts`, keeping one string throughout. I rejected it because the string is also the message context, vehicle-matching input, lead note, and Facebook surface-classification input. Removing that context would violate the requested preservation contract.

Expanding the settings denylist, or trying to subtract caption numbers after flattening, was also rejected. Arbitrary unconfigured numbers would remain possible, and flattening has already lost the distinction between a typed number and the same number in a quote. Passing the whole raw vendor event into both mutations would preserve provenance, but would duplicate vendor parsing or enlarge the internal contract unnecessarily.

To stay within existing file-size ceilings, the touched media-ID comments were shortened and `metaMessageText` reuses the collector's default array and the existing optional-string helper. The collector already trims each part, so its joined output is unchanged; the HTTP optional-string helper itself does not trim. No guardrail baseline was increased.

## Blast radius and proof obligations

The census used Graft first, then repository-wide tracked-source searches for the symbols, function references, registrations, and consumers, including `scripts/`. It was checked against fetched `origin/main` and the final local source. This is a current-source census, not a proof about deleted historical producers or production rows.

| Surface | Finding and evidence |
| --- | --- |
| `metaMessageText` | Two production callers: the Instagram and Facebook DM loops. Combined text still reaches intake and vehicle enrichment. Signed HTTP tests assert caption retention in event text and lead notes. VERIFIED in harness. |
| `collectTextParts` | Production use in `metaMessageText`, `facebookSurfaceFromPayload`, and its own nested/array recursion. Collection rules were not changed. Existing collector and surface-classification tests pass. VERIFIED in harness. |
| Instagram intake | Two production callers in `http.ts`: comment and DM. Only DM adds `senderText`. Gate, phone, and reply consume the same result. VERIFIED in harness. |
| Facebook intake | The equivalent comment and DM callers in `http.ts`. Ad referral remains context and cannot supply the number. VERIFIED in harness. |
| Retries/replays/backfills | Enumerated intake references in tracked source found those four HTTP callers and the two registrations; none in `scripts/`. Provider redelivery repeats the raw envelope and dedupes by external ID. Backfill/enrichment source reads update existing events or profiles rather than re-invoking intake. Direct legacy-call tests on both platforms prove omitted and empty provenance refuses extraction. Current call graph INSPECTED; refusal and existing redelivery behavior VERIFIED in harness. |
| WhatsApp | `handleIncomingMessage` requires `senderPhone`, uses it for lookup and writes `phone`/`whatsapp` from it. It does not call the changed extractor or text collector. INSPECTED; no WhatsApp execution claim. |
| Comments | `readSettingsAndSharedMobile` retains `kind === "dm"`. Both direct comment controls create the allowed comment lead without attaching a phone or selecting the number-received reply. VERIFIED in harness. |
| Web/mobile clients | Both changed functions remain `internalMutation`; native registration metadata confirms internal visibility and optional-string `senderText`. Public function registrations/arguments were not changed, so `scripts/intelligence/permissionMatrix.test.ts` was not required or run. |
| Deployment/version boundary | Omitted optional arguments are accepted and refuse contact extraction. Both changed HTTP callers and mutations belong to one backend deployment. Already-recorded events remain deduped; this is deliberately not a data repair. No live deployment/spec was accessed. |

The scenario library has no social-intake domain or existing social-intake scenario home at this base. Its accepted domains are money, permission, tenancy, and screen. The 23 records therefore live under `regression/scenarios/screen` at backend level, following the existing screen/backend pattern for user-visible state. Thirteen records cite the observed red commit at their current test path; ten preventive controls claim no failing-first bug. Their ruling is the SHA-256 snapshot of the freshly read SCRUM-949 description, added to `regression/rulings.json`.

The shared signed-webhook fixtures moved to `test-utils/socialWebhook.ts`. This avoids duplicating the harness and separates active regression registrations from the original suite's three expected-failure registrations, which the scenario validator refuses as executable evidence.

## Execution record

The retained Vitest verification runs use named files, one worker, and verbose reporting. One discarded quoting error is documented below. No `--testTimeout`, watchers, or dev servers were used.

Original failing-first command:

```text
pnpm exec vitest run convex/socialWebhookLeadCapture.test.ts --maxWorkers=1 --reporter=verbose
Test Files  1 failed (1)
Tests       14 failed | 55 passed | 3 expected fail (72)
AssertionError: expected [ { …(7) } ] to have a length of +0 but got 1
AssertionError: expected [ { …(7) }, { …(7) } ] to have a length of +0 but got 2
AssertionError: expected [ '0790000001' ] to deeply equal [ undefined ]
```

After fixture extraction, the current test path was rechecked with the five production files temporarily restored from the exact base and restored byte-for-byte in `finally`:

```text
pnpm exec vitest run convex/socialContactProvenance.test.ts --maxWorkers=1 --reporter=verbose -t "caption|title|ad referral|two .*senders|typed phone|typed settings phone|phoneless|story"
Test Files  1 failed (1)
Tests       13 failed | 4 passed | 6 skipped (23)
```

The six deselected cases are outside that red HTTP subset; none are skipped in the committed registrations or final green run. The 13 failures are assertion failures for caption/referral qualification, button titles, two senders, or caption phone attachment.

Final combined command:

```text
pnpm exec vitest run convex/socialContactProvenance.test.ts convex/socialWebhookLeadCapture.test.ts convex/instagramEngagement.test.ts convex/facebookEngagement.test.ts convex/utils/metaText.test.ts convex/utils/socialMobile.test.ts convex/socialInbox.test.ts convex/socialInboxConversations.test.ts convex/socialInboxStats.test.ts scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --reporter=verbose
Test Files  10 passed (10)
Tests       376 passed | 3 expected fail (379)
Duration    138.96s
```

The three existing expected failures remain SCRUM-625 customer merging, SCRUM-626 sender-less Facebook comments, and SCRUM-627 soft-deleted contacts. This change does not fix them. The standalone scenario validator also passed 70/70 after binding correction.

Required negative controls, run sequentially and restored in `finally`:

| Mutant | Command files | Observed result |
| --- | --- | --- |
| Both HTTP loops pass combined `messageText` as `senderText` | `convex/socialContactProvenance.test.ts` | KILLED: 13 assertion failures, 10 passes, exit 1 |
| `readSettingsAndSharedMobile` drops `ownNumberExclusions(settings)` | New provenance suite, original webhook suite, `convex/utils/socialMobile.test.ts` | KILLED: 3 assertion failures, 127 passes, 3 expected failures, exit 1. The pre-existing test `a DM quoting only the dealer's own number is not a lead` failed. |

The restoration script compared saved bytes after writing them back. Restored SHA-256: `http.ts` = `a22ad0b99a403fd72d5839ad960a6d452a61368beabc58665a609f1404eb9ff4`; `socialMobile.ts` = `6eb7e1caa329f60b44fb4d892cc0699cab6f7907949e1b912eb72036eb35018d`.

Other checks and the final review result are recorded below.

Two verification attempts were not used as evidence: an initial scenario run correctly failed because the old test file contained expected-failure registrations; a temporary subprocess command quoted the red-run filter incorrectly and selected an unintended set of tests. The latter was replaced with a direct Node/pnpm argument array and the one-file red run above. A scoped native-metadata attempt also refused external modules; the successful repository-wide renderer was used instead. Production source was restored in `finally` after each temporary original-source run.

## Five ways the fix could still be wrong

| Predicted failure | What I tried and found |
| --- | --- |
| A sibling context field still supplies the number | Signed ig_post, ig_reel, share, fallback title, ad referral, story mention, and reply-context cases. No phone, qualifying lead, or number-received reply. Unknown attachment types are refused without a type denylist. |
| Preserving context makes it leak back into contact extraction | Combined-text mutant killed by 13 assertions. Positive cases with typed `0790000002` beside caption `0790000001` keep the typed phone and retain caption context. |
| Business-authored button text looks like ordinary message text | Both platforms' signed quick-reply tests, including numeric titles, and helper controls for event/message postbacks and contact attachments refuse it. Null quick-reply markers are refused too. A future Meta shape without such markers remains an external-contract unknown. |
| An old caller, empty argument, or comment bypasses provenance | Both platforms' omitted/empty argument tests refuse combined-text fallback. Comment controls ignore even explicit numeric sender text. Existing redelivery tests still dedupe. Historical deleted callers are outside the current-source census. |
| The existing own-number protection or mobile-off behavior regresses | Settings-exclusion mutant failed the existing HTTP regression and both new platform controls. Mobile-off share cases still create a phoneless lead and choose the ordinary reply. |

## Proposed read-only affected-rows listing

This is a proposal for an authorized owner-run investigation. It was not run. Use a private, access-controlled dashboard export or an existing authorized read-only export facility; do not publish raw webhook bodies, names, IDs, or phone numbers to Jira, GitHub, or this repository.

1. Choose explicit organizations and a bounded time window. Read `webhookLogs` for Instagram/Facebook with full `rawPayload`, retaining source, timestamp, and truncation status. The schema has no org ID on these logs, so resolve each entry's recipient/page/account to the authorized organization rather than assuming a log belongs to it. Skip neither malformed nor truncated payloads silently; classify them UNAVAILABLE. Page through the entire selected window and record coverage and retention limits.
2. Offline, parse every messaging event and derive the same accepted sender text. Separately enumerate numbers with their JSON paths in attachment title/description/caption, reply/story context, referral, and button metadata. Use normalized synthetic-free values only in the private output. Label a number as context-only when it is absent from the accepted current sender text. Repetition across senders is a useful prioritization signal, not a necessary condition or proof of showroom ownership.
3. Join by resolved org, platform, `message.mid`/event `externalId`, and sender identity to `instagramEvents`/`facebookEvents`, then follow their `customerId` and `leadId` within the same org. List candidate customer phone equality, event/lead links, creation times, source, reply text classification, and later qualifying messages. Include candidates with no phone, since the duplicate-phone guard can still leave an invalid lead.
4. Deduplicate customers and leads and classify confidence. Current settings are not evidence of settings at the delivery time. Missing raw payloads, later manual changes, reused leads, and later genuine typed numbers require manual review. A clean result in a sampled window cannot clear older retained or missing history.

An approved repair would need to clear or replace only a proven incorrect customer phone, decide whether an invalidly created lead should be retained, corrected, or retired, and reconcile event links and any derived inbox/lead summaries through supported mutations. Preserve later genuine qualification and staff edits. Do not erase a truthfully recorded delivered auto-reply or the original message context. Decide how to record the correction and handle notifications/assignments before changing rows. No repair code or production writes are included here.

## Remaining unknowns and evidence boundaries

- Meta's full current primary webhook reference bodies remain unavailable as listed above. Unproven fields are refused; future changes in how Meta marks generated text require rechecking.
- Unmarked business-authored prefilled text is an unresolved external-contract question. The reviewer asked whether an ad prefill can arrive as plain `message.text` without `quick_reply` or `postback`. Additional primary-reference attempts, including Meta's newer `/documentation/business-messaging/` paths, returned 429. I could not validate that payload shape. This fix accepts ordinary `message.text` as specified by the task; it does not claim to distinguish a prefill from typed text when Meta supplies identical data. Blanket refusal of all messages with a referral would also reject potentially genuine typed numbers and is not justified by the retrieved evidence. This uncertainty needs a documented synthetic provider example before a further policy change.
- Existing polluted rows remain unchanged. Retention, complete affected population, original settings, and manual edits were not examined.
- `convex-test` establishes harness behavior, not Convex cloud limits, OCC, real Graph sends, or production data parity. External delivery/enrichment boundaries are stubbed in the shared HTTP fixture.
- No CI, CodeRabbit, browser screen audit, fresh explorer swarm, release rehearsal, deployment, or production verification is claimed. The task ends at a local commit; broader pilot and merge gates remain separate.

## Final checks and review

| Check | Actual result |
| --- | --- |
| `pnpm typecheck` | Exit 0. Root app/scripts TypeScript check excludes `convex/`. Repeated after fixture extraction. |
| `pnpm typecheck:convex` | Exit 0. Separate backend TypeScript check, repeated on final source. |
| Changed-file ESLint | Exit 0; zero errors, 18 pre-existing `no-explicit-any` warnings on unchanged lines of the two engagement test files. New helper/test code adds no `any`. |
| `node quality/guardrails/check.mjs` | Final exit 0: 1,071 production files measured. Existing 265 import-boundary allowances and non-tenant-builder advisory remain. First run refused three files growing two formatted lines each; shortening touched comments and simplifying the combined-text helper restored the existing ceilings. No baseline edited. |
| `scripts/regression/scenarioRecord.test.ts` | Standalone 70/70 and included in final 376-pass run. |
| `node scripts/contractSkew/checkBaselineIdentity.mjs` | Exit 0: 948 entries matched `(surface, file, callSiteId, functionId)`. As documented in `BASELINE-IDENTITY.md`, this does not certify backend finding identity or live compatibility. No renewal mode or baseline changes. |
| `node scripts/contractSkew/renderCurrentSpec.mjs .claude/review-state/scrum949-current-spec.json --concurrency 1` | Exit 0: 619 registered functions, 1,128 environment-blind evaluations, 90 modules UNPROVEN. Both affected intake contracts were present, internal, and declared `senderText` as an optional string. This is scoped contract evidence, not an all-backend or deployed-spec verdict. |
| `git diff --check` and line endings | Clean; changed `.ts`, `.json`, and `.md` files normalized to CRLF. `.gitignore` and `.ignore` were not staged. |

The advisory two-axis review found no production-code standards or spec issue. Its scenario-binding finding was accepted and corrected; the final validator and current-path red commit verify the correction. This advisory is not a review seat.

Independent review: **APPROVE** at `788825dcda4a1a4573540aa686c8a5d2efccdf90`, model reported by the runtime as `claude-opus-5-5`, requested effort `high`, separate local session `b74fb245-8c03-4bbd-b89f-750d04499992`. The reviewer used Read/Glob/Grep, executed no tests, performed no network or production access, and delegated nothing. Its independently derived 16-path enumeration matched the implementation matrix. It reported no critical, high, or authority/data-integrity medium finding. This is one independent review of a MEDIUM backend change, not a money review seat or a release certificate.

Disposition of its nonblocking items:

- L1, optional-string helper wording: VALIDATED against `http.ts`; corrected above. No source change needed because the collector trims its parts.
- L2, report-only commit not yet present: VALIDATED at review time. The report is being committed separately; the implementation SHA above identifies the reviewed code.
- L3, per-platform test symmetry: VALIDATED as a coverage limitation. Signed referral coverage is Facebook; signed reply/story coverage is Instagram. The common extractor and both platform paths are otherwise exercised. Mirrored cases are deferred, with no claim that those particular payloads were executed on the opposite platform.
- U1, unmarked ad prefill: UNRESOLVED, not a validated defect. Follow-up primary-source attempts were inaccessible. The precise limitation and why a blanket referral block was not added are recorded above. [SCRUM-951](https://autoflowdealer.atlassian.net/browse/SCRUM-951) tracks obtaining authoritative payload evidence and the related L3 platform-symmetry coverage.

The reviewer suggested rerunning the same checks; the implementation SHA's source is exactly the source already checked in the final runs, so no extra identical suite or mutant run was performed. Only this report changes afterward. CI and PR review remain outside this local task.

The review startup generated a `/graft/` entry in `.gitignore` and a new `.ignore`. Both are left uncommitted and unstaged as requested. The implementation does not depend on another branch or PR.
