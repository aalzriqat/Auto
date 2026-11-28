# The assistant proposes an expense and never saves it

## Context

[SCRUM-1039](https://autoflowdealer.atlassian.net/browse/SCRUM-1039) slice 1 lets dealership staff type a sentence ("paid 120 for office rent today", "دفعت 35 دينار بنزين أمس") and get the expense form pre-filled. A model can misread an amount or a day fluently, and a message can contain instructions aimed at it. An expense is money: it posts to the ledger.

## Decision

- The assistant produces a proposal: suggested form values in its own table, `aiAssistantProposals`. No assistant module calls the expense create door or writes `expenses`, `transactions` or any accounting table. A static test reads the module sources and fails on those references. The web app opens the normal expense form with the proposal and the staff member saves it through the existing create door, with all its permission, idempotency and accounting rules.
- The model has no tools. It sees the typed message, today's date in the dealership time zone, and the category and payment-method names. No dealership record, name, vehicle or supplier is sent.
- Its answer is structured JSON, parsed strictly, and every value is checked in code: amount finite and above zero, tax between zero and the amount, a listed category (PREPAID excluded, since it needs amortization fields one message cannot carry), a real calendar day between today and 366 days back, title 1 to 100 characters, notes up to 1,000, a payment method the expense contract accepts. Any violation is "not understood" with no partial proposal. The stored proposal is checked again at completion.
- The gate is the existing one: platform switch, dealership switch, stored provider key, then `create:expenses` permission, then a message of 1 to 1,000 characters and two rate limits (per member and per dealership, same numbers as reply drafts). All of it runs in the request mutation before anything is scheduled. The job re-checks the gate. A pending row expires after 120 seconds.
- Only the requester can read a proposal. Another member or dealership gets what a missing row gets.

## Alternatives

A separate assistant switch was not added: the existing switches already mean "this dealership allows our provider key to be used", this feature sends strictly less than reply drafts do, and a new switch needs an admin screen. If the owner wants the two features switched apart, that is a new switch and a screen, not a change to this design.

Letting the assistant call the create door for a confident proposal was rejected: a wrong amount would reach the ledger without a person reading it.

## Consequences

- The user always sees and confirms the numbers. A wrong proposal costs one edit.
- The date reaches the form as a calendar day; the form converts it with its existing date input rule.
- Turning the reply-draft switch off also turns this assistant off, and the admin page still names it "AI drafts".
