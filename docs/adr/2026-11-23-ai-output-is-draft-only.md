# AI output is a draft only, and code writes every word of it

## Context

The owner ruled that a staff member sends every reply ([SCRUM-979](https://autoflowdealer.atlassian.net/browse/SCRUM-979) ruling 3). The only money in a draft is the listed price and the financing estimate the existing rules compute, with no discount, negotiation or promise. Anything else hands the customer to a salesperson (ruling 11). Those rules are fixed in code (ruling 20). [SCRUM-980](https://autoflowdealer.atlassian.net/browse/SCRUM-980) builds the writer. A model can state a wrong number fluently, and a customer's message can contain instructions aimed at it.

## Decision

- An AI draft has no effect until a staff member sends it. No code path sends one, posts a journal entry, or decides a price, refund or credit.
- The model only chooses. Its structured answer is an outcome and a list of names from seven approved answers: greeting, availability, vehicleInfo, price, financing, location and handover. The schema has no text field, and a strict parser rejects any other shape.
- Code writes every word. Each answer is a sentence the Smart Reply builder renders from the built-in strings, in English and Arabic, without the Owner's editable templates. Code joins the chosen sentences in a fixed order. An answer with no sentence adds the fixed handover sentence, and a draft over 1,000 bytes loses trailing sentences whole.
- Code picks the language from the customer's latest message.
- The request carries the conversation and the names of the available answers. It carries no dealership fact, and it has no tools.
- A refusal, truncation, error, timeout or unreadable answer means no draft. The inbox is unchanged.

## Alternatives

Letting the model write text and filtering it was rejected. Three review rounds each found strings that passed: `10% off`, `5k` and Arabic-Indic digits against a digit rule, then a list of forbidden wording that missed paraphrases and Arabic dialect. A filter has to name every bad sentence in advance.

Letting the model call tools to look up prices was rejected. The request would lose its fixed, reviewable shape.

## Consequences

- Drafts read like Smart Reply sentences. The model cannot mirror a customer's dialect or answer a question no sentence covers.
- A new fact in a draft needs a new approved answer and sentence in code, added through review.
- The money and commitment rules hold by construction, and a test checks every combination of answers.