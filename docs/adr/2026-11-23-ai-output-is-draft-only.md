# AI output is a draft only, and its figures come from system queries

## Context

The owner ruled that a staff member sends every reply ([SCRUM-979](https://autoflowdealer.atlassian.net/browse/SCRUM-979) ruling 3). The only money in a draft is the listed price and the financing estimate the existing rules compute, with no discount, negotiation or promise. Anything else hands the customer to a salesperson (ruling 11). The money and safety rules are fixed in code, not editable from any screen (ruling 20). [SCRUM-980](https://autoflowdealer.atlassian.net/browse/SCRUM-980) builds the writer. A model can state a wrong number fluently, and a customer's message can contain instructions aimed at it.

## Decision

- An AI draft has no effect until a staff member sends it. No code path sends one, posts a journal entry, or decides a price, refund or credit.
- The model never writes a number. Its text may not contain a digit in any script. Every number and name is a token such as `{{LISTED_PRICE}}`, which code fills afterwards from values that system queries read.
- Text that contains a digit, an unknown token, a link or an `@` is discarded. A fixed handover sentence kept in code, in English or Arabic, replaces it.
- The financing estimate comes from `calculateFinancingEstimate`, the one function the Smart Reply already uses. The Owner's editable Smart Reply templates never reach the provider.
- The model's context is built from an explicit allowlist, copied field by field. Cost, profit, supplier, internal notes, access tokens and other customers' messages are never included.
- The customer's text is passed as delimited data, the rule block is a constant in code, and the request has no tools.
- When the data does not answer the customer's question, the model returns no draft and the inbox says a person is needed.
- A provider refusal, truncation, error or timeout means no draft. The inbox is unchanged.

## Alternatives

Checking the numbers in the model's text against an allowed set was rejected. `10% off`, `5k`, Arabic-Indic digits and substring matches got through a three-digit rule in design review.

Passing the Smart Reply's finished text to the model as the estimate was rejected. That text includes Owner-editable templates, so an edit could put a discount in front of the model.

Letting the model call tools to look up prices was rejected. The model would decide what to read, and the request would lose its fixed, reviewable shape.

## Consequences

- A draft that uses a number the system does not hold becomes the handover sentence, so a person answers some answerable questions.
- Numbers written as words pass the check. The staff member who reads the draft is the control for that.
- A new fact the model may state needs a token and an allowlist field, added in code through review.
- The wording is the model's. The rule covers figures and commitments, not tone.
